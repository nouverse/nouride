/**
 * The note that catches several `edit` calls to one file — see `executor/nudges.ts` for the numbers.
 */

import { describe, expect, test } from "bun:test";
import type { ChatResponse, LLMProvider, Tool } from "@nouride/shared";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { longTurnHelperNote, repeatedEditNote, roundShape, singleCallChainNote } from "@/modules/llm/executor/nudges.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const edit = (path: string, ok = true) => ({ name: "edit", ok, path });

describe("repeatedEditNote", () => {
  test("the first edit to a file says nothing", () => {
    expect(repeatedEditNote([], edit("src/a.ts"))).toBeNull();
    expect(repeatedEditNote([edit("src/b.ts")], edit("src/a.ts"))).toBeNull();
  });

  test("the second to the same file points at multi_edit, and counts", () => {
    const note = repeatedEditNote([edit("src/a.ts"), edit("src/b.ts"), edit("src/a.ts")], edit("src/a.ts"));
    expect(note).toContain("edit #3 to a.ts");
    expect(note).toContain("ONE `multi_edit`");
  });

  test("after a failed edit the next one is a fix, not a habit", () => {
    expect(repeatedEditNote([edit("src/a.ts", false)], edit("src/a.ts"))).toBeNull();
    expect(repeatedEditNote([edit("src/a.ts")], edit("src/a.ts", false))).toBeNull();
  });

  test("other tools are left alone", () => {
    expect(repeatedEditNote([edit("a.ts")], { name: "write", ok: true, path: "a.ts" })).toBeNull();
  });
});

describe("in a real turn", () => {
  test("the model reads the note on the result of its second edit to one file", async () => {
    const tool: Tool = {
      requiresApproval: false,
      definition: { name: "edit", description: "e", parameters: { type: "object", properties: {} } },
      async execute() {
        return { content: "Edited.", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === "edit" ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const script = [
      [{ id: "e1", name: "edit", arguments: { path: "src/a.ts", old_string: "1", new_string: "2" } }],
      [{ id: "e2", name: "edit", arguments: { path: "src/b.ts", old_string: "1", new_string: "2" } }],
      [{ id: "e3", name: "edit", arguments: { path: "src/a.ts", old_string: "3", new_string: "4" } }],
      [],
    ];
    let asked = 0;
    const provider = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(): Promise<ChatResponse> {
        const calls = script[asked++] ?? [];
        return {
          text: calls.length ? "" : "done",
          toolCalls: calls,
          stopReason: calls.length ? "tool_calls" : "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "m",
        } as ChatResponse;
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
      userMessage: { role: "user", content: "fix both", timestamp: 1 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

    const results = result.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results[0]).toBe("Edited.");
    expect(results[1]).toBe("Edited.");
    expect(results[2]).toContain("edit #2 to a.ts");
  });
});

describe("singleCallChainNote", () => {
  const single = (tool: string) => ({ tool, batched: false });

  test("the third reply in a row asking one tool for one thing names its list parameter", () => {
    const note = singleCallChainNote([single("read"), single("read")], single("read"), new Set());
    expect(note).toContain("third reply in a row");
    expect(note).toContain("ONE `read` with `paths`");
  });

  test("two in a row is left alone — often one read revealed the next", () => {
    expect(singleCallChainNote([single("read")], single("read"), new Set())).toBeNull();
  });

  test("a batched call anywhere in the chain breaks it", () => {
    expect(singleCallChainNote([{ tool: "read", batched: true }, single("read")], single("read"), new Set())).toBeNull();
    expect(singleCallChainNote([single("read"), single("read")], { tool: "read", batched: true }, new Set())).toBeNull();
  });

  test("a different tool in between breaks it", () => {
    expect(singleCallChainNote([single("read"), single("grep")], single("read"), new Set())).toBeNull();
  });

  test("once per tool per turn", () => {
    expect(singleCallChainNote([single("read"), single("read")], single("read"), new Set(["read"]))).toBeNull();
  });

  test("glob, which has no list, is told to put calls in one reply", () => {
    expect(singleCallChainNote([single("glob"), single("glob")], single("glob"), new Set())).toContain("ONE reply");
  });

  test("tools that change things are never nudged to batch", () => {
    expect(singleCallChainNote([single("exec"), single("exec")], single("exec"), new Set())).toBeNull();
    expect(singleCallChainNote([single("write"), single("write")], single("write"), new Set())).toBeNull();
  });

  test("the fourth `exec` in a row sent alone is told to chain — and the remote half to go in one ssh", () => {
    const note = singleCallChainNote([single("exec"), single("exec"), single("exec")], single("exec"), new Set());
    expect(note).toContain("four commands in four round trips");
    expect(note).toContain("ONE `ssh host 'bash -s'");
    // Probing where each output picks the next command is not the habit this is about, and the note says so —
    // it was read as a false alarm live when it did not.
    expect(note).toContain("When each result decides the next command, this is not about you: carry on as you were.");
    // Broken by another tool or by two commands sent together, and said once a turn.
    expect(singleCallChainNote([single("exec"), single("read"), single("exec")], single("exec"), new Set())).toBeNull();
    expect(singleCallChainNote([single("exec"), { batched: true }, single("exec")], single("exec"), new Set())).toBeNull();
    expect(singleCallChainNote([single("exec"), single("exec"), single("exec")], single("exec"), new Set(["exec"]))).toBeNull();
  });

  test("roundShape reads whether the one call used its list", () => {
    expect(roundShape([{ name: "read", arguments: { path: "a" } }])).toEqual({ tool: "read", batched: false });
    expect(roundShape([{ name: "read", arguments: { paths: ["a", "b"] } }])).toEqual({ tool: "read", batched: true });
    expect(roundShape([{ name: "web_search", arguments: { queries: ["a"] } }])).toEqual({ tool: "web_search", batched: true });
    expect(roundShape([{ name: "read", arguments: {} }, { name: "grep", arguments: {} }])).toEqual({ batched: true });
  });
});

describe("the chain note in a real turn", () => {
  test("lands on the third single read, and only once", async () => {
    const tool: Tool = {
      requiresApproval: false,
      parallelSafe: true,
      definition: { name: "read", description: "r", parameters: { type: "object", properties: {} } },
      async execute() {
        return { content: "contents", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      get: (name: string) => (name === "read" ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => true,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const reads = ["a.ts", "b.ts", "c.ts", "d.ts"].map((path, i) => [{ id: `r${i}`, name: "read", arguments: { path } }]);
    const script = [...reads, []];
    let asked = 0;
    const provider = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(): Promise<ChatResponse> {
        const calls = script[asked++] ?? [];
        return {
          text: calls.length ? "" : "done",
          toolCalls: calls,
          stopReason: calls.length ? "tool_calls" : "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "m",
        } as ChatResponse;
      },
    } as unknown as LLMProvider;
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 8, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 5 },
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
      userMessage: { role: "user", content: "read them", timestamp: 1 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
    });

    const results = result.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results.map((r) => r.includes("third reply in a row"))).toEqual([false, false, true, false]);
  });
});

describe("longTurnHelperNote", () => {
  const turn = (over: Partial<{ calls: number; elapsedMs: number; offered: number; told: boolean }> = {}) => ({ calls: 1, elapsedMs: 1_000, offered: 2, told: false, ...over });

  test("a turn still short says nothing", () => {
    expect(longTurnHelperNote(turn({ calls: 7, elapsedMs: 119_000 }))).toBeNull();
  });

  test("the eighth call, or two minutes, points at ONE helper in the background — and says when to finish instead", () => {
    const byCalls = longTurnHelperNote(turn({ calls: 8, elapsedMs: 30_000 }));
    expect(byCalls).toContain("This turn has made 8 calls over 30 s");
    expect(byCalls).toContain("hand it to ONE helper in the background (`delegate` with `background: true`");
    expect(byCalls).toContain("If it is nearly done, finish it.");
    expect(longTurnHelperNote(turn({ calls: 3, elapsedMs: 120_000 }))).toContain("3 calls over 120 s");
  });

  test("never where a helper cannot be started in the background, and once a turn", () => {
    expect(longTurnHelperNote(turn({ calls: 20, offered: 0 }))).toBeNull();
    expect(longTurnHelperNote(turn({ calls: 20, told: true }))).toBeNull();
  });
});

describe("the long-turn note in a real turn", () => {
  async function run(backgroundHelpers: number | undefined, more: { mission?: boolean; unattended?: boolean } = {}): Promise<string[]> {
    const tool: Tool = {
      requiresApproval: false,
      definition: { name: "probe", description: "checks one thing", parameters: { type: "object", properties: {} } },
      async execute() {
        return { content: "checked", isError: false };
      },
    };
    const toolset = {
      definitions: [tool.definition],
      // A chat's `mission` (0.8.11): the turn can draft one, and the note says so.
      get: (name: string) => (name === "probe" ? tool : name === "mission" && more.mission ? tool : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
      ...(backgroundHelpers === undefined ? {} : { backgroundHelpers }),
    } as unknown as AgentToolset;
    const script = [...Array.from({ length: 10 }, (_, i) => [{ id: `p${i}`, name: "probe", arguments: { what: `link ${i}` } }]), []];
    let asked = 0;
    const provider = {
      kind: "openai",
      baseUrl: "https://fake.test/v1",
      async chat(): Promise<ChatResponse> {
        const calls = script[asked++] ?? [];
        return { text: calls.length ? "" : "done", toolCalls: calls, stopReason: calls.length ? "tool_calls" : "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" } as ChatResponse;
      },
    } as unknown as LLMProvider;
    const executor = new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 20, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 5 },
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
      userMessage: { role: "user", content: "check every link in the docs", timestamp: 1 },
      gateway: "telegram",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      chatType: "dm",
      sessionId: "s1",
      senderId: "u1",
      ...(more.unattended ? { unattended: { goal: "a mission's work" } } : {}),
    });
    return result.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  }

  test("lands on the eighth call's result, once, where a helper may work in the background", async () => {
    const results = await run(2);
    expect(results).toHaveLength(10);
    expect(results.map((r) => r.includes("ONE helper in the background"))).toEqual([false, false, false, false, false, false, false, true, false, false]);
  });

  test("where the turn holds `mission`, the note offers a draft for long work; a run nobody watches is not offered one (0.8.11)", async () => {
    const draft = "draft a `mission` for it instead";
    expect((await run(2, { mission: true })).filter((r) => r.includes(draft))).toHaveLength(1);
    expect((await run(2)).some((r) => r.includes(draft))).toBe(false);
    expect((await run(2, { mission: true, unattended: true })).some((r) => r.includes(draft))).toBe(false);
  });

  test("an agent with no background helpers is not told about them", async () => {
    expect((await run(undefined)).some((r) => r.includes("helper in the background"))).toBe(false);
  });
});

describe("the rule the exec note repeats", () => {
  const prompt = (tools: string[]) =>
    buildSystemPrompt({
      agent: fakeAgent(),
      tools: tools.map((name) => ({ name, description: name, parameters: {} })),
      harness: { approvalRequired: [], approvalAvailable: true, maxToolIterations: 25, commands: [], truncates: false, workspace: { dir: "/w", roots: ["/w"] } },
      gateway: "telegram",
      chatId: "1",
      chatType: "dm",
      sessionId: "s",
      timezone: "UTC",
      now: new Date("2026-10-18T00:00:00Z"),
    } as never).text;

  test("an agent with a shell is told to send a remote sequence through one ssh", () => {
    expect(prompt(["exec"])).toContain("On another machine, send the whole sequence through ONE `ssh`");
    expect(prompt(["read"])).not.toContain("through ONE `ssh`");
  });
});
