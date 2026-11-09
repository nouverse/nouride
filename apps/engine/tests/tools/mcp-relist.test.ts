/**
 * A server's tools, taken up again when it says they changed.
 *
 * Until 0.7.13 every notification was dropped: an agent kept the tools its server listed at connect until a reload, and
 * a tool the server had taken away was still offered. Now a `tools/list_changed` from a server that declared it lists
 * them again into the agent's slot, and the log says what was added, removed and changed. A turn already running keeps
 * the list it started with; the next one has the new list.
 *
 * Against a real server, started the way the daemon starts one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { addLogSink, type LogEntry, type ToolContext } from "@nouride/shared";
import { McpManager } from "@/modules/tools/mcp.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent, tempDir } from "../helpers.ts";
import { eventually } from "../wait.ts";

/**
 * Declares `tools.listChanged`, and changes its tools when `change_tools` is called: adds, removes, gives `echo` a new
 * schema, and says so `notify` times.
 */
const SERVER = `
const ECHO = { name: "echo", description: "says it back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
let tools = [ECHO, { name: "shout", inputSchema: { type: "object" } }, { name: "change_tools", inputSchema: { type: "object" } }];
for await (const line of console) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") {
    reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "shifty", version: "1" } });
  } else if (message.method === "tools/list") {
    reply({ tools });
  } else if (message.method === "tools/call" && message.params.name === "change_tools") {
    const args = message.params.arguments;
    tools = tools.filter((tool) => !args.remove.includes(tool.name)).concat(args.add.map((name) => ({ name, description: "new: " + name, inputSchema: { type: "object" } })));
    tools = tools.map((tool) => (tool.name === "echo" ? { ...tool, inputSchema: { ...ECHO.inputSchema, properties: { ...ECHO.inputSchema.properties, loud: { type: "boolean" } } } } : tool));
    for (let n = 0; n < args.notify; n += 1) console.log(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    reply({ content: [{ type: "text", text: "changed" }] });
  } else if (message.method === "tools/call") {
    reply({ content: [{ type: "text", text: String(message.params.arguments.text) }] });
  } else reply({});
}
`;

const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component === "tools.mcp" && lines.push(entry)));

const ctx = { agentId: "nouva", signal: new AbortController().signal } as ToolContext;
const security = { toolTimeoutMs: 1000, toolMaxOutputBytes: 1024 } as never;
const sorted = (names: Iterable<string>) => [...names].sort();

let dir = "";
beforeEach(() => {
  dir = tempDir("mcp-relist");
  writeFileSync(join(dir, "server.js"), SERVER);
  lines.length = 0;
});
afterEach(() => removePath(dir));

describe("a server that says its tools changed", () => {
  test("is listed again into the agent's slot — said in the log — and the next turn has the new list; a running one keeps its own", async () => {
    const agent = fakeAgent({ config: { id: "nouva", mcpServers: [{ name: "shifty", transport: "stdio", command: process.execPath, args: [join(dir, "server.js")] }] } as never });
    const manager = new McpManager({ connectWaitMs: 10_000 });
    try {
      await manager.connectAgent(agent);
      expect(sorted(manager.toolsFor("nouva").keys())).toEqual(["shifty__change_tools", "shifty__echo", "shifty__shout"]);
      const toolsets = { mcpTools: (id: string) => manager.toolsFor(id) };
      // A turn that began before the change, and what its model was given.
      const running = resolveToolset(agent, new Map(), security, toolsets);
      const given = JSON.stringify(running.definitions);

      await manager.toolsFor("nouva").get("shifty__change_tools")!.execute({ add: ["weather"], remove: ["shout"], notify: 4 }, ctx);
      await eventually(() => manager.toolsFor("nouva").has("shifty__weather"), 4_000, "the new list in the slot");

      expect(sorted(manager.toolsFor("nouva").keys())).toEqual(["shifty__change_tools", "shifty__echo", "shifty__weather"]);
      const said = lines.filter((line) => line.message.startsWith("mcp server's tools changed"));
      expect(said.map((line) => [line.level, line.agent_id, line.data])).toEqual([
        ["info", "nouva", expect.objectContaining({ server: "shifty", added: ["shifty__weather"], removed: ["shifty__shout"], changed: ["shifty__echo"], tools: 3 })],
      ]);
      expect(manager.status()).toEqual([expect.objectContaining({ server: "shifty", tools: 3 })]);

      // The running turn: the same definitions, and the removed tool still there to call.
      expect(JSON.stringify(running.definitions)).toBe(given);
      expect(running.get("shifty__shout")).toBeDefined();
      expect(running.get("shifty__echo")?.definition.parameters).not.toHaveProperty("properties.loud");
      // The next turn.
      const next = resolveToolset(agent, new Map(), security, toolsets);
      expect(next.definitions.map((definition) => definition.name)).toEqual(["shifty__change_tools", "shifty__echo", "shifty__weather"]);
      expect(next.get("shifty__echo")?.definition.parameters).toHaveProperty("properties.loud");
      // And the new tools call the same server.
      expect((await next.get("shifty__echo")!.execute({ text: "still here" }, ctx)).content).toContain("still here");
    } finally {
      await manager.close();
    }
  });
});

/**
 * Which slot a listing lands in. A reconnect writes its new client into the slot it replaces, and a handshake that has
 * not been seated yet is not in any slot: the slot is found by its client, and the old client of a replaced slot is
 * no longer heard.
 */
describe("where a new list goes", () => {
  type Internals = {
    byAgent: Map<string, unknown[]>;
    retool(agentId: string, client: unknown, connection: unknown, listed: { name: string }[]): void;
  };
  const connection = (client: object) => ({ client, config: { name: "files" }, tools: new Map<string, unknown>(), approvalRequired: [] as string[], attempt: 0 });
  const names = (slot: { tools: Map<string, unknown> }) => sorted(slot.tools.keys());

  test("the seated slot that holds the client", () => {
    const manager = new McpManager();
    const internals = manager as unknown as Internals;
    const client = {};
    const slot = connection(client);
    internals.byAgent.set("nouva", [slot]);

    internals.retool("nouva", client, slot, [{ name: "ls" }]);

    expect(names(slot)).toEqual(["files__ls"]);
  });

  test("after a reconnect, the slot hears its new client and no longer its old one", () => {
    const manager = new McpManager();
    const internals = manager as unknown as Internals;
    const old = {};
    const slot = connection(old);
    internals.byAgent.set("nouva", [slot]);
    // `reseat`: the replacement's client written into the slot.
    const replacement = connection({});
    slot.client = replacement.client;

    internals.retool("nouva", old, slot, [{ name: "stale" }]);
    expect(names(slot)).toEqual([]);
    internals.retool("nouva", replacement.client, replacement, [{ name: "fresh" }]);
    expect(names(slot)).toEqual(["files__fresh"]);
  });

  test("a handshake not yet seated: the connection that will be", () => {
    const manager = new McpManager();
    const internals = manager as unknown as Internals;
    const client = {};
    const pending = connection(client);

    internals.retool("nouva", client, pending, [{ name: "ls" }]);

    expect(names(pending)).toEqual(["files__ls"]);
    expect(manager.status()).toEqual([]);
  });
});
