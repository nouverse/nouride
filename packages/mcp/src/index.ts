/**
 * `@nouride/mcp` — this daemon as an MCP **host**, speaking MCP 2025-06-18 (and 2025-03-26 and 2024-11-05 to a server
 * that asks for one of those).
 *
 * Three layers, kept apart so the fragile part is the testable part:
 *
 * - `protocol.ts` — the wire format. Pure functions, no I/O. `arguments.ts` beside it: a model's arguments held to a
 *   tool's schema before a call is sent.
 * - `client.ts` — one connection: handshake and version, id matching, timeouts, what happens when the peer dies, and
 *   the tools listed again when the server says they changed. Transport-agnostic, so all of that is tested against an
 *   in-memory fake.
 * - `stdio.ts` / `http.ts` — the transports: a child process, and the two HTTP shapes servers are
 *   deployed behind. Thin, because everything worth testing is above them.
 *
 * Beside them, `oauth/`: logging in to a remote server that asks for one (MCP 2025-06-18 Authorization, refined by
 * 2025-11-25) — discovering its authorization server, registering a client, the authorization request, the token
 * exchange and its refresh — and `http-auth.ts`, the hook through which the HTTP transports send the credential that
 * comes of it. The library holds no state across a restart: what a login produces (the discovery, the client, the
 * tokens) is plain data the caller keeps.
 *
 * What is deliberately *not* here: turning an MCP tool into a Nouride `Tool`. That needs the approval
 * gate and the untrusted-content convention, both of which belong to the engine — see
 * `apps/engine/src/modules/tools/mcp.ts`. A package that knew about approvals would drag the whole security
 * model into something that should only know how to talk JSON-RPC.
 */

/**
 * One connection to one server (`McpClient`) and what its calls fail with: `McpError` for any failure, and
 * `McpAuthRequiredError` — a kind of it — when the server refused for want of a login, carrying the 401's challenge
 * for `discoverOAuth`.
 */
export { McpAuthRequiredError, McpClient, McpError } from "./client.ts";
export type {
  McpClientOptions,
  McpTransport,
  McpTransportFactory,
  McpTransportHandlers,
} from "./client.ts";
export { stdioTransport, type StdioTransportOptions } from "./stdio.ts";
/** The HTTP transports. Their `auth` option takes an `McpAuth` — `oauthAuth` for a server logged in to with OAuth. */
export {
  sseTransport,
  streamableHttpTransport,
  type HttpTransportOptions,
} from "./http.ts";
export type { McpAuth } from "./http-auth.ts";
/**
 * Step one of a login: where the server's authorization server is, and what it offers. Keep the `OAuthDiscovery` with
 * the client and the tokens — every later step reads it.
 */
export { discoverOAuth, type DiscoverOptions, type OAuthDiscovery } from "./oauth/discovery.ts";
/**
 * Step two: the client the login is made as — a client id the operator registered, or one registered on the spot. Keep
 * the `OAuthClient`; a `clientSecret` in it is a credential.
 */
export { registerClient, type OAuthClient, type RegisterOptions } from "./oauth/register.ts";
/**
 * Step three: the URL the person opens. Keep `state` (the redirect must carry the same) and `verifier` (a secret, for
 * `exchangeCode`) until the redirect comes back.
 */
export { authorizationRequest, type AuthorizationOptions, type AuthorizationRequest } from "./oauth/authorize.ts";
/**
 * Step four: the redirect's code exchanged for tokens, and those tokens renewed. Keep the `OAuthTokens` as credentials
 * — the refresh token above all — and replace them with every renewed set.
 */
export { exchangeCode, refreshTokens, type ExchangeOptions, type OAuthTokens, type TokenOptions } from "./oauth/token.ts";
/**
 * The tokens in use: an `McpAuth` for a transport's `auth`, renewing them as they near expiry and on a 401, and handing
 * each renewed set to `onTokens` for the caller to store.
 */
export { oauthAuth, type OAuthAuthOptions } from "./oauth/bearer-auth.ts";
/** What an OAuth step throws. `OAuthLoginRequiredError`: the server refused the grant, and only a new login mends it. */
export { OAuthError, OAuthLoginRequiredError } from "./oauth/errors.ts";
export type { OAuthHttpOptions } from "./oauth/fetch.ts";
export { argumentProblems } from "./arguments.ts";
export {
  MCP_PROTOCOL_VERSIONS,
  negotiateVersion,
  parseTools,
  type McpImage,
  type McpServerInfo,
  type McpTool,
  type McpToolCallResult,
} from "./protocol.ts";
