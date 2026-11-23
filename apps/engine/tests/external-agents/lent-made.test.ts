/**
 * What a call of Nouride's made, said on a coding CLI's own step: a page of its own (`ToolResult.page`), a change to what
 * the person has open on a dashboard page (`ToolResult.liveEdit`).
 *
 * A model of ours has both written on its call's `tool_done` by the executor, and the page under the chat reads them
 * there. A CLI's steps are its own to say, and the call's answer went back over MCP as text: an agent on Claude Code or
 * Codex, asked to change the automation open on a page, answered that it was drawn there, and nothing was drawn. The
 * step the CLI says has ended is now written with what the call made.
 */

import { describe, expect, test } from "bun:test";
import { BUILT_IN_CLIS, type SessionUpdate } from "@nouride/acp";
import type { LoadedAgent, Tool, ToolResult } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { LentTools } from "@/modules/external-agents/lent-tools.ts";
import { UpdateReader } from "@/modules/external-agents/updates.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { eventually } from "../wait.ts";

const SESSION = { agentId: "coder", key: "web:coder|chat-1" };

/**
 * A CLI's turn lent `schedule` and `mission`, each answering what `answers` says for its name; `end` is the turn's end.
 * Both are the daemon's to offer, to an agent that holds a tool at all: `plan` here.
 */
function turn(answers: Record<string, ToolResult | (() => Promise<ToolResult>)>, lent = new LentTools()) {
  const tool = (name: string): Tool =>
    ({
      definition: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } },
      execute: async () => {
        const answer = answers[name] ?? { content: `${name} ran`, isError: false };
        return typeof answer === "function" ? await answer() : answer;
      },
    }) as unknown as Tool;
  const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" }, workspaceRoots: [], tools: { enabled: ["plan"], everyTool: false, approvalRequired: [], blocked: [] } }, dir: "/w/coder" } as unknown as LoadedAgent;
  const toolset = resolveToolset(agent, new Map([["plan", tool("plan")]]), DEFAULT_CONFIG.security, { scheduleTool: tool("schedule"), missionTool: tool("mission") });
  const req = { agent, toolset, history: [], userMessage: { role: "user", content: "hi" }, gateway: "web", gatewayId: "web:coder", chatId: "chat-1", chatType: "dm", senderId: "u1", sessionId: "s1" } as unknown as TurnRequest;
  const deps = { approvals: { available: true, canAsk: () => true, request: async () => ({ status: "approved", by: "u1", decision: "allow-once" }) }, approvalLevel: () => "trusted", onActivity: () => {} } as unknown as ExecutorDeps;
  const end = lent.begin(SESSION.agentId, SESSION.key, req, deps);
  return { lent, end };
}

/** The CLI's steps as the turn's sink is given them, read by a reader that asks `lent` what its calls made. */
function steps(lent: LentTools) {
  const done: Record<string, unknown>[] = [];
  const read = new UpdateReader(
    { text: () => {}, activity: (kind, _text, detail) => void (kind === "tool_done" && done.push(detail ?? {})), plan: () => {}, preamble: async () => false },
    undefined,
    // Read as Claude Code's row has its updates read: a helper's call is marked by its connector.
    { made: () => lent.takeMade(SESSION.agentId, SESSION.key), helper: BUILT_IN_CLIS.find((row) => row.id === "claude-code")!.helper! },
  );
  const call = (id: string, title: string): SessionUpdate => ({ sessionUpdate: "tool_call", toolCallId: id, title, kind: "other", status: "in_progress" }) as SessionUpdate;
  const ended = (id: string, status: "completed" | "failed" = "completed"): SessionUpdate => ({ sessionUpdate: "tool_call_update", toolCallId: id, status }) as SessionUpdate;
  return { read, done, call, ended };
}

const DRAWN: ToolResult = { content: "Drawn on the page they have open.", isError: false, liveEdit: "edit_1" };

describe("what a lent call made", () => {
  test("is handed over once: the change it wrote to what is open, and the page of what it made", async () => {
    const { lent } = turn({ schedule: DRAWN, mission: { content: "Drafted.", isError: false, page: "/missions/msn_1" } });
    expect(lent.takeMade(SESSION.agentId, SESSION.key)).toBeNull();
    await lent.call(SESSION, "schedule", {});
    await lent.call(SESSION, "mission", {});
    expect(lent.takeMade(SESSION.agentId, SESSION.key)).toEqual({ liveEdit: "edit_1", page: "/missions/msn_1" });
    expect(lent.takeMade(SESSION.agentId, SESSION.key)).toBeNull();
  });

  test("a call that was refused made nothing, whatever its answer carries", async () => {
    const { lent } = turn({ schedule: { content: "Not drawn on the page: a step has nothing written.", isError: true, liveEdit: "edit_9" } });
    await lent.call(SESSION, "schedule", {});
    expect(lent.takeMade(SESSION.agentId, SESSION.key)).toBeNull();
  });

  test("what no step of the turn took is not the next turn's; nor is what a call answers after its turn ended", async () => {
    const first = turn({ schedule: DRAWN });
    await first.lent.call(SESSION, "schedule", {});
    first.end();
    expect(first.lent.takeMade(SESSION.agentId, SESSION.key)).toBeNull();

    let answer: ((result: ToolResult) => void) | null = null;
    const slow = turn({ schedule: () => new Promise<ToolResult>((resolve) => (answer = resolve)) });
    const calling = slow.lent.call(SESSION, "schedule", {});
    await eventually(() => answer !== null, 2_000, "the call at work");
    // The turn ends, and another of the same conversation begins, while the call is still out.
    slow.end();
    turn({}, slow.lent);
    answer!(DRAWN);
    expect(await calling).toMatchObject({ liveEdit: "edit_1" });
    expect(slow.lent.takeMade(SESSION.agentId, SESSION.key)).toBeNull();
  });
});

describe("the CLI's own step is written with it", () => {
  test("the step that ends once the call has answered carries the change's id, and no later step carries it again", async () => {
    const { lent } = turn({ schedule: DRAWN });
    const cli = steps(lent);
    cli.read.read(cli.call("t1", "mcp__nouride__schedule"));
    await lent.call(SESSION, "schedule", {});
    cli.read.read(cli.ended("t1"));
    cli.read.read(cli.call("t2", "ls"));
    cli.read.read(cli.ended("t2"));
    expect(cli.done).toEqual([
      { callId: "t1", name: expect.any(String), error: false, outcome: "ok", liveEdit: "edit_1" },
      { callId: "t2", name: expect.any(String), error: false, outcome: "ok" },
    ]);
  });

  test("a page of what a call made rides the same way: the page under the chat reads it again at that step", async () => {
    const { lent } = turn({ mission: { content: "Drafted.", isError: false, page: "/missions/msn_1" } });
    const cli = steps(lent);
    cli.read.read(cli.call("t1", "mcp__nouride__mission"));
    await lent.call(SESSION, "mission", {});
    cli.read.read(cli.ended("t1"));
    expect(cli.done).toEqual([{ callId: "t1", name: expect.any(String), error: false, outcome: "ok", page: "/missions/msn_1" }]);
  });

  test("a step that failed does not carry it: it waits for the agent's next step that ends well", async () => {
    const { lent } = turn({ schedule: DRAWN });
    const cli = steps(lent);
    cli.read.read(cli.call("t1", "cat missing.txt"));
    cli.read.read(cli.call("t2", "mcp__nouride__schedule"));
    await lent.call(SESSION, "schedule", {});
    cli.read.read(cli.ended("t1", "failed"));
    cli.read.read(cli.ended("t2"));
    expect(cli.done).toEqual([
      { callId: "t1", name: expect.any(String), error: true, outcome: "failed" },
      { callId: "t2", name: expect.any(String), error: false, outcome: "ok", liveEdit: "edit_1" },
    ]);
  });

  test("nor does a step of a helper the CLI started itself: the change was the agent's own call's", async () => {
    const { lent } = turn({ schedule: DRAWN });
    const cli = steps(lent);
    const helpers = { _meta: { claudeCode: { parentToolUseId: "agent_1" } } };
    cli.read.read({ ...cli.call("h1", "bun test"), ...helpers } as SessionUpdate);
    cli.read.read(cli.call("t1", "mcp__nouride__schedule"));
    await lent.call(SESSION, "schedule", {});
    cli.read.read({ ...cli.ended("h1"), ...helpers } as SessionUpdate);
    cli.read.read(cli.ended("t1"));
    expect(cli.done).toEqual([
      { callId: "h1", name: expect.any(String), error: false, outcome: "ok" },
      { callId: "t1", name: expect.any(String), error: false, outcome: "ok", liveEdit: "edit_1" },
    ]);
  });

  test("a reader told of no lent calls writes its steps as before", () => {
    const done: Record<string, unknown>[] = [];
    const read = new UpdateReader({ text: () => {}, activity: (kind, _text, detail) => void (kind === "tool_done" && done.push(detail ?? {})), plan: () => {}, preamble: async () => false });
    read.read({ sessionUpdate: "tool_call", toolCallId: "t1", title: "ls", kind: "execute", status: "in_progress" } as SessionUpdate);
    read.read({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } as SessionUpdate);
    expect(done).toEqual([{ callId: "t1", name: expect.any(String), error: false, outcome: "ok" }]);
  });
});
