/**
 * The note a long run is given, read at a step boundary (`TurnRequest.harnessNote`, 0.7.25) — and its words, which are
 * behaviour too: what a delegate, the agent waiting on it and a chat turn are told when work runs long.
 */

import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatResponse, LLMProvider, Tool } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { delegateNote, leadNudgeText, nudgeBaseMs, replyNote, sinceSaid } from "@/modules/pipeline/budget-nudges.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const probe: Tool = {
  requiresApproval: false,
  definition: { name: "probe", description: "p", parameters: { type: "object", properties: {} } },
  async execute() {
    return { content: "checked", isError: false };
  },
};

/** A turn whose model asks for `script[n]` on its n-th call, with what each call was sent kept. */
async function run(script: number[], harnessNote: () => string | null, offered = 0) {
  const toolset = {
    definitions: [probe.definition],
    get: (name: string) => (name === "probe" ? probe : undefined),
    requiresApproval: () => false,
    parallelSafe: () => false,
    gate: () => ({ action: "run", via: "allowlist" }),
    blockedPatterns: [],
    backgroundHelpers: offered,
  } as unknown as AgentToolset;
  const sent: ChatMessage[][] = [];
  let asked = 0;
  const provider = {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    async chat(request: { messages: ChatMessage[] }): Promise<ChatResponse> {
      sent.push(structuredClone(request.messages));
      const calls = Array.from({ length: script[asked++] ?? 0 }, (_, i) => ({ id: `p${asked}_${i}`, name: "probe", arguments: { n: `${asked}_${i}` } }));
      return { text: calls.length ? "" : "done", toolCalls: calls, stopReason: calls.length ? "tool_calls" : "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } as ChatResponse;
    },
  } as unknown as LLMProvider;
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: false, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 8, maxTokensPerTurn: 4096 },
      context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
  });
  const result = await executor.run({
    agent: fakeAgent(),
    provider,
    toolset,
    history: [],
    userMessage: { role: "user", content: "check", timestamp: 1 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
    harnessNote,
  });
  const tools = (messages: ChatMessage[]) => messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  return { sent, tools, result };
}

/** A note handed out once, as `watchTurn` does: taken when read. */
function once(note: string) {
  let pending: string | null = note;
  let asked = 0;
  return {
    take: () => {
      asked += 1;
      const out = pending;
      pending = null;
      return out;
    },
    asked: () => asked,
  };
}

describe("in a real turn", () => {
  test("the note is on the last result of the round, read by the next call, once", async () => {
    const note = once("[harness] You have been on this for 5 min.");
    const r = await run([1, 1, 0], note.take);
    expect(r.tools(r.sent[1]!)).toEqual(["checked\n\n[harness] You have been on this for 5 min."]);
    // Taken, not repeated on the next round's result.
    expect(r.tools(r.sent[2]!).at(-1)).toBe("checked");
  });

  test("not in a round that already told the turn a helper could have the rest — it waits a round", async () => {
    // Eight calls in one round: the eighth result carries the long-turn helper note.
    const note = once("[harness] This reply has run 5 min.");
    const r = await run([8, 1, 0], note.take, 2);
    const first = r.tools(r.sent[1]!);
    expect(first.at(-1)).toContain("hand it to ONE helper in the background");
    expect(first.join("\n")).not.toContain("This reply has run");
    expect(r.tools(r.sent[2]!).at(-1)).toBe("checked\n\n[harness] This reply has run 5 min.");
  });

  test("a turn that ends with no further step is not asked for one it would never read", async () => {
    const note = once("[harness] unused");
    const r = await run([0], note.take);
    expect(note.asked()).toBe(0);
    expect(r.result.text).toBe("done");
  });
});

describe("the words", () => {
  test("a delegate is told how long, and what an honest stop says", () => {
    expect(delegateNote(5 * 60_000)).toBe(
      "[harness] You have been on this for 5 min. If you are stuck, or it will take much longer, stop now and report honestly: what is done, what is not, where it is stuck, what you would need.",
    );
  });

  test("a chat turn is asked for one line of status, and to stop if stuck", () => {
    const note = replyNote(10 * 60_000);
    expect(note).toStartWith("[harness] This reply has run 10 min. Send the person a one-line status if you have not recently");
    expect(note).toContain("a line written beside your next tool call reaches them");
    expect(note).toEndWith("if you are stuck, say so and stop.");
  });

  test("where the agent can hand the rest to a mission, the note says so, and that its notes and plan go with it (0.8.0)", () => {
    const note = replyNote(10 * 60_000, true);
    expect(note).toContain("If the rest will take much longer, hand it to a mission (`mission`, action start)");
    expect(note).toContain("this task's notes and plan go with it");
    expect(replyNote(10 * 60_000)).not.toContain("mission");
  });

  test("the agent waiting is told who, on what, how long — and that it can wait, tell, or stop it", () => {
    const text = leadNudgeText({ who: "nero", task: "delete the three datasets", ms: 10 * 60_000, job: "job_7" });
    expect(text).toStartWith('[still working, not finished] nero has been working on "delete the three datasets" for 10 min (job_7); it was asked to stop and report if it is stuck.');
    expect(text).toContain("You can wait, tell the person, or stop it with `nouride jobs kill job_7`.");
    expect(text).toContain("It has no result yet. Do not report one.");
    expect(text).toContain('reply with only "." (it is not sent)');
  });

  test("minutes as said, seconds under one, and the off positions", () => {
    expect(sinceSaid(20 * 60_000)).toBe("20 min");
    expect(sinceSaid(300)).toBe("1 s");
    expect(nudgeBaseMs(5)).toBe(300_000);
    expect(nudgeBaseMs(0)).toBe(0);
    expect(nudgeBaseMs(-1)).toBe(0);
    expect(nudgeBaseMs(Number.NaN)).toBe(0);
  });
});
