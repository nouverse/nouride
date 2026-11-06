/**
 * A skill written or revised by reflection is asked for at the model's own output cap, and an answer cut at it is said
 * to be cut. Live (2026-10-21): a 17KB skill revised by Claude Sonnet stopped at exactly the flat 8,000 tokens and was
 * logged as "reflection revision did not answer with JSON".
 */

import { expect, test } from "bun:test";
import { addLogSink, type ChatParams, type ChatResponse, type LLMProvider } from "@nouride/shared";
import { synthesizeSkill, type SynthesisInput } from "@/modules/reflection/synthesis.ts";

function input(model: string, answers: Partial<ChatResponse>[]): { input: SynthesisInput; asked: ChatParams[] } {
  const asked: ChatParams[] = [];
  const provider = {
    name: "fake",
    chat: async (params: ChatParams) => {
      asked.push(params);
      const next = answers.shift() ?? { text: "" };
      return { text: "", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, ...next } as ChatResponse;
    },
  } as unknown as LLMProvider;
  return {
    asked,
    input: {
      provider,
      model,
      transcript: "user: fix the proxmox note\nassistant: done",
      trigger: { kind: "first_integration", reason: "a first integration" } as SynthesisInput["trigger"],
      existing: [{ name: "infrastructure-ops", description: "Operating the homelab", owner: "agent", bytes: 17_024 }],
      readSkill: async () => "# Infrastructure ops\n",
      readSkillFile: async () => null,
    },
  };
}

const TRIAGE_UPDATE = { text: JSON.stringify({ decision: "update", target: "infrastructure-ops", why: "a new host" }) };

test("the revision is asked for at the model's own cap; triage keeps its small one", async () => {
  const sonnet = input("claudecode:claude-sonnet-5-5", [TRIAGE_UPDATE, { text: "{}" }]);
  await synthesizeSkill(sonnet.input);
  expect(sonnet.asked.map((params) => params.maxTokens)).toEqual([1400, 32_000]);

  const unknown = input("some-unknown-model", [TRIAGE_UPDATE, { text: "{}" }]);
  await synthesizeSkill(unknown.input);
  expect(unknown.asked[1]?.maxTokens).toBe(8192);
});

test("an answer cut at the output limit is said to be cut — not that it did not answer with JSON", async () => {
  // Sinks cannot be removed, so this one listens only while the test does.
  const lines: string[] = [];
  let listening = true;
  addLogSink((entry) => void (listening && lines.push(entry.message)));
  try {
    const cut = input("claudecode:claude-sonnet-5-5", [TRIAGE_UPDATE, { text: '```json\n{ "description": "Operational rules', cutAtLimit: true, stopReason: "max_tokens" }]);
    expect(await synthesizeSkill(cut.input)).toBeNull();
  } finally {
    listening = false;
  }
  expect(lines).toContain("reflection answer was cut at the output limit: no draft from this turn");
  expect(lines).not.toContain("reflection revision did not answer with JSON");
});
