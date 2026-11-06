/**
 * An agent's stdio MCP server runs as that agent's own user where the daemon found the helper (0.8.1), as its commands
 * do. Run as the daemon's, a shell or file server given to one agent read the database, the vault and every other
 * agent's folder.
 *
 * A real server, started the way the daemon starts one, behind a stand-in for the helper's prefix: it says in its one
 * tool's description who started it, its HOME and the folder it runs in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath, runAgentCommandsThrough } from "@nouride/runtime";
import { McpManager } from "@/modules/tools/mcp.ts";
import { fakeAgent, tempDir } from "../helpers.ts";

/** Answers the handshake and `tools/list`, and says who it runs as, its HOME and its folder. */
const SERVER = `
for await (const line of console) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") {
    reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "who", version: "1" } });
  } else if (message.method === "tools/list") {
    const said = "as=" + (process.env.NR_AGENT ?? "daemon") + " home=" + process.env.HOME + " cwd=" + process.cwd();
    reply({ tools: [{ name: "probe", description: said, inputSchema: { type: "object", properties: {} } }] });
  } else reply({});
}
`;

describe("an agent's stdio MCP server", () => {
  let dir = "";
  const own = (agentId: string) => join(dir, "private", agentId);
  beforeEach(() => {
    dir = tempDir("mcp-agent");
    writeFileSync(join(dir, "server.js"), SERVER);
    mkdirSync(own("ops"), { recursive: true });
  });
  afterEach(() => {
    runAgentCommandsThrough(null);
    removePath(dir);
  });

  const said = async (server: Record<string, unknown>): Promise<string> => {
    const manager = new McpManager({ connectWaitMs: 10_000, privateDir: own });
    try {
      await manager.connectAgent(fakeAgent({ config: { id: "ops", mcpServers: [{ name: "who", transport: "stdio", command: process.execPath, args: [join(dir, "server.js")], ...server }] } as never }));
      return manager.toolsFor("ops").get("who__probe")?.definition.description ?? "not connected";
    } finally {
      await manager.close();
    }
  };

  test("runs as the agent's own user where it has one, in its own folder, with its own HOME", async () => {
    runAgentCommandsThrough({ prefix: (agent) => ["env", `NR_AGENT=${agent}`], put: () => [] });
    const description = await said({});
    expect(description).toContain("as=ops ");
    expect(description).toContain(`home=${own("ops")} `);
    expect(description).toContain(`cwd=${realpathSync(own("ops"))}`);
  });

  test("a folder and variables its block names are still its own: written for that server", async () => {
    runAgentCommandsThrough({ prefix: (agent) => ["env", `NR_AGENT=${agent}`], put: () => [] });
    const description = await said({ cwd: dir, env: { HOME: join(dir, "home") } });
    expect(description).toContain("as=ops ");
    expect(description).toContain(`home=${join(dir, "home")} `);
    expect(description).toContain(`cwd=${realpathSync(dir)}`);
  });

  test("where no helper was found, it runs as the daemon's user, with the daemon's HOME, as before", async () => {
    const description = await said({});
    expect(description).toContain("as=daemon ");
    expect(description).toContain(`home=${process.env.HOME} `);
    expect(description).toContain(`cwd=${realpathSync(process.cwd())}`);
  });
});
