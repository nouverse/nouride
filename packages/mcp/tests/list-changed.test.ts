/**
 * A server that says its tools changed, against real servers — a child process over stdio, a socket over Streamable
 * HTTP (G4).
 *
 * Every notification was dropped until 0.7.13, so an agent kept the tools its server had at connect until a reload. Now
 * a `tools/list_changed` from a server that declared `tools.listChanged` lists the tools again — once for a burst — and
 * hands them over. Over HTTP such a server can only say so on the GET stream, which is opened for it and for no other
 * server, reopened when it ends, given up for good on a 405, and taken as the session gone on a 404.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { addLogSink, configureLogger, type LogEntry } from "@nouride/shared";
import { McpClient, type McpTransportFactory } from "../src/client.ts";
import { streamableHttpTransport } from "../src/http.ts";
import { httpClient, statsOf, stdioClient } from "./fixtures/clients.ts";
import { httpServer } from "./fixtures/http-server.ts";
import { eventually } from "./wait.ts";

const lines: LogEntry[] = [];
addLogSink((entry) => void (entry.component.startsWith("mcp") && lines.push(entry)));
// The 405 is said at debug, and only once; the floor is put back for the files after this one.
beforeAll(() => configureLogger({ level: "debug" }));
afterAll(() => configureLogger({ level: "info" }));

const opened: McpClient[] = [];
const servers: ReturnType<typeof httpServer>[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  lines.length = 0;
});

const kept = (client: McpClient): McpClient => (opened.push(client), client);
const serving = (script: Parameters<typeof httpServer>[0]) => {
  const server = httpServer(script);
  servers.push(server);
  return server;
};
const DECLARED = { tools: { listChanged: true } };
const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

/** A client, and every tool list it was handed after a change. */
function watched(client: McpClient) {
  const handed: string[][] = [];
  client.onToolsChanged((tools) => handed.push(names(tools)));
  return handed;
}

describe("over stdio", () => {
  test("a change is taken up: the tools are listed again and handed over", async () => {
    const client = kept(stdioClient({ capabilities: DECLARED }, { relistAfterMs: 20 }));
    const handed = watched(client);
    await client.connect();
    expect(names(await client.listTools())).toEqual(["echo"]);

    await client.callTool("change_tools", { add: ["weather"], remove: ["echo"], notify: 1 });
    await eventually(() => handed.length === 1, 2_000, "the new list");

    expect(handed).toEqual([["weather"]]);
  });

  test("a burst is listed once, not once a notification", async () => {
    const client = kept(stdioClient({ capabilities: DECLARED }, { relistAfterMs: 20 }));
    const handed = watched(client);
    await client.connect();
    await client.listTools();

    // Five notifications, written ahead of the call's own answer.
    await client.callTool("change_tools", { add: ["a", "b", "c", "d", "e"], notify: 5 });
    await eventually(() => handed.length === 1, 2_000, "the new list");

    // Asked through the same pipe after the listing came back, so everything sent before it has been counted.
    const listings = (await statsOf(client)).methods.filter((method) => method === "tools/list");
    expect(listings).toHaveLength(2);
    expect(handed).toEqual([["echo", "a", "b", "c", "d", "e"]]);
  });

  test("from a server that never declared it, nothing is listed again", async () => {
    const client = kept(stdioClient({ capabilities: { tools: {} } }, { relistAfterMs: 1 }));
    const handed = watched(client);
    await client.connect();
    await client.listTools();

    await client.callTool("change_tools", { add: ["weather"], notify: 3 });

    // The notifications came ahead of the answer, so they have been read; none armed a listing.
    expect((client as unknown as { relist: { timer?: unknown } }).relist.timer).toBeUndefined();
    expect((await statsOf(client)).methods.filter((method) => method === "tools/list")).toHaveLength(1);
    expect(handed).toEqual([]);
  });

  test("a ping from the server is answered, and a request it was never offered is refused", async () => {
    const client = kept(stdioClient({}));
    await client.connect();

    await client.callTool("ask_client", { method: "ping" });
    await client.callTool("ask_client", { method: "roots/list" });

    expect((await statsOf(client)).answers).toEqual([
      { jsonrpc: "2.0", id: "server-1", result: {} },
      { jsonrpc: "2.0", id: "server-2", error: { code: -32601, message: "this client does not offer roots/list" } },
    ]);
  });
});

describe("over Streamable HTTP", () => {
  test("a server that declared it is listened to on the GET stream, and a change said there is taken up", async () => {
    const server = serving({ capabilities: DECLARED });
    const client = kept(httpClient(server.url, { relistAfterMs: 20 }));
    const handed = watched(client);
    await client.connect();
    await eventually(() => server.open() === 1, 2_000, "the stream to open");

    await client.callTool("change_tools", { add: ["weather"], remove: ["echo"], notify: 3 });
    await eventually(() => handed.length === 1, 2_000, "the new list");

    expect(handed).toEqual([["weather"]]);
    expect(server.posts("tools/list")).toHaveLength(1);
    expect(server.gets()[0]?.headers.accept).toBe("text/event-stream");
  });

  test("the stream is asked for once the server has answered `notifications/initialized` — not alongside it", async () => {
    const server = serving({ capabilities: DECLARED, holdInitialized: true });
    const client = kept(httpClient(server.url));
    await client.connect();
    // A whole round trip while the notification waits for its answer: a GET sent beside it would be here by now.
    await client.callTool("echo", { text: "x" });
    expect(server.gets()).toEqual([]);

    server.answerInitialized();
    await eventually(() => server.open() === 1, 2_000, "the stream to open");
    expect(server.gets()).toHaveLength(1);
  });

  test("a server that did not is never listened to: no GET, no held connection", async () => {
    const server = serving({ capabilities: { tools: {}, logging: {} } });
    const listened: string[] = [];
    const transport: McpTransportFactory = (handlers) => {
      const inner = streamableHttpTransport({ url: server.url })(handlers);
      return { ...inner, listen: () => void listened.push("listen") };
    };
    const client = kept(new McpClient({ name: "scripted", transport, timeoutMs: 5_000 }));
    await client.connect();
    await client.callTool("echo", { text: "x" });

    expect(listened).toEqual([]);
    expect(server.gets()).toEqual([]);
  });

  test("a 405 is a server with no stream to offer: said once at debug, never asked again, and nothing else changes", async () => {
    const server = serving({ capabilities: DECLARED, noStream: true });
    const client = kept(httpClient(server.url));
    await client.connect();
    await eventually(() => lines.some((line) => line.message.includes("offers no stream")), 2_000, "the 405 to be said");

    // A round trip after the refusal — longer than the 5 ms a retry would wait — and still one GET.
    expect((await client.callTool("echo", { text: "still fine" })).text).toBe("still fine");
    expect(server.gets()).toHaveLength(1);
    expect(lines.filter((line) => line.message.includes("offers no stream")).map((line) => line.level)).toEqual(["debug"]);
    expect(client.connected).toBe(true);
  });

  test("a stream the server ends is opened again, resuming after the last event it sent — and still heard", async () => {
    const server = serving({ capabilities: DECLARED });
    const client = kept(httpClient(server.url, { relistAfterMs: 20 }));
    const handed = watched(client);
    await client.connect();
    await eventually(() => server.open() === 1, 2_000, "the stream to open");
    server.push({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } });

    server.endStreams();
    await eventually(() => server.gets().length === 2 && server.open() === 1, 2_000, "the stream to open again");
    await client.callTool("change_tools", { add: ["weather"], notify: 1 });
    await eventually(() => handed.length === 1, 2_000, "the new list");

    expect(server.gets()[0]?.headers["last-event-id"]).toBeUndefined();
    expect(server.gets()[1]?.headers["last-event-id"]).toBe("1");
    expect(handed).toEqual([["echo", "weather"]]);
  });

  test("a stream refused with 404 for its session is the session gone: the client is lost, for its supervisor to reconnect", async () => {
    const server = serving({ capabilities: DECLARED, sessions: true });
    const client = kept(httpClient(server.url));
    let lost = "";
    client.onPeerLost((reason) => (lost = reason));
    await client.connect();
    await eventually(() => server.open() === 1, 2_000, "the stream to open");

    server.dropSession();
    server.endStreams();
    await eventually(() => lost !== "", 2_000, "the session to be given up");

    expect(lost).toBe("HTTP 404 (the server no longer recognises this session; the daemon must reconnect): no such session");
    expect(client.connected).toBe(false);
  });

  test("a call refused with 404 for its session fails with why, and the client is lost — the spec has a new session started", async () => {
    // Until 0.7.13 the call failed and so did every one after it, until the daemon restarted: nothing said the session
    // was gone, so nothing started another.
    const server = serving({ sessions: true });
    const client = kept(httpClient(server.url));
    let lost = "";
    client.onPeerLost((reason) => (lost = reason));
    await client.connect();

    server.dropSession();

    await expect(client.callTool("echo", { text: "x" })).rejects.toThrow("the server no longer recognises this session");
    await eventually(() => lost !== "", 2_000, "the client to be lost");
    expect(lost).toContain("HTTP 404");
  });

  test("a ping the server sends on its stream is answered with a POST", async () => {
    const server = serving({ capabilities: DECLARED });
    const client = kept(httpClient(server.url));
    await client.connect();
    await eventually(() => server.open() === 1, 2_000, "the stream to open");

    await client.callTool("ask_client", { method: "ping" });
    await eventually(() => server.posts("answer").length === 1, 2_000, "the answer");

    expect(server.posts("answer")[0]?.body).toEqual({ jsonrpc: "2.0", id: "server-1", result: {} });
    expect(server.posts("answer")[0]?.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });
});
