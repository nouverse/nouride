/**
 * Finding where an MCP server's logins come from: its resource metadata, by the 401's pointer or the well-known URIs
 * in their order; its authorization server's metadata, by RFC 8414 or OpenID Connect in theirs; and the scope and
 * resource a login asks for. Real servers on sockets where the order is the point, a stubbed `fetch` where a document
 * no well-behaved server would publish is.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { discoverOAuth, OAuthError } from "../src/index.ts";
import { challengeOf, oauthServers, type OAuthScript } from "./fixtures/oauth-servers.ts";

const running: ReturnType<typeof oauthServers>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((servers) => servers.stop()));
});

function serve(script: OAuthScript = {}) {
  const servers = oauthServers(script);
  running.push(servers);
  return servers;
}

const paths = (seen: { method: string; path: string }[]) => seen.filter((r) => r.method === "GET").map((r) => r.path);

describe("the protected resource metadata", () => {
  test("is read where the 401's challenge points, before any well-known URI", async () => {
    const s = serve({ prm: "challenge" });
    const discovery = await discoverOAuth(s.mcpUrl, { challenge: await challengeOf(s.mcpUrl) });

    expect(discovery).toMatchObject({
      issuer: s.issuer,
      resource: s.mcpUrl,
      authorizationEndpoint: `${s.issuer}/authorize`,
      tokenEndpoint: `${s.issuer}/token`,
      registrationEndpoint: `${s.issuer}/register`,
      codeChallengeMethods: ["S256"],
    });
    expect(paths(s.mcpRequests)).toEqual(["/meta/resource"]);
  });

  test("without a pointer, is read at the well-known URI under the server's path", async () => {
    const s = serve({ prm: "path" });
    const discovery = await discoverOAuth(s.mcpUrl);

    expect(discovery.issuer).toBe(s.issuer);
    expect(paths(s.mcpRequests)).toEqual(["/.well-known/oauth-protected-resource/mcp"]);
  });

  test("and then at the root, once the path's answers 404", async () => {
    const s = serve({ prm: "root" });
    const discovery = await discoverOAuth(s.mcpUrl, { challenge: 'Bearer error="invalid_token"' });

    expect(discovery.issuer).toBe(s.issuer);
    expect(paths(s.mcpRequests)).toEqual(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]);
  });

  test("a pointer to a well-known URI is asked once, not again as the fallback", async () => {
    const s = serve({ prm: "root" });
    await discoverOAuth(s.mcpUrl, { challenge: `Bearer resource_metadata="${s.mcpOrigin}/.well-known/oauth-protected-resource/mcp"` });
    expect(paths(s.mcpRequests)).toEqual(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]);
  });

  test("a server URL that is not a URL is refused as one", async () => {
    await expect(discoverOAuth("mcp.example.com/mcp")).rejects.toThrow(/is not a URL/);
  });

  test("absent everywhere, the server is read as a 2025-03-26 one: its own origin is its authorization server", async () => {
    const s = serve({ prm: "none" });
    const discovery = await discoverOAuth(s.mcpUrl);

    expect(discovery).toMatchObject({ issuer: s.mcpOrigin, resource: s.mcpUrl, tokenEndpoint: `${s.issuer}/token` });
    expect(paths(s.mcpRequests).at(-1)).toBe("/.well-known/oauth-authorization-server");
  });
});

describe("the authorization server's metadata", () => {
  test("is read at the RFC 8414 path-insertion URI first", async () => {
    const s = serve({ prm: "path", issuerPath: "/tenant1", metadata: "oauth" });
    const discovery = await discoverOAuth(s.mcpUrl);

    expect(discovery.tokenEndpoint).toBe(`${s.issuer}/token`);
    expect(paths(s.asRequests)).toEqual(["/.well-known/oauth-authorization-server/tenant1"]);
  });

  test("then at OpenID Connect's path insertion, then its path appending — in that order", async () => {
    const inserted = serve({ prm: "path", issuerPath: "/tenant1", metadata: "oidc-insert" });
    await discoverOAuth(inserted.mcpUrl);
    expect(paths(inserted.asRequests)).toEqual(["/.well-known/oauth-authorization-server/tenant1", "/.well-known/openid-configuration/tenant1"]);

    const appended = serve({ prm: "path", issuerPath: "/tenant1", metadata: "oidc-append" });
    const discovery = await discoverOAuth(appended.mcpUrl);
    expect(discovery.authorizationEndpoint).toBe(`${appended.issuer}/authorize`);
    expect(paths(appended.asRequests)).toEqual([
      "/.well-known/oauth-authorization-server/tenant1",
      "/.well-known/openid-configuration/tenant1",
      "/tenant1/.well-known/openid-configuration",
    ]);
  });

  test("for an issuer with no path, RFC 8414's URI and then OpenID Connect's", async () => {
    const s = serve({ prm: "path", metadata: "oidc-insert" });
    await discoverOAuth(s.mcpUrl);
    expect(paths(s.asRequests)).toEqual(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]);
  });

  test("found nowhere, is an error naming every place it was looked for", async () => {
    const s = serve({ prm: "path", issuerPath: "/tenant1", metadata: "oauth" });
    const discovery = discoverOAuth(s.mcpUrl, {
      // The resource metadata as the server publishes it, and every metadata document missing.
      fetch: (input, init) => (String(input).includes("/tenant1") ? Promise.resolve(new Response("gone", { status: 404 })) : fetch(input, init)),
    });
    await expect(discovery).rejects.toThrow(/tried .*oauth-authorization-server\/tenant1: HTTP 404.*openid-configuration\/tenant1: HTTP 404.*tenant1\/\.well-known\/openid-configuration: HTTP 404/);
  });
});

describe("what a login asks for", () => {
  test("the scope: the challenge's, else every scope the resource lists, else none", async () => {
    const both = serve({ prm: "challenge", scopes: ["files:read", "files:write"], challengeScope: "files:read" });
    expect((await discoverOAuth(both.mcpUrl, { challenge: await challengeOf(both.mcpUrl) })).scope).toBe("files:read");

    const listed = serve({ prm: "challenge", scopes: ["files:read", "files:write"] });
    expect((await discoverOAuth(listed.mcpUrl, { challenge: await challengeOf(listed.mcpUrl) })).scope).toBe("files:read files:write");

    const neither = serve({ prm: "challenge" });
    expect(await discoverOAuth(neither.mcpUrl, { challenge: await challengeOf(neither.mcpUrl) })).not.toHaveProperty("scope");
  });

  test("the resource: the metadata's own when it covers this server — its origin, here", async () => {
    const s = serve({ prm: "path" });
    const discovery = await discoverOAuth(s.mcpUrl, { fetch: resourceDeclaring(s.mcpOrigin) });
    expect(discovery.resource).toBe(s.mcpOrigin);
  });

  test("and a resource metadata document for another resource is refused, not used", async () => {
    const s = serve({ prm: "path" });
    for (const other of [`${s.mcpOrigin}/elsewhere`, "https://another.example/mcp", `${s.mcpOrigin}/mcp-other`]) {
      await expect(discoverOAuth(s.mcpUrl, { fetch: resourceDeclaring(other) }), other).rejects.toThrow(/is for .* not this server/);
    }
  });

  test("with no resource declared, the server's canonical URI: scheme and host lowercased, no query or fragment", async () => {
    const s = serve({ prm: "path", prmResource: null });
    const url = `${s.mcpUrl.replace("http://", "HTTP://")}?session=abc#section`;
    expect((await discoverOAuth(url)).resource).toBe(s.mcpUrl);
  });
});

/** The real servers, with the resource metadata's `resource` replaced by `resource`. */
function resourceDeclaring(resource: string) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input, init);
    if (!String(input).includes("oauth-protected-resource") || !response.ok) return response;
    return Response.json({ ...((await response.json()) as object), resource });
  };
}

describe("documents no well-behaved server publishes", () => {
  const AS = "https://auth.example.com";
  /** A `fetch` that answers `routes` and 404s the rest, recording what was asked. */
  function stub(routes: Record<string, unknown>) {
    const asked: string[] = [];
    const fetchFn = (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      asked.push(url);
      const body = routes[url];
      if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
      return Promise.resolve(typeof body === "string" ? new Response(body, { headers: { "content-type": "text/html" } }) : Response.json(body));
    };
    return { asked, fetch: fetchFn };
  }
  const metadata = (extra: Record<string, unknown> = {}) => ({
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    ...extra,
  });
  const resource = { "https://mcp.example.com/.well-known/oauth-protected-resource": { resource: "https://mcp.example.com/mcp", authorization_servers: [AS] } };

  test("a page that is not JSON — a single-page app answering every path — is a miss, and the search goes on", async () => {
    const s = stub({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": "<!doctype html><title>app</title>",
      ...resource,
      [`${AS}/.well-known/oauth-authorization-server`]: metadata(),
    });
    expect((await discoverOAuth("https://mcp.example.com/mcp", { fetch: s.fetch })).issuer).toBe(AS);
    expect(s.asked.slice(0, 2)).toEqual(["https://mcp.example.com/.well-known/oauth-protected-resource/mcp", "https://mcp.example.com/.well-known/oauth-protected-resource"]);
  });

  test("an endpoint a code or a token would go to over plain http, off this machine, is refused", async () => {
    for (const [field, value] of [
      ["token_endpoint", "http://auth.example.com/token"],
      ["authorization_endpoint", "http://auth.example.com/authorize"],
      ["registration_endpoint", "http://auth.example.com/register"],
      ["token_endpoint", "not a url"],
    ] as const) {
      const s = stub({ ...resource, [`${AS}/.well-known/oauth-authorization-server`]: metadata({ [field]: value }) });
      await expect(discoverOAuth("https://mcp.example.com/mcp", { fetch: s.fetch }), `${field}: ${value}`).rejects.toThrow(OAuthError);
    }
  });

  test("plain http is taken only on this machine's loopback — not on a name that merely starts like it", async () => {
    for (const [host, accepted] of [
      ["localhost:8080", true],
      ["auth.localhost", true],
      ["127.5.5.5:9000", true],
      ["[::1]:8080", true],
      ["localhost.evil.example", false],
      ["127.0.0.1.evil.example", false],
      ["10.0.0.7", false],
    ] as const) {
      const issuer = `http://${host}`;
      const s = stub({
        "https://mcp.example.com/.well-known/oauth-protected-resource": { resource: "https://mcp.example.com/mcp", authorization_servers: [issuer] },
        [`${issuer}/.well-known/oauth-authorization-server`]: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` },
      });
      const found = discoverOAuth("https://mcp.example.com/mcp", { fetch: s.fetch });
      if (accepted) expect((await found).tokenEndpoint, host).toBe(`${issuer}/token`);
      else await expect(found, host).rejects.toThrow(/must be an https URL/);
    }
  });

  test("an authorization server named over plain http is refused before anything is asked of it", async () => {
    const s = stub({ "https://mcp.example.com/.well-known/oauth-protected-resource": { resource: "https://mcp.example.com/mcp", authorization_servers: ["http://auth.example.com"] } });
    await expect(discoverOAuth("https://mcp.example.com/mcp", { fetch: s.fetch })).rejects.toThrow(/must be an https URL/);
    expect(s.asked.some((url) => url.startsWith("http://auth.example.com"))).toBe(false);
  });

  test("metadata that claims another host's issuer is refused; a different path on the same host is not", async () => {
    const claims = (issuer: string) => stub({ ...resource, [`${AS}/.well-known/oauth-authorization-server`]: metadata({ issuer }) });
    await expect(discoverOAuth("https://mcp.example.com/mcp", { fetch: claims("https://evil.example").fetch })).rejects.toThrow(/is for the issuer/);
    expect((await discoverOAuth("https://mcp.example.com/mcp", { fetch: claims(`${AS}/{tenantid}/v2.0`).fetch })).issuer).toBe(AS);
  });

  test("resource metadata that names no authorization server is refused", async () => {
    const s = stub({ "https://mcp.example.com/.well-known/oauth-protected-resource": { resource: "https://mcp.example.com/mcp", authorization_servers: [] } });
    await expect(discoverOAuth("https://mcp.example.com/mcp", { fetch: s.fetch })).rejects.toThrow(/names no authorization server/);
  });
});
