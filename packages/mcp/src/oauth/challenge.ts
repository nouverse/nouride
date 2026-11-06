/**
 * The Bearer challenge of a `WWW-Authenticate` header (RFC 6750 §3), read into the parameters the MCP authorization
 * flow acts on.
 *
 * Read by its grammar (RFC 9110 §11.6.1) rather than matched: one header may carry several challenges (`Bearer …,
 * Basic realm="…"`), a value may be a token or a quoted string with `\` escapes, and a parameter's name is
 * case-insensitive. A regex over `resource_metadata="…"` gets the common case and quietly misreads the others — another
 * scheme's parameter of the same name, an escaped quote, `Resource_Metadata`.
 */

export interface BearerChallenge {
  /** Where the protected resource's metadata is (RFC 9728 §5.1) — the first place discovery looks. */
  resourceMetadata?: string;
  /** The scope the server says the request needs — what to ask for first (MCP 2025-11-25, Scope Selection Strategy). */
  scope?: string;
  /** Why it refused: `invalid_token`, `insufficient_scope` … (RFC 6750 §3.1). */
  error?: string;
}

/** The Bearer challenge in `header`, or null when there is none — no header, or only other schemes. */
export function parseBearerChallenge(header: string | null | undefined): BearerChallenge | null {
  const params = header ? bearerParams(header) : null;
  if (!params) return null;
  return {
    ...(params.resource_metadata ? { resourceMetadata: params.resource_metadata } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

/** RFC 9110's `tchar`: what a scheme, a parameter's name and an unquoted value are made of. */
const TCHAR = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;

/** The parameters of the header's first Bearer challenge, names lowercased, or null when it has none. */
function bearerParams(header: string): Record<string, string> | null {
  let at = 0;
  let scheme = "";
  let bearer: Record<string, string> | null = null;
  const skip = (chars: RegExp): void => {
    while (at < header.length && chars.test(header[at]!)) at += 1;
  };

  while (at < header.length) {
    skip(/[\s,]/);
    const start = at;
    while (at < header.length && TCHAR.test(header[at]!)) at += 1;
    const token = header.slice(start, at);
    if (!token) {
      at += 1; // Nothing the grammar allows here: stepped over, so a malformed header cannot hold the loop.
      continue;
    }
    skip(/[ \t]/);
    if (header[at] !== "=") {
      // A token not followed by `=` starts the next challenge: its scheme, and the parameters after it are its own.
      scheme = token.toLowerCase();
      if (scheme === "bearer") bearer ??= {};
      continue;
    }
    at += 1;
    skip(/[ \t]/);
    const value = header[at] === '"' ? quoted() : unquoted();
    const name = token.toLowerCase();
    if (scheme === "bearer" && bearer && !(name in bearer)) bearer[name] = value;
  }
  return bearer;

  function quoted(): string {
    let value = "";
    for (at += 1; at < header.length && header[at] !== '"'; at += 1) {
      if (header[at] === "\\" && at + 1 < header.length) at += 1;
      value += header[at];
    }
    at += 1;
    return value;
  }

  /** Up to the next separator. Wider than a token, since a server that should have quoted a URL often has not. */
  function unquoted(): string {
    const from = at;
    while (at < header.length && !/[\s,]/.test(header[at]!)) at += 1;
    return header.slice(from, at);
  }
}
