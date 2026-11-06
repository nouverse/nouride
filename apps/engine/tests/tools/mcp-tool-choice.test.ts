/**
 * An agent's `tools` list for an MCP server (0.7.21): a tool it leaves out is neither sent to the model nor callable —
 * a call that names it anyway is refused as a tool result, naming the setting, before any gate or approval — and a
 * name the server does not offer is said, never fatal. Measured live: Notion's 65 tools were ~250 KB on every request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { addLogSink, type LogEntry, type ToolCall } from "@nouride/shared";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { McpManager } from "@/modules/tools/mcp.ts";
import { buildMcpTools, schemaBytesOf, unknownChosenTools, type McpToolCaller } from "@/modules/tools/mcp-tools.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent, tempDir } from "../helpers.ts";

const TOOLS = [
  { name: "notion-search", description: "Search the workspace.\nLong prose follows.", inputSchema: { type: "object" as const } },
  { name: "notion-fetch", description: "Fetch a page." },
  { name: "notion-create-pages", description: "Create pages." },
];

function server() {
  const calls: string[] = [];
  const client: McpToolCaller = {
    async callTool(name) {
      calls.push(name);
      return { text: "ok", isError: false };
    },
  };
  return { client, calls };
}

const security = { toolTimeoutMs: 1000, toolMaxOutputBytes: 1024 } as never;

/** The toolset a turn gets for an agent that holds `notion` with this `tools` list — and, gated, the create tool. */
function toolsetWith(only: string[] | undefined) {
  const { client, calls } = server();
  const built = buildMcpTools({
    server: "notion",
    client,
    tools: TOOLS,
    approvalRequired: ["notion__notion-create-pages"],
    ...(only ? { only: { tools: only, where: "agents/nox/mcp.toml" } } : {}),
  });
  const agent = fakeAgent({ config: { id: "nox", tools: { enabled: [], approvalRequired: ["notion__notion-create-pages"], blocked: [] } } as never });
  return { toolset: resolveToolset(agent, new Map(), security, { mcpTools: () => built }), calls, agent };
}

/** One call, through the executor's own tool caller — the path a model's call takes. */
async function callThrough(only: string[] | undefined, name: string) {
  const { toolset, calls, agent } = toolsetWith(only);
  const asked: string[] = [];
  const approvals = {
    canAsk: () => true,
    request: async (ask: { tool: string }) => (asked.push(ask.tool), { status: "approved" as const, by: "gading", decision: "allow-once" as const }),
  };
  const caller = new ToolCaller({ approvals, approvalLevel: () => "careful" } as unknown as ExecutorDeps);
  const req = { toolset, agent, sessionId: "s", chatId: "c", gateway: "telegram", gatewayId: "telegram:main", senderId: "u", chatType: "dm" } as unknown as TurnRequest;
  const result = await caller.run(req, { id: "c1", name, arguments: {} } as ToolCall, 4_000);
  return { result, calls, asked };
}

describe("an agent's tools list", () => {
  test("absent: every tool is sent, as before", () => {
    expect(toolsetWith(undefined).toolset.definitions.map((d) => d.name)).toEqual(["notion__notion-create-pages", "notion__notion-fetch", "notion__notion-search"]);
  });

  test("a tool it leaves out is not sent to the model", () => {
    expect(toolsetWith(["notion-search", "notion-fetch"]).toolset.definitions.map((d) => d.name)).toEqual(["notion__notion-fetch", "notion__notion-search"]);
  });

  test("a call to one it leaves out is refused as an error naming the setting — never sent, nobody asked", async () => {
    const { result, calls, asked } = await callThrough(["notion-search"], "notion__notion-create-pages");
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("`tools` list in agents/nox/mcp.toml");
    expect(String(result.content)).toContain("nouride mcp tools");
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a tool it keeps runs as it did", async () => {
    const { result, calls } = await callThrough(["notion-search"], "notion__notion-search");
    expect(result.isError).toBe(false);
    expect(calls).toEqual(["notion-search"]);
  });

  test("a name the server does not offer is found, so it can be said", () => {
    expect(unknownChosenTools(["notion-search", "notion-old"], TOOLS)).toEqual(["notion-old"]);
    expect(unknownChosenTools(undefined, TOOLS)).toEqual([]);
  });
});

/** Offers the three tools above over stdio, the way the daemon starts a server. */
const SERVER = `
const tools = ${JSON.stringify(TOOLS)};
for await (const line of console) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "notion", version: "1" } });
  else if (message.method === "tools/list") reply({ tools });
  else reply({});
}
`;

describe("a connected server with a tools list", () => {
  let dir = "";
  const lines: LogEntry[] = [];
  addLogSink((entry) => void (entry.component === "tools.mcp" && lines.push(entry)));
  beforeEach(() => {
    dir = tempDir("mcp-choice");
    writeFileSync(join(dir, "server.js"), SERVER);
    lines.length = 0;
  });
  afterEach(() => removePath(dir));

  test("reports what the agent is sent, what was left out, and a name the server does not have — said, not fatal", async () => {
    const manager = new McpManager({ connectWaitMs: 10_000 });
    const config = { name: "notion", transport: "stdio" as const, command: process.execPath, args: [join(dir, "server.js")], tools: ["notion-search", "notion-renamed"] };
    await manager.connectAgent(fakeAgent({ config: { id: "nox", mcpServers: [config] } as never }));
    try {
      const all = manager.toolsFor("nox");
      const offered = [...all.values()].filter((tool) => !tool.withheld);
      const [status] = manager.status();
      expect(status).toMatchObject({ tools: 1, toolsTotal: 3, unknownTools: ["notion-renamed"] });
      expect(status?.schemaBytes).toBe(schemaBytesOf(offered));
      expect(status?.withheldBytes).toBe(schemaBytesOf([...all.values()].filter((tool) => tool.withheld)));

      const rows = manager.toolList("nox", "notion")!;
      expect(rows.map((row) => [row.name, row.on])).toEqual([["notion-search", true], ["notion-fetch", false], ["notion-create-pages", false]]);
      // One line of a server's description, for choosing.
      expect(rows[0]?.description).toBe("Search the workspace.");
      expect(rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0)).toBe(schemaBytesOf(all.values()));

      const warned = lines.find((entry) => entry.message.includes("does not offer"));
      expect(warned?.data).toMatchObject({ server: "notion", unknown: ["notion-renamed"] });
      expect(manager.toolList("nox", "absent")).toBeUndefined();
    } finally {
      await manager.close();
    }
  });
});
