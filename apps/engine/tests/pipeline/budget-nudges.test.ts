/**
 * Long work is nudged, never stopped (0.7.25) — through the real pipeline, on a base of a fraction of a minute.
 *
 * A helper in the background is told before its next step to stop and report if it is stuck, and the agent that
 * started it is told in its chat how long it has run — at the base and at twice it. A chat turn somebody is waiting on
 * is asked for a one-line status. `[agents] nudge_after_minutes = 0` says nothing to anyone.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTextFileIfExists } from "@nouride/runtime";
import type { Tool } from "@nouride/shared";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { NUDGE_READ } from "@/modules/llm/executor/nudges.ts";
import { conversationOf, envelope, FakeGateway } from "../helpers.ts";
import { eventually, sleep } from "../wait.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

interface Said {
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}
type Body = { messages: { role: string; content: unknown }[]; stream?: boolean };
type Who = "parent" | "helper";

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
const whoAsks = (body: Body): Who => (textOf(body.messages[0]?.content).includes("You are a helper doing one piece of work") ? "helper" : "parent");
const lastUser = (body: Body): string => textOf(conversationOf(body.messages).filter((message) => message.role === "user").at(-1)?.content);
const toolResults = (body: Body): string[] => body.messages.filter((message) => message.role === "tool").map((message) => textOf(message.content));

/** The OpenAI wire, answered by who asks: streamed, or whole for a wrap-up. */
function provider(answer: (who: Who, body: Body) => Said | Promise<Said>) {
  const asked: { who: Who; body: Body }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const who = whoAsks(body);
    asked.push({ who, body });
    const said = await answer(who, body);
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    if (!body.stream) return Response.json({ model: "test-model", choices: [{ message: { content: said.text ?? "" }, finish_reason: "stop" }], usage });
    const events: string[] = [];
    if (said.text) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: said.text } }] })}\n\n`);
    for (const [index, call] of (said.toolCalls ?? []).entries()) {
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`);
    }
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: said.toolCalls?.length ? "tool_calls" : "stop" }], usage })}\n\n`, "data: [DONE]\n\n");
    return new Response(new ReadableStream({ start: (controller) => { for (const event of events) controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

const probe: Tool = {
  requiresApproval: false,
  definition: { name: "probe", description: "checks one thing", parameters: { type: "object", properties: {} } },
  async execute() {
    return { content: "checked", isError: false };
  },
};

const benches: Bench[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  for (const jobs of stores.splice(0)) await jobs.killAll();
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

/** 0.005 minutes: a nudge at 300 ms, then 600 ms, 1.2 s. */
const BASE_MINUTES = 0.005;

async function daemon(answer: (who: Who, body: Body) => Said | Promise<Said>, nudgeAfterMinutes = BASE_MINUTES) {
  const { fetchImpl, asked } = provider(answer);
  const gateway = new FakeGateway();
  let jobs!: JobStore;
  const bench = await pipelineBench({
    fetch: () => fetchImpl,
    gateway,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "probe"]\napproval_required = []\n',
    configure: (config) => {
      config.queue.steerReply = false;
      config.agents.nudgeAfterMinutes = nudgeAfterMinutes;
    },
    deps: ({ db, dataDir }) => {
      jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4 });
      return { jobs };
    },
  });
  benches.push(bench);
  stores.push(jobs);
  const tools = createBuiltinTools({ security: bench.config.security, runSubagent: bench.pipeline.subagentRunner(), startHelper: bench.pipeline.backgroundHelpers() });
  tools.set("probe", probe);
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  jobs.setOnComplete((completion) => bench.pipeline.wakeForJob(completion));
  return { bench, gateway, asked, jobs };
}

const brief = { goal: "Find why the datasets will not delete", context: "Three ZFS datasets on the lab box refuse `zfs destroy`.", deliverable: "What blocks it, and the fix." };
const LEAD_NUDGE = "has been working on";

describe("a helper in the background that runs long", () => {
  test("is told to stop and report if stuck, and the agent that started it hears so at the base and at twice it", async () => {
    const d = await daemon(async (who, body) => {
      if (who === "helper") {
        const results = toolResults(body);
        if (results.length === 0) return { toolCalls: [{ id: "h1", name: "probe", args: {} }] };
        if (results.length === 1) {
          // Held past the second nudge, as a long step would be; then one more step, whose result carries the note.
          await eventually(() => d.asked.filter((r) => r.who === "parent" && lastUser(r.body).includes(LEAD_NUDGE)).length >= 2, 4_000, "the parent's second nudge");
          return { toolCalls: [{ id: "h2", name: "probe", args: {} }] };
        }
        return { text: "Stuck: a snapshot holds them. Done: checked both. Not done: the destroy." };
      }
      if (!body.stream) return { text: "Siap, helper lagi ngecek." };
      if (lastUser(body).includes(LEAD_NUDGE)) return { text: "" };
      if (lastUser(body).includes("[System event")) return { text: "Hasil dari helper sudah datang." };
      return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief], background: true } }] };
    });

    d.gateway.receive(envelope({ id: "m1", text: "cek kenapa dataset gak bisa dihapus", timestamp: Date.now() }));
    await eventually(() => d.asked.some((r) => r.who === "helper" && toolResults(r.body).length === 2), 6_000, "the helper's step after the nudges");
    const [job] = d.jobs.listSnapshots({ limit: 5 }).filter((row) => row.kind === "helper");

    // The helper read the note on its last result before its next step — the newest one, once.
    const third = d.asked.find((r) => r.who === "helper" && toolResults(r.body).length === 2)!;
    const results = toolResults(third.body);
    expect(results[0]).toBe("checked");
    expect(results[1]).toStartWith("checked\n\n[harness] You have been on this for ");
    expect(results[1]).toContain("If you are stuck, or it will take much longer, stop now and report honestly: what is done, what is not, where it is stuck, what you would need.");

    // The parent was told twice, in its chat, which helper, on what, and how to stop it.
    const nudges = d.asked.filter((r) => r.who === "parent" && lastUser(r.body).includes(LEAD_NUDGE)).map((r) => lastUser(r.body));
    expect(nudges.length).toBeGreaterThanOrEqual(2);
    expect(nudges[0]).toContain(`Your background helper has been working on "Find why the datasets will not delete" for 1 s (${job!.id}); it was asked to stop and report if it is stuck.`);
    expect(nudges[0]).toContain(`stop it with \`nouride jobs kill ${job!.id}\``);
    // Nothing was stopped by it.
    await eventually(() => d.gateway.sent.some((message) => message.text === "Hasil dari helper sudah datang."), 4_000, "the helper's report");
    expect(d.jobs.get(job!.id)?.status).toBe("succeeded");
    // And its log says when it was nudged.
    expect(await readTextFileIfExists(job!.logPath)).toContain("asked to report if stuck");
    // Its own turn says when the note reached it — read before its next step, a step of the record (0.7.26): whether a
    // nudge reached a delegate is read, not inferred.
    const [handed] = new TurnInspector(d.bench.db).inspect(job!.turnId!)!.delegated ?? [];
    const read = new TurnInspector(d.bench.db).inspect(handed!.id)!.steps.filter((step) => step.text.startsWith(NUDGE_READ));
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ kind: "note" });
    expect(read[0]!.text).toMatch(/^read a nudge: You have been on this for \d+ (s|min)\.$/);
    // A reply of nothing to a nudge sends nothing.
    expect(d.gateway.sent.map((message) => message.text)).toEqual(["Siap, helper lagi ngecek.", "Hasil dari helper sudah datang."]);
  });
});

describe("a reply somebody is waiting on that runs long", () => {
  /** A turn that takes one step, holds its second past the first nudge, then answers. */
  async function longReply(nudgeAfterMinutes?: number) {
    const d = await daemon(async (_who, body) => {
      const results = toolResults(body);
      if (results.length === 0) return { toolCalls: [{ id: "p1", name: "probe", args: {} }] };
      if (results.length === 1) {
        await sleep(450);
        return { toolCalls: [{ id: "p2", name: "probe", args: {} }] };
      }
      return { text: "Selesai." };
    }, nudgeAfterMinutes);
    d.gateway.receive(envelope({ id: "m1", text: "cek dua hal", timestamp: Date.now() }));
    await eventually(() => d.gateway.sent.some((message) => message.text === "Selesai."), 6_000, "the answer");
    const [turn] = d.bench.turns.forChat("telegram:main", "chat-1");
    return { results: toolResults(d.asked.find((r) => toolResults(r.body).length === 2)!.body), steps: turn!.steps.map((step) => step.text) };
  }

  test("is asked for a one-line status, on the result its next step reads — and the turn's record says it read it", async () => {
    const { results, steps } = await longReply();
    expect(results[0]).toBe("checked");
    expect(results[1]).toStartWith("checked\n\n[harness] This reply has run ");
    expect(results[1]).toContain("Send the person a one-line status if you have not recently");
    expect(steps.filter((text) => text.startsWith(NUDGE_READ))).toEqual([expect.stringMatching(/^read a nudge: This reply has run \d+ (s|min)\.$/)]);
  });

  test("with `nudge_after_minutes = 0`, nobody is told anything", async () => {
    const { results, steps } = await longReply(0);
    expect(results).toEqual(["checked", "checked"]);
    expect(steps.filter((text) => text.startsWith(NUDGE_READ))).toEqual([]);
  });
});
