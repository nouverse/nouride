/**
 * What the HTTP transports owe an `auth`: its headers on every request — both streams and every POST, over the static
 * ones — `unauthorized` asked once per 401, one retry at most, and a call that cannot get past the server failed as a
 * login needed. Each decision against a stubbed `fetch`; the legacy SSE shape and the GET stream against real servers.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { McpTransportHandlers } from "../src/client.ts";
import { McpAuthRequiredError, McpClient, sseTransport, streamableHttpTransport, type McpAuth } from "../src/index.ts";
import { loggedIn } from "./fixtures/logged-in.ts";
import type { OAuthScript } from "./fixtures/oauth-servers.ts";
import { eventually } from "./wait.ts";

const realFetch = globalThis.fetch;
const running: { stop(): Promise<unknown> }[] = [];
const clients: McpClient[] = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((servers) => servers.stop()));
});

interface Call {
  method: string;
  headers: Record<string, string>;
}

/** Replace `fetch` with `respond`, recording each call's method and headers as the server would see them. */
function stubFetch(respond: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", headers: Object.fromEntries(new Headers(init?.headers).entries()) };
    calls.push(call);
    return respond(call, calls.length);
  }) as typeof fetch;
  return calls;
}

/** An `McpAuth` that hands out `token-1`, `token-2` … and answers `unauthorized` with `retry`, recording what it is asked. */
function scriptedAuth(retry: boolean | (() => Promise<boolean>) = true) {
  let issued = 0;
  const asked: { challenge: string | null; sent: Record<string, string> }[] = [];
  const auth: McpAuth = {
    headers: async () => ({ authorization: `Bearer token-${(issued += 1)}` }),
    unauthorized: async (challenge, sent) => {
      asked.push({ challenge, sent });
      return typeof retry === "function" ? await retry() : retry;
    },
  };
  return { auth, asked };
}

function sink() {
  const messages: string[] = [];
  const logs: string[] = [];
  const refused: { id: number; challenge: string | null }[] = [];
  const handlers: McpTransportHandlers = {
    onMessage: (raw) => void messages.push(raw),
    onLog: (line) => void logs.push(line),
    onClose: () => {},
    onAuthRequired: (id, challenge) => void refused.push({ id, challenge }),
  };
  return { handlers, messages, logs, refused };
}

const REQUEST = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
const CHALLENGE = 'Bearer error="invalid_token", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"';
const ok = () => Response.json({ jsonrpc: "2.0", id: 7, result: { tools: [] } });
const unauthorized = () => new Response("no", { status: 401, headers: { "www-authenticate": CHALLENGE } });

describe("streamable-http with an auth", () => {
  test("sends its headers over the static ones — one Authorization, the auth's — and keeps the rest", async () => {
    const calls = stubFetch(ok);
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", headers: { Authorization: "Bearer static", "X-Api-Key": "k-1" }, auth: scriptedAuth().auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.messages.length > 0);

    expect(calls[0]!.headers.authorization).toBe("Bearer token-1");
    expect(calls[0]!.headers["x-api-key"]).toBe("k-1");
    await transport.close();
  });

  test("a 401 asks unauthorized once, with the challenge and what was sent, and sends the request once more with fresh headers", async () => {
    const calls = stubFetch((_call, n) => (n === 1 ? unauthorized() : ok()));
    const a = scriptedAuth();
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: a.auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.messages.length > 0);

    expect(a.asked).toEqual([{ challenge: CHALLENGE, sent: { authorization: "Bearer token-1" } }]);
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(JSON.parse(s.messages[0]!)).toMatchObject({ id: 7, result: { tools: [] } });
    await transport.close();
  });

  test("a second 401 is not retried: the call is a login needed, and unauthorized was asked once", async () => {
    // A server that would have let a third attempt through: only the one-retry rule stops at two.
    const calls = stubFetch((_call, n) => (n <= 2 ? unauthorized() : ok()));
    const a = scriptedAuth();
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: a.auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.refused.length + s.messages.length > 0);

    expect(calls).toHaveLength(2);
    expect(a.asked).toHaveLength(1);
    expect(s.refused).toEqual([{ id: 7, challenge: CHALLENGE }]);
    expect(s.messages).toEqual([]);
    await transport.close();
  });

  test("unauthorized declining is a login needed at once, with no second request", async () => {
    const calls = stubFetch(unauthorized);
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: scriptedAuth(false).auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.refused.length > 0);

    expect(calls).toHaveLength(1);
    expect(s.refused).toEqual([{ id: 7, challenge: CHALLENGE }]);
    await transport.close();
  });

  test("a 403 asking for more scope is a login needed at once — no renewal widens a scope — and a plain 403 is an HTTP failure", async () => {
    const narrow = 'Bearer error="insufficient_scope", scope="files:write"';
    let plain = false;
    stubFetch(() => new Response("", { status: 403, headers: plain ? {} : { "www-authenticate": narrow } }));
    const a = scriptedAuth();
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: a.auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.refused.length > 0);
    expect(s.refused).toEqual([{ id: 7, challenge: narrow }]);
    expect(a.asked).toEqual([]);

    plain = true;
    transport.send(REQUEST);
    await eventually(() => s.messages.length > 0);
    expect(JSON.parse(s.messages[0]!).error.message).toBe("HTTP 403 (the server rejected the credential)");
    await transport.close();
  });

  test("an unauthorized that throws fails the call with what it threw — an outage, not a lost login", async () => {
    stubFetch(unauthorized);
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: scriptedAuth(() => Promise.reject(new Error("the token endpoint is down"))).auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.messages.length > 0);

    expect(JSON.parse(s.messages[0]!)).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: "the token endpoint is down" } });
    expect(s.refused).toEqual([]);
    await transport.close();
  });

  test("with handlers that take no onAuthRequired, a refused call still fails — as a message — and a notification is said", async () => {
    stubFetch(unauthorized);
    const s = sink();
    const { onAuthRequired: _none, ...plain } = s.handlers;
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: scriptedAuth(false).auth })(plain);
    transport.send(REQUEST);
    transport.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await eventually(() => s.messages.length > 0 && s.logs.length > 0);

    expect(JSON.parse(s.messages[0]!).error.message).toContain("asks for a login");
    expect(s.logs[0]).toContain("asks for a login");
    await transport.close();
  });

  test("a renewal still running when the transport closes reports nothing once it ends", async () => {
    stubFetch(unauthorized);
    let decide: (retry: boolean) => void = () => {};
    const a = scriptedAuth(() => new Promise<boolean>((resolve) => (decide = resolve)));
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: a.auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => a.asked.length > 0);
    await transport.close();
    decide(false);
    // Said through the same paths a live transport takes; a twin request on a live one shows they had time to.
    const live = sink();
    const twin = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: scriptedAuth(false).auth })(live.handlers);
    twin.send(REQUEST);
    await eventually(() => live.refused.length > 0);

    expect(s.refused).toEqual([]);
    expect(s.messages).toEqual([]);
    await twin.close();
  });

  test("the stream the server speaks on, refused for want of a login, is asked again after the backoff", async () => {
    const encoder = new TextEncoder();
    const calls = stubFetch((call, n) => {
      if (call.method === "POST") return ok();
      if (n <= 2) return unauthorized();
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n')),
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: scriptedAuth(false).auth, listenRetryMs: 5 })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.messages.length > 0);
    transport.listen?.();
    await eventually(() => s.messages.some((m) => m.includes("list_changed")), 2_000, "the stream to be opened again and heard");

    expect(calls.filter((c) => c.method === "GET").map((c) => c.headers.authorization)).toEqual(["Bearer token-2", "Bearer token-3"]);
    await transport.close();
  });

  test("closing sends the credential with the DELETE that ends the session — and never waits on a renewal that hangs", async () => {
    const calls = stubFetch(() => Response.json({ jsonrpc: "2.0", id: 7, result: {} }, { headers: { "mcp-session-id": "s-1" } }));
    const s = sink();
    const transport = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: scriptedAuth().auth })(s.handlers);
    transport.send(REQUEST);
    await eventually(() => s.messages.length > 0);
    await transport.close();
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "s-1", authorization: "Bearer token-2" } });

    let asked = 0;
    const hanging: McpAuth = { headers: () => (asked++ === 0 ? Promise.resolve({ authorization: "Bearer first" }) : new Promise(() => {})), unauthorized: async () => false };
    const stuck = streamableHttpTransport({ url: "https://mcp.test/mcp", auth: hanging })(sink().handlers);
    stuck.send(REQUEST);
    await eventually(() => calls.length === 3);
    const started = Date.now();
    await stuck.close();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("against real servers", () => {
  let clock = 1_000_000;
  const now = () => clock;
  afterEach(() => void (clock = 1_000_000));

  async function login(script: OAuthScript = {}) {
    const login = await loggedIn(script, now);
    running.push(login.servers);
    return login;
  }
  function client(transport: ReturnType<typeof sseTransport>): McpClient {
    const made = new McpClient({ name: "remote", transport, timeoutMs: 5_000 });
    clients.push(made);
    return made;
  }

  test("the legacy SSE transport sends the token on its stream and every POST", async () => {
    const l = await login();
    const remote = client(sseTransport({ url: l.servers.sseUrl, auth: l.auth() }));
    await remote.connect();
    expect((await remote.callTool("echo", { text: "over sse" })).text).toBe("over sse");

    const sse = l.servers.mcpRequests.filter((r) => r.path === "/sse" || r.path === "/messages");
    expect(sse.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /sse", "POST /messages", "POST /messages", "POST /messages"]);
    expect(new Set(sse.map((r) => r.headers.authorization))).toEqual(new Set([`Bearer ${l.tokens.accessToken}`]));
  });

  test("a 401 on the SSE stream, and on an SSE POST, renews the login and goes on", async () => {
    const l = await login();
    l.servers.revokeAll();
    const remote = client(sseTransport({ url: l.servers.sseUrl, auth: l.auth() }));
    await remote.connect();
    expect(l.servers.refreshes()).toBe(1);

    await eventually(() => l.servers.initialized(), 4_000, "the initialized notification to reach the server");
    l.servers.revokeAll();
    expect((await remote.callTool("echo", { text: "renewed twice" })).text).toBe("renewed twice");
    expect(l.servers.refreshes()).toBe(2);
    expect(l.stored).toHaveLength(2);
  });

  test("an SSE stream refused for want of a login fails the connect as a login needed, with the challenge", async () => {
    const l = await login({ refusesRefresh: true });
    l.servers.revokeAll();
    const remote = client(sseTransport({ url: l.servers.sseUrl, auth: l.auth() }));

    const refused = await remote.connect().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(McpAuthRequiredError);
    expect((refused as McpAuthRequiredError).challenge).toContain("resource_metadata=");
    // And the stream is said to be over, so nothing holds the client as though it were connected.
    expect(remote.connected).toBe(false);
  });

  test("the stream a streamable-http server speaks on unasked is opened with the token too", async () => {
    const l = await login({ listChanged: true });
    const remote = client(streamableHttpTransport({ url: l.servers.mcpUrl, auth: l.auth(), listenRetryMs: 5 }));
    await remote.connect();
    await eventually(() => l.servers.mcpRequests.some((r) => r.method === "GET" && r.path === "/mcp"), 2_000, "the GET stream to be asked for");

    const opened = l.servers.mcpRequests.find((r) => r.method === "GET" && r.path === "/mcp")!;
    expect(opened.headers.authorization).toBe(`Bearer ${l.tokens.accessToken}`);
    expect(opened.headers.accept).toBe("text/event-stream");
  });
});
