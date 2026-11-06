/**
 * A login already made, the way a caller makes one — discovery from the 401's challenge, a registered client, the
 * authorization approved, the code exchanged — for the tests about what happens after it: the token in use, renewed,
 * refused, and never logged.
 */

import {
  authorizationRequest,
  discoverOAuth,
  exchangeCode,
  oauthAuth,
  refreshTokens,
  registerClient,
  type OAuthAuthOptions,
  type OAuthTokens,
} from "../../src/index.ts";
import { approve, challengeOf, oauthServers, type OAuthScript } from "./oauth-servers.ts";

export const REDIRECT = "http://127.0.0.1:7777/oauth/callback";

/**
 * The servers, logged in to: `tokens` is what the exchange returned, `stored` every set `onTokens` has been handed,
 * and `auth()` an `oauthAuth` over them, refreshing through the real token endpoint, on the clock the caller passes.
 */
export async function loggedIn(script: OAuthScript, now: () => number) {
  const servers = oauthServers(script);
  const discovery = await discoverOAuth(servers.mcpUrl, { challenge: await challengeOf(servers.mcpUrl) });
  const client = await registerClient(discovery, { redirectUris: [REDIRECT] });
  const request = authorizationRequest(discovery, client, { redirectUri: REDIRECT });
  const { code } = await approve(request.url);
  const tokens = await exchangeCode(discovery, client, { code, verifier: request.verifier, redirectUri: REDIRECT, now });
  const stored: OAuthTokens[] = [];
  const auth = (options: Partial<OAuthAuthOptions> = {}) =>
    oauthAuth({ tokens, refresh: (current) => refreshTokens(discovery, client, current, { now }), onTokens: (next) => void stored.push(next), now, ...options });
  return { servers, discovery, client, tokens, stored, auth, verifier: request.verifier, code };
}
