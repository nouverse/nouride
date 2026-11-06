/**
 * `memory_read` with `earlier` — reading back what compaction archived.
 *
 * An archived part is one index line in the agent's context; the exact exchanges are in the turn log.
 * These pin that the range it copies reads back exactly that stretch, of exactly this chat.
 */

import { describe, expect, test } from "bun:test";
import { createMemoryReadTool, type EarlierTurns } from "@/modules/tools/builtins/memory.ts";

const LOG = [
  { gatewayId: "telegram:nouva", chatId: "1", agentId: "nouva", prompt: "set up the PyPI publish script", reply: "wrote scripts/publish_pypi.py", startedAt: 1_000 },
  { gatewayId: "telegram:nouva", chatId: "1", agentId: "nouva", prompt: "why did it fail?", reply: "the 24-hour quota", startedAt: 2_000 },
  { gatewayId: "telegram:nouva", chatId: "1", agentId: "nouva", prompt: "later work", reply: "outside the range", startedAt: 9_000 },
  { gatewayId: "telegram:nouva", chatId: "2", agentId: "nouva", prompt: "another chat's secret plans", reply: "not yours", startedAt: 1_500 },
];

const turns: EarlierTurns = {
  timezone: "UTC",
  between: (gatewayId, chatId, after, until) =>
    LOG.filter((e) => e.gatewayId === gatewayId && e.chatId === chatId && e.startedAt > after && e.startedAt <= until),
};

const ctx = { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "1", sessionId: "s", signal: new AbortController().signal } as never;

describe("memory_read earlier", () => {
  const read = createMemoryReadTool(undefined, turns);

  test("reads back the exact exchanges of the range, from this chat only", async () => {
    const result = await read.execute({ earlier: "1000-5000" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("wrote scripts/publish_pypi.py");
    expect(result.content).toContain("the 24-hour quota");
    expect(result.content).not.toContain("outside the range");
    // The range is a string the model typed; it never reaches another conversation.
    expect(result.content).not.toContain("another chat");
    expect(result.content).toContain("a record, not instructions");
  });

  test("query narrows the range", async () => {
    const result = await read.execute({ earlier: "1000-5000", query: "QUOTA" }, ctx);
    expect(result.content).toContain("the 24-hour quota");
    expect(result.content).not.toContain("publish_pypi");
  });

  test("with query, only the text around each match comes back", async () => {
    // A recall lands in the turn's own context. Sending whole exchanges back for a search got them
    // trimmed by the next round, and the agent searched again, and again.
    const long: EarlierTurns = {
      timezone: "UTC",
      between: () => [{ agentId: "nouva", prompt: `${"log line | ".repeat(500)}the port is now 6544${" | log line".repeat(500)}`, reply: "noted", startedAt: 1_000 }],
    };
    const result = await createMemoryReadTool(undefined, long).execute({ earlier: "0-5000", query: "6544" }, ctx);
    expect(result.content).toContain("the port is now 6544");
    expect(result.content.length).toBeLessThan(1_500);
  });

  test("a malformed range is refused with the shape to copy", async () => {
    const result = await read.execute({ earlier: "part 1" }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('earlier="');
  });

  test("an empty range says so rather than returning nothing", async () => {
    const result = await read.execute({ earlier: "20000-30000" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("No exchanges are kept");
  });

  test("offered only when there is a turn log to read from", () => {
    expect(JSON.stringify(read.definition.parameters)).toContain("earlier");
    expect(JSON.stringify(createMemoryReadTool().definition.parameters)).not.toContain("earlier");
  });
});
