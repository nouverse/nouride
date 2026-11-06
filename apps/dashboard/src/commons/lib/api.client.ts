/**
 * How this client talks to the daemon — the transport, not the endpoint list.
 *
 * Split out of `api.ts` when that file hit its line budget, and it is the seam that was already
 * there: everything here is about credentials, timeouts and error shape, and none of it changes when
 * a route is added. Two callers now — `api.ts` and `api.setup.ts` — which is the other reason it
 * could not stay private to one of them.
 *
 * Same-origin in production (the engine serves this SPA), proxied by Vite in dev — so paths are
 * always root-relative and there is no base URL to configure.
 *
 * Authentication is a cookie the browser holds and never reads: the session token is `httpOnly`, so
 * there is no token in `localStorage` for a script on this page to find. `credentials: "same-origin"`
 * is what carries it, and it is on every request rather than on the ones that seemed to need it.
 */

export const control = "/api/control";

export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly status: number,
    /** What the page says: the reply's `plain` where it has one (0.8.20), else its `error`. */
    message: string,
    /** What to do about it, where the route says — `POST /restart` refused with no supervisor, say. Never beside a `plain`, which says it. */
    readonly note?: string,
    /**
     * What went wrong in the server's own terms, shown under Details (0.8.19): where the daemon gave no words of its
     * own, the page says something went wrong, and the route and its status are for whoever runs the server; beside a
     * `plain` (0.8.20), the route's own `error` and `note`.
     */
    readonly detail?: string,
    /**
     * The route's own `error` and `note` where the message is its `plain` (0.8.20): what the CLI prints for the same
     * reply, and what code that tells one refusal from another reads, as a mission's delete over unsaved work does.
     */
    readonly server?: { error?: string; note?: string },
  ) {
    super(message);
  }
}

/**
 * What a page says of a failure, and what goes under Details (0.8.20). The route's everyday words where it gave them,
 * its own under Details; else its error and what to do about it, as the page always said them.
 */
export function failureWords(error: unknown): { said: string; detail: string | null } {
  if (!(error instanceof Error)) return { said: String(error), detail: null };
  const note = "note" in error && typeof error.note === "string" ? error.note : null;
  const detail = "detail" in error && typeof error.detail === "string" ? error.detail : null;
  return { said: note ? `${error.message}: ${note}` : error.message, detail };
}

/**
 * How long any call waits before it is treated as a failure.
 *
 * A daemon under enough load to stop answering leaves `fetch` pending forever, and a query with
 * `retry: false` then sits in `isPending` for as long as the tab is open — a spinner that never
 * resolves and never explains itself. That is what a wedged box looked like from the browser: a
 * loading state indistinguishable from a slow one. Fifteen seconds is far longer than any route here
 * legitimately takes, and turning a hang into an error is what lets the page say so.
 */
const TIMEOUT_MS = 15_000;

interface CustomRequestInit extends RequestInit {
  timeoutMs?: number;
}

/**
 * Told the moment a request finds the daemon not answering — nothing came back, or a proxy answered for it — so the
 * restart follower (`restart.ts`) can hold the page's queries before a retry turns into an error on screen. Not for
 * `/api/health`: that is how the follower looks, and its silence is expected.
 */
let onUnreachable: (() => void) | null = null;

export function whenUnreachable(listener: () => void): void {
  onUnreachable = listener;
}

const notAnswering = (status: number) => status === 0 || (status >= 502 && status <= 504) || (status >= 520 && status <= 527);

/**
 * Every request in one place, so the credential rule and the error shape cannot drift apart.
 *
 * A non-2xx carries the server's own `error` string when there is one. Those messages are written for
 * the person reading them — "this is the only admin", "that config would not parse" — and replacing
 * them with an HTTP status here would throw away the only useful half. Where a route wrote one for the command line
 * (a section of the config file, a flag), it gives the page's own words as `plain` too, and those are what is said.
 */
export async function request<T>(path: string, init?: CustomRequestInit): Promise<T> {
  const timeout = init?.timeoutMs ?? TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: init?.signal ?? AbortSignal.timeout(timeout),
      headers: {
        accept: "application/json",
        // Never for `FormData`: the browser has to set the content type itself, because only it knows
        // the multipart boundary it generated. Setting it here silently produces a body the server
        // cannot parse — and the error arrives as "expected a multipart form", pointing at the wrong end.
        ...(init?.body && !(init.body instanceof FormData)
          ? { "content-type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    if (path !== "/api/health") onUnreachable?.();
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError(0, `Nouride did not answer within ${timeout / 1000} seconds`);
    }
    throw new ApiError(0, "cannot reach Nouride");
  }
  if (notAnswering(res.status) && path !== "/api/health") onUnreachable?.();

  // /health answers 503 when degraded but still returns the payload — that body is
  // exactly what the dashboard needs to show, so a non-2xx is not automatically an
  // error here. Only there: every other 503 is a refusal — "nouride is starting", or a
  // part of the daemon that is not wired — and read as data it was a body of the wrong shape.
  if (!res.ok && !(res.status === 503 && path === "/api/health")) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; note?: string; plain?: string };
    // A reply written for the command line carries the page's words beside it (0.8.20): those are said, the route's
    // own go under Details, a line each, as the CLI prints them.
    if (body.plain) {
      const server = { ...(body.error ? { error: body.error } : {}), ...(body.note ? { note: body.note } : {}) };
      throw new ApiError(res.status, body.plain, undefined, [body.error, body.note].filter(Boolean).join("\n"), server);
    }
    if (body.error) throw new ApiError(res.status, body.error, body.note);
    throw new ApiError(res.status, "the server could not do that", body.note, `${path} answered ${res.status}`);
  }
  return (await res.json()) as T;
}
/** A POST with a JSON body, which is every write in this API — including whole-document replacements. */
export const post = <T,>(path: string, body?: unknown, options?: { timeoutMs?: number }): Promise<T> =>
  request<T>(path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
