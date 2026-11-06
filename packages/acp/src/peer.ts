/**
 * One JSON-RPC connection, both ways.
 *
 * ACP is not a client calling a server: the agent asks the client too — for a permission, for a file — while the
 * client's own call is still waiting. So both ends of a connection are this one class: it sends calls and matches their
 * answers by id, answers the peer's calls through a handler, and passes notifications on. A transport feeds it lines and
 * says when the peer is gone; what a line means stays here, where it is tested without a process.
 */

import {
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  notification,
  parseMessage,
  refusal,
  reply,
  request,
  type JsonRpcError,
  type JsonRpcId,
} from "./protocol.ts";

/** Where a connection's lines go. The reader side calls `receive` and `closed`; this side only writes. */
export interface LineTransport {
  send(line: string): void;
}

/** A call the peer refused, with the code it gave; or the connection gone before an answer came. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

/** The connection ended while a call waited: the process died or was stopped. */
const CONNECTION_CLOSED = -32099;

export interface PeerHandlers {
  /** A call from the peer. Throw an `AcpError` to refuse it with a code; anything else is answered as internal. */
  request?: (method: string, params: unknown) => Promise<unknown>;
  notification?: (method: string, params: unknown) => void;
  /** A line that was not a message — a banner, a log line on stdout. Ignored by the protocol; given here to be logged. */
  stray?: (line: string) => void;
  /** A notification its handler threw on: dropped, given here to be logged, and the connection reads on. */
  failed?: (method: string, error: unknown) => void;
}

export interface CallOptions {
  /** How long to wait for the answer; none for a call that runs as long as its work does (`session/prompt`). */
  timeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AcpPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private gone: string | null = null;

  constructor(
    private readonly transport: LineTransport,
    private readonly handlers: PeerHandlers = {},
  ) {}

  /** Why the connection ended, or null while it is open. */
  get closedReason(): string | null {
    return this.gone;
  }

  call<T = unknown>(method: string, params?: unknown, options: CallOptions = {}): Promise<T> {
    if (this.gone) return Promise.reject(new AcpError(CONNECTION_CLOSED, `${method}: the connection is closed (${this.gone})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve: resolve as (value: unknown) => void, reject };
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          try {
            this.pending.delete(id);
            reject(new AcpError(INTERNAL_ERROR, `${method}: no answer in ${Math.round(options.timeoutMs! / 1000)} s`));
          } catch {
            // Nothing in a rejection can fail; the guard keeps a timer from ever taking the daemon down.
          }
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      this.transport.send(request(id, method, params));
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.gone) this.transport.send(notification(method, params));
  }

  /** One line from the peer. */
  receive(line: string): void {
    const message = parseMessage(line);
    if (!message) {
      if (line.trim()) this.handlers.stray?.(line);
      return;
    }
    if (message.kind === "response") {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) entry.reject(new AcpError(message.error.code, `${entry.method}: ${message.error.message}`, message.error.data));
      else entry.resolve(message.result);
      return;
    }
    if (message.kind === "notification") {
      // One message a handler cannot take is dropped, not the connection: a throw here ended the reader of a CLI's
      // stdout for good, and its turn waited forever on an answer nobody read (0.8.1).
      try {
        this.handlers.notification?.(message.method, message.params);
      } catch (err) {
        this.handlers.failed?.(message.method, err);
      }
      return;
    }
    void this.answer(message.id, message.method, message.params);
  }

  /** The peer is gone: every call still waiting fails now, rather than at a timeout that may never come. */
  closed(reason: string): void {
    if (this.gone) return;
    this.gone = reason;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new AcpError(CONNECTION_CLOSED, `${entry.method}: the connection closed (${reason})`));
      this.pending.delete(id);
    }
  }

  private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    if (!this.handlers.request) {
      this.transport.send(refusal(id, { code: METHOD_NOT_FOUND, message: `${method} is not supported` }));
      return;
    }
    try {
      const result = await this.handlers.request(method, params);
      if (!this.gone) this.transport.send(reply(id, result));
    } catch (err) {
      if (this.gone) return;
      const error: JsonRpcError =
        err instanceof AcpError
          ? { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) }
          : { code: INTERNAL_ERROR, message: err instanceof Error ? err.message : String(err) };
      // A peer gone between the answer and its sending refuses the write too: nothing is left to tell it.
      try {
        this.transport.send(refusal(id, error));
      } catch {
        // The connection's end is said by whoever reads it.
      }
    }
  }
}
