/**
 * Nouride's tools lent to an external agent's CLI (0.8.1, EXTERNAL_AGENTS §4): a CLI started as a real process is
 * given `/mcp/agent` when its session opens, lists what the turn lends — Nouride's own, not what the CLI does itself —
 * and its call runs as one of the turn's, through the executor's own tool path. Between turns, from another address,
 * or with no token of its session's, nothing runs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent, Tool, ToolContext } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { serveHttp, type HttpServer } from "@nouride/runtime";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { stderrSaid } from "./fixtures/stderr.ts";
import { situationOf, untold } from "@/modules/external-agents/situation.ts";
import { CLOCK, clockDeps } from "./fixtures/clock.ts";
import { mountAgentMcp } from "@/modules/web/mcp/agent.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";

const FAKE = join(import.meta.dir, "fixtures/fake-cli.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tool(name: string, run: (args: Record<string, unknown>, ctx: ToolContext) => string): Tool {
  return {
    definition: { name, description: `the ${name} tool`, parameters: { type: "object", properties: {} } },
    requiresApproval: false,
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => ({ content: run(args, ctx), isError: false }),
  } as unknown as Tool;
}

function setup(options: { envHeaders?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "external-lent-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
  const row: CliRow = { id: "fake", name: "Fake CLI", command: process.execPath, args: [FAKE], install: "it is a test", versionArgs: ["--version"], env: { FAKE_MODE: "mcp" }, instructionFile: "AGENTS.md", ...(options.envHeaders ? { mcpEnvHeaders: true } : {}) };
  let server: HttpServer | undefined;
  const service = new ExternalAgents({
    rows: () => [row],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    mcpUrl: () => (server ? `http://127.0.0.1:${server.port}/mcp/agent` : undefined),
  });
  cleanups.push(() => service.stopAll());
  const app = new Hono();
  mountAgentMcp(app, { lent: service.lent, version: "test" });
  server = serveHttp({ port: 0, hostname: "127.0.0.1", fetch: (req, info) => app.fetch(req, { clientAddress: info.address }) });
  cleanups.push(() => server!.stop(true));

  const ran: { name: string; agentId: string; chatId: string }[] = [];
  const tools = new Map<string, Tool>([
    ["notes", tool("notes", (args, ctx) => (ran.push({ name: "notes", agentId: ctx.agentId, chatId: ctx.chatId }), `kept: ${String(args.text)}`))],
    ["exec", tool("exec", () => (ran.push({ name: "exec", agentId: "", chatId: "" }), "ran"))],
  ]);
  // `notes` asks, so a lent call is seen to meet the turn's own gate and approval.
  const toolset = {
    definitions: [...tools.values()].map((entry) => entry.definition),
    get: (name: string) => tools.get(name),
    requiresApproval: (name: string) => name === "notes",
    parallelSafe: () => false,
    gate: (name: string) => (name === "notes" ? { action: "ask", grantable: false, reason: "notes asks in this test" } : { action: "run", via: "allowlist" }),
    blockedPatterns: [],
  } as unknown as AgentToolset;
  const asked: string[] = [];
  const agent = { config: { id: "coder", displayName: "Coder", workspaceRoots: [], external: { cli: "fake" } }, dir } as unknown as LoadedAgent;
  const deps = {
    ...clockDeps,
    approvals: { available: true, canAsk: () => true, request: async (ask: { tool: string }) => (asked.push(ask.tool), { status: "approved", by: "555", decision: "allow-once" }) },
    approvalLevel: () => "careful",
    onActivity: () => {},
  } as unknown as ExecutorDeps;
  const req = {
    agent,
    toolset,
    history: [],
    userMessage: { role: "user", content: "hello" },
    gateway: "telegram",
    gatewayId: "telegram:coder",
    chatId: "555",
    senderId: "555",
    senderName: "Mira",
    sessionId: "session-1",
  } as unknown as TurnRequest;
  return { service, agent, runner: service.runnerFor(agent, deps)!, req, ran, asked, app, url: () => `http://127.0.0.1:${server!.port}/mcp/agent` };
}

describe("Nouride's tools, lent to an external agent's CLI", () => {
  test("its session is given them; it lists Nouride's own, and a call runs as the turn's", async () => {
    const { runner, req, ran, asked } = setup();
    const result = await runner.run(req);
    expect(asked).toEqual(["notes"]);
    // The turn's first prompt opens with who is here (`situation.ts`), whose words are its own test.
    expect(result.text).toBe(`listed=notes notes=kept: ${untold(situationOf(req), undefined)}[telegram] Mira: hello\n\n${CLOCK}/false exec=exec is not one of the tools Nouride lends. Use your own/true`);
    expect(ran).toEqual([{ name: "notes", agentId: "coder", chatId: "555" }]);
  });

  test("between turns, from another address, or without its session's token, nothing runs", async () => {
    const { service, runner, req, ran, app, url } = setup();
    await runner.run(req);
    ran.length = 0;
    const token = service.lent.tokenFor("coder", "telegram:coder|555");
    const call = (headers: Record<string, string>) =>
      fetch(url(), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes", arguments: { text: "late" } } }) });
    const late = (await (await call({ authorization: `Bearer ${token}` })).json()) as { result: { content: { type: string; text: string }[]; isError: boolean } };
    expect(late.result).toEqual({ content: [{ type: "text", text: "notes: no turn of this conversation is running, and Nouride's tools answer inside one" }], isError: true });
    expect((await call({ authorization: "Bearer nagt_made_up" })).status).toBe(401);
    expect((await call({})).status).toBe(401);
    const away = await app.request("/mcp/agent", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" }, { clientAddress: "10.0.0.7" });
    expect(away.status).toBe(404);
    expect(ran).toEqual([]);
  });

  test("to a CLI that fills its headers from its environment, the token is there, never in the headers its command line carries (0.8.1)", async () => {
    // On the live box Claude Code put the session's headers in its argv, and another agent's user read Nix's bearer from
    // /proc — enough to call Nouride's tools as Nix.
    const { service, agent, runner, req, ran, url } = setup({ envHeaders: true });
    const result = await runner.run(req);
    // The turn's first prompt opens with who is here (`situation.ts`), whose words are its own test.
    expect(result.text).toBe(`listed=notes notes=kept: ${untold(situationOf(req), undefined)}[telegram] Mira: hello\n\n${CLOCK}/false exec=exec is not one of the tools Nouride lends. Use your own/true`);
    expect(ran).toEqual([{ name: "notes", agentId: "coder", chatId: "555" }]);
    const given = await stderrSaid(await service.connection(agent), (line) => line.startsWith("mcp-headers:"), 1);
    expect(given).toEqual([`mcp-headers:Bearer \${NOURIDE_MCP_TOKEN} ${service.lent.conversationFor("coder", "telegram:coder|555")}`]);
    // The agent's token with a conversation of another agent's, or with none, is nobody's.
    const call = (headers: Record<string, string>) => fetch(url(), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const own = service.lent.agentToken("coder");
    expect((await call({ authorization: `Bearer ${own}` })).status).toBe(401);
    expect((await call({ authorization: `Bearer ${service.lent.agentToken("other")}`, "x-nouride-conversation": service.lent.conversationFor("coder", "telegram:coder|555") })).status).toBe(401);
    expect((await call({ authorization: `Bearer ${own}`, "x-nouride-conversation": service.lent.conversationFor("coder", "telegram:coder|555") })).status).toBe(200);
  });
});
