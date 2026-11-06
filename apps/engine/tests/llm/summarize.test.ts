import { messageText } from "@nouride/shared";
/**
 * Compacting a conversation instead of forgetting the start of it.
 *
 * The properties pinned here are the ones the old version got wrong: the summarizer reads all of what
 * it summarizes, a part is never summarized twice, and what leaves the context is archived with a range
 * it can be read back from — plus the one it always got right, that a failed summary never costs the
 * operator the turn they are waiting on.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { addLogSink, type ChatMessage, type ChatParams, type ChatResponse, type LLMProvider, type LogEntry } from "@nouride/shared";
import { compactHistory, compactionShape, isSummary, resetCompactionBreaker, SUMMARY_PREFIX } from "@/modules/llm/summarize.ts";
import { COMPACTION_FAILED } from "@/modules/llm/helper-trouble.ts";

/** ~1,000 tokens a turn, so a handful of them passes a small limit. */
function turn(n: number, size = 2_000): ChatMessage[] {
  return [
    { role: "user", content: `question ${n} ${"x".repeat(size)}`, timestamp: n * 1000 },
    { role: "assistant", content: `answer ${n} ${"y".repeat(size)}`, timestamp: n * 1000 + 1 },
  ];
}

function history(turns: number, from = 1): ChatMessage[] {
  return Array.from({ length: turns }, (_, i) => turn(i + from)).flat();
}

/** Records what it was asked, so the test can assert on the request as well as the result. */
function fakeProvider(answer: string | Error | ((params: ChatParams) => string)): LLMProvider & { calls: ChatParams[] } {
  const calls: ChatParams[] = [];
  return {
    kind: "openai",
    baseUrl: "https://example",
    calls,
    async chat(params: ChatParams): Promise<ChatResponse> {
      calls.push(params);
      if (answer instanceof Error) throw answer;
      return {
        text: typeof answer === "function" ? answer(params) : answer,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "stop" as const,
        model: params.model,
      };
    },
    async *stream() {
      throw new Error("not used");
    },
  } as unknown as LLMProvider & { calls: ChatParams[] };
}

/** A limit of 10k: the tail is 4k tokens — the last few turns — and the parts' budget 3k. */
const options = (provider: LLMProvider, maxTokens = 10_000) => ({
  provider,
  model: "test-model",
  maxTokens,
  limit: 10_000,
  key: "conversation",
});

const sent = (provider: { calls: ChatParams[] }, call = 0) => messageText(provider.calls[call]?.messages.at(-1)?.content ?? "");
const head = (messages: ChatMessage[]) => messageText(messages[0]?.content ?? "");

beforeEach(() => resetCompactionBreaker());

describe("compactHistory", () => {
  test("history that fits is left alone, and costs nothing", async () => {
    const provider = fakeProvider("should not be called");
    const messages = history(1);

    const result = await compactHistory(messages, options(provider, 100_000));

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(provider.calls).toHaveLength(0);
  });

  test("older turns become one part; the newest are kept verbatim, counted in tokens", async () => {
    const provider = fakeProvider("Headline: set up the server\n## Done\n- wrote server.js");
    const result = await compactHistory(history(10), options(provider));

    expect(result.compacted).toBe(true);
    expect(isSummary(result.messages[0] as ChatMessage)).toBe(true);
    expect(head(result.messages)).toContain("## Part 1 ·");
    expect(head(result.messages)).toContain("wrote server.js");
    // ~1k tokens a turn against a 4k tail: the tail is a few whole turns, ending on the newest.
    const tail = result.messages.slice(1);
    expect(tail.length).toBeGreaterThanOrEqual(2);
    expect(tail.length % 2).toBe(0);
    expect(messageText(tail[0]!.content)).toStartWith("question");
    expect(messageText(tail.at(-1)!.content)).toContain("answer 10");
    expect(result.summarizedTurns).toBe(10 - tail.length / 2);
  });

  test("the summarizer reads all of what it summarizes, not the end of it", async () => {
    // The old version cut the transcript to its last 60k characters, so the start of a long session —
    // what is most worth remembering — never reached the summarizer at all.
    const provider = fakeProvider("Headline: x\nnotes");
    await compactHistory(history(40), { ...options(provider, 10_000), limit: 10_000 });

    const input = provider.calls.map((call) => messageText(call.messages.at(-1)?.content ?? "")).join("\n");
    expect(input).toContain("question 1 ");
    expect(input).toContain("question 30 ");
  });

  test("what the summarizer reads says who said each line, and which tool was called with what", async () => {
    // How the transcript is written out for the summary call was not tested at all: swapping the
    // labels — a person's words sent as a tool result, a tool call dropped — left every test here green.
    const provider = fakeProvider("Headline: x\nnotes");
    const withTool: ChatMessage[] = [
      { role: "user", content: "question 0 read the config", timestamp: 1 },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", arguments: { path: "config.toml" } }], timestamp: 2 },
      { role: "tool", content: "port = 8080", toolCallId: "c1", timestamp: 3 },
      { role: "assistant", content: "It listens on 8080.", timestamp: 4 },
      ...history(10),
    ];
    await compactHistory(withTool, options(provider));

    const input = provider.calls.map((call) => messageText(call.messages.at(-1)?.content ?? "")).join("\n");
    expect(input).toContain("user: question 0 read the config");
    expect(input).toContain('→ read({"path":"config.toml"})');
    expect(input).toContain("tool result:");
    expect(input).toContain("assistant: It listens on 8080.");
  });

  test("a stretch too large for one call is split into parts, not cut", async () => {
    const provider = fakeProvider("Headline: x\nnotes");
    // 60 turns ≈ 60k tokens, against a 16k-token input budget.
    const result = await compactHistory(history(60), { ...options(provider), limit: 10_000, summarizerWindow: 40_000 });

    expect(provider.calls.length).toBeGreaterThan(1);
    expect(sent(provider, 0)).toContain("question 1 ");
    // Each piece after the first sees the one before it as notes it must not repeat.
    expect(sent(provider, 1)).toContain("<earlier-notes>");
    expect(result.compacted).toBe(true);
  });

  test("a second compaction adds a part and leaves the first exactly as written", async () => {
    // Compaction over compaction is what this replaced: the earlier summary folded into each new one,
    // so the first hour went through another lossy pass every time.
    const first = await compactHistory(history(10), options(fakeProvider("Headline: first stretch\nPART ONE NOTES")));
    const provider = fakeProvider("Headline: second stretch\nPART TWO NOTES");
    const second = await compactHistory([...first.messages, ...history(10, 11)], options(provider));

    const text = head(second.messages);
    expect(text).toContain("## Part 1 ·");
    expect(text).toContain("PART ONE NOTES");
    expect(text).toContain("## Part 2 ·");
    expect(text).toContain("PART TWO NOTES");
    expect(second.messages.filter(isSummary)).toHaveLength(1);

    // Part one went to the summarizer only as reference, and the conversation it read starts after it.
    expect(sent(provider)).toContain("<earlier-notes>\nHeadline: first stretch\nPART ONE NOTES");
    const conversation = sent(provider).split("<conversation>")[1] ?? "";
    expect(conversation).not.toContain("question 1 ");
    expect(conversation).toContain("question 11 ");
  });

  test("parts past their budget are archived with the range they can be read back from", async () => {
    // ~2k tokens a part, against a 3k budget: the third compaction has to move the first one out.
    const big = (name: string) => `Headline: ${name}\n${"z".repeat(8_000)}`;
    let messages = (await compactHistory(history(10), options(fakeProvider(big("the first stretch"))))).messages;
    messages = (await compactHistory([...messages, ...history(10, 11)], options(fakeProvider(big("the second stretch"))))).messages;
    const result = await compactHistory([...messages, ...history(10, 21)], options(fakeProvider(big("the third stretch"))));

    const text = head(result.messages);
    expect(result.archivedParts).toBeGreaterThan(0);
    expect(text).toContain("### Archived");
    expect(text).toMatch(/- Part 1 · .* · the first stretch · earlier="1000-\d+"/);
    expect(text).not.toContain("## Part 1 ·");
    // Never the newest part: it is the one the kept tail continues from.
    expect(text).toContain("## Part 3 ·");
  });

  test("old tool output is cleared first, and when that is enough no summary is written", async () => {
    const provider = fakeProvider("should not be called");
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 12; i += 1) {
      messages.push(
        { role: "user", content: `run step ${i}`, timestamp: i * 10 },
        { role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "read", arguments: { path: `f${i}` } }], timestamp: i * 10 + 1 },
        { role: "tool", content: "o".repeat(12_000), toolCallId: `c${i}`, timestamp: i * 10 + 2 } as ChatMessage,
        { role: "assistant", content: `done ${i}`, timestamp: i * 10 + 3 },
      );
    }
    const result = await compactHistory(messages, { ...options(provider, 30_000), limit: 60_000 });

    expect(result.compacted).toBe(true);
    expect(result.prunedToolResults).toBeGreaterThan(0);
    expect(result.summarizedTurns).toBe(0);
    expect(provider.calls).toHaveLength(0);
    // The newest output is untouched; the pairing of every call with its result is intact.
    expect(messageText(result.messages.at(-2)!.content)).toBe("o".repeat(12_000));
    expect(result.messages).toHaveLength(messages.length);
  });

  test("a failed summary keeps the history and does not throw", async () => {
    // The turn the operator is waiting on must not fail because tidying up history did.
    const provider = fakeProvider(new Error("provider is down"));
    const messages = history(10);

    const result = await compactHistory(messages, options(provider));

    expect(result.compacted).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.messages).toBe(messages);
  });

  test("an empty summary is treated as a failure, not as an empty history", async () => {
    const result = await compactHistory(history(10), options(fakeProvider("   ")));
    expect(result.compacted).toBe(false);
    expect(result.failed).toBe(true);
  });

  test("three failures in a row pause compaction for that conversation", async () => {
    const provider = fakeProvider(new Error("down"));
    for (let i = 0; i < 3; i += 1) await compactHistory(history(10), options(provider));
    expect(provider.calls).toHaveLength(3);

    const paused = await compactHistory(history(10), options(provider));
    expect(paused.paused).toBe(true);
    expect(provider.calls).toHaveLength(3);

    // Another conversation is not affected.
    await compactHistory(history(10), { ...options(provider), key: "another" });
    expect(provider.calls).toHaveLength(4);
  });

  test("a summary cut short by a stop is no failure: it pauses nothing, and is not counted where an operator reads", async () => {
    const provider = fakeProvider(new Error("request aborted"));
    const failures: LogEntry[] = [];
    addLogSink((entry) => void (entry.message === COMPACTION_FAILED && failures.push(entry)));
    for (let i = 0; i < 3; i += 1) await compactHistory(history(10), { ...options(provider), key: "stopped", signal: AbortSignal.abort() });

    expect(failures).toEqual([]);
    const next = await compactHistory(history(10), { ...options(fakeProvider("Headline: x\nnotes")), key: "stopped" });
    expect(next.paused).toBeUndefined();
    expect(next.compacted).toBe(true);
  });

  test("nothing older than the kept tail is nothing to compact", async () => {
    const provider = fakeProvider("unused");
    const result = await compactHistory(history(1), options(provider, 1));

    expect(result.compacted).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  test("a summary no smaller than what it would replace is not kept: the history stays word for word", async () => {
    // `/compact` on a two-turn chat on a live box replaced 66 tokens of history with a 193-token summary, and every
    // turn after it re-sent the difference.
    const short = [...turn(1, 200), ...turn(2, 200)];
    const wordy = fakeProvider(`Headline: a short exchange\n${"what was said, at length. ".repeat(80)}`);
    const kept = await compactHistory(short, options(wordy, 0));

    expect(wordy.calls).toHaveLength(1);
    expect(kept.compacted).toBe(false);
    expect(kept.messages).toEqual(short);

    // The same chat with a summary that is smaller is compacted as before.
    const brief = await compactHistory(short, options(fakeProvider("Headline: x\nasked twice"), 0));
    expect(brief.compacted).toBe(true);
    expect(isSummary(brief.messages[0]!)).toBe(true);
  });

  test("the summary is asked for deterministically and sized to what it covers", async () => {
    const provider = fakeProvider("notes");
    await compactHistory(history(10), options(provider));

    expect(provider.calls[0]?.temperature).toBe(0);
    // Room for a model that reasons before it writes — never the old 800.
    expect(provider.calls[0]?.maxTokens).toBeGreaterThan(800);
    expect(provider.calls[0]?.model).toBe("test-model");
  });

  test("the summary is marked as one, so nobody reads it as something that was said", async () => {
    const result = await compactHistory(history(10), options(fakeProvider("notes")));

    expect(head(result.messages).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(isSummary({ role: "user", content: "an ordinary message", timestamp: 0 })).toBe(false);
  });

  describe("exact values survive a summary that smoothed them away", () => {
    const said: ChatMessage[] = [
      { role: "user", content: `We moved staging Postgres to 192.168.0.11:5433 with max_connections=200. ${"x".repeat(2_000)}`, timestamp: 1 },
      { role: "assistant", content: `Done: edited apps/engine/src/index.ts and /etc/postgresql/16/main/postgresql.conf, commit 3e070f8. ${"y".repeat(2_000)}`, timestamp: 2 },
      { role: "tool", content: `/usr/lib/noise/ignored.so ${"z".repeat(400)}`, timestamp: 3 } as ChatMessage,
      ...history(10),
    ];

    test("what the people said is appended verbatim when the model left it out", async () => {
      const result = await compactHistory(said, options(fakeProvider("Fixed the staging database.")));
      const summary = head(result.messages);
      for (const value of ["192.168.0.11:5433", "max_connections=200", "apps/engine/src/index.ts", "/etc/postgresql/16/main/postgresql.conf", "3e070f8"]) {
        expect(summary).toContain(value);
      }
      // Tool output is full of paths nobody asked about.
      expect(summary).not.toContain("/usr/lib/noise/ignored.so");
    });

    test("they last through later compactions, because a part is never rewritten", async () => {
      const first = await compactHistory(said, options(fakeProvider("Fixed the staging database.")));
      const second = await compactHistory([...first.messages, ...history(10, 20)], options(fakeProvider("Worked on other things.")));
      expect(head(second.messages)).toContain("192.168.0.11:5433");
    });

    test("a secret pasted as key=value is not pinned into the summary", async () => {
      const leaky: ChatMessage[] = [{ role: "user", content: `use token=sk-abc123secret ${"x".repeat(2_000)}`, timestamp: 1 }, ...history(10)];
      const result = await compactHistory(leaky, options(fakeProvider("Set up the client.")));
      expect(head(result.messages)).not.toContain("sk-abc123secret");
    });
  });
});

describe("compactionShape", () => {
  test("shares of the limit, clamped at both ends", () => {
    expect(compactionShape(145_000).keepRecentTokens).toBe(40_000);
    expect(compactionShape(145_000).partsTokens).toBe(21_750);
    expect(compactionShape(10_000).keepRecentTokens).toBe(4_000);
    expect(compactionShape(10_000).partsTokens).toBe(2_000);
    // A small limit is not handed floors larger than the room they are carved from.
    const small = compactionShape(6_000);
    expect(small.keepRecentTokens + small.partsTokens).toBeLessThanOrEqual(6_000 * 0.6);
  });
});

describe("saying it is happening", () => {
  test("onStart fires before the summary call, with how many turns and tokens it is about", async () => {
    // The summary is a provider call of its own, often the slowest thing in the turn. Said before it,
    // not after, or a chat watching the turn sees nothing until it is over.
    const order: string[] = [];
    const provider = fakeProvider("- a summary");
    const chat = provider.chat.bind(provider);
    provider.chat = async (params) => {
      order.push("summary call");
      return chat(params);
    };
    let seen: { turns: number; tokens: number } | undefined;

    await compactHistory(history(10), {
      ...options(provider),
      onStart: (info) => {
        order.push("onStart");
        seen = info;
      },
    });

    expect(order[0]).toBe("onStart");
    expect(order[1]).toBe("summary call");
    expect(seen?.turns).toBeGreaterThan(0);
    expect(seen?.tokens).toBeGreaterThan(10_000);
  });

  test("no summary, no onStart", async () => {
    let called = false;
    await compactHistory(history(1), { ...options(fakeProvider("x"), 100_000), onStart: () => (called = true) });
    expect(called).toBe(false);
  });
});
