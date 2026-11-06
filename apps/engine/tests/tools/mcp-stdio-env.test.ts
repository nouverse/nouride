/**
 * The ssh-agent socket reaches the stdio MCP servers of an agent that asked for it, and no others (S11).
 *
 * A real server, started the way the daemon starts one: it reports `SSH_AUTH_SOCK` as it sees it in its one tool's
 * description, so what is asserted is the environment of the process the manager actually spawned.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { addLogSink } from "@nouride/shared";
import { McpManager } from "@/modules/tools/mcp.ts";
import { fakeAgent, tempDir } from "../helpers.ts";

const SOCKET = "/tmp/nouride-test-mcp-agent.sock";

/** Answers the handshake and `tools/list`, and says what socket it was started with. */
const SERVER = `
for await (const line of console) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") {
    reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "envy", version: "1" } });
  } else if (message.method === "tools/list") {
    const socket = process.env.SSH_AUTH_SOCK ?? "unset";
    const token = process.env.SERVICE_TOKEN ?? "unset";
    reply({ tools: [{ name: "probe", description: "socket=" + socket + " token=" + token, inputSchema: { type: "object", properties: {} } }] });
  } else reply({});
}
`;

describe("a stdio MCP server's ssh-agent socket", () => {
  let dir = "";
  let before: string | undefined;
  beforeEach(() => {
    dir = tempDir("mcp-env");
    writeFileSync(join(dir, "server.js"), SERVER);
    before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = SOCKET;
  });
  afterEach(() => {
    removePath(dir);
    if (before === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = before;
  });

  test("is handed only to the servers of an agent whose pack says ssh_agent = true", async () => {
    const server = { name: "envy", transport: "stdio" as const, command: process.execPath, args: [join(dir, "server.js")] };
    const manager = new McpManager({ connectWaitMs: 10_000 });
    try {
      await manager.connectAgent(fakeAgent({ config: { id: "ops", sshAgent: true, mcpServers: [server] } as never }));
      await manager.connectAgent(fakeAgent({ config: { id: "nouva", mcpServers: [server] } as never }));

      expect(manager.toolsFor("ops").get("envy__probe")?.definition.description).toContain(`socket=${SOCKET}`);
      expect(manager.toolsFor("nouva").get("envy__probe")?.definition.description).toContain("socket=unset");
    } finally {
      await manager.close();
    }
  });

  test("a server's own env still wins: an operator who named a socket for one server meant that one", async () => {
    const server = {
      name: "envy",
      transport: "stdio" as const,
      command: process.execPath,
      args: [join(dir, "server.js")],
      env: { SSH_AUTH_SOCK: "/tmp/nouride-test-named.sock" },
    };
    const manager = new McpManager({ connectWaitMs: 10_000 });
    try {
      await manager.connectAgent(fakeAgent({ config: { id: "ops", sshAgent: true, mcpServers: [server] } as never }));
      expect(manager.toolsFor("ops").get("envy__probe")?.definition.description).toContain("socket=/tmp/nouride-test-named.sock");
    } finally {
      await manager.close();
    }
  });
});

describe("a stdio MCP server's credential variables (env_secrets, 0.7.19)", () => {
  let dir = "";
  beforeEach(() => {
    dir = tempDir("mcp-env-secrets");
    writeFileSync(join(dir, "server.js"), SERVER);
  });
  afterEach(() => removePath(dir));

  const server = { name: "envy", transport: "stdio" as const, command: process.execPath, args: [join(dir, "server.js")], envSecrets: { SERVICE_TOKEN: "service_token" } };

  test("arrive in the process's environment, resolved from the store when it starts", async () => {
    const asked: string[] = [];
    const secrets = { require: (name: string) => (asked.push(name), "tok-from-the-store") };
    const manager = new McpManager({ connectWaitMs: 10_000, secrets });
    try {
      await manager.connectAgent(fakeAgent({ config: { id: "ops", mcpServers: [{ ...server, args: [join(dir, "server.js")] }] } as never }));
      expect(manager.toolsFor("ops").get("envy__probe")?.definition.description).toContain("token=tok-from-the-store");
      expect(asked).toEqual(["service_token"]);
    } finally {
      await manager.close();
    }
  });

  test("a secret that is not set stops the server from starting, and says which", async () => {
    const said: string[] = [];
    addLogSink((entry) => void said.push(`${entry.message} ${JSON.stringify(entry.data ?? {})}`));
    const secrets = {
      require: (name: string, usedBy: string) => {
        throw new Error(`secret "${name}" is not set (${usedBy})`);
      },
    };
    const manager = new McpManager({ connectWaitMs: 10_000, secrets });
    try {
      await manager.connectAgent(fakeAgent({ config: { id: "ops", mcpServers: [{ ...server, args: [join(dir, "server.js")] }] } as never }));
      expect(manager.toolsFor("ops").get("envy__probe")).toBeUndefined();
      expect(said.some((line) => line.includes('MCP server \\"envy\\" env SERVICE_TOKEN'))).toBe(true);
    } finally {
      await manager.close();
    }
  });
});
