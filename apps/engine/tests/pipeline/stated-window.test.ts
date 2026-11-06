/**
 * A gateway's stated context window reaching a turn through the daemon as it is wired (G2): the provider registry's
 * listing (`llm/catalog.ts`), read for the agent's own profile by the pipeline. The decision itself is in
 * `tests/llm/stated-window.test.ts`; this is the path.
 */

import { afterEach, expect, test } from "bun:test";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => {
  bench?.dispose();
  bench = undefined;
});

test("the first turn on a model the table does not know is budgeted at 32k and asks the gateway; the next one at what it says", async () => {
  bench = await pipelineBench({
    turns: [{ text: "first" }, { text: "second" }],
    // `test-model` is in no family the table knows.
    models: [{ id: "test-model", context_window: 1_000_000 }],
    configure: (config) => {
      config.llm.context.truncationStrategy = "sliding_window";
    },
  });
  bench.pipeline.attach();
  const history = Array.from({ length: 60 }, (_, n) => [
    { role: "user" as const, content: `question ${n} ${"x".repeat(2_000)}`, timestamp: n },
    { role: "assistant" as const, content: `answer ${n} ${"y".repeat(2_000)}`, timestamp: n },
  ]).flat();
  const first = envelope({ text: "and now?", timestamp: Date.now() });
  bench.sessions.save({ agentId: "nouva", gatewayId: first.gatewayId, chatId: first.chatId }, history, 30_000);

  bench.gateway.receive(first);
  await bench.pipeline.idle();
  bench.gateway.receive(envelope({ id: "m2", text: "and then?", timestamp: Date.now() }));
  await bench.pipeline.idle();

  const carried = (bench.requests as { messages: unknown[] }[]).map((request) => request.messages.length);
  // The first, cut to fit 32k; the second, the whole conversation and both questions.
  expect(carried[0]!).toBeLessThan(60);
  expect(carried[1]!).toBeGreaterThan(120);
});
