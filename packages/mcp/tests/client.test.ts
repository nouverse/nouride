/**
 * The client against a fake transport — no process, no server installed, no network.
 *
 * That separation is the reason the package is split the way it is: everything that can actually be
 * wrong here (handshake order, id matching, what a timeout does to the map, what happens when the peer
 * dies mid-call) is reachable without any of the machinery that makes such tests flaky elsewhere.
 */

import { describe, expect, jest, test } from "bun:test";
import { McpClient, McpError } from "../src/client.ts";
import type { McpTransport, McpTransportHandlers } from "../src/client.ts";
import { MCP_PROTOCOL_VERSION } from "../src/protocol.ts";
import { eventually } from "./wait.ts";

interface Sent {
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A peer the test drives by hand: it answers when told to, and never on its own — `initialize` aside, which it
 * answers with `version` and `capabilities`. What the client tells the transport besides messages is in `told`.
 */
function fakeServer(options: { autoInitialize?: boolean; version?: string; capabilities?: Record<string, unknown> } = {}) {
  let handlers: McpTransportHandlers | undefined;
  const sent: Sent[] = [];
  /** Everything the transport was told, in order: a message's method, `version:…`, `listen`. */
  const told: string[] = [];
  let closed = false;

  const factory = (h: McpTransportHandlers): McpTransport => {
    handlers = h;
    return {
      send(raw) {
        const message = JSON.parse(raw) as Sent;
        sent.push(message);
        told.push(message.method ?? "answer");
        if (options.autoInitialize !== false && message.method === "initialize") {
          reply(message.id as number, {
            protocolVersion: options.version ?? MCP_PROTOCOL_VERSION,
            capabilities: options.capabilities ?? { tools: {} },
            serverInfo: { name: "fake-mcp", version: "1.2.3" },
          });
        }
      },
      async close() {
        closed = true;
      },
      protocolVersion(version) {
        told.push(`version:${version}`);
      },
      listen() {
        told.push("listen");
      },
    };
  };

  function reply(id: number, result: unknown): void {
    handlers?.onMessage(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  function fail(id: number, code: number, message: string): void {
    handlers?.onMessage(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
  function raw(line: string): void {
    handlers?.onMessage(line);
  }
  function die(reason = "exited with code 1"): void {
    handlers?.onClose(reason);
  }
  /** The id of the last request of a given method, for answering out of order. */
  function idOf(method: string): number {
    return sent.filter((m) => m.method === method).at(-1)!.id as number;
  }
  /** Something the server says unasked: a notification, or — with an id — a request of its own. */
  function say(method: string, id?: string | number): void {
    handlers?.onMessage(JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method }));
  }

  return { factory, sent, told, reply, fail, raw, die, idOf, say, get closed() { return closed; } };
}

const client = (server: ReturnType<typeof fakeServer>, timeoutMs = 1000) =>
  new McpClient({ name: "fake", transport: server.factory, timeoutMs });

describe("the handshake", () => {
  test("initializes and then sends the initialized notification", async () => {
    // Both, in that order. A server that has not seen the notification may refuse everything after
    // it — which presents as a server that connected fine and then answered nothing.
    const server = fakeServer();
    const info = await client(server).connect();

    expect(info.name).toBe("fake-mcp");
    expect(info.version).toBe("1.2.3");
    expect(server.sent.map((m) => m.method)).toEqual(["initialize", "notifications/initialized"]);
  });

  test("asks for 2025-06-18, declaring nothing a server could ask of it", async () => {
    // `tools: {}` is a server's capability: declared by a client, it meant nothing.
    const server = fakeServer();
    await client(server).connect();

    expect(server.sent[0]?.params).toMatchObject({ protocolVersion: "2025-06-18", capabilities: {} });
    expect(server.sent[0]?.params?.capabilities).toEqual({});
  });

  test("a server on a version this client does not speak is refused, by name and both versions, and let go", async () => {
    // Taken as it came until 0.7.13 — a server a revision ahead was spoken to as though it were not.
    const server = fakeServer({ autoInitialize: false });
    const c = client(server);
    const connecting = c.connect();

    await Promise.resolve();
    server.reply(server.idOf("initialize"), { protocolVersion: "2099-01-01", serverInfo: { name: "future" } });

    await expect(connecting).rejects.toThrow(
      '"fake" answered with MCP 2099-01-01, which this daemon does not speak: it asked for 2025-06-18, and speaks 2025-06-18, 2025-03-26 and 2024-11-05',
    );
    expect(server.closed).toBe(true);
    expect(c.connected).toBe(false);
    // Never told the handshake was done.
    expect(server.sent.map((m) => m.method)).toEqual(["initialize"]);
  });

  test("an answer that names no version at all is refused the same way", async () => {
    const server = fakeServer({ autoInitialize: false });
    const c = client(server);
    const connecting = c.connect();

    await Promise.resolve();
    server.reply(server.idOf("initialize"), { serverInfo: { name: "vague" } });

    await expect(connecting).rejects.toThrow('"fake" answered with no protocol version at all');
    expect(server.closed).toBe(true);
  });

  test("connect is idempotent — a second call does not re-handshake", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    await c.connect();

    expect(server.sent.filter((m) => m.method === "initialize")).toHaveLength(1);
  });
});

describe("requests", () => {
  test("answers are matched by id, not by arrival order", async () => {
    // Two calls in flight and the server answers the second one first. Matching on order would hand
    // each caller the other's result — silently, since both are well-formed.
    const server = fakeServer();
    const c = client(server);
    await c.connect();

    const first = c.callTool("slow", {});
    const second = c.callTool("fast", {});
    await Promise.resolve();

    const ids = server.sent.filter((m) => m.method === "tools/call").map((m) => m.id as number);
    server.reply(ids[1]!, { content: [{ type: "text", text: "SECOND" }] });
    server.reply(ids[0]!, { content: [{ type: "text", text: "FIRST" }] });

    expect((await first).text).toBe("FIRST");
    expect((await second).text).toBe("SECOND");
  });

  test("a JSON-RPC error rejects the call that caused it", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();

    const call = c.callTool("boom", {});
    await Promise.resolve();
    server.fail(server.idOf("tools/call"), -32602, "invalid params");

    await expect(call).rejects.toThrow(/invalid params/);
  });

  test("a tool that reports failure is a result, not an exception", async () => {
    // The model should see it and adapt, exactly as it does for a refused built-in. Throwing would
    // turn a recoverable answer into a dead turn.
    const server = fakeServer();
    const c = client(server);
    await c.connect();

    const call = c.callTool("grep", {});
    await Promise.resolve();
    server.reply(server.idOf("tools/call"), {
      content: [{ type: "text", text: "no such file" }],
      isError: true,
    });

    expect(await call).toEqual({ text: "no such file", isError: true, images: [] });
  });

  test("an image a tool returns comes back beside the text, numbered where it stood", async () => {
    // It used to be flattened to "[image content, not renderable as text]" and the bytes dropped.
    const server = fakeServer();
    const c = client(server);
    await c.connect();

    const call = c.callTool("screenshot", {});
    await Promise.resolve();
    server.reply(server.idOf("tools/call"), {
      content: [
        { type: "text", text: "the page" },
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///x" } },
      ],
    });

    expect(await call).toEqual({
      text: "the page\n[image 1]\n[resource content, not renderable as text]",
      isError: false,
      images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    });
  });

  test("a call that is never answered times out and stops being tracked", async () => {
    const server = fakeServer();
    const c = client(server, 20);
    await c.connect();

    await expect(c.callTool("void", {})).rejects.toThrow(/did not answer tools\/call within 20ms/);

    // A late answer must find no waiter: resolving a promise that already rejected is the bug this
    // pins, and it would surface as one call receiving another's result much later.
    expect(() => server.reply(server.idOf("tools/call"), { content: [] })).not.toThrow();
  });

  test("a request given up on at its timeout is cancelled, as the spec asks — the server can stop the work", async () => {
    const server = fakeServer();
    const c = client(server, 20);
    await c.connect();

    await expect(c.callTool("slow", {})).rejects.toThrow(/within 20ms/);

    expect(server.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: server.idOf("tools/call"), reason: "no answer within 20ms" },
    } as unknown as Sent);
  });

  test("…but never initialize, which a client may not cancel", async () => {
    const server = fakeServer({ autoInitialize: false });

    await expect(client(server, 20).connect()).rejects.toThrow(/did not answer initialize within 20ms/);

    expect(server.sent.map((m) => m.method)).toEqual(["initialize"]);
  });

  test("initialize may be given longer than the requests after it: a server that fetches itself first is slow once (0.8.10)", async () => {
    const server = fakeServer({ autoInitialize: false });
    const c = new McpClient({ name: "fake", transport: server.factory, timeoutMs: 20, initializeTimeoutMs: 1_000 });
    jest.useFakeTimers();
    try {
      const connecting = c.connect();
      // Past the requests' ceiling, inside initialize's own.
      jest.advanceTimersByTime(500);
      server.reply(server.idOf("initialize"), { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.2.3" } });
      await connecting;
    } finally {
      jest.useRealTimers();
    }

    await expect(c.callTool("void", {})).rejects.toThrow(/did not answer tools\/call within 20ms/);
  });

  test("non-protocol output on the message channel is ignored", async () => {
    // Servers that log to stdout are common. Treating a stray line as a protocol error would make
    // this host useless against real ones.
    const server = fakeServer();
    const c = client(server);
    await c.connect();

    const call = c.callTool("ok", {});
    await Promise.resolve();
    server.raw("INFO: starting up");
    server.raw("{not json");
    server.raw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" }));
    server.reply(server.idOf("tools/call"), { content: [{ type: "text", text: "fine" }] });

    expect((await call).text).toBe("fine");
  });

  test("calling before connecting fails rather than hanging", async () => {
    await expect(client(fakeServer()).callTool("x", {})).rejects.toThrow(/is not connected/);
  });
});

describe("when the peer goes away", () => {
  test("everything in flight fails immediately", async () => {
    // The alternative is a turn parked until the request timeout for a server that is definitively
    // gone — holding its conversation's queue for all of it.
    const server = fakeServer();
    const c = client(server, 60_000);
    await c.connect();

    const call = c.callTool("anything", {});
    await Promise.resolve();
    server.die();

    await expect(call).rejects.toThrow(/exited with code 1/);
  });

  test("close fails waiters and shuts the transport down", async () => {
    const server = fakeServer();
    const c = client(server, 60_000);
    await c.connect();

    const call = c.callTool("anything", {});
    await Promise.resolve();
    await c.close();

    await expect(call).rejects.toBeInstanceOf(McpError);
    expect(server.closed).toBe(true);
    expect(c.connected).toBe(false);
  });

  test("a client whose peer died no longer reports itself connected", async () => {
    // It did, and the dashboard showed a dead server as green with a tool count it could not
    // deliver: `failAll` rejected the waiters but left `connected` true, so nothing downstream could
    // tell a live server from a corpse.
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    expect(c.connected).toBe(true);

    server.die();

    expect(c.connected).toBe(false);
  });

  test("a lost peer is announced, so a supervisor can reconnect", async () => {
    const server = fakeServer();
    const c = client(server);
    const lost: string[] = [];
    await c.connect();
    c.onPeerLost((reason) => lost.push(reason));

    server.die("the event stream ended");

    expect(lost).toEqual(["the event stream ended"]);
  });

  test("closing on purpose is not announced as a loss", async () => {
    // Conflating the two is how a deliberate shutdown turns into a reconnect loop against a server
    // nobody asked to keep.
    const server = fakeServer();
    const c = client(server);
    const lost: string[] = [];
    await c.connect();
    c.onPeerLost((reason) => lost.push(reason));

    await c.close();

    expect(lost).toEqual([]);
  });

  test("close is safe to call twice", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    await c.close();
    await c.close();

    expect(c.connected).toBe(false);
  });
});

describe("listTools", () => {
  /** What `tools/list` comes back as, when the server answers with `result`. */
  async function listed(result: unknown) {
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    const listing = c.listTools();
    await Promise.resolve();
    server.reply(server.idOf("tools/list"), result);
    return await listing;
  }

  test("returns what the server declared — and only the entries that are tools", async () => {
    // Third-party output: an entry with no name cannot be called, and a schema that is not an object cannot be handed
    // to a model. Each is dropped where it is read, rather than reaching the engine as a tool named `undefined`.
    const tools = await listed({
      tools: [
        { name: "memory_query", description: "search memory", inputSchema: { type: "object" } },
        { name: "no_description", inputSchema: null },
        { description: "nameless" },
        { name: "" },
        "memory_write",
        null,
      ],
    });
    expect(tools).toEqual([
      { name: "memory_query", description: "search memory", inputSchema: { type: "object" } },
      { name: "no_description" },
    ]);
  });

  test("a server that lists no tools array has no tools, rather than failing the connection", async () => {
    expect(await listed({})).toEqual([]);
    expect(await listed({ tools: "none" })).toEqual([]);
  });
});

/**
 * A call the turn no longer wants (P4). It carried no signal, so `/stop`, the deadline and a shutdown each waited out
 * the request timeout — thirty seconds by default — and a parallel group of MCP reads held the turn for the slowest.
 */
describe("a call abandoned by the turn that made it", () => {
  test("is released at once, and the server is told which request no longer matters", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    const stop = new AbortController();

    const call = c.callTool("slow", {}, { signal: stop.signal });
    await Promise.resolve();
    stop.abort();

    await expect(call).rejects.toThrow(/tools\/call was cancelled/);
    const asked = server.sent.find((m) => m.method === "tools/call")!;
    expect(server.sent.at(-1)).toMatchObject({ method: "notifications/cancelled", params: { requestId: asked.id } });
  });

  test("one already stopped is never sent", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    const stop = new AbortController();
    stop.abort();

    await expect(c.callTool("slow", {}, { signal: stop.signal })).rejects.toThrow(/cancelled before it was sent/);
    expect(server.sent.some((m) => m.method === "tools/call")).toBe(false);
  });

  test("one answered first stops listening: a stop that comes later cancels nothing", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    const stop = new AbortController();

    const call = c.callTool("fast", {}, { signal: stop.signal });
    await Promise.resolve();
    server.reply(server.idOf("tools/call"), { content: [{ type: "text", text: "done" }] });
    expect((await call).text).toBe("done");
    stop.abort();

    expect(server.sent.some((m) => m.method === "notifications/cancelled")).toBe(false);
  });
});

/**
 * What the client tells its transport besides messages (G4): the version settled on, before the handshake is done —
 * HTTP sends it on every request after — and, only for a server that will say when its tools change, to listen.
 */
describe("what the transport is told", () => {
  test("the version, between initialize and initialized; and to listen, for a server that declared tools.listChanged", async () => {
    const server = fakeServer({ capabilities: { tools: { listChanged: true } } });
    await client(server).connect();

    expect(server.told).toEqual(["initialize", "version:2025-06-18", "notifications/initialized", "listen"]);
  });

  test("a server that will say nothing about its tools is not listened to — no held connection for messages nobody reads", async () => {
    const server = fakeServer({ capabilities: { tools: {}, resources: { listChanged: true }, logging: {} } });
    await client(server).connect();

    expect(server.told).toEqual(["initialize", "version:2025-06-18", "notifications/initialized"]);
  });

  test("an older version the server chose is the one it is told, and spoken", async () => {
    for (const version of ["2025-03-26", "2024-11-05"]) {
      const server = fakeServer({ version });
      const info = await client(server).connect();
      expect(info.protocolVersion).toBe(version);
      expect(server.told).toContain(`version:${version}`);
    }
  });
});

/** A server's tools are listed again when it says they changed, once a burst — and only a server that declared it. */
describe("tools/list_changed", () => {
  const relisting = (server: ReturnType<typeof fakeServer>, relistAfterMs = 5) =>
    new McpClient({ name: "fake", transport: server.factory, timeoutMs: 1_000, relistAfterMs });
  const listings = (server: ReturnType<typeof fakeServer>) => server.sent.filter((m) => m.method === "tools/list").length;
  const armed = (c: McpClient) => (c as unknown as { relist: { timer?: ReturnType<typeof setTimeout> } }).relist.timer;

  test("a burst is one listing, and its tools are handed over", async () => {
    const server = fakeServer({ capabilities: { tools: { listChanged: true } } });
    const c = relisting(server);
    const handed: string[][] = [];
    c.onToolsChanged((tools) => handed.push(tools.map((tool) => tool.name)));
    await c.connect();

    for (let n = 0; n < 4; n += 1) server.say("notifications/tools/list_changed");
    await eventually(() => listings(server) === 1, 2_000, "the listing");
    server.reply(server.idOf("tools/list"), { tools: [{ name: "weather" }] });
    await eventually(() => handed.length === 1, 2_000, "the tools handed over");

    expect(handed).toEqual([["weather"]]);
    expect(listings(server)).toBe(1);
    expect(armed(c)).toBeUndefined();
  });

  test("one that arrives while a listing runs is answered by another listing after it — the first may predate it", async () => {
    const server = fakeServer({ capabilities: { tools: { listChanged: true } } });
    const c = relisting(server);
    const handed: string[][] = [];
    c.onToolsChanged((tools) => handed.push(tools.map((tool) => tool.name)));
    await c.connect();

    server.say("notifications/tools/list_changed");
    await eventually(() => listings(server) === 1, 2_000, "the first listing");
    server.say("notifications/tools/list_changed");
    server.reply(server.idOf("tools/list"), { tools: [{ name: "old" }] });
    await eventually(() => listings(server) === 2, 2_000, "the second listing");
    server.reply(server.idOf("tools/list"), { tools: [{ name: "new" }] });
    await eventually(() => handed.length === 2, 2_000, "both handed over");

    expect(handed).toEqual([["old"], ["new"]]);
  });

  test("from a server that never declared it, it is not acted on", async () => {
    const server = fakeServer({ capabilities: { tools: {} } });
    const c = relisting(server);
    await c.connect();

    server.say("notifications/tools/list_changed");

    // Read from the client itself: the notification was handled when `say` returned, and no listing was armed.
    expect(armed(c)).toBeUndefined();
    expect(listings(server)).toBe(0);
  });

  test("a listing that fails keeps the tools the server had: nothing is handed over, and a later change lists again", async () => {
    const server = fakeServer({ capabilities: { tools: { listChanged: true } } });
    const c = relisting(server);
    const handed: string[][] = [];
    c.onToolsChanged((tools) => handed.push(tools.map((tool) => tool.name)));
    await c.connect();

    server.say("notifications/tools/list_changed");
    await eventually(() => listings(server) === 1, 2_000, "the listing");
    server.fail(server.idOf("tools/list"), -32603, "busy");
    server.say("notifications/tools/list_changed");
    await eventually(() => listings(server) === 2, 2_000, "the listing after the failure");
    server.reply(server.idOf("tools/list"), { tools: [{ name: "back" }] });
    await eventually(() => handed.length === 1, 2_000, "the tools handed over");

    expect(handed).toEqual([["back"]]);
  });

  test("closing stops a listing still waiting out its burst", async () => {
    const server = fakeServer({ capabilities: { tools: { listChanged: true } } });
    const c = relisting(server, 60_000);
    await c.connect();
    server.say("notifications/tools/list_changed");
    const timer = armed(c);
    expect(timer).toBeDefined();
    const cleared: unknown[] = [];
    const realClear = globalThis.clearTimeout;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearTimeout;
    try {
      await c.close();
    } finally {
      globalThis.clearTimeout = realClear;
    }

    expect(cleared).toContain(timer);
  });
});

/** A server may ask the client things too. Either side must answer a ping; anything this client never offered is refused. */
describe("a request from the server", () => {
  test("ping is answered at once, under the server's own id", async () => {
    const server = fakeServer();
    await client(server).connect();

    server.say("ping", "srv-1");

    expect(server.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: "srv-1", result: {} } as unknown as Sent);
  });

  test("anything else is refused as not offered, rather than left waiting for an answer", async () => {
    const server = fakeServer();
    await client(server).connect();

    server.say("sampling/createMessage", 7);

    expect(server.sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "this client does not offer sampling/createMessage" },
    } as unknown as Sent);
  });

  test("one that carries the id of a call of ours settles nothing: the call is answered by its own reply", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();
    const call = c.callTool("slow", {});
    await Promise.resolve();

    server.say("ping", server.idOf("tools/call"));
    server.reply(server.idOf("tools/call"), { content: [{ type: "text", text: "the call's own" }] });

    expect((await call).text).toBe("the call's own");
  });
});

describe("tools/list, paged", () => {
  const listings = (server: ReturnType<typeof fakeServer>) => server.sent.filter((m) => m.method === "tools/list");

  test("every page is read, each asked for with the cursor the last one ended on", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();

    const listing = c.listTools();
    await eventually(() => listings(server).length === 1);
    server.reply(server.idOf("tools/list"), { tools: [{ name: "a" }], nextCursor: "page-2" });
    await eventually(() => listings(server).length === 2);
    server.reply(server.idOf("tools/list"), { tools: [{ name: "b" }] });

    expect((await listing).map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(listings(server).map((m) => m.params)).toEqual([{}, { cursor: "page-2" }]);
  });

  test("a cursor that comes round again ends the listing with what was read", async () => {
    const server = fakeServer();
    const c = client(server);
    await c.connect();

    const listing = c.listTools();
    for (let page = 1; page <= 2; page += 1) {
      await eventually(() => listings(server).length === page);
      server.reply(server.idOf("tools/list"), { tools: [{ name: `t${page}` }], nextCursor: "again" });
    }

    expect((await listing).map((tool) => tool.name)).toEqual(["t1", "t2"]);
    expect(listings(server)).toHaveLength(2);
  });
});
