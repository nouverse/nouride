/**
 * An approval asked in a turn a restart cut off is still there to answer after it, and its answer runs the call.
 *
 * Through two real pipelines on one database, wired as the daemon wires them: the first asks and is stopped as a
 * shutdown stops it (`stopTurns`, then `handOver`), or as a crash leaves it (no hand-over); the second boots as the
 * daemon boots (`carryOver`, the kept question asked again once the gateways are up, then the turn taken up) — and the
 * person's one answer runs the call, in the turn taken up, without a second question.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SqliteDb } from "@nouride/runtime";
import type { Tool } from "@nouride/shared";
import { askKeptApprovals, lapsedNotice } from "@/boot/approvals-kept.ts";
import { resumeAfterBoot } from "@/boot/durable.ts";
import { stopTurns } from "@/boot/interrupted.ts";
import { Notifier, approvalPrompt } from "@/commons/notify.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { envelope, eventually, type FakeGateway, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench, type Bench, type RebootOptions } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});


/** A call that needs a person's yes, every time — and counts the times it ran. */
function probe(runs: { count: number }): Tool {
  return {
    requiresApproval: true,
    definition: { name: "probe", description: "touches the box", parameters: { type: "object", properties: { target: { type: "string" } } } },
    gate: () => ({ action: "ask", grantable: false, reason: "it touches the box" }),
    execute: async () => {
      runs.count += 1;
      return { content: "probed", isError: false };
    },
  };
}

/**
 * One process: its gate, its pipeline and its connection — the first over a new install, each after it over the same
 * one (`reboot`).
 */
async function boot(previous: Bench | null, turns: Parameters<typeof scriptedOpenAI>[0], runs: { count: number }) {
  let notifier!: Notifier;
  let approvals!: SqliteApprovalGate;
  const options: RebootOptions = {
    turns,
    deps: ({ db, gateways }) => {
      notifier = new Notifier({ gateways });
      // The daemon's `onRequest`, as `index.ts` has it: the prompt into the conversation it belongs to.
      approvals = new SqliteApprovalGate({
        db,
        timeoutMs: 300_000,
        onRequest: (notice) => void notifier.toChat({ gatewayId: notice.gatewayId, chatId: notice.request.chatId }, approvalPrompt(notice)),
        onLateAnswer: (request, decision, by) => void bench.pipeline.resumeAfterApproval(request, decision, by),
      });
      cleanup.push(() => approvals.shutDown());
      return { approvals };
    },
  };
  const bench: Bench = previous
    ? await previous.reboot(options)
    : await pipelineBench({ ...options, agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\n', config: { security: { approvals: "careful" } } });
  if (!previous) cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map([["probe", probe(runs)]]));
  bench.pipeline.attach();
  return { bench, pipeline: bench.pipeline, approvals, gateway: bench.gateway, notifier, durable: bench.durable, turns: bench.turns, requests: bench.requests, db: bench.db };
}

const prompts = (gateway: FakeGateway) => gateway.sent.filter((msg) => msg.text.includes("is waiting on you") || msg.text.includes("still waiting on you"));
const rows = (db: SqliteDb) => db.prepare<{ id: string; status: string }>("SELECT id, status FROM approvals").all();

describe("an approval across a restart", () => {
  test("is asked again after it, and the turn taken up waits on it: one answer, and the call runs once", async () => {
    const runs = { count: 0 };

    // The first process: the turn asks, and is parked on the person's answer.
    const first = await boot(null, [{ toolCalls: [{ id: "c1", name: "probe", args: { target: "db" } }] }], runs);
    first.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "probe the db", timestamp: Date.now() }));
    await eventually(() => prompts(first.gateway).length === 1, 3_000);

    // Its shutdown, in the daemon's order: the turn stopped and closed, the question handed over, not expired.
    await stopTurns({ pipeline: first.pipeline, pauseMs: 30, abortMs: 2_000 });
    expect(first.approvals.handOver()).toBe(1);
    first.approvals.shutDown();
    expect(rows(first.db).map((row) => row.status)).toEqual(["pending"]);

    // The next process: the question kept, asked again once the gateways are up, then the turn taken up.
    const second = await boot(first.bench, [{ toolCalls: [{ id: "c2", name: "probe", args: { target: "db" } }] }, { text: "Probed the db." }], runs);
    const { kept, lapsed } = second.approvals.carryOver();
    expect(lapsed).toEqual([]);
    askKeptApprovals({ approvals: second.approvals, kept, lapsed, notifier: second.notifier, voice: (_agent, gatewayId) => gatewayId });
    expect(prompts(second.gateway).map((msg) => msg.text.split("\n")[0])).toEqual([
      "⏸ **nouva** is still waiting on you before running **probe**. It was asked before the daemon restarted, and is still open.",
    ]);
    const resumedFrom = second.bench.events.latest();
    await resumeAfterBoot({
      recovered: [],
      orphaned: [],
      stores: second.durable,
      startedAt: Date.now(),
      pipeline: second.pipeline,
      turns: second.turns,
      notifier: second.notifier,
      chatEvents: { record: () => null },
      keptFor: (turn) => second.approvals.keptFor(turn),
    });

    // The turn taken up was told its question is still open, makes the same call, and waits on that question.
    await eventually(() => second.requests.length === 1, 3_000);
    expect(JSON.stringify(second.requests[0])).toContain("is still open, and has been put in front of them again");
    // Parked on it: a `waiting` step of its own names the kept question — and nothing has run, nor been asked a second
    // time. The first process's step named it too, so only what this one wrote counts.
    const waitsOnKept = () => second.bench.events.list({ since: resumedFrom, limit: 1_000 }).some((row) => row.kind === "waiting" && row.data.approvalId === kept[0]!.id);
    await eventually(waitsOnKept, 3_000, "the call waiting on the kept question");
    expect(prompts(second.gateway)).toHaveLength(1);
    expect(runs.count).toBe(0);

    expect(second.approvals.resolve(kept[0]!.id, "allow-once", "user-1")).toBe(true);
    await eventually(() => second.gateway.sent.some((msg) => msg.text === "Probed the db."), 3_000);
    await second.pipeline.idle();
    expect(runs.count).toBe(1);
    expect(rows(first.db).map((row) => row.status)).toEqual(["approved"]);
    // One question in the chat after the restart, however it was answered.
    expect(prompts(second.gateway)).toHaveLength(1);
  });

  test("one too old to keep is expired at boot, and its chat is told in words — nothing ran", async () => {
    const runs = { count: 0 };
    const first = await boot(null, [{ toolCalls: [{ id: "c1", name: "probe", args: { target: "db" } }] }], runs);
    first.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "probe the db", timestamp: Date.now() }));
    await eventually(() => prompts(first.gateway).length === 1, 3_000);
    await stopTurns({ pipeline: first.pipeline, pauseMs: 30, abortMs: 2_000 });
    first.approvals.handOver();
    first.approvals.shutDown();
    // Asked four minutes and forty seconds ago, of a five-minute window.
    first.db.prepare("UPDATE approvals SET requested_at = requested_at - 280000").run();

    const second = await boot(first.bench, [{ text: "unused" }], runs);
    const { kept, lapsed } = second.approvals.carryOver();
    expect(kept).toEqual([]);
    const notes: string[] = [];
    askKeptApprovals({ approvals: second.approvals, kept, lapsed, notifier: second.notifier, chatEvents: { record: (event) => (notes.push(event.text), null) }, voice: (_agent, gatewayId) => gatewayId });
    await eventually(() => second.gateway.sent.length === 1, 3_000);

    expect(second.gateway.sent[0]).toMatchObject({ chatId: "chat-1", text: lapsedNotice(lapsed[0]!) });
    expect(second.gateway.sent[0]!.text).toContain("expired and nothing ran");
    expect(notes).toEqual([lapsedNotice(lapsed[0]!)]);
    expect(rows(first.db).map((row) => row.status)).toEqual(["expired"]);
    expect(runs.count).toBe(0);
  });

  test("after a crash, in a room: the person who asked still answers it, and the call runs once on that answer", async () => {
    const runs = { count: 0 };
    // In a room as a platform delivers it: from the person who asks, addressed to the agent by a tag.
    const inRoom = (id: string, text: string) => envelope({ id, chatType: "group", chatId: "room-1", senderId: "user-1", mentions: ["nouva"], text, timestamp: Date.now() });

    const first = await boot(null, [{ toolCalls: [{ id: "c1", name: "probe", args: { target: "db" } }] }], runs);
    first.gateway.receive(inRoom("m1", "probe the db"));
    await eventually(() => prompts(first.gateway).length === 1, 3_000);

    // A crash: nothing hands the question over. Its turn and the gate's clocks are stopped only so this process does not
    // run on into the next one, and neither writes what a crash would not have left.
    await stopTurns({ pipeline: first.pipeline, pauseMs: 30, abortMs: 2_000 });
    first.approvals.shutDown();

    const second = await boot(first.bench, [{ toolCalls: [{ id: "c2", name: "probe", args: { target: "db" } }] }, { text: "Probed the db." }], runs);
    const { kept, lapsed } = second.approvals.carryOver();
    expect(lapsed).toEqual([]);
    askKeptApprovals({ approvals: second.approvals, kept, lapsed, notifier: second.notifier, voice: (_agent, gatewayId) => gatewayId });
    const resumedFrom = second.bench.events.latest();
    await resumeAfterBoot({
      recovered: [],
      orphaned: [],
      stores: second.durable,
      startedAt: Date.now(),
      pipeline: second.pipeline,
      turns: second.turns,
      notifier: second.notifier,
      chatEvents: { record: () => null },
      keptFor: (turn) => second.approvals.keptFor(turn),
    });
    // The turn taken up asks as the daemon, not as the person: who asked has to come from the question's own row.
    const waitsOnKept = () => second.bench.events.list({ since: resumedFrom, limit: 1_000 }).some((row) => row.kind === "waiting" && row.data.approvalId === kept[0]!.id);
    await eventually(waitsOnKept, 3_000, "the call waiting on the kept question");

    // In a room only the person who asked, or an admin, answers: here nobody is an admin.
    second.gateway.receive(inRoom("m2", "/approve"));
    await eventually(() => second.gateway.sent.some((msg) => msg.text === "Probed the db."), 3_000, "the call run on the asker's answer");
    await second.pipeline.idle();
    expect(runs.count).toBe(1);
    expect(rows(first.db).map((row) => row.status)).toEqual(["approved"]);
  });
});
