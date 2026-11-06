/**
 * The HTTP every OAuth step makes: a metadata document read, a form or a registration posted — each through a `fetch`
 * the caller may hand in, so a test drives it, and each with a ceiling, so an authorization server that never answers
 * cannot hold a login open forever.
 */

import { messageOf, OAuthError } from "./errors.ts";

/** `fetch` as the OAuth steps take it: the global one unless the caller hands its own. */
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What every OAuth step accepts besides its own arguments. */
export interface OAuthHttpOptions {
  /** The global `fetch` when absent. */
  fetch?: Fetch;
  /** One request's ceiling — `OAUTH_TIMEOUT_MS` when absent. */
  timeoutMs?: number;
}

const OAUTH_TIMEOUT_MS = 30_000;

/** An answer read as an object: JSON, or the form encoding some token endpoints still answer with (GitHub's does). */
export interface Answer {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

function send(url: string, init: RequestInit, options: OAuthHttpOptions): Promise<Response> {
  const fetchFn = options.fetch ?? fetch;
  return fetchFn(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? OAUTH_TIMEOUT_MS) });
}

/**
 * A metadata document: GET `url` for a JSON object. What came back instead — a status, a page that is not JSON, no
 * connection — is said in `failed`, so discovery can try the next place and name every one it tried.
 */
export async function getJsonObject(
  url: string,
  headers: Record<string, string>,
  options: OAuthHttpOptions,
): Promise<{ body: Record<string, unknown> } | { failed: string }> {
  let response: Response;
  try {
    response = await send(url, { headers: { accept: "application/json", ...headers } }, options);
  } catch (err) {
    return { failed: `${url}: ${messageOf(err)}` };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { failed: `${url}: HTTP ${response.status}` };
  }
  const body = parseObject(await response.text().catch(() => ""));
  return body ? { body } : { failed: `${url}: not a JSON object` };
}

/** POST to a token or registration endpoint, and read the answer whatever its status — an error is a body too. */
export async function post(url: string, what: string, init: { headers: Record<string, string>; body: string }, options: OAuthHttpOptions): Promise<Answer> {
  let response: Response;
  try {
    response = await send(url, { method: "POST", headers: { accept: "application/json", ...init.headers }, body: init.body }, options);
  } catch (err) {
    throw new OAuthError(`could not reach ${what} at ${url}: ${messageOf(err)}`);
  }
  const text = await response.text().catch(() => "");
  const form = (response.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const body = form ? Object.fromEntries(new URLSearchParams(text)) : (parseObject(text) ?? {});
  return { status: response.status, ok: response.ok, body };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * An endpoint a credential or a code goes to, refused unless it is https — or http on this machine's loopback, where
 * nothing crosses a network. Every authorization server endpoint must be https (MCP 2025-06-18, Security
 * Considerations); a metadata document that names a plain-http one is either misconfigured or not the server's own.
 */
export function secureEndpoint(value: unknown, what: string): string {
  if (typeof value !== "string" || !URL.canParse(value)) throw new OAuthError(`${what} is not a URL: ${JSON.stringify(value ?? null)}`);
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new OAuthError(`${what} must be an https URL, and is ${JSON.stringify(value)}`);
  }
  return url.href;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
