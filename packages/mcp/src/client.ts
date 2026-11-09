/**
 * One connection to one MCP server.
 *
 * Transport-agnostic on purpose: the client is handed a factory, so the whole request/response
 * lifecycle — handshake, id matching, timeouts, what happens when the peer dies mid-call — is
 * exercised in tests against an in-memory fake, with no process to spawn and no server to install.
 * `stdio.ts` is then a thin adapter rather than the thing under test.
 */

import { contained, createLogger } from "@nouride/shared";
import {
  METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  flattenContent,
  imagesOf,
  nextCursor,
  notification,
  parseMessage,
  parseServerInfo,
  parseTools,
  refusal,
  reply,
  request,
  type JsonRpcId,
  type JsonRpcResponse,
  type McpImage,
  type McpServerInfo,
  type McpTool,
  type McpToolCallResult,
} from "./protocol.ts";

const log = createLogger("mcp");

/** How the client talks to a peer. Implemented by `stdio.ts` and `http.ts`, and by fakes in the tests. */
export interface McpTransport {
  send(raw: string): void;
  close(): Promise<void>;
  /**
   * How long the peer may say nothing before it is asked `ping` — for a transport whose death is otherwise silent.
   *
   * The legacy SSE stream sits quiet between calls by design, and one a NAT or a proxy dropped without a word is
   * noticed only when the next call's answer never comes back on it: that call waits out its timeout, the
   * transport is never reported lost, and nothing reconnects it. Absent, nothing is pinged.
   */
  idlePingMs?: number;
  /**
   * The protocol version the handshake settled on, for a transport that says it on every request after it — HTTP's
   * `MCP-Protocol-Version` (2025-06-18). Told once, before `notifications/initialized` goes out.
   */
  protocolVersion?(version: string): void;
  /**
   * Open the way a server speaks unasked, for a transport that has to open one: Streamable HTTP's GET stream. Asked
   * only of a server that declared something this client acts on — `tools.listChanged` — so every other server is
   * spared a held connection that would deliver nothing anyone reads.
   */
  listen?(): void;
}

export interface McpTransportHandlers {
  /** One complete protocol message. */
  onMessage(raw: string): void;
  /** Anything the peer wrote to its log channel — stderr for stdio. */
  onLog?(line: string): void;
  /** The peer went away. Any call still in flight is failed with this reason. */
  onClose(reason: string): void;
  /**
   * The server refused request `id` for want of a login — its credential was turned down and could not be renewed —
   * with the server's `WWW-Authenticate` value. The call fails with `McpAuthRequiredError` rather than a message, so the
   * caller can tell "log in again" from every other failure. A transport whose handlers have none says it through
   * `onMessage`, as any failed request.
   */
  onAuthRequired?(id: number, challenge: string | null): void;
}

export type McpTransportFactory = (handlers: McpTransportHandlers) => McpTransport;

export interface McpClientOptions {
  /** The name from config — used in every log line and every error a model will read. */
  name: string;
  transport: McpTransportFactory;
  /** Per-request ceiling. A server that never answers must not park a turn forever. */
  timeoutMs?: number;
  /** `initialize`'s own, for a server that may be slow to come up the first time: `timeoutMs` where it is not set. */
  initializeTimeoutMs?: number;
  /** How long a burst of `tools/list_changed` is gathered into one listing — `RELIST_AFTER_MS` by default. */
  relistAfterMs?: number;
}

export class McpError extends Error {
  constructor(
    readonly server: string,
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/**
 * A server over HTTP refused a call for want of a login: it answered 401 — or 403 `insufficient_scope`, wanting more
 * than the login gave — and the transport's `auth` could not renew the credential. Nothing short of the person logging
 * in mends it, so whoever holds the connection shows "needs a login" rather than retrying. `challenge` is the server's
 * `WWW-Authenticate` value: `discoverOAuth` reads where its authorization server is from it, and the scope it wants.
 */
export class McpAuthRequiredError extends McpError {
  override name = "McpAuthRequiredError";

  constructor(
    server: string,
    readonly challenge: string | null,
  ) {
    super(server, `"${server}" needs a login: it refused the credential this connection holds, and no renewed one was to be had`);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A server that changes its tools often says so once per tool — five registered, five notifications back to back. They
 * are gathered for this long and answered with one listing, not five.
 */
const RELIST_AFTER_MS = 250;

/** Pages of `tools/list` read before the rest is given up on — a server whose cursor never ends cannot hold a connect. */
const MAX_TOOL_PAGES = 50;

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  /** Stops the timeout and stops listening for the caller's abort — called however the request ends. */
  release(): void;
  method: string;
}

export class McpClient {
  private transport: McpTransport | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  /** Set when the transport reports the peer went away, as opposed to us closing it. */
  private peerGone = false;
  private peerLost: ((reason: string) => void) | undefined;
  private info: McpServerInfo | undefined;
  /** When the peer last said anything — what an idle ping is measured from. */
  private lastHeard = 0;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private toolsChanged: ((tools: McpTool[]) => void) | undefined;
  /** The listing a `tools/list_changed` asked for: waiting out its burst, running, and asked for again meanwhile. */
  private relist: { timer?: ReturnType<typeof setTimeout>; running: boolean; again: boolean } = { running: false, again: false };

  constructor(private readonly options: McpClientOptions) {}

  get name(): string {
    return this.options.name;
  }

  /**
   * Whether this client can still be called.
   *
   * False once the peer goes away, not only once *we* close. Those were conflated, and the symptom
   * was a dashboard reporting a dead server as connected with a tool count it could no longer
   * deliver: a stdio child that exited, or an HTTP stream a proxy timed out, left `transport` set and
   * `closed` false, so nothing here noticed.
   */
  get connected(): boolean {
    return this.transport !== undefined && !this.closed && !this.peerGone;
  }

  get serverInfo(): McpServerInfo | undefined {
    return this.info;
  }

  /**
   * Be told when the peer goes away on its own — a child that exited, a stream that dropped.
   *
   * A setter rather than a constructor option because the supervisor that reacts to it is attached
   * *after* the handshake succeeds: a server that never connected has nothing to reconnect, and
   * subscribing earlier would put a failed first attempt on the retry curve.
   *
   * Never fired by `close()`. A shutdown we asked for is not an event anybody needs to react to, and
   * conflating the two is how a deliberate disconnect turns into a reconnect loop.
   */
  onPeerLost(handler: (reason: string) => void): void {
    this.peerLost = handler;
  }

  /**
   * Be handed the server's tools as they are after it said they changed (`notifications/tools/list_changed`) — listed
   * again once per burst, and only for a server that declared `tools.listChanged`. A listing that fails keeps nothing
   * from the caller: it is logged, and the tools it had are the tools it has.
   */
  onToolsChanged(handler: (tools: McpTool[]) => void): void {
    this.toolsChanged = handler;
  }

  /**
   * Open the transport and complete the MCP handshake.
   *
   * `initialize` then the `initialized` notification, in that order and both required: a server that
   * has not seen the notification is entitled to refuse everything after it, which presents as a
   * server that connected fine and then answered nothing.
   *
   * The server answers with the version it will speak. One this client does not (`MCP_PROTOCOL_VERSIONS`) is refused
   * and the connection closed, as the spec has a client do: until 0.7.13 any answer was taken, so a server a revision
   * ahead was spoken to as though it were not, with nothing said but a line at info.
   */
  async connect(): Promise<McpServerInfo> {
    if (this.transport) return this.info!;
    this.closed = false;
    this.peerGone = false;

    const transport = this.options.transport({
      onMessage: (raw) => this.receive(raw),
      onLog: (line) => log.debug("server log", { server: this.options.name, line }),
      // Announced so a supervisor can decide what to do about it. The client itself does not reconnect: it has no
      // idea how to rebuild its own transport, and the thing that does — the engine's manager — also owns the tools
      // that have to be rebuilt with it.
      onClose: (reason) => this.lose(reason),
      onAuthRequired: (id, challenge) => this.refuse(id, new McpAuthRequiredError(this.options.name, challenge)),
    });
    this.transport = transport;
    this.lastHeard = Date.now();

    const info = parseServerInfo(
      await this.send("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        // Nothing a server may ask of a client — roots, sampling, elicitation — is offered here, so nothing is declared.
        // It said `tools: {}` until 0.7.13: a server's capability, which meant nothing from a client.
        capabilities: {},
        clientInfo: { name: "nouride", version: "0.1.0" },
      }),
    );
    if (!MCP_PROTOCOL_VERSIONS.includes(info.protocolVersion)) {
      await this.close();
      throw new McpError(this.options.name, refusedVersion(this.options.name, info.protocolVersion));
    }

    this.info = info;
    transport.protocolVersion?.(info.protocolVersion);
    transport.send(notification("notifications/initialized"));
    if (info.toolsListChanged) transport.listen?.();
    this.startPinging(transport.idlePingMs);
    log.info("mcp server connected", {
      server: this.options.name,
      reported_as: info.name,
      version: info.version,
      protocol: info.protocolVersion,
      says_when_tools_change: info.toolsListChanged,
    });
    return info;
  }

  /** Every tool the server lists, page by page when it pages them (spec § Pagination). */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const cursors = new Set<string>();
    for (let cursor: string | undefined, page = 1; ; page += 1) {
      const answer = await this.send("tools/list", cursor === undefined ? {} : { cursor });
      tools.push(...parseTools(answer));
      cursor = nextCursor(answer);
      if (cursor === undefined) return tools;
      if (cursors.has(cursor) || page >= MAX_TOOL_PAGES) {
        log.warn("an MCP server's tool list does not end; keeping the pages read so far", { server: this.options.name, pages: page, tools: tools.length });
        return tools;
      }
      cursors.add(cursor);
    }
  }

  /**
   * Run one tool.
   *
   * A tool that fails is a *result*, not an exception — `isError` comes back for the model to read and
   * adapt to, the same way a refused built-in does. Only the call itself failing (no answer, transport
   * gone) throws, because then there is nothing to tell the model about the tool.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    /** The turn's: `/stop`, the deadline and a shutdown end the call at once, and the server is told. */
    options: { signal?: AbortSignal } = {},
  ): Promise<{ text: string; isError: boolean; images: McpImage[]; structured?: unknown }> {
    const result = (await this.send("tools/call", { name, arguments: args }, options.signal)) as McpToolCallResult;
    // The data itself too, so whoever holds the tool's `outputSchema` can check it — `text` is only how it reads.
    const structured = result?.structuredContent;
    return {
      text: flattenContent(result ?? {}),
      isError: result?.isError === true,
      images: imagesOf(result ?? {}),
      ...(structured === undefined || structured === null ? {} : { structured }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    clearTimeout(this.relist.timer);
    this.failAll("client closed");
    const transport = this.transport;
    this.transport = undefined;
    await transport?.close();
  }

  /**
   * One request, answered, timed out — or abandoned when `signal` fires.
   *
   * A call carried no signal: `/stop`, the turn's deadline and a shutdown each waited out the request timeout, and
   * a parallel group of MCP reads held the turn for the slowest. Abandoned, the waiter goes at once and the server
   * is sent `notifications/cancelled` — the protocol's way to say the answer is no longer wanted, so a server
   * doing real work can stop it. One that ignores it costs a late answer, which finds no waiter and is dropped.
   * A request given up on at its timeout is cancelled the same way, as the spec asks — except `initialize`, which a
   * client may never cancel.
   */
  private async send(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport;
    if (!transport || this.closed) {
      throw new McpError(this.options.name, `"${this.options.name}" is not connected`);
    }
    if (signal?.aborted) throw new McpError(this.options.name, `${method} was cancelled before it was sent`);

    const id = this.nextId++;
    const timeoutMs = (method === "initialize" ? this.options.initializeTimeoutMs : undefined) ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        contained(log, "could not time out an MCP request", () => {
          // Removed before rejecting: a late answer must not find a waiter and resolve a promise that
          // already settled, and leaving the entry behind would leak one per timed-out call.
          this.pending.delete(id);
          signal?.removeEventListener("abort", abandon);
          if (method !== "initialize") cancel(transport, id, `no answer within ${timeoutMs}ms`);
          reject(
            new McpError(
              this.options.name,
              `"${this.options.name}" did not answer ${method} within ${timeoutMs}ms`,
            ),
          );
        }, { server: this.options.name, method }),
        timeoutMs,
      );
      // An abort listener: what it throws is uncaught (`lint:timers`), so all of it is one `try`, and the waiter is
      // released whatever happens in it.
      const abandon = (): void => {
        try {
          release();
          this.pending.delete(id);
          cancel(transport, id, "the turn that asked was stopped");
        } catch {
          // Nothing above can fail on its own; the waiter is released either way.
        } finally {
          reject(new McpError(this.options.name, `${method} was cancelled: the turn that asked was stopped`));
        }
      };
      const release = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abandon);
      };

      this.pending.set(id, { resolve, reject, release, method });
      signal?.addEventListener("abort", abandon, { once: true });
      try {
        transport.send(request(id, method, params));
      } catch (err) {
        release();
        this.pending.delete(id);
        reject(new McpError(this.options.name, `could not reach "${this.options.name}": ${String(err)}`));
      }
    });
  }

  /**
   * Ask a quiet peer whether it is still there, and call it lost when it does not answer.
   *
   * Only while idle: a call in flight is already a question the peer has to answer, and anything it says counts as
   * an answer. A ping that times out — or fails — is the peer gone, said the way a stream that closed is, so the
   * supervisor reconnects instead of the next call waiting out its timeout on a dead stream.
   */
  private startPinging(everyMs: number | undefined): void {
    if (!everyMs) return;
    // A ping that fails is the peer lost (`pingIfIdle`); one that throws past that — a supervisor told so, throwing —
    // is said here, where out of the timer it was a rejection nobody caught.
    this.pinger = setInterval(contained(log, "could not ping an idle MCP server", () => this.pingIfIdle(everyMs), { server: this.options.name }), everyMs);
    // A daemon shutting down is not held open by a timer asking a server how it is.
    this.pinger.unref?.();
  }

  private async pingIfIdle(everyMs: number): Promise<void> {
    if (!this.connected || this.pending.size > 0 || Date.now() - this.lastHeard < everyMs) return;
    try {
      await this.send("ping", {});
    } catch (err) {
      if (this.closed || this.peerGone) return;
      this.lose(`did not answer a ping: ${err instanceof Error ? err.message : String(err)}`);
      // Closed so a stream that is not dead after all cannot go on delivering into a client that has let it go.
      void this.transport?.close().catch(() => {});
    }
  }

  /** The peer went away on its own: every waiter fails with why, and whoever supervises is told. */
  private lose(reason: string): void {
    if (this.peerGone) return;
    this.peerGone = true;
    clearInterval(this.pinger);
    clearTimeout(this.relist.timer);
    this.failAll(reason);
    this.peerLost?.(reason);
  }

  /**
   * One message from the peer. Called from a transport's read loop, so nothing here may throw: a throw would end the
   * loop, and with it every answer after this one.
   */
  private receive(raw: string): void {
    this.lastHeard = Date.now();
    const message = parseMessage(raw);
    // Anything that is not JSON-RPC lands here. A server that logs to stdout is common enough that this must not be an error.
    if (!message) return;
    if (message.kind === "notification") return this.notified(message.method);
    if (message.kind === "request") return this.answer(message.id, message.method);
    this.settle(message.response);
  }

  /** Fail one call with an error of its own type — a refusal the transport could tell apart from an answer. */
  private refuse(id: number, error: McpError): void {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    waiter.release();
    waiter.reject(error);
  }

  private settle(response: JsonRpcResponse): void {
    const waiter = this.pending.get(response.id);
    if (!waiter) return;
    this.pending.delete(response.id);
    waiter.release();

    if (response.error) {
      waiter.reject(
        new McpError(
          this.options.name,
          `${waiter.method} failed: ${response.error.message}${
            response.error.code ? ` (code ${response.error.code})` : ""
          }`,
        ),
      );
      return;
    }
    waiter.resolve(response.result);
  }

  /**
   * A notification. One is acted on — the server's tools changed — and only from a server that declared it would say
   * so; the rest (progress, log messages, other lists) are about things this client does not use.
   */
  private notified(method: string): void {
    if (method !== "notifications/tools/list_changed") return;
    if (!this.info?.toolsListChanged) {
      log.debug("tools/list_changed from a server that never declared it; not acted on", { server: this.options.name });
      return;
    }
    this.listAgainSoon();
  }

  /**
   * A request from the server. `ping` is answered — either side must answer one at once — and anything else asks for
   * what this client never declared (roots, sampling, elicitation), so it is refused rather than left to wait.
   */
  private answer(id: JsonRpcId, method: string): void {
    try {
      if (this.connected) this.transport!.send(method === "ping" ? reply(id, {}) : refusal(id, METHOD_NOT_FOUND, `this client does not offer ${method}`));
    } catch (err) {
      log.debug("could not answer the server", { server: this.options.name, method, error: String(err) });
    }
  }

  /**
   * One listing for a burst of `tools/list_changed`: the first arms a timer, the rest of the burst rides on it, and one
   * that arrives while a listing is running asks for one more after it — the list it read may predate the change.
   */
  private listAgainSoon(): void {
    if (!this.connected) return;
    if (this.relist.running) {
      this.relist.again = true;
      return;
    }
    if (this.relist.timer !== undefined) return;
    this.relist.timer = setTimeout(
      contained(log, "could not take up an MCP server's changed tools", () => this.listAgain(), { server: this.options.name }),
      this.options.relistAfterMs ?? RELIST_AFTER_MS,
    );
    this.relist.timer.unref?.();
  }

  private async listAgain(): Promise<void> {
    this.relist.timer = undefined;
    this.relist.running = true;
    let tools: McpTool[] | undefined;
    try {
      if (this.connected) tools = await this.listTools();
    } catch (err) {
      if (this.connected) log.warn("could not list an MCP server's tools again; it keeps the ones it had", { server: this.options.name, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.relist.running = false;
    }
    if (this.relist.again) {
      this.relist.again = false;
      this.listAgainSoon();
    }
    if (tools && this.connected) this.toolsChanged?.(tools);
  }

  /**
   * Fail everything in flight.
   *
   * The alternative is a turn parked on a promise whose server has already exited — it would sit there
   * until the request timeout, holding its conversation's queue, for a peer that is definitively gone.
   */
  private failAll(reason: string): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiting) {
      waiter.release();
      waiter.reject(new McpError(this.options.name, `"${this.options.name}" ${reason}`));
    }
  }
}

/** Tell the server a request's answer is no longer wanted. A transport already gone cannot be told, and need not be. */
function cancel(transport: McpTransport, requestId: number, reason: string): void {
  try {
    transport.send(notification("notifications/cancelled", { requestId, reason }));
  } catch {
    // The request is given up on either way.
  }
}

/** Why a server's answer to `initialize` was refused — its name, its version, and ours. */
function refusedVersion(server: string, theirs: string): string {
  const spoken = `${MCP_PROTOCOL_VERSIONS.slice(0, -1).join(", ")} and ${MCP_PROTOCOL_VERSIONS.at(-1)}`;
  const answered = theirs ? `MCP ${theirs}` : "no protocol version at all";
  return `"${server}" answered with ${answered}, which this daemon does not speak: it asked for ${MCP_PROTOCOL_VERSION}, and speaks ${spoken}`;
}
