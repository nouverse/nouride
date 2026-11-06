/**
 * A server's first start (0.8.10). One whose first start failed was left out until the agent was reloaded — a box that
 * booted before its network was up, or a `uvx` that took longer to fetch its server than the handshake waited, kept
 * its tools away until a restart — while one lost after it had connected came back by itself. And the handshake waited
 * the request timeout, thirty seconds, so `uvx` fetching a Python on a slow link was killed mid-download every time.
 * Found by the release gate, on a slow network: the library's `uvx` server never came up in the container.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { McpManager } from "@/modules/tools/mcp.ts";
import { fakeAgent, tempDir } from "../helpers.ts";
import { eventually } from "../wait.ts";

/** Answers the handshake `argv[2]` ms late, and — given a marker that is not there yet — exits at its first start. */
const SERVER = `
import { existsSync, writeFileSync } from "node:fs";
const [late = "0", marker] = process.argv.slice(2);
if (marker && !existsSync(marker)) {
  writeFileSync(marker, "started once");
  process.exit(1);
}
for await (const line of console) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  if (message.method === "initialize") {
    await new Promise((resolve) => setTimeout(resolve, Number(late)));
    reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "late", version: "1" } });
  } else if (message.method === "tools/list") {
    reply({ tools: [{ name: "probe", description: "here", inputSchema: { type: "object", properties: {} } }] });
  } else reply({});
}
`;

const agentWith = (id: string, ...servers: { name: string; transport: "stdio"; command: string; args?: string[] }[]) =>
  fakeAgent({ config: { id, mcpServers: servers } as never });

describe("a stdio server's first start", () => {
  let dir = "";
  beforeEach(() => {
    dir = tempDir("mcp-first-start");
    writeFileSync(join(dir, "server.js"), SERVER);
  });
  afterEach(() => removePath(dir));

  test("slow to answer its handshake — fetching itself, as uvx does the first time — is waited for past the request timeout", async () => {
    const manager = new McpManager({ timeoutMs: 100, connectWaitMs: 10_000 });
    try {
      await manager.connectAgent(agentWith("nouva", { name: "late", transport: "stdio", command: process.execPath, args: [join(dir, "server.js"), "400"] }));
      expect([...manager.toolsFor("nouva").keys()]).toEqual(["late__probe"]);
    } finally {
      await manager.close();
    }
  });

  test("failed, it is started again, and its tools join when it comes up", async () => {
    const manager = new McpManager({ connectWaitMs: 10_000 });
    try {
      await manager.connectAgent(agentWith("nouva", { name: "late", transport: "stdio", command: process.execPath, args: [join(dir, "server.js"), "0", join(dir, "marker")] }));
      expect(manager.toolsFor("nouva").size).toBe(0);
      await eventually(() => manager.toolsFor("nouva").has("late__probe"), 5_000, "the server's second start");
    } finally {
      await manager.close();
    }
  });
});

describe("starting again", () => {
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  /** A manager whose starts all come to `result`, counted — no process is started. */
  function failing(result: "again" | "stays") {
    const manager = new McpManager({ connectWaitMs: 1_000 });
    const seen = { starts: 0 };
    (manager as unknown as { connect: unknown }).connect = async () => {
      seen.starts += 1;
      return result;
    };
    return { manager, seen };
  }

  test("on a backoff that doubles to five minutes, and never gives up", async () => {
    const waits: unknown[] = [];
    addLogSink((entry: LogEntry) => void (entry.message === "mcp server did not start, trying again" && waits.push(entry.data?.in_ms)));
    jest.useFakeTimers();
    try {
      const { manager, seen } = failing("again");
      await manager.connectAgent(agentWith("nouva", { name: "files", transport: "stdio", command: "unused" }));
      for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000]) {
        jest.advanceTimersByTime(ms);
        await flush();
      }
      expect(seen.starts).toBe(11);
      expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("not one that only an edit to its block or a person's login mends", async () => {
    jest.useFakeTimers();
    try {
      const { manager, seen } = failing("stays");
      await manager.connectAgent(agentWith("nouva", { name: "files", transport: "stdio", command: "unused" }));
      jest.advanceTimersByTime(3_600_000);
      await flush();
      expect(seen.starts).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("stopped by a reload that took the server out, and by the shutdown", async () => {
    jest.useFakeTimers();
    try {
      const { manager, seen } = failing("again");
      await manager.connectAgent(agentWith("nouva", { name: "files", transport: "stdio", command: "unused" }));
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(seen.starts).toBe(2);
      await manager.connectAgent(agentWith("nouva"));
      jest.advanceTimersByTime(3_600_000);
      await flush();
      expect(seen.starts).toBe(2);

      await manager.connectAgent(agentWith("nero", { name: "files", transport: "stdio", command: "unused" }));
      await manager.close();
      jest.advanceTimersByTime(3_600_000);
      await flush();
      expect(seen.starts).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
