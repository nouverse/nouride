/**
 * The client a login is made as: one the operator registered by hand with the authorization server, or one registered
 * on the spot through Dynamic Client Registration (RFC 7591) where the server offers it — in that order, as MCP
 * 2025-11-25 ranks them. Client ID Metadata Documents, which that revision ranks between the two, are not made here.
 */

import { createLogger } from "@nouride/shared";
import type { OAuthDiscovery } from "./discovery.ts";
import { OAuthError, refusal } from "./errors.ts";
import { post, type OAuthHttpOptions } from "./fetch.ts";

const log = createLogger("mcp.oauth");

/**
 * Who the login is asked for. Plain data, kept by the caller with the discovery and the tokens: every token request
 * names it, and a registered client's secret — when the server issued one — is a credential like the tokens are.
 */
export interface OAuthClient {
  clientId: string;
  /** Present only for a confidential client: the operator's, or one the registration handed back. */
  clientSecret?: string;
  /** How the token endpoint wants the secret shown — what the registration said, when it said. */
  tokenEndpointAuthMethod?: string;
}

export interface RegisterOptions extends OAuthHttpOptions {
  /** Where the authorization server may send the person back — the authorization request names one of these. */
  redirectUris: string[];
  /** A client id registered by hand with the authorization server. When given, nothing is registered. */
  clientId?: string;
  /** That client's secret, if it has one. */
  clientSecret?: string;
}

/**
 * The client to log in as: `clientId` when the caller has one, else a public client registered with the server's
 * registration endpoint — `token_endpoint_auth_method: "none"`, so no secret has to be kept, as PKCE makes possible.
 * A server that offers no registration and was given no client id is refused with what it needs.
 */
export async function registerClient(discovery: OAuthDiscovery, options: RegisterOptions): Promise<OAuthClient> {
  if (options.clientId) {
    return { clientId: options.clientId, ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}) };
  }
  if (!discovery.registrationEndpoint) {
    throw new OAuthError(
      `the authorization server ${discovery.issuer} offers no dynamic client registration, so logging in to it needs a client id: ` +
        "register an application with it and give its client id (and its secret, if it issued one)",
    );
  }

  const answer = await post(
    discovery.registrationEndpoint,
    "the registration endpoint",
    {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Nouride",
        redirect_uris: options.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    options,
  );
  const { client_id: clientId, client_secret: clientSecret, token_endpoint_auth_method: method } = answer.body;
  if (!answer.ok) {
    const refused = refusal(`registering with ${discovery.registrationEndpoint}`, answer.status, answer.body, []);
    throw new OAuthError(refused.message, refused.code);
  }
  if (typeof clientId !== "string" || !clientId) throw new OAuthError(`the registration endpoint ${discovery.registrationEndpoint} answered without a client id`);
  log.debug("registered a client with an MCP server's authorization server", { issuer: discovery.issuer, confidential: typeof clientSecret === "string" });
  return {
    clientId,
    ...(typeof clientSecret === "string" && clientSecret ? { clientSecret } : {}),
    ...(typeof method === "string" ? { tokenEndpointAuthMethod: method } : {}),
  };
}
