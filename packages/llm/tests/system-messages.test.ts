/**
 * A `system` message in the conversation, on the Messages API — which has no system role (`withSystemMessages`).
 *
 * `toWireMessages` leaves them out on the promise that the request's `system` field carries them, and it did not: the
 * reflection pass's triage instruction, sent that way, reached the model as nothing, and it answered the transcript in
 * prose — six times on the live box the first day the agents ran on an Anthropic profile (2026-10-22).
 */

import { expect, test } from "bun:test";
import { AnthropicProvider } from "../src/anthropic.ts";
import { fakeFetch, jsonResponse, noSleep } from "./helpers.ts";

const answer = () => jsonResponse({ id: "m", model: "c", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });

test("reaches the system field, after the system prompt — and is not a message", async () => {
  const fetcher = fakeFetch(() => answer());
  const provider = new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });

  await provider.chat({
    model: "m",
    messages: [
      { role: "system", content: "Answer with JSON only.", timestamp: 1 },
      { role: "user", content: "the transcript", timestamp: 2 },
    ],
  });
  expect(fetcher.last().body.system).toBe("Answer with JSON only.");
  expect(fetcher.last().body.messages).toHaveLength(1);

  await provider.chat({
    model: "m",
    system: [{ text: "You are Nouva.", cache: true }, { text: "Today: Thursday." }],
    messages: [
      { role: "system", content: "Answer with JSON only.", timestamp: 1 },
      { role: "user", content: "the transcript", timestamp: 2 },
    ],
  });
  const blocks = fetcher.last().body.system as { text: string; cache_control?: unknown }[];
  expect(blocks.map((block) => block.text)).toEqual(["You are Nouva.", "Today: Thursday.", "Answer with JSON only."]);
  // The system prompt's own cache marker stays where it was.
  expect(blocks[0]!.cache_control).toBeDefined();
});

test("a conversation with no system message sends the system prompt as it was", async () => {
  const fetcher = fakeFetch(() => answer());
  const provider = new AnthropicProvider({ baseUrl: "https://gw.test/v1", apiKey: "k", http: { fetchImpl: fetcher.fn, sleep: noSleep } });
  await provider.chat({ model: "m", system: "You are Nouva.", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  expect(fetcher.last().body.system).toBe("You are Nouva.");
});
