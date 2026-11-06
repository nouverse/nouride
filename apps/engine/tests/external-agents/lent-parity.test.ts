/**
 * What a coding CLI is lent since 0.8.11 (RFC Part C §C.5): what a Nouride agent does that a CLI cannot do itself — a new
 * agent, the household's skills, an MCP server to add, a credential from chat kept, the conversation's earlier files —
 * each lent only where the agent's own toolset holds it, and each call met by the turn's own gate and approval. What the
 * CLI does itself, and what stays a Nouride agent's, is still answered "not one of the tools Nouride lends". The toolset
 * is the registry's own, resolved from `"*"` as the loader writes it; the calls go through the executor's `ToolCaller`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstruction } from "@/modules/external-agents/instruction.ts";
import type { CliConnection } from "@/modules/external-agents/connection.ts";
import { BUILTIN_TOOLS } from "@nouride/persona";
import type { LoadedAgent, Tool, ToolContext } from "@nouride/shared";
import { LentTools, lends } from "@/modules/external-agents/lent-tools.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";

const PARITY = ["agent_create", "skill_create", "skill_toggle", "skill_improve", "skill_search", "skill_install", "mcp_search", "secret_save", "attachment_read"];

/** A built-in stand-in: `agent_create` asks, as the real one does — on the fixed list, as `config`. */
function builtin(name: string, ran: string[]): Tool {
  return {
    definition: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } },
    requiresApproval: name === "agent_create",
    ...(name === "agent_create" ? { gate: () => ({ action: "ask", grantable: false, hardline: true, hardlineClass: "config", reason: "it makes a new agent" }) } : {}),
    execute: async (_args: Record<string, unknown>, ctx: ToolContext) => (ran.push(`${name}:${ctx.agentId}:${ctx.lent ? "lent" : "own"}`), { content: `${name} ran`, isError: false }),
  } as unknown as Tool;
}

function lentFor(enabled: readonly string[]) {
  const ran: string[] = [];
  const asked: string[] = [];
  const registry = new Map(BUILTIN_TOOLS.map((name) => [name, builtin(name, ran)] as const));
  // `"*"` as the loader writes it: every built-in named, `everyTool` set.
  const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake" }, workspaceRoots: [], tools: { enabled: [...enabled], everyTool: true, approvalRequired: [], blocked: [] } }, dir: "/w/coder" } as unknown as LoadedAgent;
  const toolset = resolveToolset(agent, registry, DEFAULT_CONFIG.security);
  const req = { agent, toolset, history: [], userMessage: { role: "user", content: "hi" }, gateway: "telegram", gatewayId: "telegram:coder", chatId: "555", chatType: "dm", senderId: "555", sessionId: "s1" } as unknown as TurnRequest;
  const deps = {
    approvals: { available: true, canAsk: () => true, request: async (ask: { tool: string }) => (asked.push(ask.tool), { status: "approved", by: "555", decision: "allow-once" }) },
    approvalLevel: () => "balanced",
    onActivity: () => {},
  } as unknown as ExecutorDeps;
  const lent = new LentTools();
  const session = { agentId: "coder", key: "telegram:coder|555" };
  lent.begin(session.agentId, session.key, req, deps);
  return { lent, session, ran, asked };
}

describe("what a CLI is lent since 0.8.11", () => {
  test("on `\"*\"`: each of the nine, and none of what the CLI does itself or what stays a Nouride agent's", () => {
    const { lent, session } = lentFor(BUILTIN_TOOLS);
    const names = lent.definitions(session).map((definition) => definition.name);
    for (const name of PARITY) expect(names).toContain(name);
    for (const name of ["exec", "session", "read", "write", "edit", "multi_edit", "glob", "grep", "web_fetch", "web_search", "nouride", "update", "session_status"]) expect(names).not.toContain(name);
  });

  test("only what the agent's own toolset holds: one whose `[tools] enabled` leaves out `agent_create` is not lent it", async () => {
    const { lent, session, ran } = lentFor(BUILTIN_TOOLS.filter((name) => name !== "agent_create"));
    expect(lent.definitions(session).map((definition) => definition.name)).not.toContain("agent_create");
    const call = await lent.call(session, "agent_create", { id: "nexa" });
    expect(call.isError).toBe(true);
    expect(call.content).toStartWith('Unknown tool "agent_create".');
    expect(ran).toEqual([]);
  });

  test("a lent `agent_create` asks a person first, as a model's does — then runs as the turn's, marked lent", async () => {
    const { lent, session, ran, asked } = lentFor(BUILTIN_TOOLS);
    const call = await lent.call(session, "agent_create", { id: "nexa" });
    expect(asked).toEqual(["agent_create"]);
    expect(call).toMatchObject({ content: "agent_create ran", isError: false });
    // `ToolContext.lent`: what the tool answers over MCP is text alone, and a CLI's shell is its process's (§C.6, §C.7).
    expect(ran).toEqual(["agent_create:coder:lent"]);
  });

  test("`nouride`, `update` and `session_status` are still a Nouride agent's", async () => {
    const { lent, session, ran } = lentFor(BUILTIN_TOOLS);
    for (const name of ["nouride", "update", "session_status"]) {
      expect(lends(name)).toBe(false);
      expect((await lent.call(session, name, {})).content).toBe(`${name} is not one of the tools Nouride lends. Use your own`);
    }
    expect(ran).toEqual([]);
  });
});

describe("what its instructions say Nouride's server does", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("the conversation's earlier files, a credential kept, the household's skills, a new agent, an MCP server", async () => {
    const folder = mkdtempSync(join(tmpdir(), "lent-instructions-"));
    dirs.push(folder);
    const agent = { config: { displayName: "Coder" }, persona: { identity: "# IDENTITY" } } as unknown as LoadedAgent;
    await writeInstruction(agent, { row: { name: "Claude Code", instructionFile: "CLAUDE.md" }, launch: {} } as unknown as CliConnection, folder);
    expect(readFileSync(join(folder, "CLAUDE.md"), "utf8")).toContain(
      "sending a message or a file, a file sent earlier in this conversation (`attachment_read`), keeping a credential sent in chat (`secret_save`), skills in the household's pool, a new agent, and an MCP server to add.",
    );
  });
});
