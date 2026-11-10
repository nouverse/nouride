import { messageText } from "@nouride/shared";
import { describe, expect, test } from "bun:test";
import { estimateMessagesTokens } from "@nouride/llm";
import type { ChatMessage } from "@nouride/shared";
import {
  compactionThreshold,
  conversationBudget,
  groupTurns,
  isTrimmedToolResult,
  pruneToolOutputs,
  resolveCompactionLimit,
  trimToolResults,
  truncateContext,
  TRIMMED_TOOL_PREFIX,
} from "@/modules/llm/context.ts";

function turn(user: string, assistant: string): ChatMessage[] {
  return [
    { role: "user", content: user },
    { role: "assistant", content: assistant },
  ];
}

/** A turn with a tool round-trip in it — the shape truncation must never split. */
function toolTurn(id: string): ChatMessage[] {
  return [
    { role: "user", content: "read the file" },
    { role: "assistant", content: "", toolCalls: [{ id, name: "read", arguments: { path: "a" } }] },
    { role: "tool", content: "file contents", toolCallId: id },
    { role: "assistant", content: "here it is" },
  ];
}

describe("groupTurns", () => {
  test("starts a new turn at each user message", () => {
    const turns = groupTurns([...turn("one", "1"), ...turn("two", "2")]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.[0]?.content).toBe("one");
  });

  test("keeps a tool round-trip inside its turn", () => {
    const turns = groupTurns(toolTurn("c1"));
    expect(turns).toHaveLength(1);
    expect(turns[0]).toHaveLength(4);
  });

  test("groups leading assistant messages with no user message", () => {
    // A cron-initiated turn has no user message; it still has to be a group.
    const turns = groupTurns([
      { role: "assistant", content: "scheduled check" },
      { role: "user", content: "thanks" },
    ]);
    expect(turns).toHaveLength(2);
  });

  test("returns nothing for an empty conversation", () => {
    expect(groupTurns([])).toEqual([]);
  });
});

describe("truncateContext", () => {
  test("leaves a conversation inside budget untouched", () => {
    const messages = turn("hi", "hello");
    const result = truncateContext(messages, { maxTokens: 10_000, preserveRecentTurns: 4 });

    expect(result.truncated).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(result.dropped).toEqual([]);
  });

  test("drops the oldest turns first", () => {
    const messages = [
      ...turn("oldest", "a".repeat(400)),
      ...turn("middle", "b".repeat(400)),
      ...turn("newest", "c".repeat(400)),
    ];

    const result = truncateContext(messages, { maxTokens: 250, preserveRecentTurns: 1 });

    expect(result.truncated).toBe(true);
    expect(result.messages[0]?.content).not.toBe("oldest");
    expect(result.dropped[0]?.content).toBe("oldest");
  });

  test("never splits a turn, so a tool result keeps its tool call", () => {
    // The failure this prevents: Anthropic rejects a tool_result whose tool_use was trimmed
    // away, so a mid-turn cut turns a long conversation into a hard error.
    const messages = [...turn("filler", "x".repeat(2000)), ...toolTurn("c1")];

    const result = truncateContext(messages, { maxTokens: 60, preserveRecentTurns: 1 });

    const toolMessages = result.messages.filter((m) => m.role === "tool");
    for (const toolMessage of toolMessages) {
      const hasCall = result.messages.some((m) =>
        m.toolCalls?.some((call) => call.id === toolMessage.toolCallId),
      );
      expect(hasCall).toBe(true);
    }
  });

  test("keeps the preserved tail even when it alone exceeds the budget", () => {
    // Better to overshoot and get a provider error naming the cause than to send an agent
    // into a conversation with no history at all.
    const messages = [...turn("old", "o".repeat(400)), ...turn("recent", "r".repeat(4000))];

    const result = truncateContext(messages, { maxTokens: 50, preserveRecentTurns: 1 });

    expect(result.messages.some((m) => messageText(m.content).startsWith("r"))).toBe(true);
    expect(result.tokens).toBeGreaterThan(50);
  });

  test("preserveRecentTurns is a floor of at least one turn", () => {
    const messages = [...turn("a", "1"), ...turn("b", "2")];
    const result = truncateContext(messages, { maxTokens: 1, preserveRecentTurns: 0 });
    // Exactly one, the newest: "more than nothing" passed with the floor raised to two.
    expect(result.messages.map((m) => m.content)).toEqual(["b", "2"]);
  });
});

describe("compactionThreshold", () => {
  test("a million-token window no longer buys a 610k prompt", () => {
    /**
     * The exact shape of the bug, in one assertion. nouva runs `gemini-3.7-flash` — a 1M window —
     * so `max_context_ratio` 0.8 gave ~762k of budget and `compact_at_ratio` 0.8 put compaction at
     * ~610k. The Telegram session sat at 426,179 tokens: under the line, so it never compacted, and
     * every one of a turn's 20 iterations resent all of it. 11,957,058 input tokens for one reply.
     */
    const budget = 762_000;
    const ratioOnly = Math.floor(budget * 0.8);
    const withCeiling = compactionThreshold(budget, 0.8, 120_000);

    expect(ratioOnly).toBeGreaterThan(426_179); // why nothing ever fired
    expect(withCeiling).toBeLessThan(426_179); // why it now does
    expect(withCeiling).toBe(120_000);
  });

  test("it is inert on a small window, where the ratio is already lower", () => {
    // The other half of the contract, and the reason this is a floor-and-ceiling pair rather than a
    // replacement. A 32k model has ~19k of budget; compacting that at 120k would mean never, and
    // compacting it at the ratio is what it has always correctly done.
    expect(compactionThreshold(19_000, 0.8, 120_000)).toBe(15_200);
  });
});

describe("conversationBudget", () => {
  test("subtracts the system prompt, tools and reserved output from the usable window", () => {
    expect(
      conversationBudget({
        contextWindow: 100_000,
        maxContextRatio: 0.8,
        systemPromptTokens: 5_000,
        toolsTokens: 3_000,
        maxOutputTokens: 8_000,
      }),
    ).toBe(64_000);
  });

  test("floors at zero rather than going negative", () => {
    // A negative budget would make truncateContext drop everything.
    expect(
      conversationBudget({
        contextWindow: 8_000,
        maxContextRatio: 0.8,
        systemPromptTokens: 6_000,
        toolsTokens: 2_000,
        maxOutputTokens: 4_000,
      }),
    ).toBe(0);
  });
});

/**
 * Making room inside a turn.
 *
 * Compaction runs once, before the tool loop. Inside the loop the working set grows with every tool
 * result and nothing measured it again — and the reactive net in `ProviderCaller.call` could not help, because
 * truncation preserves the running turn and can only drop history. A turn that overflowed on its own
 * tool output was a hard failure.
 */
describe("trimToolResults", () => {
  const big = (marker: string) => `${marker}\n${"x".repeat(4000)}`;

  /** A tool round-trip, as the loop builds it: assistant asks, tool answers. */
  function exchange(id: string, content: string) {
    return [
      { role: "assistant" as const, content: "", toolCalls: [{ id, name: "read", arguments: {} }] },
      { role: "tool" as const, content, toolCallId: id },
    ];
  }

  const conversation = () => [
    { role: "user" as const, content: "read all of them" },
    ...exchange("c1", big("FIRST")),
    ...exchange("c2", big("SECOND")),
    ...exchange("c3", big("THIRD")),
  ];

  test("leaves everything alone when it already fits", () => {
    const messages = conversation();
    const result = trimToolResults(messages, { maxTokens: 1_000_000, targetTokens: 1_000_000, keepRecent: 1 });

    expect(result.trimmed).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test("drops the oldest output first and keeps the recent ones", () => {
    const result = trimToolResults(conversation(), { maxTokens: 1500, targetTokens: 1500, keepRecent: 1 });

    expect(result.trimmed).toBeGreaterThan(0);
    const tools = result.messages.filter((m) => m.role === "tool");
    expect(isTrimmedToolResult(tools[0]!)).toBe(true);
    // The newest is what the model is still working from.
    expect(tools.at(-1)!.content).toContain("THIRD");
  });

  test("never removes a message — the tool_use pairing survives", () => {
    // The failure this exists to make impossible: an orphaned `tool_use` is rejected outright by
    // Anthropic. Content shrinks; the message and its `toolCallId` stay.
    const before = conversation();
    const after = trimToolResults(before, { maxTokens: 10, targetTokens: 10, keepRecent: 0 }).messages;

    expect(after).toHaveLength(before.length);
    expect(after.map((m) => m.role)).toEqual(before.map((m) => m.role));
    expect(after.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
  });

  test("stops at its target rather than trimming everything it may", () => {
    // Trimming past the target throws away context for nothing.
    const result = trimToolResults(conversation(), { maxTokens: 2200, targetTokens: 2200, keepRecent: 0 });

    const intact = result.messages.filter((m) => m.role === "tool" && !isTrimmedToolResult(m));
    expect(intact.length).toBeGreaterThan(0);
  });

  test("over the line it goes down to the target, not only back under the line", () => {
    const messages = conversation();
    const total = estimateMessagesTokens(messages);
    // One trim is enough to be back under this line; the target is two results lower.
    const justFits = trimToolResults(messages, { maxTokens: total - 200, targetTokens: total - 200, keepRecent: 0 });
    expect(justFits.trimmed).toBe(1);

    const toTarget = trimToolResults(messages, { maxTokens: total - 200, targetTokens: Math.floor(total / 2), keepRecent: 0 });
    expect(toTarget.trimmed).toBe(2);
    expect(toTarget.tokens).toBeLessThanOrEqual(Math.floor(total / 2));
  });

  test("under the line nothing is touched, however far above the target the set is", () => {
    const messages = conversation();
    const result = trimToolResults(messages, { maxTokens: estimateMessagesTokens(messages), targetTokens: 10, keepRecent: 0 });
    expect(result.trimmed).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test("the kept results are squeezed to get under the line, never further to reach the target", () => {
    const messages = conversation();
    const total = estimateMessagesTokens(messages);
    // Nothing but protected results, and a line one of them clears: the target would take all three.
    const result = trimToolResults(messages, { maxTokens: total - 200, targetTokens: 10, keepRecent: 10 });
    expect(result.trimmed).toBe(1);
    expect(result.reachedProtected).toBe(true);

    // Under the line once the older one went: the kept one stays, though the target is not reached.
    const kept = trimToolResults(messages, { maxTokens: total - 200, targetTokens: 10, keepRecent: 1 });
    expect(kept.trimmed).toBe(1);
    expect(kept.reachedProtected).toBeFalsy();
    expect(kept.messages.find((m) => m.toolCallId === "c2")!.content).toContain("SECOND");
  });

  test("says what went, so an empty result is not mistaken for an empty file", () => {
    const result = trimToolResults(conversation(), { maxTokens: 10, targetTokens: 10, keepRecent: 0 });
    const first = result.messages.find((m) => m.role === "tool")!;

    expect(first.content).toStartWith(TRIMMED_TOOL_PREFIX);
    expect(first.content).toMatch(/\d+ lines/);
    expect(first.content).toContain("read it again");
  });

  test("leaves small output alone — the marker would be bigger than the content", () => {
    const messages = [
      { role: "user" as const, content: "go" },
      ...exchange("c1", "done"),
      ...exchange("c2", big("SECOND")),
    ];
    const result = trimToolResults(messages, { maxTokens: 10, targetTokens: 10, keepRecent: 0 });

    expect(result.messages.find((m) => m.toolCallId === "c1")!.content).toBe("done");
  });

  test("the total it reports is the set's estimate as returned — kept current trim by trim, not measured again", () => {
    for (const [maxTokens, keepRecent] of [[1_000_000, 1], [2_200, 0], [1_500, 1], [10, 0], [10, 10]] as const) {
      const result = trimToolResults(conversation(), { maxTokens, targetTokens: maxTokens, keepRecent });
      expect(result.tokens).toBe(estimateMessagesTokens(result.messages));
    }
  });

  test("an already-trimmed result is not trimmed again", () => {
    // Called on every iteration, so this runs many times over the same messages. Re-trimming would
    // grow the marker into a marker about a marker.
    const once = trimToolResults(conversation(), { maxTokens: 10, targetTokens: 10, keepRecent: 0 });
    const twice = trimToolResults(once.messages, { maxTokens: 10, targetTokens: 10, keepRecent: 0 });

    expect(twice.trimmed).toBe(0);
    expect(twice.messages).toBe(once.messages);
  });

  test("keepRecent larger than the number of results trims nothing — while it fits", () => {
    // The ordinary reading of the setting: everything is protected, so nothing is touched.
    const messages = conversation();
    const result = trimToolResults(messages, {
      maxTokens: estimateMessagesTokens(messages),
      targetTokens: 0,
      keepRecent: 10,
    });
    expect(result.trimmed).toBe(0);
    expect(result.reachedProtected).toBeUndefined();
  });

  test("a protection that cannot be honoured yields instead of overflowing", () => {
    /**
     * The fix, and the whole point of it. `keepRecent` was absolute, so `keepRecent × the per-result
     * cap` was a floor no pass could remove — and nothing checked that product against the budget.
     * Three protected results at the 25k cap is three quarters of a 128k model's budget, and at
     * `preserve_recent_tool_results = 6` on a 200k model it exceeds the whole of it: every request
     * overflows and every pass is forbidden to help. The reactive net cannot either — it drops
     * *history* and preserves the running turn, which is exactly where these live.
     */
    const result = trimToolResults(conversation(), { maxTokens: 10, targetTokens: 10, keepRecent: 10 });

    expect(result.trimmed).toBeGreaterThan(0);
    // Reported, because it is a statement about the configuration rather than about this turn: the
    // agent has lost output it was still using, and it will keep happening until a number changes.
    expect(result.reachedProtected).toBe(true);
  });

  test("the protected results are squeezed only after the older ones are exhausted", () => {
    // Order matters as much as the yielding does. A pass that reached for the newest first would cost
    // the model the result it is mid-way through using while older, already-read output sat untouched.
    const messages = conversation();
    const oldest = messages.findIndex((m) => m.role === "tool");

    // A budget that only one trim can satisfy: the oldest goes, the newest is left alone.
    const result = trimToolResults(messages, {
      maxTokens: estimateMessagesTokens(messages) - 200,
      targetTokens: estimateMessagesTokens(messages) - 200,
      keepRecent: 1,
    });

    expect(isTrimmedToolResult(result.messages[oldest]!)).toBe(true);
    expect(result.reachedProtected).toBeFalsy();
    const tools = result.messages.filter((m) => m.role === "tool");
    expect(isTrimmedToolResult(tools.at(-1)!)).toBe(false);
  });
});

describe("resolveCompactionLimit", () => {
  test("the agent beats the operator, the operator beats the model, the model beats the default", () => {
    expect(resolveCompactionLimit(250_000, 140_000, "gemini-3.8-flash")).toEqual({ tokens: 250_000, source: "agent" });
    expect(resolveCompactionLimit(undefined, 140_000, "gemini-3.8-flash")).toEqual({ tokens: 140_000, source: "config" });
    expect(resolveCompactionLimit(undefined, undefined, "gemini-3.8-flash")).toEqual({ tokens: 200_000, source: "model:gemini-flash" });
    // Through a proxy's routing prefix, the same as the window table.
    expect(resolveCompactionLimit(undefined, undefined, "antigravity:gemini-3.8-flash-high").source).toBe("model:gemini-flash");
    expect(resolveCompactionLimit(undefined, undefined, "claude-opus-5-5")).toEqual({ tokens: 160_000, source: "model:default" });
  });
});

describe("pruneToolOutputs", () => {
  const session = (results: number, size: number): ChatMessage[] =>
    Array.from({ length: results }, (_, i) => [
      { role: "user" as const, content: `step ${i}` },
      { role: "assistant" as const, content: "", toolCalls: [{ id: `c${i}`, name: "read", arguments: {} }] },
      { role: "tool" as const, content: `${i}:${"o".repeat(size)}`, toolCallId: `c${i}` },
    ]).flat() as ChatMessage[];

  test("clears old output beyond the protected newest tokens, and keeps every message", () => {
    const messages = session(10, 8_000);
    const result = pruneToolOutputs(messages, { protectTokens: 5_000, minSavingsTokens: 1_000 });

    expect(result.pruned).toBeGreaterThan(0);
    expect(result.messages).toHaveLength(messages.length);
    expect(isTrimmedToolResult(result.messages[2]!)).toBe(true);
    expect(isTrimmedToolResult(result.messages.at(-1)!)).toBe(false);
  });

  test("a saving too small to be worth the cache it costs changes nothing", () => {
    const messages = session(3, 2_000);
    const result = pruneToolOutputs(messages, { protectTokens: 600, minSavingsTokens: 50_000 });
    expect(result.pruned).toBe(0);
    expect(result.messages).toBe(messages);
  });
});
