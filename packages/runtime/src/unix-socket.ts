/**
 * One request over a Unix socket: write a line, read until the other side closes.
 *
 * The shape `nouride-pkg` speaks (systemd `Accept=yes`, one process per connection, stdin and stdout
 * the socket), and small enough that it needs nothing else. The answer streams as it arrives, because
 * an install can print for minutes and the person watching should see it move.
 *
 * Failures are named, not thrown as whatever the platform said: "not set up here" (no socket), "not
 * allowed" (permissions) and "nobody answered" (refused, or the timeout) lead a caller to different
 * sentences, and `ENOENT` leads a person nowhere.
 */

import { createConnection } from "node:net";
import { lstatSync } from "node:fs";
import { contained, createLogger } from "@nouride/shared";

const log = createLogger("runtime.socket");

export type UnixSocketFailure = "missing" | "denied" | "refused" | "timeout" | "other";

export class UnixSocketError extends Error {
  constructor(
    readonly failure: UnixSocketFailure,
    message: string,
  ) {
    super(message);
    this.name = "UnixSocketError";
  }
}

export interface UnixRequestOptions {
  /** From connecting to the last byte. Past it the connection is closed and this rejects. */
  timeoutMs: number;
  /** Each piece of the answer as it arrives. */
  onData?: (chunk: string) => void;
}

function failureOf(code: string | undefined): UnixSocketFailure {
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  if (code === "EACCES" || code === "EPERM") return "denied";
  if (code === "ECONNREFUSED") return "refused";
  return "other";
}

/** Sends `request` (a newline is added when it has none) and resolves with everything answered. */
export function requestUnixSocket(path: string, request: string, options: UnixRequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const chunks: string[] = [];
    let settled = false;
    const settle = (error?: UnixSocketError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(chunks.join(""));
    };
    const timer = setTimeout(
      contained(log, "could not time out a request over a Unix socket", () =>
        settle(new UnixSocketError("timeout", `no complete answer from ${path} within ${Math.round(options.timeoutMs / 1000)}s`)),
      { socket: path }),
      options.timeoutMs,
    );

    socket.setEncoding("utf8");
    // The socket emits from the event loop, so each listener is contained: a throw would be uncaught (`lint:timers`).
    const context = { socket: path };
    socket.on("connect", contained(log, "could not send a request over a Unix socket", () => socket.write(request.endsWith("\n") ? request : `${request}\n`), context));
    socket.on(
      "data",
      contained(
        log,
        "could not take an answer over a Unix socket",
        (chunk: string) => {
          chunks.push(chunk);
          options.onData?.(chunk);
        },
        context,
      ),
    );
    socket.on("end", contained(log, "could not settle a request over a Unix socket", () => settle(), context));
    socket.on("close", contained(log, "could not settle a request over a Unix socket", () => settle(), context));
    socket.on(
      "error",
      contained(log, "could not settle a failed request over a Unix socket", (err: NodeJS.ErrnoException) => settle(new UnixSocketError(failureOf(err.code), `${path}: ${err.code ?? err.message}`)), context),
    );
  });
}

/** Whether `path` is a socket — present, and not a leftover file of the same name. */
export function isSocketFile(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}
