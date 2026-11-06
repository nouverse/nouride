/**
 * Where an MCP server's logins come from (MCP 2025-06-18 Authorization, as 2025-11-25 refines it).
 *
 * Two documents, read in turn. The server's protected resource metadata (RFC 9728) names the authorization server that
 * issues its tokens and the scopes it knows; that authorization server's own metadata (RFC 8414, or OpenID Connect
 * Discovery) names the endpoints a login goes through. Each is looked for where the spec lists it, in its order, and
 * the first place that answers with a JSON object wins — an HTML page served for every path, as a single-page app's
 * host does, is a miss like a 404 rather than the end of the search.
 */

import { createLogger } from "@nouride/shared";
import { MCP_PROTOCOL_VERSION } from "../protocol.ts";
import { parseBearerChallenge } from "./challenge.ts";
import { OAuthError } from "./errors.ts";
import { getJsonObject, secureEndpoint, type OAuthHttpOptions } from "./fetch.ts";

const log = createLogger("mcp.oauth");

/**
 * Everything a login to one MCP server needs to know about where it goes. Plain data: the caller keeps it with the
 * client and the tokens, since the authorization request, the code exchange and every refresh after it read it.
 */
export interface OAuthDiscovery {
  /**
   * The RFC 8707 `resource` every authorization and token request names, so the token is issued for this server and no
   * other: the resource the server's metadata declares, or — when it declares none — the server's canonical URI.
   */
  resource: string;
  /** The authorization server's issuer, as the resource metadata names it. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Dynamic client registration (RFC 7591) — absent when the server offers none, and a client id is needed instead. */
  registrationEndpoint?: string;
  /** The PKCE methods the server lists. Absent when its metadata does not say. */
  codeChallengeMethods?: string[];
  /** How the token endpoint takes a client's secret, as listed. Absent when its metadata does not say. */
  tokenEndpointAuthMethods?: string[];
  /** The scope to ask for: the 401's own, else every scope the resource lists, else none. */
  scope?: string;
}

export interface DiscoverOptions extends OAuthHttpOptions {
  /** The `WWW-Authenticate` value of the 401 that asked for a login — `McpAuthRequiredError.challenge`. */
  challenge?: string | null;
}

/**
 * Find the authorization server behind an MCP server, and what a login to it needs.
 *
 * Protected resource metadata is read from the challenge's `resource_metadata` when the 401 named one, and otherwise
 * from the well-known URI under the server's path, then at its root. A server with none at all is read as a 2025-03-26
 * server was: its own origin is the authorization server. The authorization server's metadata is read at the RFC 8414
 * path-insertion URI, then OpenID Connect's two (MCP 2025-11-25, Authorization Server Metadata Discovery).
 */
export async function discoverOAuth(serverUrl: string, options: DiscoverOptions = {}): Promise<OAuthDiscovery> {
  if (!URL.canParse(serverUrl)) throw new OAuthError(`the MCP server's URL is not a URL: ${JSON.stringify(serverUrl)}`);
  const server = new URL(serverUrl);
  const challenge = parseBearerChallenge(options.challenge);
  const headers = { "mcp-protocol-version": MCP_PROTOCOL_VERSION };

  let issuer = server.origin;
  let resource = canonicalResource(server);
  let scopes: string[] | undefined;
  const protectedResource = await firstObject(resourceMetadataUrls(server, challenge?.resourceMetadata), headers, options);
  if ("body" in protectedResource) {
    const { body, url } = protectedResource;
    issuer = authorizationServerOf(body.authorization_servers, url);
    resource = resourceOf(body.resource, server, url);
    scopes = stringList(body.scopes_supported);
  } else {
    log.debug("an MCP server publishes no protected resource metadata, so its own origin is taken as its authorization server", { server: resource, tried: protectedResource.failed });
  }

  const found = await firstObject(authorizationServerUrls(secureEndpoint(issuer, "the authorization server")), headers, options);
  if (!("body" in found)) throw new OAuthError(`found no metadata for the authorization server ${issuer} (tried ${found.failed.join("; ")})`);
  const { body: metadata, url: metadataUrl } = found;
  // RFC 8414 §3.3 asks for the issuer to match exactly. Held to its origin: a path that differs is a templated tenant
  // or a trailing slash far more often than an attack, while metadata claiming another host's issuer is refused.
  if (typeof metadata.issuer === "string" && (!URL.canParse(metadata.issuer) || new URL(metadata.issuer).origin !== new URL(metadataUrl).origin)) {
    throw new OAuthError(`the metadata at ${metadataUrl} is for the issuer ${JSON.stringify(metadata.issuer)}, not ${issuer}`);
  }

  const scope = challenge?.scope ?? (scopes?.length ? scopes.join(" ") : undefined);
  const challengeMethods = stringList(metadata.code_challenge_methods_supported);
  const authMethods = stringList(metadata.token_endpoint_auth_methods_supported);
  log.debug("found an MCP server's authorization server", { server: canonicalResource(server), issuer, metadata: metadataUrl });
  return {
    resource,
    issuer,
    authorizationEndpoint: secureEndpoint(metadata.authorization_endpoint, `the authorization endpoint at ${metadataUrl}`),
    tokenEndpoint: secureEndpoint(metadata.token_endpoint, `the token endpoint at ${metadataUrl}`),
    ...(metadata.registration_endpoint === undefined ? {} : { registrationEndpoint: secureEndpoint(metadata.registration_endpoint, `the registration endpoint at ${metadataUrl}`) }),
    ...(challengeMethods ? { codeChallengeMethods: challengeMethods } : {}),
    ...(authMethods ? { tokenEndpointAuthMethods: authMethods } : {}),
    ...(scope ? { scope } : {}),
  };
}

/**
 * An MCP server's canonical URI (MCP 2025-06-18, Canonical Server URI): scheme and host lowercased, the path kept, no
 * query or fragment — and no lone `/` for a server at its root, the form the spec asks for.
 */
function canonicalResource(url: URL): string {
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

/** Where the protected resource metadata may be: the 401's pointer, then the well-known URI under the path, then at the root (RFC 9728 §3.1). */
function resourceMetadataUrls(server: URL, pointer: string | undefined): string[] {
  const urls: string[] = [];
  if (pointer && URL.canParse(pointer, server.href)) urls.push(new URL(pointer, server).href);
  if (server.pathname !== "/") urls.push(`${server.origin}/.well-known/oauth-protected-resource${server.pathname}`);
  urls.push(`${server.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(urls)];
}

/** Where an issuer's metadata may be, in the order MCP 2025-11-25 lists — path insertion first, OpenID Connect after. */
function authorizationServerUrls(issuer: string): string[] {
  const { origin, pathname } = new URL(issuer);
  const path = pathname.replace(/\/+$/, "");
  if (!path) return [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

/** The first of `urls` that answers with a JSON object, or every way each one failed. */
async function firstObject(
  urls: string[],
  headers: Record<string, string>,
  options: OAuthHttpOptions,
): Promise<{ body: Record<string, unknown>; url: string } | { failed: string[] }> {
  const failed: string[] = [];
  for (const url of urls) {
    const answer = await getJsonObject(url, headers, options);
    if ("body" in answer) return { body: answer.body, url };
    failed.push(answer.failed);
  }
  return { failed };
}

/** `authorization_servers[0]`: which of several to use is the client's to choose (MCP 2025-06-18), and the first is the one listed first. */
function authorizationServerOf(listed: unknown, from: string): string {
  const first = Array.isArray(listed) ? listed[0] : undefined;
  if (typeof first !== "string") throw new OAuthError(`the protected resource metadata at ${from} names no authorization server`);
  return first;
}

/**
 * The resource tokens are asked for. The metadata's own `resource` when it covers this server — the same origin, and
 * this server's path at or under its path — since that is the name the authorization server knows the resource by.
 * One that covers some other resource is refused: a token issued for it, sent here, would hand this server a credential
 * for something else (RFC 9728 §3.3).
 */
function resourceOf(declared: unknown, server: URL, from: string): string {
  if (declared === undefined) return canonicalResource(server);
  const url = typeof declared === "string" && URL.canParse(declared) ? new URL(declared) : null;
  const base = url?.pathname.replace(/\/+$/, "") ?? "";
  const covers = url !== null && !url.hash && url.origin === server.origin && (server.pathname === base || server.pathname.startsWith(`${base}/`));
  if (!covers) {
    throw new OAuthError(`the protected resource metadata at ${from} is for ${JSON.stringify(declared)}, not this server (${canonicalResource(server)})`);
  }
  return declared as string;
}

/** A list of strings, or undefined when the field is not one. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
