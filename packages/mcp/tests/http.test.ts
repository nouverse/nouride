/**
 * The HTTP transports against a stubbed `fetch` — no server, no port, no network.
 *
 * Same separation as `client.test.ts`: what can actually be wrong here is framing and bookkeeping —
 * which content type came back, whether the session id was echoed, what a 401 turns into, whether a
 * message sent before the endpoint was announced is lost. None of that needs a socket.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sseTransport, streamableHttpTransport } from "../src/http.ts";
import type { McpTransportHandlers } from "../src/client.ts";
import { eventually } from "./wait.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replace `fetch`, recording every call and answering from `respond`. */
function stubFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    calls.push(call);
    return await respond(call);
  }) as typeof fetch;
  return calls;
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });
}

function eventStream(chunks: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** Collects what a transport hands back, so a test can await one message without timers. */
function collector() {
  const messages: string[] = [];
  const logs: string[] = [];
  const closes: string[] = [];
  let notify: (() => void) | undefined;

  const handlers: McpTransportHandlers = {
    onMessage: (raw) => {
      messages.push(raw);
      notify?.();
    },
    onLog: (line) => logs.push(line),
    onClose: (reason) => {
      closes.push(reason);
      notify?.();
    },
  };

  /** Resolve once at least `count` messages (or a close) have landed. */
  async function settled(count = 1): Promise<void> {
    if (messages.length >= count || closes.length > 0) return;
    await new Promise<void>((resolve) => {
      notify = () => {
        if (messages.length >= count || closes.length > 0) resolve();
      };
    });
  }

  return { handlers, messages, logs, closes, settled };
}

const REQUEST = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });

describe("streamable-http", () => {
  test("a JSON reply reaches the client", async () => {
    stubFetch(() => json({ jsonrpc: "2.0", id: 7, result: { tools: [] } }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled();

    expect(JSON.parse(sink.messages[0]!)).toMatchObject({ id: 7, result: { tools: [] } });
    await transport.close();
  });

  test("a reply streamed as SSE reaches the client the same way", async () => {
    // The server's choice, not the client's: a result preceded by progress notifications comes back
    // as a stream. Above the transport the two must be indistinguishable.
    stubFetch(() =>
      eventStream([
        'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
        'data: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n',
      ]),
    );
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled(2);

    expect(sink.messages).toHaveLength(2);
    expect(JSON.parse(sink.messages[1]!)).toMatchObject({ id: 7, result: { tools: [] } });
    await transport.close();
  });

  test("the session id is captured and echoed on later requests", async () => {
    // A server that issues one and stops seeing it treats every later call as a new unauthenticated
    // client — which looks like connect working and everything after it 404ing.
    const calls = stubFetch(() =>
      json({ jsonrpc: "2.0", id: 7, result: {} }, { "mcp-session-id": "abc123" }),
    );
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled();
    transport.send(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }));
    await sink.settled(2);

    expect(calls[0]!.headers["mcp-session-id"]).toBeUndefined();
    expect(calls[1]!.headers["mcp-session-id"]).toBe("abc123");
    await transport.close();
  });

  test("configured headers are sent on every request", async () => {
    const calls = stubFetch(() => json({ jsonrpc: "2.0", id: 7, result: {} }));
    const sink = collector();
    const transport = streamableHttpTransport({
      url: "https://mcp.test/mcp",
      headers: { Authorization: "Bearer secret-value" },
    })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled();

    expect(calls[0]!.headers.authorization).toBe("Bearer secret-value");
    await transport.close();
  });

  test("an HTTP error fails the waiting call instead of leaving it to time out", async () => {
    // The whole reason this transport parses what it sends. `send` returns void, so without this the
    // caller waits the full request timeout for a server that already said no.
    stubFetch(() => new Response("nope", { status: 500 }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled();

    const reply = JSON.parse(sink.messages[0]!) as { id: number; error: { message: string } };
    expect(reply.id).toBe(7);
    expect(reply.error.message).toContain("500");
    await transport.close();
  });

  test("a 401 says it is the credential, not the address", async () => {
    stubFetch(() => new Response("", { status: 401 }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled();

    expect(JSON.parse(sink.messages[0]!).error.message).toContain("credential");
    await transport.close();
  });

  test("a batched reply is unwrapped into one message each", async () => {
    // The client matches one id at a time. An array would parse, match nothing, and be dropped in
    // silence — the worst available failure.
    stubFetch(() =>
      json([
        { jsonrpc: "2.0", id: 7, result: { a: 1 } },
        { jsonrpc: "2.0", id: 8, result: { b: 2 } },
      ]),
    );
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled(2);

    expect(sink.messages.map((m) => JSON.parse(m).id)).toEqual([7, 8]);
    await transport.close();
  });

  test("a failed notification is logged, not turned into a reply nobody awaits", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    // Said one way or the other — a log line, or wrongly a reply — and read once it has been.
    await eventually(() => sink.logs.length + sink.messages.length > 0, 2_000, "the failure to be said");

    expect(sink.messages).toHaveLength(0);
    expect(sink.logs.join(" ")).toContain("500");
    await transport.close();
  });

  test("closing an established session tells the server", async () => {
    const calls = stubFetch(() =>
      json({ jsonrpc: "2.0", id: 7, result: {} }, { "mcp-session-id": "abc123" }),
    );
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);

    transport.send(REQUEST);
    await sink.settled();
    await transport.close();

    expect(calls.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "abc123" } });
  });
});

describe("sse", () => {
  /** The GET stream, plus a handle to push events onto it while the test runs. */
  function openStream() {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return {
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
      end: () => controller.close(),
    };
  }

  test("a message sent before the endpoint is announced is held, then delivered", async () => {
    // `McpClient.connect` sends `initialize` the instant the transport exists, which is reliably
    // before the server has said where to send it. Dropping it would fail the handshake on a server
    // that is working perfectly.
    const stream = openStream();
    const calls = stubFetch((call) =>
      call.method === "POST" ? new Response("", { status: 202 }) : stream.response,
    );
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);

    transport.send(REQUEST);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    stream.push("event: endpoint\ndata: /messages?sessionId=xyz\n\n");
    await eventually(() => calls.some((c) => c.method === "POST"));

    const posted = calls.find((c) => c.method === "POST")!;
    expect(posted.url).toBe("https://mcp.test/messages?sessionId=xyz");
    expect(posted.body).toBe(REQUEST);

    stream.end();
    await transport.close();
  });

  test("replies arrive on the stream rather than on the POST", async () => {
    const stream = openStream();
    stubFetch((call) => (call.method === "POST" ? new Response("", { status: 202 }) : stream.response));
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);

    stream.push("event: endpoint\ndata: /messages\n\n");
    stream.push('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n');
    await sink.settled();

    expect(JSON.parse(sink.messages[0]!)).toMatchObject({ id: 7 });
    stream.end();
    await transport.close();
  });

  test("a stream that will not open closes the transport with the reason", async () => {
    stubFetch(() => new Response("no such endpoint", { status: 404 }));
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);

    await eventually(() => sink.closes.length > 0);

    expect(sink.closes[0]).toContain("404");
    await transport.close();
  });
});

// ── Every decision above, held one by one (the mutation sweep, tests-unreviewed-areas-mutation) ──────────────────

const NOTIFICATION = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

/**
 * Sent after a POST whose answer must say nothing, and refused: its refusal takes the longest way through the same code,
 * so once it is said, anything the earlier POST led to has been said before it.
 */
const SENTINEL = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" });
const SENTINEL_REFUSED = JSON.stringify({ jsonrpc: "2.0", id: 8, error: { code: -32000, message: "HTTP 500" } });

/** A `fetch` that never answers, and rejects only when its signal fires — a request still in flight. */
function hangingFetch() {
  const signals: (AbortSignal | undefined)[] = [];
  const requests: Promise<Response>[] = [];
  globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    signals.push(signal);
    const request = new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    requests.push(request);
    return request;
  }) as typeof fetch;
  return { signals, requests };
}

describe("streamable-http, each decision", () => {
  test("a POST is a POST of JSON that accepts either answer", async () => {
    const calls = stubFetch(() => json({ jsonrpc: "2.0", id: 7, result: {} }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();

    expect(calls[0]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: REQUEST,
    });
    await transport.close();
  });

  test("the version the client settled on is sent on every request after it is told — and only that one", async () => {
    let n = 0;
    const calls = stubFetch(() =>
      json(n++ === 0 ? { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } } : { jsonrpc: "2.0", id: n, result: {} }),
    );
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    for (let id = 1; id <= 3; id++) {
      transport.send(JSON.stringify({ jsonrpc: "2.0", id, method: "x" }));
      await sink.settled(id);
      if (id === 1) transport.protocolVersion?.("2025-03-26");
    }

    expect(calls.map((c) => c.headers["mcp-protocol-version"])).toEqual([undefined, "2025-03-26", "2025-03-26"]);
    await transport.close();
  });

  test("a version in an answer is not taken up on its own: the client accepts one first, or refuses it", async () => {
    // It used to be read off the first answer that carried one — a version the client then refused went out on the
    // requests after it all the same.
    const calls = stubFetch(() => json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2099-01-01" } }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();
    transport.send(REQUEST);
    await sink.settled(2);

    expect(calls[1]!.headers["mcp-protocol-version"]).toBeUndefined();
    await transport.close();
  });

  test("a session id is kept when a later answer carries none", async () => {
    let n = 0;
    const calls = stubFetch(() => json({ jsonrpc: "2.0", id: 7, result: {} }, n++ === 0 ? { "mcp-session-id": "abc123" } : {}));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    for (let i = 1; i <= 3; i++) {
      transport.send(REQUEST);
      await sink.settled(i);
    }

    expect(calls.map((c) => c.headers["mcp-session-id"])).toEqual([undefined, "abc123", "abc123"]);
    await transport.close();
  });

  test("an empty 202 to a notification delivers nothing", async () => {
    stubFetch((call) => (call.body === SENTINEL ? new Response("", { status: 500 }) : new Response("  \n", { status: 202 })));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(NOTIFICATION);
    transport.send(SENTINEL);
    await eventually(() => sink.logs.length + sink.messages.length > 0, 2_000, "the sentinel's refusal");

    expect(sink.messages).toEqual([SENTINEL_REFUSED]);
    expect(sink.logs).toEqual([]);
    await transport.close();
  });

  test("a body that looks like a batch but is not JSON is handed on as it is", async () => {
    stubFetch(() => new Response("[not json", { headers: { "content-type": "application/json" } }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();

    expect(sink.messages).toEqual(["[not json"]);
    await transport.close();
  });

  test("the failure handed back is a JSON-RPC server error for that id", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();

    expect(JSON.parse(sink.messages[0]!)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "HTTP 500" } });
    await transport.close();
  });

  test("an error body is quoted trimmed and cut at 300 characters", async () => {
    stubFetch(() => new Response(`  ${"x".repeat(299)}yz  `, { status: 500 }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();

    expect(JSON.parse(sink.messages[0]!).error.message).toBe(`HTTP 500: ${"x".repeat(299)}y`);
    await transport.close();
  });

  test("a 403 is the credential too; a 404 is not", async () => {
    let status = 403;
    stubFetch(() => new Response("", { status }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();
    status = 404;
    transport.send(REQUEST);
    await sink.settled(2);

    const [forbidden, missing] = sink.messages.map((m) => JSON.parse(m).error.message);
    expect(forbidden).toBe("HTTP 403 (the server rejected the credential)");
    expect(missing).toBe("HTTP 404");
    await transport.close();
  });

  test("a 404 after a session was issued says the session was dropped, not that the address is wrong", async () => {
    let n = 0;
    stubFetch(() =>
      n++ === 0 ? json({ jsonrpc: "2.0", id: 7, result: {} }, { "mcp-session-id": "abc123" }) : new Response("gone", { status: 404 }),
    );
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();
    transport.send(REQUEST);
    await sink.settled(2);

    expect(JSON.parse(sink.messages[1]!).error.message).toBe(
      "HTTP 404 (the server no longer recognises this session; the daemon must reconnect): gone",
    );
    await transport.close();
  });

  test("an answer to the server's own request that fails is logged — never failed back as one of our calls with its id", async () => {
    // The server's id is not ours: `7` could be a call of this client's still waiting, and would be failed by it.
    stubFetch(() => new Response("", { status: 500 }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }));
    await eventually(() => sink.logs.length + sink.messages.length > 0, 2_000, "the failure to be said");

    expect(sink.messages).toEqual([]);
    expect(sink.logs).toEqual(["HTTP 500"]);
    await transport.close();
  });

  test("a message that is not JSON is treated as a notification when it fails", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send("not json");
    // Said one way or the other — logged as a notification's, or answered as a request's — and read once it has been.
    await eventually(() => sink.logs.length + sink.messages.length > 0, 2_000, "the failure to be said");

    expect(sink.messages).toEqual([]);
    expect(sink.logs).toEqual(["HTTP 500"]);
    await transport.close();
  });

  test("closing aborts a request in flight, and its failure reaches nobody", async () => {
    const { signals, requests } = hangingFetch();
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    transport.send(NOTIFICATION);
    await transport.close();

    expect(signals.map((signal) => signal?.aborted)).toEqual([true, true]);
    // Each request's own failure: the transport awaited it before we did, so has handled it by the time we hear of it.
    await Promise.allSettled(requests);
    expect(sink.messages).toEqual([]);
    expect(sink.logs).toEqual([]);
  });

  test("closing with no session sends no DELETE", async () => {
    const calls = stubFetch(() => json({ jsonrpc: "2.0", id: 7, result: {} }));
    const sink = collector();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp" })(sink.handlers);
    transport.send(REQUEST);
    await sink.settled();
    await transport.close();

    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });
});

describe("sse, each decision", () => {
  const SSE = "https://mcp.test/sse";
  /** A second transport's stream, left open: what it says is what the same moment sounds like when the end is not ours. */
  const TWIN = "https://mcp.test/twin";

  /** A GET stream per URL, which the test drives, and every POST answered by `post`. */
  function server(post: (call: Call) => Response = () => new Response("", { status: 202 })) {
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const calls = stubFetch((call) => {
      if (call.method === "POST") return post(call);
      const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.set(call.url, c) });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const encoder = new TextEncoder();
    const stream = (url: string) => streams.get(url)!;
    return {
      calls,
      end: (url = SSE) => stream(url).close(),
      fail: (url = SSE) => stream(url).error(new Error("reset by peer")),
      announce: (url = SSE) => stream(url).enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n")),
    };
  }

  test("the stream is asked for as an event stream, and a POST as JSON", async () => {
    const s = server();
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);
    s.announce();
    await eventually(() => s.calls.length === 1);
    transport.send(REQUEST);
    await eventually(() => s.calls.length === 2);

    expect(s.calls[0]!.headers.accept).toBe("text/event-stream");
    expect(s.calls[1]).toMatchObject({ method: "POST", url: "https://mcp.test/messages", headers: { "content-type": "application/json" } });
    s.end();
    await transport.close();
  });

  test("a message sent after the endpoint is known is posted at once", async () => {
    const s = server((call) => new Response("", { status: call.body === SENTINEL ? 500 : 202 }));
    const sink = collector();
    const transport = sseTransport({ url: SSE })(sink.handlers);
    transport.send(REQUEST);
    s.announce();
    // Held for the announcement and posted on it: from here on the endpoint is known.
    await eventually(() => s.calls.length === 2, 2_000, "the held request to be posted");
    transport.send(NOTIFICATION);
    await eventually(() => s.calls.length === 3, 2_000, "the notification to be posted");

    expect(s.calls.slice(1).map((c) => c.body)).toEqual([REQUEST, NOTIFICATION]);
    // A 202 is the acknowledgement: the answer comes on the stream, and nothing is said on the POST's behalf.
    transport.send(SENTINEL);
    await eventually(() => sink.logs.length + sink.messages.length > 0, 2_000, "the sentinel's refusal");
    expect(sink.messages).toEqual([SENTINEL_REFUSED]);
    expect(sink.logs).toEqual([]);
    s.end();
    await transport.close();
  });

  test("a refused POST fails the waiting call, said as a status — never as a dropped session", async () => {
    const s = server(() => new Response("missing", { status: 404 }));
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);
    s.announce();
    transport.send(REQUEST);
    await sink.settled();

    expect(JSON.parse(sink.messages[0]!)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "HTTP 404: missing" } });
    expect(sink.logs).toEqual([]);
    s.end();
    await transport.close();
  });

  test("a refused notification is logged, not answered", async () => {
    const s = server(() => new Response("", { status: 500 }));
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);
    s.announce();
    transport.send(NOTIFICATION);
    await eventually(() => sink.logs.length > 0);

    expect(sink.logs).toEqual(["HTTP 500"]);
    expect(sink.messages).toEqual([]);
    s.end();
    await transport.close();
  });

  test("a stream that will not open is said as its status, never as a dropped session", async () => {
    stubFetch(() => new Response("no such endpoint", { status: 404 }));
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);
    await eventually(() => sink.closes.length > 0);

    expect(sink.closes).toEqual(["HTTP 404: no such endpoint"]);
    await transport.close();
  });

  test("a stream with no body closes the transport and says so", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);
    await eventually(() => sink.closes.length > 0);

    expect(sink.closes).toEqual(["the event stream returned no body"]);
    await transport.close();
  });

  test("a stream that ends is the transport closed — once", async () => {
    const s = server();
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);
    s.announce();
    s.end();
    await eventually(() => sink.closes.length > 0);

    expect(sink.closes).toEqual(["the event stream ended"]);
    await transport.close();
  });

  test("a stream that ends after we closed is not reported — the end is ours", async () => {
    const s = server();
    const sink = collector();
    const open = collector();
    const transport = sseTransport({ url: SSE })(sink.handlers);
    const twin = sseTransport({ url: TWIN })(open.handlers);
    s.announce();
    s.announce(TWIN);
    await transport.close();
    // Ended the same way, ours first: once the twin has said its end, ours has had its turn to say one.
    s.end();
    s.end(TWIN);
    await eventually(() => open.closes.length > 0, 2_000, "the twin's end to be said");

    expect(open.closes).toEqual(["the event stream ended"]);
    expect(sink.closes).toEqual([]);
    await twin.close();
  });

  test("a stream that fails is the transport closed, with why", async () => {
    const s = server();
    const sink = collector();
    const transport = sseTransport({ url: "https://mcp.test/sse" })(sink.handlers);
    s.fail();
    await eventually(() => sink.closes.length > 0);

    expect(sink.closes).toEqual(["the event stream failed: reset by peer"]);
    await transport.close();
  });

  test("closing aborts the stream and a POST in flight, and neither reports anything", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let failTwin = () => {};
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === TWIN) {
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (failTwin = () => c.error(new Error("reset by peer"))) });
        return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      }
      const signal = init?.signal ?? undefined;
      signals.push(signal);
      if (signals.length === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("event: endpoint\ndata: /messages\n\n"));
            signal?.addEventListener("abort", () => c.error(new Error("aborted")), { once: true });
          },
        });
        return Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } }));
      }
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as typeof fetch;
    const sink = collector();
    const open = collector();
    const transport = sseTransport({ url: SSE })(sink.handlers);
    const twin = sseTransport({ url: TWIN })(open.handlers);
    transport.send(REQUEST);
    transport.send(NOTIFICATION);
    await eventually(() => signals.length === 3);
    await transport.close();
    // The twin's stream fails after ours did: once it has said so, whatever ours led to has been said too.
    failTwin();
    await eventually(() => open.closes.length > 0, 2_000, "the twin's failure to be said");

    expect(open.closes).toEqual(["the event stream failed: reset by peer"]);
    expect(signals.map((signal) => signal?.aborted)).toEqual([true, true, true]);
    expect(sink.closes).toEqual([]);
    expect(sink.messages).toEqual([]);
    expect(sink.logs).toEqual([]);
    await twin.close();
  });

  test("a POST names the version the client settled on, once it is told — the stream it opened before does not", async () => {
    const s = server();
    const sink = collector();
    const transport = sseTransport({ url: SSE })(sink.handlers);
    s.announce();
    transport.send(REQUEST);
    await eventually(() => s.calls.length === 2, 2_000, "the first POST");
    transport.protocolVersion?.("2024-11-05");
    transport.send(NOTIFICATION);
    await eventually(() => s.calls.length === 3, 2_000, "the second POST");

    expect(s.calls.map((c) => c.headers["mcp-protocol-version"])).toEqual([undefined, undefined, "2024-11-05"]);
    s.end();
    await transport.close();
  });

  test("the idle ping is the option's when one is given", () => {
    const transport = sseTransport({ url: "http://127.0.0.1:9/sse", idlePingMs: 5 })({ onMessage: () => {}, onClose: () => {} });
    expect(transport.idlePingMs).toBe(5);
    void transport.close();
  });
});
