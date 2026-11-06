/**
 * The handshake against real servers — a child process over stdio, a socket over Streamable HTTP (G4).
 *
 * The client asks for MCP 2025-06-18. A server that answers 2025-03-26 or 2024-11-05 is spoken to in that version; one
 * that answers anything else is refused, by name and with both versions, and let go. Until 0.7.13 it asked for
 * 2024-11-05 and took whatever came back. Over HTTP the version settled on rides on every request after `initialize`,
 * as 2025-06-18 requires — the `initialized` notification, each call, the stream, and the DELETE that ends the session.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { McpClient } from "../src/client.ts";
import { httpClient, statsOf, stdioClient } from "./fixtures/clients.ts";
import { httpServer } from "./fixtures/http-server.ts";
import type { ServerScript } from "./fixtures/server.ts";
import { eventually } from "./wait.ts";

const opened: { close(): Promise<void> }[] = [];
const servers: ReturnType<typeof httpServer>[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

const kept = <T extends { close(): Promise<void> }>(client: T): T => (opened.push(client), client);
const serving = (script: Parameters<typeof httpServer>[0]) => {
  const server = httpServer(script);
  servers.push(server);
  return server;
};

/** One client per transport, on a server scripted the same way. */
const transports: [string, (script: ServerScript) => McpClient][] = [
  ["stdio", (script) => kept(stdioClient(script))],
  ["streamable-http", (script) => kept(httpClient(serving(script).url))],
];

describe.each(transports)("over %s", (_name, connectTo) => {
  test("asks for 2025-06-18, declaring nothing, and speaks it with a server that agrees", async () => {
    const client = connectTo({});
    const info = await client.connect();

    expect(info.protocolVersion).toBe("2025-06-18");
    expect((await statsOf(client)).initialize).toEqual({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "nouride", version: "0.1.0" } });
  });

  test.each(["2025-03-26", "2024-11-05"])("speaks %s with a server that answers it", async (version) => {
    const client = connectTo({ answers: version });
    const info = await client.connect();

    expect(info.protocolVersion).toBe(version);
    expect((await client.callTool("echo", { text: "still here" })).text).toBe("still here");
  });

  test("refuses a version it does not speak, naming the server and both versions — and goes no further", async () => {
    const client = connectTo({ answers: "2099-01-01" });

    await expect(client.connect()).rejects.toThrow(
      '"scripted" answered with MCP 2099-01-01, which this daemon does not speak: it asked for 2025-06-18, and speaks 2025-06-18, 2025-03-26 and 2024-11-05',
    );
    expect(client.connected).toBe(false);
  });

  test("refuses an answer that names no version", async () => {
    await expect(connectTo({ answers: null }).connect()).rejects.toThrow('"scripted" answered with no protocol version at all');
  });
});

describe("the MCP-Protocol-Version header", () => {
  /** Each request the server saw, as `METHOD rpc version` — sorted, since the GET's place among the POSTs is the network's. */
  const named = (server: ReturnType<typeof httpServer>) =>
    server.requests.map((r) => `${r.method} ${r.rpc ?? "-"} ${r.headers["mcp-protocol-version"] ?? "(none)"}`).sort();

  test("is on every request after initialize — and not on initialize, which predates it", async () => {
    const server = serving({ sessions: true, capabilities: { tools: { listChanged: true } } });
    const client = httpClient(server.url);
    await client.connect();
    await client.listTools();
    await client.callTool("echo", { text: "x" });
    await eventually(() => server.gets().length === 1, 2_000, "the stream to be asked for");
    await client.close();

    expect(named(server)).toEqual(
      [
        "POST initialize (none)",
        "POST notifications/initialized 2025-06-18",
        "POST tools/list 2025-06-18",
        "POST tools/call 2025-06-18",
        "GET - 2025-06-18",
        "DELETE - 2025-06-18",
      ].sort(),
    );
  });

  test("names the version the server chose, when it chose an older one", async () => {
    const server = serving({ answers: "2025-03-26" });
    const client = kept(httpClient(server.url));
    await client.connect();
    await client.callTool("echo", { text: "x" });

    expect(server.posts("tools/call")[0]?.headers["mcp-protocol-version"]).toBe("2025-03-26");
  });

  test("is never sent for a version the client refused", async () => {
    const server = serving({ answers: "2099-01-01", sessions: true });
    const client = httpClient(server.url);

    await expect(client.connect()).rejects.toThrow(/does not speak/);
    // The session the refused handshake opened is ended, and nothing named the version it was refused for.
    expect(named(server)).toEqual(["DELETE - (none)", "POST initialize (none)"]);
  });
});
