/**
 * The executor says a line per model request (0.7.26) — every round and the wrap-up — through `onRequest`, and the
 * chat turn writes each into its record: the stream's `context` row, read back by `nouride turns show`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { ChatParams, ChatResponse, LLMProvider, StreamChunk, Tool } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import type { ContextLine } from "@/modules/llm/executor/context-line.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { TurnRecorder } from "@/modules/turns/recorder.ts";
import { SUMMARY_PREFIX } from "@/modules/llm/summarize.ts";
import { AutoApprovalGate, fakeAgent, tempDir, turnStore } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
beforeEach(async () => {
  dir = tempDir("request-lines");
  db = await openAndMigrate(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  removePath(dir);
});

/** A model that calls `probe` twice, then answers. */
function twoRounds(): LLMProvider {
  let n = 0;
  const answer = (): ChatResponse => {
    n += 1;
    return n <= 2
      ? { text: "", toolCalls: [{ id: `c${n}`, name: "probe", arguments: {} }], stopReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 1 }, model: "m" }
      : { text: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 10, outputTokens: 1 }, model: "m" };
  };
  return {
    kind: "openai",
    baseUrl: "https://fake.test/v1",
    chat: async (_params: ChatParams) => answer(),
    async *stream(): AsyncIterable<StreamChunk> {
      const response = answer();
      if (response.text) yield { type: "text", delta: response.text };
      for (const call of response.toolCalls) yield { type: "tool_call", call };
      yield { type: "usage", usage: response.usage };
      yield { type: "done", stopReason: response.stopReason };
    },
  } as unknown as LLMProvider;
}

const probe: Tool = {
  requiresApproval: false,
  definition: { name: "probe", description: "checks", parameters: { type: "object", properties: {} } },
  execute: async () => ({ content: "checked", isError: false }),
};
const toolset = {
  definitions: [probe.definition],
  get: (name: string) => (name === "probe" ? probe : undefined),
  requiresApproval: () => false,
  parallelSafe: () => false,
  gate: () => ({ action: "run", via: "allowlist" }),
  blockedPatterns: [],
} as unknown as AgentToolset;

async function run(onRequest: (line: ContextLine) => void) {
  const executor = new TurnExecutor({
    llm: {
      streaming: { enabled: true, typingIndicator: false, progressInChat: false },
      limits: { maxToolIterations: 8, maxTokensPerTurn: 1024 },
      context: { maxContextRatio: 0.8, truncationStrategy: "drop", preserveRecentTurns: 2, summaryModel: undefined, compactAtRatio: 0.9, compactAtTokens: 1_000_000, preserveRecentToolResults: 3 },
    } as never,
    approvals: new AutoApprovalGate(),
    timezone: "UTC",
    commands: [],
    onRequest,
  });
  return executor.run({
    agent: fakeAgent(),
    provider: twoRounds(),
    toolset,
    history: [{ role: "user", content: `${SUMMARY_PREFIX}\nHeadline: verifying KK 1.1`, timestamp: 1 }, { role: "assistant", content: "noted", timestamp: 1 }],
    userMessage: { role: "user", content: "carry on", timestamp: 2 },
    gateway: "telegram",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    chatType: "dm",
    sessionId: "s1",
    senderId: "u1",
  });
}

describe("a line per model request", () => {
  test("one per round, numbered from 1, with the request's size and the summary that was in it", async () => {
    const lines: ContextLine[] = [];
    await run((line) => void lines.push(line));
    expect(lines.map((line) => line.request)).toEqual([1, 2, 3]);
    expect(lines.every((line) => line.summary && line.notes === false && line.cleared === 0)).toBe(true);
    // Grows as the turn's own results are added: the size is of the request, not of the turn's question.
    expect(lines[0]!.estimatedTokens).toBeGreaterThan(0);
    expect(lines[2]!.estimatedTokens).toBeGreaterThan(lines[0]!.estimatedTokens);
  });

  test("…written to the turn's record, and read back with it", async () => {
    const turns = turnStore(db);
    const record = TurnRecorder.begin(turns, { sessionId: "s1", agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", prompt: "carry on" })!;
    await run((line) => record.context(line));
    record.finish({ status: "done", reply: "done" });
    const seen = new TurnInspector(db).inspect(record.id)!;
    expect(seen.contexts?.map((line) => [line.request, line.summary])).toEqual([[1, true], [2, true], [3, true]]);
    // Not steps: the turn's step log is what it did.
    expect(seen.steps.every((step) => !step.text.includes("tokens"))).toBe(true);
  });
});
