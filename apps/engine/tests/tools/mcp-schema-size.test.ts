/**
 * What an MCP server's tools cost every request of the agent holding them, said where it can be read (G12).
 *
 * The built-ins' schemas are held to a budget by `tool-schema-budget.test.ts`; a server's are somebody else's and
 * arrive when it connects, so the budget never covered them. A real server, started the way the daemon starts one:
 * its size is reported by the manager, on the line that says it is ready, and at warn past `MCP_SCHEMA_WARN_BYTES`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { MCP_SCHEMA_WARN_BYTES, McpManager } from "@/modules/tools/mcp.ts";
import { fakeAgent, tempDir } from "../helpers.ts";

/** Offers `count` tools, each described in `size` characters — its argv says how many and how long. */
const SERVER = `
const [count, size] = process.argv.slice(2).map(Number);
for await (const line of console) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") {
    reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "big", version: "1" } });
  } else if (message.method === "tools/list") {
    const tools = Array.from({ length: count }, (_, n) => ({ name: "tool_" + n, description: "x".repeat(size), inputSchema: { type: "object", properties: {} } }));
    reply({ tools });
  } else reply({});
}
`;

let dir = "";
const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "tools.mcp" && lines.push(entry)));

beforeEach(() => {
  dir = tempDir("mcp-schema");
  writeFileSync(join(dir, "server.js"), SERVER);
  lines.length = 0;
});
afterEach(() => removePath(dir));

async function connected(server: string, count: number, size: number) {
  const manager = new McpManager({ connectWaitMs: 10_000 });
  await manager.connectAgent(
    fakeAgent({ config: { id: "nouva", mcpServers: [{ name: server, transport: "stdio", command: process.execPath, args: [join(dir, "server.js"), String(count), String(size)] }] } as never }),
  );
  return manager;
}

describe("a server's tool schemas", () => {
  test("are measured as the provider receives them: the definitions, as JSON, in bytes", async () => {
    const manager = await connected("docs", 3, 100);
    try {
      const [status] = manager.status();
      const definitions = [...manager.toolsFor("nouva").values()].map((tool) => JSON.stringify(tool.definition));
      expect(status?.schemaBytes).toBe(definitions.reduce((sum, json) => sum + new TextEncoder().encode(json).byteLength, 0));
      expect(lines.find((entry) => entry.message === "mcp server ready")?.data?.schema_bytes).toBe(status!.schemaBytes);
      // Small: said, and nothing more.
      expect(lines.some((entry) => entry.level === "warn")).toBe(false);
    } finally {
      await manager.close();
    }
  });

  test("past the size every request can carry without notice, are said at warn when it connects", async () => {
    const manager = await connected("everything", 4, MCP_SCHEMA_WARN_BYTES / 4);
    try {
      expect(manager.status()[0]!.schemaBytes).toBeGreaterThan(MCP_SCHEMA_WARN_BYTES);
      const warned = lines.find((entry) => entry.level === "warn");
      expect(warned?.message).toContain("tool schemas are large");
      expect(warned?.data).toMatchObject({ server: "everything", tool_count: 4 });
    } finally {
      await manager.close();
    }
  });
});
