/**
 * A credential that changes while a connection lives — an OAuth access token, renewed before it expires and when a
 * server refuses it — and the one thing the HTTP transports do with it: ask for it before every request, and on a 401
 * ask whether the request is worth sending once more.
 *
 * The transports know nothing of OAuth. What a credential is, when it is renewed and how is the `McpAuth`'s
 * (`oauthAuth` is the one this package makes); what a transport owes it is the order — headers before each request,
 * `unauthorized` on a 401, one retry at most — and the typed failure when it declines (`McpAuthRequiredError`).
 */

import { parseBearerChallenge } from "./oauth/challenge.ts";

/** The credential an HTTP transport sends, asked for request by request. */
export interface McpAuth {
  /** Headers for the next request, on top of the transport's own and the operator's static `headers` — asked before every request. */
  headers(): Promise<Record<string, string>>;
  /**
   * A request came back 401, with its `WWW-Authenticate` value (null when it had none) and `sent`, what `headers()` gave
   * that request. True sends it once more with fresh headers; false fails it with `McpAuthRequiredError`, which is how
   * a caller learns the person has to log in. A throw fails it with what was thrown — a renewal that could not reach its
   * server is an outage, not a lost login.
   */
  unauthorized(challenge: string | null, sent: Record<string, string>): Promise<boolean>;
}

/** How a request ended once its credential had its say: an answer, or the server asking for a login, with its challenge. */
type Authorized = { response: Response } | { loginNeeded: string | null };

/**
 * One request with `auth`'s headers on top of `headers`, sent once more — with fresh headers — when it comes back 401
 * and `auth.unauthorized` says to. A second 401, or `unauthorized` declining, is `loginNeeded`; so is a 403 whose
 * challenge says `insufficient_scope` (MCP 2025-11-25's step-up), at once, since no renewal widens a login's scope.
 * Without `auth` it is the plain request, and a 401 is an answer like any other.
 */
export async function authorizedFetch(url: string, init: RequestInit, headers: Record<string, string>, auth: McpAuth | undefined): Promise<Authorized> {
  if (!auth) return { response: await fetch(url, { ...init, headers }) };
  for (let retried = false; ; retried = true) {
    const sent = await auth.headers();
    const response = await fetch(url, { ...init, headers: withHeaders(headers, sent) });
    const challenge = response.headers.get("www-authenticate");
    const narrow = response.status === 403 && parseBearerChallenge(challenge)?.error === "insufficient_scope";
    if (response.status !== 401 && !narrow) return { response };
    // Nobody reads the refusal's body, and an unread one holds its connection.
    await response.body?.cancel().catch(() => {});
    if (narrow || retried || !(await auth.unauthorized(challenge, sent))) return { loginNeeded: challenge };
  }
}

/**
 * `base` with `extra` set over it, by name and whatever its case: the credential an `McpAuth` gives replaces one the
 * operator wrote into the static headers rather than being sent beside it as a second `Authorization`.
 */
export function withHeaders(base: Record<string, string>, extra: Record<string, string>): Headers {
  const merged = new Headers(base);
  for (const [name, value] of Object.entries(extra)) merged.set(name, value);
  return merged;
}
