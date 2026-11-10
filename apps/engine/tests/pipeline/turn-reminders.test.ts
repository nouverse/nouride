/**
 * Reminders for one turn: sent after the message, and kept as sent.
 *
 * A line after the question holds where the harness, read at the top of a long prompt, loses. It used
 * to be sent and not kept — and the message stored differently from the one sent is the byte at which
 * the next turn's prompt cache stopped (2026-10-15). The nightly pass reads the turn records, not
 * the session, so nothing a person said is mistaken for it; `llm/executor/reminders.ts` has the rest.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatParams, LLMProvider } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { messageText } from "@nouride/shared";
import { turnReminders } from "@/modules/pipeline/messages.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const emptyToolset = (): AgentToolset => ({
  definitions: [],
  get: () => undefined,
  requiresApproval: () => false,
  parallelSafe: () => false,
  gate: () => ({ action: "run", via: "allowlist" }),
  blockedPatterns: [],
});

const search = [{ name: "web_search" }, { name: "nouride" }];

describe("which reminders a message gets", () => {
  test("a question about something recent is told to search first", () => {
    const [note] = turnReminders("harga emas hari ini berapa?", search);
    expect(note).toContain("check with `web_search`");
    expect(turnReminders("what's the latest Bun release?", search)).toHaveLength(1);
  });

  test("a question naming Nouride gets none: the harness sends that to the `nouride` tool, not the web", () => {
    expect(turnReminders("menurut lu di nouride ini solid ga system memorynya?", search)).toEqual([]);
    expect(turnReminders("rilis nouride terbaru apa?", search)).toEqual([]);
  });

  test("an ordinary question gets none, and an agent without web_search is not pointed at it", () => {
    expect(turnReminders("what should I cook tonight?", search)).toEqual([]);
    expect(turnReminders("harga emas hari ini?", [{ name: "read" }])).toEqual([]);
  });
});

describe("what is running now, said on the message", () => {
  const load = (background: number, missions?: number) => ({ background: { running: background, limit: 4 }, ...(missions === undefined ? {} : { missions: { running: missions, atOnce: 2 } }) });

  test("this agent's helpers and asks in the background and the box's missions, each against what may run", () => {
    expect(turnReminders("hello", [], undefined, load(2, 1))).toEqual(["(Running now: 2 of the 4 helpers and asks you may have in the background; 1 of the 2 missions this machine runs at once.)"]);
  });

  test("only what is running is said, and nothing at all when nothing is", () => {
    expect(turnReminders("hello", [], undefined, load(1, 0))).toEqual(["(Running now: 1 of the 4 helpers and asks you may have in the background.)"]);
    expect(turnReminders("hello", [], undefined, load(0, 2))).toEqual(["(Running now: 2 of the 2 missions this machine runs at once.)"]);
    expect(turnReminders("hello", [], undefined, load(0, 0))).toEqual([]);
    expect(turnReminders("hello", [], undefined, load(0))).toEqual([]);
    expect(turnReminders("hello", [])).toEqual([]);
  });

  test("after the other notes of the turn, so it is the last thing read", () => {
    const notes = turnReminders("harga emas hari ini?", search, { running: [{ id: "job_1", goal: "Check the links", startedAt: 0 }], now: 60_000 }, load(1));
    expect(notes).toHaveLength(3);
    expect(notes.at(-1)).toStartWith("(Running now: ");
  });
});

/** A provider that records every request and answers each with the same short reply. */
function recording() {
  const calls: ChatParams[] = [];
  const provider = {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat(params: ChatParams) {
      // Everything but the retry callback, which is a function and not part of what was sent.
      const { onRetry: _onRetry, ...sent } = params;
      calls.push(structuredClone(sent));
      return { text: "ok", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "gpt-4" };
    },
    stream() {
      throw new Error("streaming is disabled in this test");
    },
  } as unknown as LLMProvider;
  return { calls, provider };
}

function executorFor(): TurnExecutor {
  return new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 4, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 4, compactAtRatio: 0.8, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
  });
}

function turn(provider: LLMProvider, text: string, history: ChatMessage[], reminders?: string[]) {
  const agent = fakeAgent();
  agent.config.llm = { provider: "test", model: "gpt-4", maxTokens: 128, temperature: 0.7 };
  return executorFor().run({
    agent,
    provider,
    toolset: emptyToolset(),
    history,
    userMessage: { role: "user", content: text, timestamp: Date.now() },
    ...(reminders ? { reminders } : {}),
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "session-1",
    senderId: "user-1",
  });
}

describe("a reminder is sent, and kept as it was sent", () => {
  test("the model reads it after the message, and the session keeps exactly that message", async () => {
    const { calls, provider } = recording();
    const result = await turn(provider, "is nouride solid?", [], ["(check first)"]);

    const sent = calls[0]!.messages.findLast((m) => m.role === "user")!;
    // The time rides on the message too, ahead of the reminders: kept out of the system prompt so the
    // conversation behind it stays cached (`clockNote`).
    expect(messageText(sent.content)).toMatch(/^is nouride solid\?\n\n\(Sent \d{4}-\d\d-\d\d \d\d:\d\d UTC\.\)\n\n\(check first\)$/);
    expect(result.turnMessages[0]).toEqual(sent);
  });

  test("so the next turn's request begins with this one's, byte for byte — what a prefix cache needs", async () => {
    const { calls, provider } = recording();
    const first = await turn(provider, "is nouride solid?", [], ["(check first)"]);
    await turn(provider, "and the memory?", first.messages);

    // Stored without its note, the first message differed here and the cache stopped at it: every
    // token turn one added was written to the cache again on turn two.
    const before = calls[0]!.messages;
    expect(JSON.stringify(calls[1]!.messages.slice(0, before.length))).toBe(JSON.stringify(before));
  });
});
