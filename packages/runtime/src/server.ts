/**
 * HTTP server adapter over `Bun.serve` (TD-001).
 *
 * Thin on purpose: routing, middleware and validation are Hono's job (TD-002).
 * This exists so `apps/engine` can start and stop a server without importing
 * `Bun` itself.
 */

/**
 * What the adapter knows about a request that the `Request` object does not.
 *
 * One field so far, and it exists because a rate limit keyed on `x-forwarded-for` alone is not a
 * rate limit: that header is written by whoever sent the request, so an attacker sets a fresh value
 * per attempt and the per-address rule counts to one forever. The socket address is the only value
 * they cannot choose, and only the server that accepted the connection has it.
 */
export interface RequestInfo {
  /** The peer's address as the kernel reports it, or null where the platform cannot say. */
  address: string | null;
  /**
   * Let this one request stay silent for up to `seconds` before the connection is closed, instead of
   * the server's idle timeout. For a request that does its work before answering — the memory pass
   * on a Raspberry Pi takes minutes, and a closed socket reads to the caller as the daemon being down.
   */
  keepOpen(seconds: number): void;
}

export interface HttpServerOptions {
  port: number;
  hostname: string;
  fetch: (req: Request, info: RequestInfo) => Response | Promise<Response>;
  /** Long-running agent turns need more than the 10s default. */
  idleTimeoutSeconds?: number;
}

export interface HttpServer {
  readonly port: number;
  readonly hostname: string;
  /** `true` drops in-flight requests; the shutdown sequence lets them finish first. */
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export function serveHttp(opts: HttpServerOptions): HttpServer {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port: opts.port,
      hostname: opts.hostname,
      idleTimeout: opts.idleTimeoutSeconds ?? 60,
      // `requestIP` is the socket, not a header, and it is null for a closed connection or a unix
      // socket — reported as null rather than guessed, so a caller can tell "no address" from one.
      fetch: (req, srv) => opts.fetch(req, { address: srv.requestIP(req)?.address ?? null, keepOpen: (seconds) => srv.timeout(req, seconds) }),
    });
  } catch (err) {
    // The most common boot failure there is — a daemon already running, or a leftover from a
    // previous run. A raw EADDRINUSE stack trace names the syscall but not the thing to do
    // about it, and this is the first output a new user sees.
    // Matched structurally, not with `instanceof Error`: Bun raises a SystemError-shaped object
    // here, and an instanceof check silently fell through to the raw trace.
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    if (code === "EADDRINUSE") {
      throw new Error(
        `Port ${opts.port} is already in use; another Nouride is probably running. ` +
          `Check with \`nouride status\`, or set PORT to something else.`,
        { cause: err },
      );
    }
    throw err;
  }

  return {
    // Bun reports the bound values, which differ from the requested ones when port
    // 0 asks the OS to pick. Falling back to the request keeps the type honest.
    port: server.port ?? opts.port,
    hostname: server.hostname ?? opts.hostname,
    stop: async (closeActiveConnections) => {
      await server.stop(closeActiveConnections);
    },
  };
}

/**
 * Static asset response, or `null` when the path is not a file we serve.
 *
 * `headers` are added to what Bun derives from the file — its `Content-Type` is kept, which matters
 * under `nosniff`: a script served without one is a script the browser refuses to run.
 *
 * `typeOf` names the file whose type to send instead: a precompressed `index.js.br` is a script, and
 * Bun alone would call it `application/octet-stream`.
 */
export async function serveStaticFile(path: string, headers?: Record<string, string>, typeOf?: string): Promise<Response | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const all = typeOf ? { "Content-Type": Bun.file(typeOf).type, ...headers } : headers;
  return new Response(file, all ? { headers: all } : undefined);
}
