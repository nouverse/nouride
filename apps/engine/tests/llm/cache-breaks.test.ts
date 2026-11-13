/**
 * What broke a conversation's cache, said by name.
 *
 * A week of the live box's own usage: a turn's first request on the largest model read the same 41,243 tokens from
 * the cache again and again and wrote everything after them anew, 45 to 64 thousand, twenty seconds after the request
 * before it. Something in front of the conversation had changed. The daemon knew that it had (`CacheBreaks`, one
 * digest for the whole prefix) and could not say what. It keeps a digest per part now, and the log names the parts.
 */

import { describe, expect, test } from "bun:test";
import { addLogSink, type LogEntry } from "@nouride/shared";
import type { ChatMessage, ChatParams, LLMProvider } from "@nouride/shared";
import { CacheBreaks } from "@/modules/llm/cache-breaks.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { buildSystemPrompt as buildPrompt, type PromptContext } from "@/modules/llm/prompt/index.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SAID = "the cached prefix changed since this conversation's last request";

const logged: LogEntry[] = [];
addLogSink((entry) => {
  if (entry.message === SAID) logged.push(entry);
});

describe("the parts of a prefix, between two requests of a conversation", () => {
  const PARTS = { tools: "t1", model: "m", identity: "i1", memory: "mem1", harness: "h1", recall: "r1", runtime: "rt1" };
  const twice = (second: Record<string, string>, idleMs = MINUTE) => {
    const breaks = new CacheBreaks();
    breaks.seen("ses", PARTS, 1_000_000, 1_000_000, HOUR);
    return breaks.seen("ses", second, 1_000_000, 1_000_000 + idleMs, HOUR);
  };

  test("a conversation seen for the first time has lost nothing by what it holds: only its idle says", () => {
    expect(new CacheBreaks().seen("ses", PARTS, 1_000_000, 1_000_000 + MINUTE, HOUR)).toEqual({ lost: false, idle: false, changed: [] });
    expect(new CacheBreaks().seen("ses", PARTS, 1_000_000, 1_000_000 + 2 * HOUR, HOUR)).toEqual({ lost: true, idle: true, changed: [] });
    expect(new CacheBreaks().seen("ses", PARTS, undefined, 1_000_000, HOUR)).toEqual({ lost: false, idle: false, changed: [] });
  });

  test("the same parts again: nothing lost", () => {
    expect(twice({ ...PARTS })).toEqual({ lost: false, idle: false, changed: [] });
  });

  test("a part that reads differently is named, alone, and the cache is lost by it", () => {
    expect(twice({ ...PARTS, memory: "mem2" })).toEqual({ lost: true, idle: false, changed: ["memory"] });
    expect(twice({ ...PARTS, model: "another" })).toEqual({ lost: true, idle: false, changed: ["model"] });
    expect(twice({ ...PARTS, tools: "t2" })).toEqual({ lost: true, idle: false, changed: ["tools"] });
  });

  test("several are named in the order a request carries them; a part that is new and one that is gone count", () => {
    expect(twice({ ...PARTS, recall: "r2", memory: "mem2" }).changed).toEqual(["memory", "recall"]);
    const { recall: _gone, ...without } = PARTS;
    expect(twice(without).changed).toEqual(["recall"]);
    expect(twice({ ...PARTS, skills: "s1" }).changed).toEqual(["skills"]);
  });

  test("idle past the endpoint's lifetime is said as that, beside whatever changed", () => {
    expect(twice({ ...PARTS }, 2 * HOUR)).toEqual({ lost: true, idle: true, changed: [] });
    expect(twice({ ...PARTS, memory: "mem2" }, 2 * HOUR)).toEqual({ lost: true, idle: true, changed: ["memory"] });
  });

  test("each conversation is its own, and the next request is held against the one before it", () => {
    const breaks = new CacheBreaks();
    breaks.seen("a", PARTS, 1, 1, HOUR);
    breaks.seen("b", { ...PARTS, memory: "other" }, 1, 1, HOUR);
    expect(breaks.seen("a", PARTS, 1, 2, HOUR).changed).toEqual([]);
    expect(breaks.seen("b", PARTS, 1, 2, HOUR).changed).toEqual(["memory"]);
    // Once seen as changed, it is the conversation's last: the same again is nothing new.
    expect(breaks.seen("b", PARTS, 1, 3, HOUR).changed).toEqual([]);
  });

  test("the whole prefix as one digest still answers lost or not", () => {
    const breaks = new CacheBreaks();
    expect(breaks.lost("ses", "one", 1, 2, HOUR)).toBe(false);
    expect(breaks.lost("ses", "one", 1, 3, HOUR)).toBe(false);
    expect(breaks.lost("ses", "two", 1, 4, HOUR)).toBe(true);
  });
});

describe("a prompt's parts", () => {
  const context = (over: { memory?: string; senderName?: string } = {}): PromptContext => ({
    agent: fakeAgent({ persona: { identity: "# IDENTITY\n- Name: Nouva\n", soul: "Be terse.", memory: over.memory ?? "# MEMORY\n- likes tea\n" } }),
    tools: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
    harness: { approvalRequired: [], approvalAvailable: false, maxToolIterations: 25, maxTurnDurationMs: 300_000, commands: ["/help"], truncates: true },
    gateway: "telegram",
    chatId: "814",
    chatType: "dm",
    sessionId: "ses",
    model: "m",
    now: new Date("2026-11-14T03:00:00Z"),
    timezone: "UTC",
    ...(over.senderName ? { senderName: over.senderName } : {}),
  });

  test("each section in front of the conversation has a digest by its name; who is speaking is not among them", () => {
    const prompt = buildPrompt(context({ senderName: "Gading" }));
    expect(Object.keys(prompt.parts)).toEqual(prompt.sections.map((section) => section.name).filter((name) => name !== "dynamic"));
    expect(Object.keys(prompt.parts)).toEqual(expect.arrayContaining(["identity", "memory", "harness", "runtime"]));
    for (const digest of Object.values(prompt.parts)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Another person speaking moves what goes after the conversation, and no part in front of it.
    expect(buildPrompt(context({ senderName: "Rina" })).parts).toEqual(prompt.parts);
  });

  test("a section whose text changed is the one whose digest did", () => {
    const before = buildPrompt(context()).parts;
    const after = buildPrompt(context({ memory: "# MEMORY\n- likes tea\n- and coffee\n" })).parts;
    expect(Object.keys(after).filter((name) => after[name] !== before[name])).toEqual(["memory"]);
  });
});

// The conversations' ids are this file's own: the tracker is one for the process, and a suite runs its files in one.
// An id another file used (`ses_idle`, in the stale output's tests) came with that file's parts already remembered,
// and this file's first turn of it was then a change.
describe("at a turn's start, through the executor", () => {
  /** One turn of a conversation whose last message was `idleMs` ago, with what the agent's memory file holds now. */
  async function turn(sessionId: string, memory: string, idleMs = MINUTE, model = "m"): Promise<void> {
    const provider = {
      kind: "anthropic",
      baseUrl: "https://gw.test/v1",
      cacheLifetimeMs: 5 * MINUTE,
      chat: async (_params: ChatParams) => ({ text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model }),
      stream() {
        throw new Error("streaming is off here");
      },
    } as unknown as LLMProvider;
    const agent = fakeAgent();
    agent.persona.memory = memory;
    agent.config.llm = { provider: "gw", model, maxTokens: 128, temperature: 0.7, contextWindow: 1_000_000, compactAtTokens: 900_000 };
    const toolset: AgentToolset = { definitions: [], get: () => undefined, requiresApproval: () => false, parallelSafe: () => false, gate: () => ({ action: "run", via: "allowlist" }), blockedPatterns: [] };
    const at = Date.now() - idleMs;
    const history: ChatMessage[] = [
      { role: "user", content: "what is in the fridge?", timestamp: at },
      { role: "assistant", content: `milk, eggs and ${"a long list ".repeat(200)}`, timestamp: at },
    ];
    await new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: 2, maxTokensPerTurn: 1024 },
        context: { maxContextRatio: 0.8, truncationStrategy: "summary", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.8, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    }).run({
      agent, provider, toolset, history,
      userMessage: { role: "user", content: "and now?", timestamp: Date.now() },
      gateway: "telegram", gatewayId: "telegram:main", chatId: "814", chatType: "dm", sessionId, senderId: "814", turnId: `turn_${sessionId}_${logged.length}`,
    });
  }
  const said = (sessionId: string) => logged.filter((entry) => entry.turn_id?.startsWith(`turn_${sessionId}_`));

  test("a memory file written between two turns of a warm conversation is named, with how much conversation is written again", async () => {
    await turn("cachebreaks_memory", "# MEMORY\n- likes tea\n");
    expect(said("cachebreaks_memory")).toEqual([]);
    await turn("cachebreaks_memory", "# MEMORY\n- likes tea\n- and coffee\n");
    const lines = said("cachebreaks_memory");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", component: "llm.executor", agent_id: "nouva", data: { changed: ["memory"] } });
    // The conversation at stake, estimated: a few hundred tokens of it here, and never nothing.
    expect(lines[0]!.data!.history_tokens as number).toBeGreaterThan(300);
    // Names and a size, nothing of what the memory holds.
    expect(JSON.stringify(lines[0])).not.toContain("coffee");
  });

  test("the same prompt twice says nothing; another model is named as that", async () => {
    await turn("cachebreaks_same", "# MEMORY\n- likes tea\n");
    await turn("cachebreaks_same", "# MEMORY\n- likes tea\n");
    expect(said("cachebreaks_same")).toEqual([]);
    await turn("cachebreaks_same", "# MEMORY\n- likes tea\n", MINUTE, "another-model");
    expect(said("cachebreaks_same").map((entry) => entry.data!.changed)).toEqual([expect.arrayContaining(["model"])]);
  });

  test("a conversation idle past its endpoint's lifetime is not said: its cache was gone whatever the prompt held", async () => {
    await turn("cachebreaks_idle", "# MEMORY\n- likes tea\n");
    await turn("cachebreaks_idle", "# MEMORY\n- likes tea\n- and coffee\n", 20 * MINUTE);
    expect(said("cachebreaks_idle")).toEqual([]);
  });
});
