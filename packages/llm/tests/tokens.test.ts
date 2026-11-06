import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@nouride/shared";
import {
  compactionLimitInfo,
  contextWindowInfo,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolsTokens,
} from "../src/tokens.ts";

/** The window size alone. */
const contextWindowFor = (model: string): number => contextWindowInfo(model).tokens;

describe("estimateTokens", () => {
  test("is zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("uses roughly four characters per token for Latin text", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("counts CJK more densely than Latin", () => {
    // The same character count in Japanese carries far more tokens; treating it as
    // Latin would under-count by ~2.6x and overflow the window.
    const latin = estimateTokens("a".repeat(60));
    const cjk = estimateTokens("あ".repeat(60));
    expect(cjk).toBeGreaterThan(latin * 2);
  });

  test("handles mixed scripts", () => {
    const mixed = estimateTokens(`${"a".repeat(40)}${"漢".repeat(15)}`);
    expect(mixed).toBe(Math.ceil(15 / 1.5 + 40 / 4));
  });

  /**
   * The blocks the per-character regex counted, as escapes. Typed as characters, U+F900 is one an NFC
   * pass turns into U+8C48 — and then this oracle would quietly test a class twice as wide.
   */
  const CJK = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

  test("counts exactly what the regex it replaced counted: every BMP code unit, and astral characters as two non-CJK units", () => {
    const wrong: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const char = String.fromCharCode(code);
      // Twelve of one character: 8 tokens if it is CJK (12 / 1.5), 3 if not (12 / 4).
      if (estimateTokens(char.repeat(12)) !== (CJK.test(char) ? 8 : 3)) wrong.push(code.toString(16));
    }
    expect(wrong).toEqual([]);
    // An emoji and a CJK extension-B ideograph are each two code units, and neither block reaches them.
    expect(estimateTokens("\u{1F6E0}".repeat(6))).toBe(3);
    expect(estimateTokens("\u{20000}".repeat(6))).toBe(3);
  });

  test("a character costs a comparison, not a regex — the context guard runs it over the whole conversation every round", () => {
    // A log line of timestamps and ids, the text the estimate is run over most, ~2M characters of it.
    const log = "2026-10-17T08:00:00.123Z INFO pipeline turn complete turn=4f9c2e1a chat=1000000001\n".repeat(24_000);
    const median = (fn: () => number): number => {
      for (let warm = 0; warm < 3; warm += 1) fn();
      const samples = Array.from({ length: 9 }, () => {
        const start = performance.now();
        fn();
        return performance.now() - start;
      });
      return samples.sort((a, b) => a - b)[4]!;
    };
    // What the estimator used to do: a regex test per character (E9). Measured here, beside it, so the
    // comparison is between two runs on the same machine — a range check costs about a quarter of it.
    const regex = median(() => {
      let cjk = 0;
      for (const char of log) if (CJK.test(char)) cjk += 1;
      return cjk;
    });
    expect(median(() => estimateTokens(log))).toBeLessThan(regex / 2);
  });
});

describe("a message is measured once, while it holds what was measured", () => {
  /** A call whose arguments count how often they are serialized — once per time the message is measured. */
  function counted(): { message: ChatMessage; serialized: () => number } {
    let serialized = 0;
    const args = {
      path: "logs/nouride.log",
      toJSON() {
        serialized += 1;
        return { path: "logs/nouride.log" };
      },
    };
    const message: ChatMessage = { role: "assistant", content: "reading the log", toolCalls: [{ id: "c1", name: "read", arguments: args }] };
    return { message, serialized: () => serialized };
  }

  test("asked again, the same message is not measured again", () => {
    const { message, serialized } = counted();
    const first = estimateMessageTokens(message);

    expect(estimateMessageTokens(message)).toBe(first);
    expect(estimateMessagesTokens([message, message, message])).toBe(first * 3);
    expect(serialized()).toBe(1);
  });

  test("given new content or new calls, it is measured again — a remembered number never outlives what it measured", () => {
    const { message, serialized } = counted();
    const first = estimateMessageTokens(message);

    // The executor gives a message new content in place: the owed-report note, a wrap-up's answer.
    message.content = `reading the log\n\n[harness] ${"say what the job found. ".repeat(20)}`;
    const longer = estimateMessageTokens(message);
    expect(longer).toBeGreaterThan(first);
    expect(serialized()).toBe(2);

    message.toolCalls = [{ id: "c2", name: "read", arguments: { path: "logs/nouride.log", offset: 4_000, limit: 400 } }];
    expect(estimateMessageTokens(message)).not.toBe(longer);
    expect(serialized()).toBe(2);
  });
});

describe("estimateMessageTokens", () => {
  test("adds per-message overhead", () => {
    expect(estimateMessageTokens({ role: "user", content: "" })).toBe(4);
  });

  test("counts serialized tool call arguments", () => {
    const withCall = estimateMessageTokens({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "read", arguments: { path: "/tmp/a-long-file-name.txt" } }],
    });
    expect(withCall).toBeGreaterThan(estimateMessageTokens({ role: "assistant", content: "" }));
  });

  test("sums over a conversation", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    expect(estimateMessagesTokens(messages)).toBe(
      messages.reduce((s, m) => s + estimateMessageTokens(m), 0),
    );
  });
});

describe("estimateToolsTokens", () => {
  test("counts the schema, not just the name", () => {
    const bare = estimateToolsTokens([{ name: "x", description: "", parameters: {} }]);
    const rich = estimateToolsTokens([
      {
        name: "x",
        description: "a tool that does a thing",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "file path to read" } },
        },
      },
    ]);
    expect(rich).toBeGreaterThan(bare * 3);
  });
});

describe("contextWindowFor", () => {
  test.each([
    ["claude-sonnet-4-20250514", 200_000],
    ["claude-opus-5", 200_000],
    ["gpt-4o", 128_000],
    ["gpt-4", 8_192],
  ])("knows %s", (model, expected) => {
    expect(contextWindowFor(model)).toBe(expected);
  });

  /**
   * The miss that cost a live evening. Three agents ran on `antigravity:gemini-3.x-*`, matched
   * nothing here, and were budgeted at the 32k default against a million-token window — so the
   * conversation budget came out near 6k, `trimToolResults` fired on every single tool iteration, and
   * the agent kept throwing away the output of the call it was mid-way through using. Twenty-two to
   * twenty-five iterations and 700k tokens per turn, ending in a reply with no text in it.
   */
  test.each([
    ["gemini-3.7-flash", 1_000_000],
    ["antigravity:gemini-3.7-flash-high", 1_000_000],
    ["antigravity:gemini-3.6-flash-medium", 1_000_000],
    ["gemini-2.5-pro", 1_000_000],
    ["gemini-1.5-flash", 1_000_000],
  ])("knows %s, which the 32k default was crippling", (model, expected) => {
    expect(contextWindowFor(model)).toBe(expected);
  });

  test("keeps the narrower gpt-4 patterns ahead of the broader one", () => {
    // `find` takes the first match, so ordering *is* the behaviour here: put `^gpt-4` first and a
    // million-token window reads as eight thousand.
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
    expect(contextWindowFor("gpt-4-turbo")).toBe(128_000);
    expect(contextWindowFor("gpt-4")).toBe(8_192);
  });
});

describe("contextWindowInfo", () => {
  test("says when the number was looked up", () => {
    expect(contextWindowInfo("antigravity:claude-sonnet-4-6")).toEqual({
      tokens: 200_000,
      known: true,
    });
  });

  test("says when the number is a guess", () => {
    // The whole point of the extra field: a silent fallback is what let three agents run for days on
    // a budget thirty times too small. The caller logs this once per model id.
    expect(contextWindowInfo("some-local-llama")).toEqual({ tokens: 32_000, known: false });
  });
});

describe("compactionLimitInfo", () => {
  test("Gemini 3 and later Flash compact at 200k, behind any prefix a proxy adds", () => {
    expect(compactionLimitInfo("gemini-3.8-flash")).toEqual({ tokens: 200_000, rule: "gemini-flash" });
    expect(compactionLimitInfo("antigravity:gemini-3.8-flash-high")).toEqual({ tokens: 200_000, rule: "gemini-flash" });
    expect(compactionLimitInfo("google/gemini-10-flash")).toEqual({ tokens: 200_000, rule: "gemini-flash" });
  });

  test("an older Flash, a Pro and anything else fall to the default", () => {
    for (const model of ["gemini-2.5-flash", "gemini-3-pro", "claude-opus-5-5", "gpt-4.1"]) {
      expect({ model, ...compactionLimitInfo(model) }).toEqual({ model, tokens: 160_000, rule: "default" });
    }
  });
});
