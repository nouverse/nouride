/**
 * The HTTP transports: `streamable-http` (current) and `sse` (the 2024 shape, still what a lot of
 * deployed servers speak).
 *
 * Thin for the same reason `stdio.ts` is thin — `protocol.ts` and `client.ts` own the request
 * lifecycle, and neither knows or cares how bytes move. What is genuinely different here is that
 * HTTP has no single long-lived pipe to read: a reply can come back on the POST that asked for it,
 * on a *stream* returned by that POST, or on a separate stream opened once for the whole session.
 * All three end in the same place, `handlers.onMessage`, and above that line the client cannot tell
 * which happened.
 *
 * ## Failing a call instead of waiting for it to time out
 *
 * `McpTransport.send` returns void: it cannot report that a POST came back 401. Left alone, an
 * unreachable or misconfigured server presents as every call hanging for the full request timeout —
 * thirty seconds per tool call, for a server that answered immediately and said "no".
 *
 * So a failed POST is turned into a JSON-RPC error response carrying the id of the request that
 * failed, and handed back through `onMessage`. The waiting call rejects at once with the real
 * reason. This is the whole justification for parsing the outgoing message here; nothing else in
 * this file looks at what it is sending.
 *
 * ## No SSRF guard, deliberately
 *
 * `web_fetch` resolves and checks its host because a *model* chose that URL. An MCP server's URL is
 * written by the operator in a config file, next to the credential it authenticates with — the same
 * trust level as the `command` a stdio server runs. Guarding it would block an agent from reaching
 * an MCP server on its own LAN, which is a normal deployment, in exchange for no boundary that the
 * operator could not already cross.
 */

import { createLogger, parseSse } from "@nouride/shared";
import type { McpTransport, McpTransportFactory, McpTransportHandlers } from "./client.ts";
import { authorizedFetch, withHeaders, type McpAuth } from "./http-auth.ts";

const log = createLogger("mcp.http");

/** One POST, or one silent stretch of a stream, before we stop waiting. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Enough of a server's error body to diagnose it, not enough to fill a log line with HTML. */
const MAX_ERROR_DETAIL = 300;

/** The GET stream, reopened after it ends: a second at first, doubling to half a minute. */
const LISTEN_RETRY_MS = 1_000;
const LISTEN_RETRY_MAX_MS = 30_000;
/** A stream that stayed open this long was a working one: the next drop starts the backoff over. */
const LISTEN_STABLE_MS = 60_000;

export interface HttpTransportOptions {
  url: string;
  /**
   * Sent on every request. Where the credential goes — `Authorization: Bearer …` for most hosted
   * servers, `X-Api-Key` for some.
   *
   * Resolved from the secret store before it reaches here: config holds the *name* of a secret, not
   * its value, so a pack that gets committed does not carry a token with it.
   */
  headers?: Record<string, string>;
  /**
   * A credential that changes while the connection lives — `oauthAuth` for a server logged in to with OAuth. Its
   * headers go on every request, the POSTs and both streams, over the static `headers` (an `Authorization` it gives
   * replaces one written there); a 401 asks it whether to send the request once more, and when it says no the call
   * fails with `McpAuthRequiredError`. Absent, a 401 is an HTTP failure like any other, as it always was.
   */
  auth?: McpAuth;
  /** Ceiling for one request. Matches the client's own per-call timeout when the caller sets both. */
  timeoutMs?: number;
  /** How long the legacy SSE stream may be silent before the client pings it — `SSE_IDLE_PING_MS` by default. */
  idlePingMs?: number;
  /** `LISTEN_RETRY_MS`, for a test that cannot wait a second for a stream to be opened again. */
  listenRetryMs?: number;
}

/**
 * A minute of silence on the legacy SSE stream, and the client asks `ping`. Long enough that a server talked
 * to twice an hour costs one small request a minute, short enough that a stream dropped by something in between is
 * found within a call's timeout of it rather than at the next call.
 */
const SSE_IDLE_PING_MS = 60_000;

// ── streamable-http ──────────────────────────────────────────────────────────

/**
 * One endpoint, POST per message, reply on that POST's own response.
 *
 * The response is `application/json` for a plain answer or `text/event-stream` when the server wants
 * to send progress notifications before the result. Both are handled; the difference never reaches
 * the client.
 *
 * **The GET stream is opened only when the client asks (`listen`)** — for a server that declared it will say when its
 * tools change. It is the one way such a server can say so unasked; for any other it would be a held connection and a
 * reconnect policy delivering messages nobody reads, which is why none was opened at all before 0.7.13. A server
 * that offers no stream answers the GET with 405, which is the end of it.
 */
export function streamableHttpTransport(options: HttpTransportOptions): McpTransportFactory {
  return (handlers: McpTransportHandlers): McpTransport => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abort = new AbortController();
    let closed = false;

    /**
     * Assigned by the server on `initialize`, echoed on everything after.
     *
     * A server that issues one and stops seeing it treats each call as a fresh unauthenticated
     * client — which presents as `tools/list` working during connect and every later call 404ing.
     */
    let sessionId: string | undefined;
    /**
     * The version the handshake settled on, sent on every request after it as 2025-06-18 requires — told by the client
     * once it has accepted it, rather than read off whatever answer came first.
     */
    let version: string | undefined;
    /** The latest POST, so the GET stream is asked for after the one before it: `notifications/initialized`. */
    let lastPost: Promise<void> = Promise.resolve();
    let listening = false;

    /** What every request after `initialize` carries: the session, the version, and the operator's own headers. */
    const sessionHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
      ...extra,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(version ? { "mcp-protocol-version": version } : {}),
      ...options.headers,
    });

    /**
     * The server dropped the session (a 404 that carried one): the spec has the client start a new one, and the client
     * cannot do that in place, so the transport is over — said the way a stream ending is, and the supervisor reconnects.
     */
    const sessionGone = (reason: string): void => {
      if (closed) return;
      closed = true;
      sessionId = undefined;
      abort.abort();
      handlers.onClose(reason);
    };

    const deliver = (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // A batch is unwrapped here rather than in the client, which is written against one message at
      // a time — handing it a JSON array would parse cleanly, match no pending id, and be dropped in
      // silence. 2025-06-18 has no batches and none is ever sent from here; one from a 2025-03-26 server is still read.
      if (trimmed.startsWith("[")) {
        let batch: unknown;
        try {
          batch = JSON.parse(trimmed);
        } catch {
          handlers.onMessage(trimmed);
          return;
        }
        if (Array.isArray(batch)) {
          for (const message of batch) handlers.onMessage(JSON.stringify(message));
          return;
        }
      }
      handlers.onMessage(trimmed);
    };

    const post = async (raw: string): Promise<void> => {
      const id = requestIdOf(raw);
      try {
        const answered = await authorizedFetch(
          options.url,
          { method: "POST", body: raw, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]) },
          // Both, because the server chooses: a plain result comes back as JSON, a result with
          // progress notifications ahead of it comes back as a stream.
          sessionHeaders({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
          options.auth,
        );
        if ("loginNeeded" in answered) {
          if (!closed) loginNeeded(handlers, id, answered.loginNeeded, options.url);
          return;
        }
        const response = answered.response;

        const assigned = response.headers.get("mcp-session-id");
        if (assigned) sessionId = assigned;

        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          const reason = describeStatus(response.status, detail, sessionId !== undefined);
          // Said to the call first, so it fails with what the server answered; then the transport is over.
          if (response.status === 404 && sessionId !== undefined) {
            if (id !== null) handlers.onMessage(errorResponse(id, reason));
            sessionGone(reason);
            return;
          }
          throw new Error(reason);
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("text/event-stream") && response.body) {
          // Idle-bounded, not open-ended: this stream exists to answer one request, and the spec has
          // the server close it afterwards. One that does not would otherwise leave this task — and
          // the connection under it — alive for the life of the daemon.
          for await (const event of parseSse(response.body, timeoutMs)) deliver(event.data);
          return;
        }

        // 202 with an empty body is the documented answer to a notification. Nothing was returned
        // and nothing is waiting, so there is nothing to do with it.
        const body = await response.text();
        deliver(body);
      } catch (err) {
        if (closed) return;
        const reason = err instanceof Error ? err.message : String(err);

        if (id === null) {
          // A notification, or an answer to the server. Nobody is waiting on it, so there is no call to fail — but a
          // server that is rejecting `notifications/initialized` is about to reject everything, and the log line
          // is the only warning of that.
          log.warn("a message no call waits on was not delivered", { url: options.url, error: reason });
          handlers.onLog?.(reason);
          return;
        }
        handlers.onMessage(errorResponse(id, reason));
      }
    };

    /**
     * The GET stream, for as long as the transport lives: opened, read, and opened again when it ends — a server may
     * close it whenever it likes, and so may anything between us and it. A 405 is a server with no stream to offer, and
     * the end of asking. What it says reaches the client as any message does; an event id is kept so a reopened stream
     * can ask to resume after it (`Last-Event-ID`), for a server that replays.
     */
    const listenLoop = async (): Promise<void> => {
      const retryMs = options.listenRetryMs ?? LISTEN_RETRY_MS;
      let lastEventId: string | undefined;
      for (let attempt = 0; !closed; attempt += 1) {
        const openedAt = Date.now();
        let ended: string;
        try {
          const answered = await authorizedFetch(
            options.url,
            { method: "GET", signal: abort.signal },
            sessionHeaders({ accept: "text/event-stream", ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }) }),
            options.auth,
          );
          // Opened again after the backoff, with whatever credential there is by then: the next POST is where a lost
          // login is said, to the call that made it.
          if ("loginNeeded" in answered) throw new Error("the server asks for a login");
          const response = answered.response;
          if (response.status === 405) {
            log.debug("the server offers no stream of its own (405); a change to its tools is taken up when it next connects", { url: options.url });
            return;
          }
          if (!response.ok) {
            const reason = describeStatus(response.status, await response.text().catch(() => ""), sessionId !== undefined);
            if (response.status === 404 && sessionId !== undefined) return sessionGone(reason);
            throw new Error(reason);
          }
          if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
            log.debug("the server answered its stream with something else; not asked again", { url: options.url, status: response.status });
            return;
          }
          // No idle timeout: this stream is meant to sit quiet until the server has something to say.
          for await (const event of parseSse(response.body)) {
            if (event.id !== undefined) lastEventId = event.id;
            deliver(event.data);
          }
          ended = "it ended";
        } catch (err) {
          if (closed) return;
          ended = `it failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (closed) return;
        if (Date.now() - openedAt >= LISTEN_STABLE_MS) attempt = 0;
        const inMs = Math.min(retryMs * 2 ** attempt, LISTEN_RETRY_MAX_MS);
        log.debug("the server's stream closed; opening it again", { url: options.url, why: ended, in_ms: inMs });
        await pause(abort.signal, inMs);
      }
    };

    return {
      send(raw) {
        // Deliberately not awaited. `send` is void by contract, and the reply — success or the
        // synthesised failure above — reaches the client through `onMessage` either way.
        lastPost = post(raw);
      },
      protocolVersion(negotiated) {
        version = negotiated;
      },
      listen() {
        if (listening || closed) return;
        listening = true;
        // `listenLoop` catches what it meets; a rejection past that would be this file's own bug, and is said.
        void lastPost.then(listenLoop).catch((err: unknown) => log.error("the server's stream stopped being read", { url: options.url, error: String(err) }));
      },
      async close() {
        if (closed) return;
        closed = true;
        // Best effort, and unawaited failures are fine: the session is ending here whatever the
        // server thinks, and a host that is shutting down should not block on one that has already
        // stopped answering.
        if (sessionId) {
          const deadline = AbortSignal.timeout(2_000);
          await fetch(options.url, {
            method: "DELETE",
            headers: withHeaders(sessionHeaders(), await credentialWithin(options.auth, deadline)),
            signal: deadline,
          }).catch(() => {});
        }
        abort.abort();
      },
    };
  };
}

// ── sse (legacy) ─────────────────────────────────────────────────────────────

/**
 * Two channels: a long-lived GET stream for everything the server says, and a POST endpoint the
 * server names on that stream for everything the client says.
 *
 * The ordering is the awkward part. The POST URL is not known until the server's first event
 * arrives, and `McpClient.connect` sends `initialize` the moment the transport is constructed — so
 * the first message reliably predates the address it has to be sent to. It is held and flushed
 * rather than rejected; the alternative is a handshake that fails on a working server because of
 * who spoke first.
 */
export function sseTransport(options: HttpTransportOptions): McpTransportFactory {
  return (handlers: McpTransportHandlers): McpTransport => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const abort = new AbortController();
    let closed = false;

    let endpoint: string | undefined;
    const backlog: string[] = [];
    /** The negotiated version, on every POST after `initialize` — the header is the spec's for any MCP over HTTP. */
    let version: string | undefined;

    const post = async (raw: string, to: string): Promise<void> => {
      const id = requestIdOf(raw);
      try {
        const answered = await authorizedFetch(
          to,
          { method: "POST", body: raw, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]) },
          { "content-type": "application/json", ...(version ? { "mcp-protocol-version": version } : {}), ...options.headers },
          options.auth,
        );
        if ("loginNeeded" in answered) {
          if (!closed) loginNeeded(handlers, id, answered.loginNeeded, to);
          return;
        }
        const response = answered.response;
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(describeStatus(response.status, detail, false));
        }
        // The reply is not here. In this transport a POST is acknowledged with 202 and the actual
        // response is written to the GET stream, which the read loop below is already draining.
      } catch (err) {
        if (closed) return;
        const reason = err instanceof Error ? err.message : String(err);
        if (id === null) {
          log.warn("a message no call waits on was not delivered", { url: to, error: reason });
          handlers.onLog?.(reason);
          return;
        }
        handlers.onMessage(errorResponse(id, reason));
      }
    };

    // The read loop. Not awaited — it runs for the life of the transport, and its caller is holding
    // the conversation.
    void (async () => {
      try {
        const answered = await authorizedFetch(options.url, { signal: abort.signal }, { accept: "text/event-stream", ...options.headers }, options.auth);
        if ("loginNeeded" in answered) {
          if (closed) return;
          // Every message so far is held for an endpoint this stream will never announce: each call is told why, and
          // `initialize` among them fails the connect with `McpAuthRequiredError`.
          for (const queued of backlog.splice(0)) loginNeeded(handlers, requestIdOf(queued), answered.loginNeeded, options.url);
          handlers.onClose(LOGIN_NEEDED);
          return;
        }
        const response = answered.response;
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          handlers.onClose(describeStatus(response.status, detail, false));
          return;
        }
        if (!response.body) {
          handlers.onClose("the event stream returned no body");
          return;
        }

        // No idle timeout, unlike the streamable-http response stream: this one is *supposed* to sit
        // quiet between calls. A server the agent talks to twice an hour is healthy, and cutting it
        // off after thirty seconds would make this transport unusable for the normal case. Silence is asked about
        // instead: the client pings after `idlePingMs` of it, and a ping unanswered is the stream lost.
        for await (const event of parseSse(response.body)) {
          if (event.event === "endpoint") {
            // Servers answer with a path far more often than an absolute URL, and resolving against
            // the stream's own URL covers both.
            endpoint = new URL(event.data.trim(), options.url).toString();
            log.debug("sse endpoint announced", { url: options.url, endpoint });
            for (const queued of backlog.splice(0)) void post(queued, endpoint);
            continue;
          }
          handlers.onMessage(event.data);
        }
        if (!closed) handlers.onClose("the event stream ended");
      } catch (err) {
        if (closed) return;
        handlers.onClose(`the event stream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();

    return {
      send(raw) {
        const to = endpoint;
        if (!to) {
          backlog.push(raw);
          return;
        }
        void post(raw, to);
      },
      protocolVersion(negotiated) {
        version = negotiated;
      },
      async close() {
        closed = true;
        abort.abort();
      },
      idlePingMs: options.idlePingMs ?? SSE_IDLE_PING_MS,
    };
  };
}

// ── shared ───────────────────────────────────────────────────────────────────

/**
 * The id of an outgoing request, or null for anything nobody here waits on.
 *
 * Null is not a failure: `notifications/initialized` has no id and is supposed to have none, and an answer to a
 * server's own request (a `ping`) carries the *server's* id — failed back into the client, it could match a call of
 * ours that happens to have the same number. Only a request has somebody waiting to be told it failed.
 */
function requestIdOf(raw: string): number | null {
  try {
    const message = JSON.parse(raw) as { id?: unknown; method?: unknown };
    return typeof message.id === "number" && typeof message.method === "string" ? message.id : null;
  } catch {
    return null;
  }
}

/** A request refused for want of a login, said where no `McpAuthRequiredError` can be: a log line, a stream's end. */
const LOGIN_NEEDED = "the server asks for a login: it refused the credential it was sent, and no renewed one was to be had";

/**
 * Request `id` was refused for want of a login. Its call fails with `McpAuthRequiredError` through `onAuthRequired`, or
 * as any failed request does where the handlers take no such thing; a message no call waits on is only said.
 */
function loginNeeded(handlers: McpTransportHandlers, id: number | null, challenge: string | null, url: string): void {
  if (id === null) {
    log.warn("a message no call waits on was not delivered", { url, error: LOGIN_NEEDED });
    handlers.onLog?.(LOGIN_NEEDED);
  } else if (handlers.onAuthRequired) {
    handlers.onAuthRequired(id, challenge);
  } else {
    handlers.onMessage(errorResponse(id, LOGIN_NEEDED));
  }
}

/** `auth`'s headers for a best-effort request, or none once `deadline` fires first: closing never waits on a renewal. */
async function credentialWithin(auth: McpAuth | undefined, deadline: AbortSignal): Promise<Record<string, string>> {
  if (!auth) return {};
  const late = new Promise<undefined>((resolve) => deadline.addEventListener("abort", () => resolve(undefined), { once: true }));
  return (await Promise.race([auth.headers().catch(() => undefined), late])) ?? {};
}

/** A JSON-RPC error the client will match to its pending call. See the note at the top of the file. */
function errorResponse(id: number, message: string): string {
  // -32000 is the JSON-RPC "server error" range, which is the honest code here: the failure happened
  // below the protocol, and nothing about it came from the peer's own error handling.
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });
}

/** `ms`, or until `signal` fires — whichever is first. */
function pause(signal: AbortSignal, ms: number): Promise<void> {
  const either = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  return new Promise((resolve) => either.addEventListener("abort", () => resolve(), { once: true }));
}

/**
 * An HTTP failure, said in terms of what the operator has to change.
 *
 * The two that get misread are called out by name. A 401/403 is a credential problem and nothing
 * about the URL; a 404 *after* a session was issued is not a wrong address — it is the server having
 * dropped a session it previously accepted, which otherwise reads as "the URL was wrong all along"
 * on a config that worked a minute earlier.
 */
function describeStatus(status: number, detail: string, hadSession: boolean): string {
  const trimmed = detail.trim().slice(0, MAX_ERROR_DETAIL);
  const suffix = trimmed ? `: ${trimmed}` : "";

  if (status === 401 || status === 403) {
    return `HTTP ${status} (the server rejected the credential)${suffix}`;
  }
  if (status === 404 && hadSession) {
    return `HTTP 404 (the server no longer recognises this session; the daemon must reconnect)${suffix}`;
  }
  return `HTTP ${status}${suffix}`;
}
