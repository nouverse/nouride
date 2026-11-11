/**
 * The bubble in a chat while the model writes a tool call, through the real pipeline.
 *
 * Found in a person's Telegram chat: after a step, the model said a few words and then wrote a long command to run
 * (a script, half a minute of arguments). The bubble read "writing a reply" all that time, and then ran another
 * step. The words before a call were taken for the answer; what the model was writing was the call.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Tool } from "@nouride/shared";
import { AutoApprovalGate, envelope, eventually, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

const look: Tool = {
  requiresApproval: false,
  definition: { name: "look", description: "looks", parameters: { type: "object", properties: {} } },
  async execute() {
    return { content: "seen", isError: false };
  },
};

/** A room of one agent whose second model request is answered by `second`, a stream the test holds open. */
async function held(second: (say: (event: unknown) => void, letGo: Promise<void>) => Promise<void>) {
  const encoder = new TextEncoder();
  let finish = () => {};
  const letGo = new Promise<void>((resolve) => (finish = resolve));
  let asked = 0;
  const gateway = new FakeGateway("telegram:nouva");
  const bench = await pipelineBench({
    // The first request calls a tool; the third is the answer. The second is the held one.
    turns: [{ toolCalls: [{ id: "c1", name: "look", args: {} }] }, { text: "unused" }, { text: "Here is the chart." }],
    maxAttempts: 1,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["look"]\n',
    fetch: (scripted) =>
      (async (url: string, init?: RequestInit) => {
        if (init?.method !== "POST" || (asked += 1) !== 2) return scripted(url, init);
        // Counted by the script too, so the third request gets the third answer.
        void scripted(url, init);
        const stream = new ReadableStream({
          async start(controller) {
            await second((event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)), letGo);
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch,
    gateway,
    deps: () => ({ approvals: new AutoApprovalGate(), progressIntervalMs: 1, progressQuietMs: 20 }),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map([["look", look]]));
  bench.pipeline.attach();
  const last = () => gateway.edits.at(-1)?.text ?? "";
  gateway.receive(envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", text: "draw the downloads", timestamp: Date.now() }));
  return { bench, gateway, last, finish };
}

const words = { choices: [{ delta: { content: "Let me draw it. " } }] };
const callOf = (args: string, first = true) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: "c2", function: { name: "look", arguments: args } } : { function: { arguments: args } }) }] } }] });
const ends = { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };

describe("the bubble while the model writes a call", () => {
  test("its arguments arriving piece by piece: it is preparing the next step", async () => {
    const h = await held(async (say, letGo) => {
      say(words);
      say(callOf(""));
      say(callOf("{", false));
      await letGo;
      say(callOf("}", false));
      say(ends);
    });
    await eventually(() => h.last().includes("preparing the next step"), 4_000, "the bubble saying a step is being prepared");
    h.finish();
    await h.bench.pipeline.idle();
    expect(h.gateway.sent.at(-1)?.text).toBe("Here is the chart.");
  });

  test("a few words, then nothing until the call comes whole: it is thinking, not writing a reply", async () => {
    const h = await held(async (say, letGo) => {
      say(words);
      await letGo;
      say(callOf("{}"));
      say(ends);
    });
    // Whatever it said in the moment the words came, it settles on thinking and stays there while nothing arrives.
    await eventually(() => h.last().includes("thinking"), 4_000, "the bubble saying the model is thinking");
    await eventually(() => /thinking… [1-9]/.test(h.last()), 6_000, "the bubble still saying so a second later");
    expect(h.last()).not.toContain("writing a reply");
    h.finish();
    await h.bench.pipeline.idle();
    expect(h.gateway.sent.at(-1)?.text).toBe("Here is the chart.");
  });
});
