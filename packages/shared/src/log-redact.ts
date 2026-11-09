/**
 * What a log line may not carry: a value under a key named like a credential, and the parts of a string that
 * are one — an `Authorization` value, a URL's password, a parameter or a JSON field named like a key.
 *
 * Every line passes through `emit`, and from there to the journal, the log table the dashboard reads and, for an
 * error, the audit log. Nothing upstream was careful about what went in: a provider's error body was written into a
 * line whole, a header table would have carried its `Authorization`, and three lines named a secret under the key
 * `secret` where its value could as easily have stood. So it is decided once, here, by the shape of the line rather
 * than by every caller remembering.
 *
 * **By name, not by guessing at values.** `redact` (`@nouride/secrets`) masks anything credential-shaped — long hex, vendor
 * prefixes — which is right for a transcript of unknown text and wrong for a journal: a log line is full of hashes,
 * grant keys and ids that look like keys and are the point of the line. A key that ends in `token`, `password`,
 * `api_key`, `authorization`, `cookie` or `secret` holds a credential far more often than not; a line that means a
 * secret's *name* says `secret_name`, and one that means a token's id says `token_id`.
 *
 * **Only what can carry a secret is replaced.** A string, or a structure under such a key. `has_credential: true`
 * and a count say nothing a reader should not know, and `tokens` — the plural every usage line in this daemon writes —
 * is not a key named `token`. Neither is `session_id`: a session here is a conversation, not a login.
 */

const REDACTED = "[redacted]";

/** How a key ends, once case and separators are gone, when what it holds is a credential. */
const SECRET_KEY_ENDINGS = [
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "apikey",
  "privatekey",
  "secretkey",
  "accesskey",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "bearer",
];

/**
 * Query parameters that carry a credential under a name no object key here would: `key=` is how Google's APIs take
 * one, and a presigned URL's signature (`sig=`, `X-Amz-Signature=`) is a credential for that URL.
 */
const SECRET_PARAMS = new Set(["key", "sig"]);

/** Deeper than any line this daemon writes. Past it a value is dropped rather than written unread. */
const MAX_DEPTH = 8;

function normalized(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whether a field, a header or a parameter of this name holds a credential. */
function isSecretKey(key: string): boolean {
  const name = normalized(key);
  return SECRET_KEY_ENDINGS.some((ending) => name.endsWith(ending));
}

/** A line's free-form data with every credential replaced — a copy, as `JSON.stringify` would see it. */
export function redactLogData(data: Record<string, unknown>): Record<string, unknown> {
  return redactObject(data, 0, new WeakSet([data]));
}

/**
 * The credential-shaped parts of one string.
 *
 * Four, each anchored on a name or a scheme rather than on how the value looks:
 *
 * - `Bearer <token>`, and `Basic <base64>` when it decodes to `user:password` — the header, not the word.
 * - A URL's password: `https://user:pass@host` keeps the user and the host.
 * - `name=value` — a query string, a cookie, an assignment in a command line — when the name is a credential's.
 * - `"name": "value"` — a JSON body quoted into an error — the same.
 */
export function redactLogText(text: string): string {
  if (text.length < 8) return text;
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(/\b(Basic)\s+([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9+/=])/gi, (match, scheme: string, value: string) =>
      decodesToUserinfo(value) ? `${scheme} ${REDACTED}` : match,
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, (_match, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`)
    .replace(/(^|[?&;,\s])([A-Za-z_][\w.-]*)=("[^"]*"|'[^']*'|[^&#\s;,"']*)/g, (match, lead: string, name: string, value: string) =>
      value && value !== '""' && value !== "''" && isSecretParam(name) ? `${lead}${name}=${REDACTED}` : match,
    )
    .replace(/"([^"\\]{1,64})"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, (match, name: string, colon: string) =>
      isSecretKey(name) ? `"${name}"${colon}"${REDACTED}"` : match,
    );
}

function isSecretParam(name: string): boolean {
  return isSecretKey(name) || SECRET_PARAMS.has(normalized(name)) || normalized(name).endsWith("signature");
}

/**
 * Whether a `Basic` value is base64 of `user:password` — and not the word after "Basic" in a sentence. An English word
 * is valid base64 too, and decodes to bytes; printable text with a colon in it is what a credential decodes to.
 */
function decodesToUserinfo(value: string): boolean {
  try {
    const decoded = atob(value);
    return decoded.includes(":") && /^[\x20-\x7e]+$/.test(decoded);
  } catch {
    return false;
  }
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[too deep to log]";
  seen.add(value);
  try {
    // What `JSON.stringify` would write: a URL as its address, a Date as its time — and either read like any string.
    const json = (value as { toJSON?: unknown }).toJSON;
    if (typeof json === "function") return redactValue(json.call(value), depth + 1, seen);
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));
    // An Error's own fields too, as `JSON.stringify` writes them: a provider error keeps the body it was given.
    return redactObject(value as Record<string, unknown>, depth + 1, seen);
  } finally {
    seen.delete(value);
  }
}

function redactObject(value: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    out[key] = isSecretKey(key) && carriesText(field) ? REDACTED : redactValue(field, depth, seen);
  }
  return out;
}

/** A string or a structure — what can hold a credential. A flag, a count, an absence cannot. */
function carriesText(value: unknown): boolean {
  return (typeof value === "string" && value !== "") || (typeof value === "object" && value !== null);
}
