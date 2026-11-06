/**
 * The token endpoint: the code a login came back with exchanged for tokens, and those tokens renewed with the refresh
 * token afterwards. Both name the resource (RFC 8707) so the token is this server's, both show the client the way it
 * was registered, and both answer in one shape, read here into `OAuthTokens`.
 */

import type { OAuthDiscovery } from "./discovery.ts";
import { OAuthError, OAuthLoginRequiredError, refusal } from "./errors.ts";
import { post, type OAuthHttpOptions } from "./fetch.ts";
import type { OAuthClient } from "./register.ts";

/**
 * A login's tokens. Plain data, for the caller to keep — in its secret store, since the access token and above all the
 * refresh token are credentials — and to replace with each renewed set `oauthAuth` hands its `onTokens`.
 */
export interface OAuthTokens {
  accessToken: string;
  /** `Bearer`: the only type an MCP server is sent. */
  tokenType: string;
  /** When the access token stops working, in milliseconds since the epoch. Absent when the server did not say. */
  expiresAt?: number;
  /** What renews the login without the person. Absent when the server issued none: then it lasts as long as the access token. */
  refreshToken?: string;
  scope?: string;
}

export interface TokenOptions extends OAuthHttpOptions {
  /** The clock `expiresAt` is counted from — `Date.now` unless a test drives it. */
  now?: () => number;
}

export interface ExchangeOptions extends TokenOptions {
  /** The `code` the redirect came back with. */
  code: string;
  /** The verifier `authorizationRequest` returned with the URL that led here. */
  verifier: string;
  /** The redirect URI that authorization request named — the server holds the two to each other. */
  redirectUri: string;
}

/** What a token endpoint answers when only a new login mends it (RFC 6749 §5.2). */
const LOGIN_ERRORS = new Set(["invalid_grant", "invalid_client", "unauthorized_client"]);

/** The code a login came back with, exchanged for its tokens — with the PKCE verifier that proves it was asked for here. */
export async function exchangeCode(discovery: OAuthDiscovery, client: OAuthClient, options: ExchangeOptions): Promise<OAuthTokens> {
  const grant = { grant_type: "authorization_code", code: options.code, redirect_uri: options.redirectUri, code_verifier: options.verifier };
  return await tokenRequest(discovery, client, grant, options, "exchanging the login's code", [options.code, options.verifier]);
}

/**
 * New tokens for `tokens`, from its refresh token. A server that keeps the refresh token, or the scope, as it was may
 * say neither (RFC 6749 §6), so each is carried over when the answer leaves it out. Throws `OAuthLoginRequiredError`
 * when the server refuses the refresh token (`invalid_grant`), or when there is none: the person has to log in again.
 */
export async function refreshTokens(discovery: OAuthDiscovery, client: OAuthClient, tokens: OAuthTokens, options: TokenOptions = {}): Promise<OAuthTokens> {
  if (!tokens.refreshToken) throw new OAuthLoginRequiredError("the login has no refresh token to renew it with; log in again");
  const grant = { grant_type: "refresh_token", refresh_token: tokens.refreshToken };
  const next = await tokenRequest(discovery, client, grant, options, "renewing the login", [tokens.refreshToken, tokens.accessToken]);
  return {
    ...next,
    refreshToken: next.refreshToken ?? tokens.refreshToken,
    ...(next.scope === undefined && tokens.scope !== undefined ? { scope: tokens.scope } : {}),
  };
}

async function tokenRequest(
  discovery: OAuthDiscovery,
  client: OAuthClient,
  grant: Record<string, string>,
  options: TokenOptions,
  what: string,
  secrets: string[],
): Promise<OAuthTokens> {
  const body = new URLSearchParams({ ...grant, resource: discovery.resource });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  const method = clientAuthMethod(client, discovery);
  if (method === "client_secret_basic") {
    // RFC 6749 §2.3.1: each half form-encoded before the pair is base64'd.
    headers.authorization = `Basic ${btoa(`${formEncoded(client.clientId)}:${formEncoded(client.clientSecret ?? "")}`)}`;
  } else {
    body.set("client_id", client.clientId);
    if (method === "client_secret_post") body.set("client_secret", client.clientSecret ?? "");
  }

  const answer = await post(discovery.tokenEndpoint, "the token endpoint", { headers, body: body.toString() }, options);
  // The body decides, not only the status: GitHub answers a refused code with 200 and an `error`.
  if (!answer.ok || answer.body.error !== undefined) {
    const refused = refusal(what, answer.status, answer.body, [...secrets, client.clientSecret]);
    if (refused.code && LOGIN_ERRORS.has(refused.code)) throw new OAuthLoginRequiredError(`${refused.message}; log in again`, refused.code);
    throw new OAuthError(refused.message, refused.code);
  }
  return tokensOf(answer.body, options.now ?? Date.now, discovery.tokenEndpoint);
}

/**
 * How the token endpoint is shown the client's secret: as the registration said; else basic, then post, as the
 * metadata lists them; else post. RFC 8414's default for a server that lists nothing is basic, but post is the form such
 * servers are documented to take (GitHub's is), and the one the reference MCP client sends them.
 */
function clientAuthMethod(client: OAuthClient, discovery: OAuthDiscovery): "client_secret_basic" | "client_secret_post" | "none" {
  if (!client.clientSecret) return "none";
  const said = client.tokenEndpointAuthMethod;
  if (said === "client_secret_basic" || said === "client_secret_post" || said === "none") return said;
  const listed = discovery.tokenEndpointAuthMethods;
  if (listed?.includes("client_secret_basic")) return "client_secret_basic";
  if (listed?.includes("client_secret_post")) return "client_secret_post";
  if (listed?.includes("none")) return "none";
  return "client_secret_post";
}

/** `value` as `application/x-www-form-urlencoded` writes it. */
function formEncoded(value: string): string {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

/** A token response (RFC 6749 §5.1) as `OAuthTokens`, refusing one an MCP server could not be sent. */
function tokensOf(body: Record<string, unknown>, now: () => number, from: string): OAuthTokens {
  const { access_token: accessToken, token_type: tokenType, expires_in: expiresIn, refresh_token: refreshToken, scope } = body;
  if (typeof accessToken !== "string" || !accessToken) throw new OAuthError(`the token endpoint ${from} answered without an access token`);
  if (tokenType !== undefined && String(tokenType).toLowerCase() !== "bearer") {
    throw new OAuthError(`the token endpoint ${from} issued a ${JSON.stringify(tokenType)} token, and an MCP server is sent only Bearer tokens`);
  }
  // A number, or a numeric string — some servers quote it.
  const seconds = typeof expiresIn === "number" || typeof expiresIn === "string" ? Number(expiresIn) : Number.NaN;
  return {
    accessToken,
    tokenType: "Bearer",
    ...(Number.isFinite(seconds) && seconds > 0 ? { expiresAt: now() + seconds * 1000 } : {}),
    ...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
    ...(typeof scope === "string" && scope ? { scope } : {}),
  };
}
