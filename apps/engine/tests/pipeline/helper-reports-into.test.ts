/**
 * A helper's tool calls are told the kind of chat its report is kept in (`ToolContext.reportsInto`), through the real
 * pipeline: its own turn is built as a direct chat's, so a helper started from a group read memory as a direct chat
 * with the one speaking does, and its report left what it found in the group's conversation.
 */

import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Tool, ToolContext } from "@nouride/shared";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { conversationOf, envelope as envelopeAt } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

/** A message of now: one older than the daemon is not answered. */
const envelope = (overrides: Parameters<typeof envelopeAt>[0] = {}) => envelopeAt({ timestamp: Date.now(), ...overrides });

const benches: Bench[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  for (const jobs of stores.splice(0)) await jobs.killAll();
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

type Body = { messages: { role: string; content: unknown }[]; stream?: boolean };
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "");
const isHelper = (body: Body) => textOf(body.messages[0]?.content).includes("You are a helper doing one piece of work");
const toolResults = (body: Body) => conversationOf(body.messages).filter((message) => message.role === "tool").length;

/** The model: the parent delegates once and then answers; the helper calls `probe` once and then reports. */
const model = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as Body;
  const done = toolResults(body) > 0;
  const call = isHelper(body) ? { id: "p1", name: "probe", args: {} } : { id: "d1", name: "delegate", args: { tasks: [{ goal: "Check one thing.", context: "Nothing else.", constraints: "Read only.", deliverable: "One line." }] } };
  const usage = { prompt_tokens: 10, completion_tokens: 5 };
  if (!body.stream) return Response.json({ model: "test-model", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage });
  const events = done
    ? [`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." } }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n`]
    : [`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`, `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage })}\n\n`];
  return new Response(new ReadableStream({ start: (controller) => { for (const event of [...events, "data: [DONE]\n\n"]) controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
}) as unknown as typeof fetch;

async function daemon() {
  const seen: ToolContext[] = [];
  const probe: Tool = {
    requiresApproval: false,
    definition: { name: "probe", description: "checks one thing", parameters: { type: "object", properties: {} } },
    async execute(_args, ctx) {
      seen.push(ctx);
      return { content: "checked", isError: false };
    },
  };
  let jobs!: JobStore;
  const bench = await pipelineBench({
    fetch: () => model,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "probe"]\napproval_required = []\n',
    configure: (config) => {
      config.queue.steerReply = false;
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
  return { bench, seen };
}

test("a helper started from a group is told it reports into a group, and one from a direct chat into a direct chat", async () => {
  const { bench, seen } = await daemon();

  bench.gateway.receive(envelope({ id: "g1", chatType: "group", chatId: "-100200", text: "nouva: check one thing" }));
  await bench.pipeline.idle();
  expect(seen).toHaveLength(1);
  // Its own turn is a direct chat's, in the group's chat, for the one who spoke: read alone, that is a direct chat with them.
  expect(seen[0]).toMatchObject({ chatType: "dm", chatId: "-100200", senderId: "user-1", reportsInto: "group" });

  bench.gateway.receive(envelope({ id: "m1", text: "check one thing" }));
  await bench.pipeline.idle();
  expect(seen).toHaveLength(2);
  expect(seen[1]).toMatchObject({ chatType: "dm", chatId: "chat-1", reportsInto: "dm" });
});
