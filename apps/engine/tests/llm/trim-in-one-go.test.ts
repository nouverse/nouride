/**
 * Old tool output is set aside in one go inside a long turn, so the rounds after a trim send the prefix the provider
 * has cached.
 *
 * The trimmer ran before every round and stopped the moment the working set fit. Past the line each round's results
 * put it over again, one more old result went, and every round rewrote bytes early in the conversation: a provider
 * that caches the prefix read nothing back for the rest of the turn. Now a trim goes down to a target well under the
 * line, and the rounds after it change nothing until the set has grown back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateMessagesTokens } from "@nouride/llm";
import { readTextFileIfExists, removePath } from "@nouride/runtime";
import { messageText, type ChatMessage, type ChatParams, type LLMProvider, type Tool } from "@nouride/shared";
import { isTrimmedToolResult, keptPathOf, trimToolResults } from "@/modules/llm/context.ts";
import { ceilingsAt, type WindowFacts } from "@/modules/llm/executor/prepare.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { TRIM_TO_SHARE } from "@/modules/llm/executor/types.ts";
import { ToolOutputSpill } from "@/modules/llm/spill.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { AutoApprovalGate, fakeAgent } from "../helpers.ts";

/** A command's output: lines of words, each round's its own. */
const output = (round: number, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `round ${round} line ${i}: service unit ${i} is active and running`).join("\n");

/** The rounds whose request no longer starts with the request before it: what a provider's prefix cache loses. */
function roundsThatChangedThePrefix(sent: ChatMessage[][]): number[] {
  return sent.flatMap((messages, round) => {
    const before = sent[round - 1];
    return before && JSON.stringify(messages.slice(0, before.length)) !== JSON.stringify(before) ? [round] : [];
  });
}

/** The fewest unchanged rounds between two that changed the prefix. */
const shortestQuiet = (changed: number[]): number => Math.min(...changed.slice(1).map((round, i) => round - changed[i]! - 1));

describe("the target a trim goes down to", () => {
  const facts: WindowFacts = {
    contextWindow: 200_000,
    maxContextRatio: 0.8,
    promptTokens: 6_000,
    toolsTokens: 4_000,
    maxOutputTokens: 8_000,
    compactAtRatio: 0.8,
    totalLimit: { tokens: 160_000, source: "model:default" },
    summaryModel: "m",
    summarizerWindow: 200_000,
  };

  test("is a share of the line the trim starts at, at any scale", () => {
    for (const scale of [1, 2.3]) {
      const ceilings = ceilingsAt(facts, scale);
      expect(ceilings.trimTo).toBe(Math.floor(ceilings.compactAt * TRIM_TO_SHARE));
      expect(ceilings.trimTo).toBeLessThan(ceilings.compactAt);
      // Room for more than one result at the largest size one may have: a trim is not followed by another at once.
      expect(ceilings.compactAt - ceilings.trimTo).toBeGreaterThan(ceilings.toolResultCap);
    }
  });
});

describe("a long turn of many rounds, the trimmer run before each", () => {
  const ROUNDS = 60;
  const KEEP_RECENT = 3;
  let dir: string;
  let spill: ToolOutputSpill;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nouride-trim-"));
    spill = new ToolOutputSpill(join(dir, "tool-output"));
  });
  afterEach(() => removePath(dir));

  const exchange = (round: number): ChatMessage[] => [
    { role: "assistant", content: "", toolCalls: [{ id: `c${round}`, name: "exec", arguments: { command: `status ${round}` } }] },
    { role: "tool", content: output(round, 120), toolCallId: `c${round}` },
  ];
  /** Twenty rounds' results fill the line. */
  const LINE = estimateMessagesTokens(exchange(0)) * 20;

  function turn(targetTokens: number) {
    let working: ChatMessage[] = [{ role: "user", content: "check every service" }];
    const sent: ChatMessage[][] = [];
    const keep = spill.keeperFor({ agentId: "nouva", sessionId: "s1" });
    for (let round = 0; round < ROUNDS; round += 1) {
      working = [...working, ...exchange(round)];
      working = trimToolResults(working, { maxTokens: LINE, targetTokens, keepRecent: KEEP_RECENT, keep }).messages;
      sent.push(working);
    }
    return sent;
  }

  test("the prefix changes once, then the rounds after it are identical until the line is reached again", () => {
    const sent = turn(Math.floor(LINE * TRIM_TO_SHARE));
    const changed = roundsThatChangedThePrefix(sent);

    // It did trim, and again later: the loop went round the line more than once.
    expect(changed.length).toBeGreaterThan(1);
    // Two fifths of twenty rounds' room: seven rounds grow back into it before the eighth trims.
    expect(shortestQuiet(changed)).toBeGreaterThanOrEqual(7);
    expect(changed.length).toBeLessThanOrEqual(6);
    // Every request is at or under the line: trimming less often is not carrying more than the line allows.
    for (const messages of sent) expect(estimateMessagesTokens(messages)).toBeLessThanOrEqual(LINE);
  });

  test("stopping the moment the set fits changed the prefix on nearly every round past the line", () => {
    // What the target replaces, kept as the measure of it: the same turn with the target at the line itself.
    const changed = roundsThatChangedThePrefix(turn(LINE));
    expect(changed.length).toBeGreaterThanOrEqual(ROUNDS - 21);
    expect(shortestQuiet(changed)).toBe(0);
  });

  test("the last round's results and the newest kept ones are whole in every request", () => {
    for (const [round, messages] of turn(Math.floor(LINE * TRIM_TO_SHARE)).entries()) {
      const tools = messages.filter((message) => message.role === "tool");
      expect(tools).toHaveLength(round + 1);
      // The round just run, which the model has not read, and the three before it.
      for (const kept of tools.slice(-(KEEP_RECENT + 1))) expect(isTrimmedToolResult(kept)).toBe(false);
      expect(messageText(tools.at(-1)!.content)).toBe(output(round, 120));
    }
  });

  test("a result set aside is in the file its marker names, whole", async () => {
    const last = turn(Math.floor(LINE * TRIM_TO_SHARE)).at(-1)!;
    const cleared = last.filter(isTrimmedToolResult);
    expect(cleared.length).toBeGreaterThan(20);
    for (const message of cleared) {
      const path = keptPathOf(message);
      expect(path).not.toBeNull();
      expect(await readTextFileIfExists(path!)).toBe(output(Number(message.toolCallId!.slice(1)), 120));
    }
  });

  test("a turn that stays under the line is sent as it is", () => {
    let working: ChatMessage[] = [{ role: "user", content: "check a few" }];
    for (let round = 0; round < 15; round += 1) {
      working = [...working, ...exchange(round)];
      const result = trimToolResults(working, { maxTokens: LINE, targetTokens: Math.floor(LINE * TRIM_TO_SHARE), keepRecent: KEEP_RECENT });
      expect(result.trimmed).toBe(0);
      expect(result.messages).toBe(working);
    }
  });
});

describe("through the executor", () => {
  const ROUNDS = 45;

  test("a long turn's requests keep their prefix between trims", async () => {
    const seen: ChatMessage[][] = [];
    let round = 0;
    const provider = {
      async chat(params: ChatParams) {
        // A copy: what was sent, not the turn's list as it grows after.
        seen.push(structuredClone(params.messages));
        round += 1;
        // No input count: one would teach the executor a token scale this test does not mean to set.
        const usage = { inputTokens: 0, outputTokens: 1, estimated: true as const };
        return round <= ROUNDS
          ? { text: "", toolCalls: [{ id: `c${round}`, name: "status", arguments: { unit: `unit-${round}` } }], stopReason: "tool_use", usage, model: params.model }
          : { text: "all checked", toolCalls: [], stopReason: "stop", usage, model: params.model };
      },
    } as unknown as LLMProvider;
    let calls = 0;
    const status: Tool = {
      definition: { name: "status", description: "A unit's status.", parameters: { type: "object", properties: { unit: { type: "string" } } } },
      requiresApproval: false,
      execute: async () => ({ content: output((calls += 1), 100), isError: false }),
    };
    const toolset = {
      definitions: [status.definition],
      get: (name: string) => (name === "status" ? status : undefined),
      requiresApproval: () => false,
      parallelSafe: () => false,
      gate: () => ({ action: "run", via: "allowlist" }),
      blockedPatterns: [],
    } as unknown as AgentToolset;
    const agent = fakeAgent();
    agent.config.llm = { provider: "nougate", model: "primary", maxTokens: 1024, temperature: 0, contextWindow: 40_000 };

    const result = await new TurnExecutor({
      llm: {
        streaming: { enabled: false, typingIndicator: false, progressInChat: false },
        limits: { maxToolIterations: ROUNDS + 5, maxTokensPerTurn: 4096 },
        context: { maxContextRatio: 0.8, truncationStrategy: "sliding_window", preserveRecentTurns: 1, summaryModel: undefined, compactAtRatio: 0.9, preserveRecentToolResults: 3 },
      } as never,
      approvals: new AutoApprovalGate(),
      timezone: "UTC",
      commands: [],
    }).run({
      agent, provider, toolset, history: [],
      userMessage: { role: "user", content: "check every unit", timestamp: 1 },
      gateway: "web", gatewayId: "web:dashboard", chatId: "chat-1", chatType: "dm", sessionId: "trim-in-one-go", senderId: "u1",
    });

    expect(result.text).toBe("all checked");
    expect(seen).toHaveLength(ROUNDS + 1);
    const changed = roundsThatChangedThePrefix(seen);
    // The premise: the turn's output is past the line several times over, so it trimmed, and more than once.
    expect(seen.at(-1)!.filter(isTrimmedToolResult).length).toBeGreaterThan(ROUNDS / 2);
    expect(changed.length).toBeGreaterThan(1);
    // And between two trims the requests are the same bytes, for rounds on end: not a trim a round.
    expect(shortestQuiet(changed)).toBeGreaterThanOrEqual(7);
    expect(changed.length).toBeLessThanOrEqual(5);
  });
});
