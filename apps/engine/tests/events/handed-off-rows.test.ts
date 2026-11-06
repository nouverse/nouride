/**
 * A helper's and a peer's steps are rows of the turn that started them (stream 1.2).
 *
 * They went only to the in-memory activity feed of the chat: the stream saw one opaque `delegate` or `ask_agent` call
 * for minutes, their tool calls wrote no `tool`, `tool_done` or `audit` row, and their audit rows had no turn. Through
 * the real pipeline here: a turn delegates, then asks another agent, and each of the two makes a tool call whose id the
 * provider repeats — the turn's own call had it first. And a scheduled job's turn, which had no record at all: only its
 * run history and the same in-memory feed knew it had run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { eventProblems, type Job, type Tool } from "@nouride/shared";
import { AuditLog } from "@/commons/audit.store.ts";
import type { EventRow, EventStore } from "@/modules/events/events.store.ts";
import { audited } from "@/modules/tools/audited.ts";
import { createAskAgentTool } from "@/modules/tools/builtins/ask-agent.ts";
import { createDelegateTool } from "@/modules/tools/builtins/delegate.ts";
import { envelope, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

type Script = Parameters<typeof scriptedOpenAI>[0];

async function delegatingTurn(): Promise<{ rows: EventRow[]; events: EventStore; audit: { turn_id: string | null; agent_id: string }[] }> {
  // The parent asks for a helper; the helper probes; the parent asks nox; nox probes; the parent answers. Every call
  // is `c1`, as a gateway that numbers each request's calls from the start gives them.
  const d = await daemon([
    { toolCalls: [{ id: "c1", name: "delegate", args: { tasks: [{ goal: "probe the disk", context: "a test", deliverable: "what you found" }] } }] },
    { toolCalls: [{ id: "c1", name: "probe", args: {} }] },
    { text: "disk is fine" },
    { toolCalls: [{ id: "c1", name: "ask_agent", args: { agent: "nox", task: "probe the network" } }] },
    { toolCalls: [{ id: "c1", name: "probe", args: {} }] },
    { text: "network is fine" },
    { text: "All fine." },
  ]);
  d.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "check everything", timestamp: Date.now(), mentions: ["nouva"] }));
  await d.pipeline.idle();
  d.auditLog.flush();
  const audit = d.db.prepare<{ turn_id: string | null; agent_id: string }>("SELECT turn_id, agent_id FROM audit_log WHERE action = 'tool_exec' ORDER BY agent_id").all();
  return { rows: d.events.list({ limit: 1_000 }), events: d.events, audit };
}

async function daemon(script: Script) {
  const tools = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe", "delegate", "ask_agent"]\n';
  const bench = await pipelineBench({ turns: script, agents: ["nouva", "nox"], agentToml: tools });
  benches.push(bench);
  const { pipeline, events, turns, db, gateway } = bench;
  const auditLog = new AuditLog(db);
  const probe: Tool = {
    requiresApproval: false,
    definition: { name: "probe", description: "checks a thing", parameters: { type: "object", properties: {} } },
    execute: async () => ({ content: "probe ok", isError: false }),
  };
  pipeline.setTools(
    new Map<string, Tool>([
      ["probe", audited("probe", probe, auditLog)],
      ["delegate", createDelegateTool({ run: pipeline.subagentRunner() })],
      ["ask_agent", createAskAgentTool({ run: pipeline.peerTurnRunner(), peers: (caller) => ["nouva", "nox"].filter((id) => id !== caller) })],
    ]),
  );
  pipeline.attach();
  return { pipeline, events, turns, db, auditLog, gateway };
}

describe("a helper's and a peer's steps", () => {
  test("are rows of the turn that started them, marked whose, each call its own id", async () => {
    const { rows, audit } = await delegatingTurn();
    const turnId = rows.find((row) => row.kind === "turn" && row.data.phase === "start")?.turnId;
    expect(turnId).toBeTruthy();
    // Every row is the one turn's, and what each writer wrote is what the contract says.
    expect(new Set(rows.map((row) => row.turnId))).toEqual(new Set([turnId!]));
    expect(rows.flatMap((row) => eventProblems(row.kind, row.data))).toEqual([]);

    const calls = rows.filter((row) => row.kind === "tool").map((row) => ({ name: row.data.name, via: row.data.via, by: row.data.by, text: row.data.text }));
    expect(calls).toEqual([
      { name: "delegate", via: undefined, by: undefined, text: expect.stringContaining("delegate") },
      { name: "probe", via: "delegate", by: "nouva", text: "↳ probe" },
      { name: "ask_agent", via: undefined, by: undefined, text: expect.stringContaining("ask_agent") },
      { name: "probe", via: "ask_agent", by: "nox", text: "[nox] probe" },
    ]);
    // What each of their requests carried (1.4) is the turn's too, marked whose as their steps are.
    const lines = rows.filter((row) => row.kind === "context").map((row) => [row.data.via, row.data.by]);
    expect(lines).toContainEqual([undefined, undefined]);
    expect(lines).toContainEqual(["delegate", "nouva"]);
    expect(lines).toContainEqual(["ask_agent", "nox"]);
    // The provider said `c1` four times; the stream pairs by id, so each call has one of its own — and its result and
    // its audit row carry the same one.
    const ids = rows.filter((row) => row.kind === "tool").map((row) => row.data.callId as string);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(rows.filter((row) => row.data.callId === id).map((row) => row.kind).sort()).toEqual(["tool", "tool_done"].concat(rows.some((row) => row.kind === "audit" && row.data.callId === id) ? ["audit"] : []).sort());
    }
    // The helper's and the peer's probes are audited — in the stream and in the audit log, under the turn.
    expect(rows.filter((row) => row.kind === "audit").map((row) => row.data.tool)).toEqual(["probe", "probe"]);
    expect(audit).toEqual([
      { turn_id: turnId!, agent_id: "nouva" },
      { turn_id: turnId!, agent_id: "nox" },
    ]);
    // Numbered on in the turn's own log.
    const steps = rows.filter((row) => typeof row.data.step === "number").map((row) => row.data.step as number);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBe(steps.length);
  });

  test("reach only who follows that conversation", async () => {
    const { rows, events } = await delegatingTurn();
    // Stamped with the conversation the turn is in — the peer's too, though it is another agent.
    expect(new Set(rows.map((row) => `${row.gatewayId}/${row.chatId}`)).size).toBe(1);
    const where = rows[0]!;
    expect(where.chatId).toBe("chat-1");
    expect(events.list({ chatId: "chat-2", gatewayId: where.gatewayId!, limit: 1_000 })).toEqual([]);
    expect(events.list({ chatId: "chat-1", gatewayId: "elsewhere:main", limit: 1_000 })).toEqual([]);
    expect(events.list({ chatId: "chat-1", gatewayId: where.gatewayId!, limit: 1_000 }).filter((row) => row.data.via === "ask_agent").length).toBeGreaterThan(0);
  });
});

describe("a scheduled job's turn", () => {
  const job = (session: "isolated" | "chat") =>
    ({
      id: "job_report",
      name: "report",
      agentId: "nouva",
      session,
      trigger: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "probe and report" },
      target: { gatewayId: "telegram:main", chatId: "chat-1" },
      delivery: { mode: "none" },
      enabled: true,
    }) as unknown as Job;

  test("is a turn of its own in the stream — its start, its steps, its end — in the conversation it runs in", async () => {
    const d = await daemon([{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "all probed" }]);
    const result = await d.pipeline.cronExecutors().runTurn({ job: job("isolated"), session: { gatewayId: "telegram:main", chatId: "cron:job_report" }, message: "probe and report", signal: new AbortController().signal });
    expect(result.text).toBe("all probed");

    const rows = d.events.list({ limit: 1_000 });
    expect(rows.flatMap((row) => eventProblems(row.kind, row.data))).toEqual([]);
    // A line per model request too (1.4): one before the call that asked for the probe, one before the answer.
    expect(rows.map((row) => row.kind).filter((kind) => kind !== "usage" && kind !== "reply")).toEqual(["turn", "context", "tool", "audit", "tool_done", "context", "turn"]);
    expect(rows[0]!.data).toMatchObject({ phase: "start", prompt: "probe and report" });
    expect(rows.findLast((row) => row.kind === "turn")!.data).toMatchObject({ phase: "end", status: "done", reply: "all probed", toolCalls: 1 });
    expect(new Set(rows.map((row) => `${row.gatewayId}/${row.chatId}`))).toEqual(new Set(["telegram:main/cron:job_report"]));
    // Its model calls are metered under it, and the record says the schedule started it.
    expect(rows.filter((row) => row.kind === "usage").every((row) => row.turnId === rows[0]!.turnId)).toBe(true);
    expect(d.turns.get(rows[0]!.turnId!)?.cause).toEqual({ via: "schedule", job: "job_report" });
  });

  test("a job kept in a chat's history runs in that chat, and nobody else's view has it", async () => {
    const d = await daemon([{ text: "reported" }]);
    await d.pipeline.cronExecutors().runTurn({ job: job("chat"), session: { gatewayId: "telegram:main", chatId: "chat-1" }, message: "report", signal: new AbortController().signal });
    expect(d.events.list({ chatId: "chat-1", gatewayId: "telegram:main", limit: 100 }).filter((row) => row.kind === "turn").map((row) => row.data.phase)).toEqual(["start", "end"]);
    expect(d.events.list({ chatId: "chat-2", gatewayId: "telegram:main", limit: 100 })).toEqual([]);
  });
});
