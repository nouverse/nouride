/**
 * Talking to `nouride-pkg`: one request per connection, the answer parsed.
 *
 * Whether a change should happen at all is decided before this — by a person, at the engine's exec
 * gate — and what it may change by the root script; this only carries the request and reads the
 * answer.
 */

import { agreed, backendOf, parseAnswer, requestLine, type PackageAnswer, type PackageRequest } from "./protocol.ts";
import { requestUnixSocket, UnixSocketError } from "@nouride/runtime";

/** Where `nouride-pkg.socket` listens (`root/systemd/nouride-pkg.socket`). */
export const PACKAGE_SOCKET = "/run/nouride-pkg.sock";

/** A status answers at once; a change can take a Pi a quarter of an hour. */
const STATUS_TIMEOUT_MS = 10_000;
const CHANGE_TIMEOUT_MS = 30 * 60_000;

export interface ClientOptions {
  socket?: string;
  /** Each piece of the answer as it arrives. */
  onData?: (chunk: string) => void;
  /** Replaces the socket, for tests. */
  request?: typeof requestUnixSocket;
}

/**
 * Sends one request, once the service has said it speaks this protocol (`agreed`): a status is asked first, and a
 * service that is not there, or speaks another, is the answer. Never throws: an unreachable service is a `failed`
 * answer that says why.
 */
export async function askPackages(request: PackageRequest, options: ClientOptions = {}): Promise<PackageAnswer> {
  const status = agreed(await ask({ op: "status" }, request.op === "status" ? options : { ...options, onData: undefined }));
  return request.op === "status" || status.status !== "ok" ? status : ask(request, options);
}

async function ask(request: PackageRequest, options: ClientOptions): Promise<PackageAnswer> {
  const socket = options.socket ?? PACKAGE_SOCKET;
  const send = options.request ?? requestUnixSocket;
  const timeoutMs = request.op === "status" ? STATUS_TIMEOUT_MS : CHANGE_TIMEOUT_MS;
  try {
    return parseAnswer(await send(socket, requestLine(request), { timeoutMs, ...(options.onData ? { onData: options.onData } : {}) }));
  } catch (err) {
    const failure = err instanceof UnixSocketError ? err.failure : "other";
    const detail =
      failure === "missing"
        ? "the package service is not set up on this box"
        : failure === "denied"
          ? `not allowed to reach ${socket}: only root and the service account's group may`
          : failure === "timeout"
            ? "the package service did not finish in time"
            : `could not reach the package service: ${err instanceof Error ? err.message : String(err)}`;
    return { status: "failed", detail, installs: [], removes: [], output: "" };
  }
}

/** The backend in use (`apt`, `apk`), or null when the service does not answer. */
export async function packageBackend(options: ClientOptions = {}): Promise<string | null> {
  return backendOf(await askPackages({ op: "status" }, options));
}
