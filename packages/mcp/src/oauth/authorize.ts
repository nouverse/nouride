/**
 * The authorization request: the URL a person opens to log in, and the two values that prove the answer is the one to
 * this request — `state` against a forged redirect, and the PKCE verifier (RFC 7636) against a stolen code.
 */

import { base64Url, createHash, randomBytes } from "@nouride/runtime";
import type { OAuthDiscovery } from "./discovery.ts";
import { OAuthError } from "./errors.ts";
import type { OAuthClient } from "./register.ts";

/**
 * A login, started. The caller sends the person to `url` and keeps `state` and `verifier` until the redirect comes
 * back: the redirect's `state` must equal this one, and `exchangeCode` needs the verifier. The verifier is a secret —
 * kept where a token would be, and never logged.
 */
export interface AuthorizationRequest {
  url: string;
  state: string;
  verifier: string;
}

export interface AuthorizationOptions {
  /** Where the person is sent back — one of the client's `redirectUris`, and named again to `exchangeCode`. */
  redirectUri: string;
  /** The scope to ask for, in place of the one discovery chose. */
  scope?: string;
}

/** 32 random bytes: a 43-character verifier, as RFC 7636 §4.1 recommends, and a `state` as hard to guess. */
const RANDOM_BYTES = 32;

/**
 * The authorization request for `client` at `discovery`'s server: the code flow with PKCE S256, a random `state`, the
 * scope, and the RFC 8707 `resource` this server's tokens are issued for. A server whose metadata lists its PKCE
 * methods without S256 is refused: the code would travel unprotected, and plain PKCE protects nothing.
 */
export function authorizationRequest(discovery: OAuthDiscovery, client: OAuthClient, options: AuthorizationOptions): AuthorizationRequest {
  const methods = discovery.codeChallengeMethods;
  if (methods && !methods.includes("S256")) {
    throw new OAuthError(
      `the authorization server ${discovery.issuer} does not offer PKCE with S256 (it lists ${methods.length ? methods.join(", ") : "no method"}): ` +
        "a login through it would not be protected against a stolen code, so none is started",
    );
  }

  const verifier = base64Url(randomBytes(RANDOM_BYTES));
  const state = base64Url(randomBytes(RANDOM_BYTES));
  const url = new URL(discovery.authorizationEndpoint);
  const scope = options.scope ?? discovery.scope;
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge", base64Url(createHash("sha256").update(verifier).digest()));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("resource", discovery.resource);
  return { url: url.href, state, verifier };
}
