/**
 * A quiet peer is asked whether it is still there (G13).
 *
 * The legacy SSE stream sits silent between calls by design, so one dropped by a NAT or a proxy without a word was
 * noticed only when a call's answer never came back on it: that call waited out its timeout, the transport was never
 * reported lost, and nothing reconnected it. A transport that says so is pinged after its idle stretch, and a ping
 * left unanswered is the peer lost — the supervisor's signal to reconnect.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { McpClient } from "../src/client.ts";
import type { McpTransport, McpTransportHandlers } from "../src/client.ts";
import { MCP_PROTOCOL_VERSION } from "../src/protocol.ts";
import { sseTransport } from "../src/http.ts";
import { eventually } from "./wait.ts";


/** A peer that completes the handshake, answers pings only while `alive`, and `tools/list` after `slow` ms — or never. */
function peer(idlePingMs: number | undefined, options: { slow?: number | "never" } = {}) {
  const state = { alive: true, pings: 0, closed: false };
  let current: McpTransportHandlers | undefined;
  const factory = (handlers: McpTransportHandlers): McpTransport => ({
    send(raw) {
      current = handlers;
      const message = JSON.parse(raw) as { id?: number; method: string };
      const reply = (result: unknown) => handlers.onMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") reply({ protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "quiet", version: "1" } });
      if (message.method === "tools/list" && options.slow !== "never") setTimeout(() => reply({ tools: [] }), options.slow ?? 0);
      if (message.method === "ping") {
        state.pings += 1;
        if (state.alive) reply({});
      }
    },
    async close() {
      state.closed = true;
    },
    ...(idlePingMs ? { idlePingMs } : {}),
  });
  return { factory, state, handlers: () => current };
}

/**
 * Connect, holding the ping timer the client starts: the timer, and how many of its ticks have run. A tick is the client
 * deciding whether to ping, and a ping it decides on reaches the peer within the tick — so once the count has moved,
 * what that tick decided can be read off the peer.
 */
async function connectWatchingTimer(client: McpClient) {
  const realSetInterval = globalThis.setInterval;
  const timers: ReturnType<typeof setInterval>[] = [];
  let ticks = 0;
  globalThis.setInterval = ((tick: () => void, ms?: number) => {
    const timer = realSetInterval(() => {
      tick();
      ticks += 1;
    }, ms);
    timers.push(timer);
    return timer;
  }) as typeof setInterval;
  try {
    await client.connect();
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  return { timers, ticks: () => ticks };
}

describe("an idle peer", () => {
  test("is pinged after its quiet stretch, and stays connected while it answers", async () => {
    const { factory, state } = peer(20);
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 50 });
    await client.connect();
    await eventually(() => state.pings >= 2, 2_000, "two pings");
    expect(client.connected).toBe(true);
    await client.close();
  });

  test("that stops answering is lost — said to the supervisor, and its transport closed", async () => {
    const { factory, state } = peer(20);
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 30 });
    let lost = "";
    client.onPeerLost((reason) => (lost = reason));
    await client.connect();
    state.alive = false;
    await eventually(() => lost !== "", 2_000, "the peer to be lost");
    expect(lost).toContain("did not answer a ping");
    expect(client.connected).toBe(false);
    expect(state.closed).toBe(true);
  });

  test("is not pinged on a transport whose death is not silent — a child that exits says so", async () => {
    const { factory, state } = peer(undefined);
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 30 });
    const { timers } = await connectWatchingTimer(client);
    // No timer at all: nothing is left that could ever ask.
    expect(timers).toEqual([]);
    expect(state.pings).toBe(0);
    await client.close();
  });

  test("is not pinged while a call is in flight — the call is already a question it has to answer", async () => {
    const { factory, state, handlers } = peer(20, { slow: 120 });
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 500 });
    await client.connect();
    expect(handlers()).toBeDefined();
    await client.listTools();

    expect(state.pings).toBe(0);
    await client.close();
  });

  test("is not pinged while it keeps talking — anything it says counts as an answer", async () => {
    const { factory, state, handlers } = peer(100);
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 500 });
    const { ticks } = await connectWatchingTimer(client);
    const chatter = setInterval(() => handlers()!.onMessage(JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })), 5);
    // Three decisions, each made while the peer was talking.
    await eventually(() => ticks() >= 3, 2_000, "three ticks of the ping timer");
    clearInterval(chatter);

    expect(state.pings).toBe(0);
    await client.close();
  });

  test("closed by us while a ping waits is not lost — no reconnect for a shutdown we asked for", async () => {
    const { factory, state } = peer(10, { slow: "never" });
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 1_000 });
    let lost = "";
    client.onPeerLost((reason) => (lost = reason));
    await client.connect();
    state.alive = false;
    await eventually(() => state.pings > 0, 2_000, "a ping to be waiting");
    // A call made after the ping waits behind it, and the close fails the two in that order: by the time the call's
    // failure reaches us, the ping's has reached the client.
    const listing = client.listTools();
    await client.close();
    await expect(listing).rejects.toThrow("client closed");

    expect(lost).toBe("");
  });

  test("lost twice is said once", async () => {
    const { factory, handlers } = peer(undefined);
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 30 });
    const lost: string[] = [];
    client.onPeerLost((reason) => lost.push(reason));
    await client.connect();
    handlers()!.onClose("the event stream ended");
    handlers()!.onClose("the event stream failed: reset");

    expect(lost).toEqual(["the event stream ended"]);
  });

  test("lost, it is pinged no more", async () => {
    const { factory, handlers } = peer(10);
    const client = new McpClient({ name: "quiet", transport: factory, timeoutMs: 1_000 });
    const { timers } = await connectWatchingTimer(client);
    // The timer it started is the one it stops, not left firing into a client that has let the peer go.
    const cleared: unknown[] = [];
    const realClear = globalThis.clearInterval;
    globalThis.clearInterval = ((timer?: Parameters<typeof clearInterval>[0]) => {
      cleared.push(timer);
      realClear(timer);
    }) as typeof clearInterval;
    try {
      handlers()!.onClose("the event stream ended");
    } finally {
      globalThis.clearInterval = realClear;
    }

    expect(timers).toHaveLength(1);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toBe(timers[0]);
  });

  test("its timer does not hold a daemon that is shutting down open", () => {
    // A client connected and never closed: the process still exits, because the ping timer is unref'd.
    const script = [
      `import { McpClient } from ${JSON.stringify(new URL("../src/client.ts", import.meta.url).pathname)};`,
      "const client = new McpClient({ name: 'q', timeoutMs: 1000, transport: (h) => ({",
      "  send(raw) { const m = JSON.parse(raw); if (m.method === 'initialize') h.onMessage(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'q', version: '1' } } })); },",
      "  async close() {}, idlePingMs: 60000 }) });",
      "await client.connect();",
      "console.log('connected');",
    ].join("\n");
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });

    expect(run.stdout.trim().split("\n").at(-1)).toBe("connected");
    expect(run.signal).toBeNull();
    expect(run.status).toBe(0);
  });

  test("the legacy SSE transport asks for it, a minute by default", () => {
    const transport = sseTransport({ url: "http://127.0.0.1:9/sse" })({ onMessage: () => {}, onClose: () => {} });
    expect(transport.idlePingMs).toBe(60_000);
    void transport.close();
  });
});
