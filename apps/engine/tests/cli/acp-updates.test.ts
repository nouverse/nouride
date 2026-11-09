/**
 * A conversation's rows as an editor's ACP updates, as a table: each kind of row and what it sends,
 * calls paired by `callId`, the answer sent as the chunks that extend it, a delegate's own turn left out, and every
 * kind of the contract mapped without throwing.
 */

import { describe, expect, test } from "bun:test";
import type { SessionUpdate } from "@nouride/acp";
import { EVENT_EXAMPLES } from "@nouride/shared";
import { TurnUpdates, type EventRow } from "@/cli/acp-updates.ts";

const row = (kind: string, data: Record<string, unknown>, turnId: string | null = "t1"): EventRow => ({ turnId, kind, data });
const chunk = (kind: "agent_message_chunk" | "agent_thought_chunk", text: string): SessionUpdate => ({ sessionUpdate: kind, content: { type: "text", text } });

describe("rows as session updates", () => {
  test("each kind sends what the RFC's table says", () => {
    const turn = new TurnUpdates();
    expect(turn.read(row("reasoning", { step: 1, text: "Checking the fixture." })).updates).toEqual([chunk("agent_thought_chunk", "Checking the fixture.")]);
    expect(turn.read(row("tool", { step: 2, text: "exec bun test", callId: "c1", name: "exec" })).updates).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "c1", title: "exec bun test", kind: "execute", status: "in_progress" },
    ]);
    expect(turn.read(row("audit", { callId: "c1", tool: "exec", args: { command: "bun test" }, ms: 5 })).updates).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "c1", rawInput: { command: "bun test" } },
    ]);
    expect(turn.read(row("tool_done", { step: 3, text: "exec exit 1 · 2.1s", callId: "c1", name: "exec", error: true })).updates).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", content: [{ type: "content", content: { type: "text", text: "exec exit 1 · 2.1s" } }] },
    ]);
    expect(turn.read(row("note", { step: 4, text: "2 calls at once" })).updates).toEqual([chunk("agent_thought_chunk", "2 calls at once")]);
    expect(turn.read(row("waiting", { step: 5, text: "waiting for approval: write", callId: "c2", name: "write", approvalId: "apr_9" }))).toEqual({
      updates: [],
      waiting: { approvalId: "apr_9", text: "waiting for approval: write", callId: "c2", name: "write" },
    });
    expect(turn.read(row("turn", { phase: "end", status: "done", reply: "All green." })).ended).toEqual({ status: "done", reply: "All green." });
  });

  test("a tool's name is the protocol's coarser kind", () => {
    const kinds = ["read", "grep", "write", "web_fetch", "web_search", "send_message"].map((name, index) => {
      const [update] = new TurnUpdates().read(row("tool", { step: 1, text: name, callId: `c${index}`, name })).updates;
      return (update as { kind: string }).kind;
    });
    expect(kinds).toEqual(["read", "search", "edit", "fetch", "search", "other"]);
  });

  test("the answer is sent as the chunks that extend it; one rewritten under them is put right once, at the end", () => {
    const turn = new TurnUpdates();
    expect(turn.read(row("reply", { from: 0, text: "Hel" })).updates).toEqual([chunk("agent_message_chunk", "Hel")]);
    expect(turn.read(row("reply", { from: 3, text: "lo" })).updates).toEqual([chunk("agent_message_chunk", "lo")]);
    expect(turn.finish("Hello world")).toEqual([chunk("agent_message_chunk", " world")]);
    expect(turn.finish("Hello world")).toEqual([]);

    const rewritten = new TurnUpdates();
    rewritten.read(row("reply", { from: 0, text: "Draft" }));
    expect(rewritten.read(row("reply", { from: 0, text: "Final" })).updates).toEqual([]);
    expect(rewritten.finish("Final answer")).toEqual([chunk("agent_message_chunk", "\n\n(corrected)\nFinal answer")]);
  });

  test("a delegate's own turn is no turn of this conversation", () => {
    const turn = new TurnUpdates();
    turn.read(row("turn", { phase: "start", via: "delegate", by: "nox" }, "helper"));
    expect(turn.read(row("tool", { step: 1, text: "exec ls", callId: "h1", name: "exec" }, "helper")).updates).toEqual([]);
    expect(turn.read(row("turn", { phase: "end", status: "done" }, "helper")).ended).toBeUndefined();
  });

  test("every kind of the contract maps without throwing, and a kind newer than this is passed over", () => {
    for (const [kind, data] of Object.entries(EVENT_EXAMPLES)) expect(() => new TurnUpdates().read(row(kind, data as Record<string, unknown>))).not.toThrow();
    expect(new TurnUpdates().read(row("signal", { text: "new" }))).toEqual({ updates: [] });
  });
});
