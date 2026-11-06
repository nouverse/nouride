/**
 * What an OAuth step throws, and the one rule every message here keeps: it never carries a credential.
 *
 * An error's message is read by a log line, a dashboard and — through a failed MCP call — a model. So it names the step,
 * the endpoint and what the server said (`error`, `error_description`), and a server that echoes back what it was sent
 * (a code, a refresh token) has that echo cut out by `withoutSecrets` before it is quoted.
 */

/** An OAuth step that failed: discovery, registration, the authorization request, or a token request. */
export class OAuthError extends Error {
  override name = "OAuthError";

  constructor(
    message: string,
    /** The server's `error` (RFC 6749 §5.2) — `invalid_request`, `invalid_client` … — when it gave one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The authorization server refused the grant itself — `invalid_grant` (the code or refresh token is spent, expired or
 * revoked), `invalid_client` or `unauthorized_client` (the client it was issued to is not, or no longer, accepted).
 * Asking again cannot mend it: the person has to log in again, and after `invalid_client` the client has to be
 * registered again before that.
 */
export class OAuthLoginRequiredError extends OAuthError {
  override name = "OAuthLoginRequiredError";
}

/** A server's own words, at most this long — enough to say what went wrong, not a page of HTML. */
const MAX_DETAIL = 300;

/**
 * The error a token or registration endpoint answered with (RFC 6749 §5.2, RFC 7591 §3.2.2), said as `what` was
 * refused, and why: `body` is the parsed answer, `secrets` everything sent that the answer must not repeat.
 */
export function refusal(what: string, status: number, body: Record<string, unknown>, secrets: readonly (string | undefined)[]): { message: string; code?: string } {
  const code = typeof body.error === "string" ? withoutSecrets(body.error, secrets).slice(0, MAX_DETAIL) : undefined;
  const description = typeof body.error_description === "string" ? withoutSecrets(body.error_description, secrets).trim().slice(0, MAX_DETAIL) : "";
  const said = code ? `${code}${description ? `: ${description}` : ""}` : `HTTP ${status}`;
  return { message: `${what} was refused (${said})`, ...(code ? { code } : {}) };
}

/**
 * `text` with every one of `secrets` cut out. For text that came from somewhere else — a server's error, a caller's
 * exception — and is about to be quoted where a credential must not appear.
 */
export function withoutSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let clean = text;
  for (const secret of secrets) {
    // Short values are left: a two-letter "secret" would cut every word it occurs in, and no real one is that short.
    if (secret && secret.length >= 8) clean = clean.split(secret).join("[redacted]");
  }
  return clean;
}

/** What an exception says, whatever was thrown. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
