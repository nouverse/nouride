/**
 * A login to a remote MCP server, step by step and then whole: the client registered (or given), the authorization
 * URL, the code exchanged, and the server spoken to with what came of it — against an authorization server that holds
 * every step to what a real one checks, so a request it would refuse fails here too.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  authorizationRequest,
  discoverOAuth,
  exchangeCode,
  McpAuthRequiredError,
  McpClient,
  OAuthError,
  OAuthLoginRequiredError,
  oauthAuth,
  refreshTokens,
  registerClient,
  streamableHttpTransport,
  type McpAuth,
  type OAuthDiscovery,
} from "../src/index.ts";
import { approve, challengeOf, oauthServers, type OAuthScript } from "./fixtures/oauth-servers.ts";

const REDIRECT = "http://127.0.0.1:7777/oauth/callback";

const running: ReturnType<typeof oauthServers>[] = [];
const clients: McpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(running.splice(0).map((servers) => servers.stop()));
});

function serve(script: OAuthScript = {}) {
  const servers = oauthServers(script);
  running.push(servers);
  return servers;
}

const registrations = (s: ReturnType<typeof serve>) => s.asRequests.filter((r) => r.method === "POST" && r.path.endsWith("/register"));

/** Discovery as a login starts it: from the challenge of the 401 the server answers a request with no credential. */
async function discover(s: ReturnType<typeof serve>): Promise<OAuthDiscovery> {
  return await discoverOAuth(s.mcpUrl, { challenge: await challengeOf(s.mcpUrl) });
}

describe("the client a login is made as", () => {
  test("is registered as a public client with what the spec asks for", async () => {
    const s = serve();
    const client = await registerClient(await discover(s), { redirectUris: [REDIRECT] });

    expect(client.clientId).toMatch(/^client_/);
    expect(client).not.toHaveProperty("clientSecret");
    const [registration] = registrations(s);
    expect(registration!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(registration!.body!)).toEqual({
      client_name: "Nouride",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  test("is the operator's own when a client id is given, and then nothing is registered", async () => {
    const s = serve();
    const client = await registerClient(await discover(s), { redirectUris: [REDIRECT], clientId: "by-hand", clientSecret: "hand-secret-value" });

    expect(client).toEqual({ clientId: "by-hand", clientSecret: "hand-secret-value" });
    expect(registrations(s)).toEqual([]);
  });

  test("on a server that registers nobody, without a client id, is refused with what it needs", async () => {
    const s = serve({ registration: false });
    const discovery = await discover(s);
    expect(discovery).not.toHaveProperty("registrationEndpoint");
    await expect(registerClient(discovery, { redirectUris: [REDIRECT] })).rejects.toThrow(/needs a client id/);
  });

  test("keeps the secret and the way to show it when the server registers a confidential client after all", async () => {
    const discovery: OAuthDiscovery = { resource: "https://mcp.example.com/mcp", issuer: "https://auth.example.com", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token", registrationEndpoint: "https://auth.example.com/register" };
    const answer = { client_id: "issued-1", client_secret: "issued-secret-1", token_endpoint_auth_method: "client_secret_post" };
    const client = await registerClient(discovery, { redirectUris: [REDIRECT], fetch: () => Promise.resolve(Response.json(answer, { status: 201 })) });
    expect(client).toEqual({ clientId: "issued-1", clientSecret: "issued-secret-1", tokenEndpointAuthMethod: "client_secret_post" });
  });

  test("a registration the server refuses says why, in its own words", async () => {
    const discovery: OAuthDiscovery = { resource: "https://mcp.example.com/mcp", issuer: "https://auth.example.com", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token", registrationEndpoint: "https://auth.example.com/register" };
    const refused = registerClient(discovery, {
      redirectUris: ["https://not.allowed/cb"],
      fetch: () => Promise.resolve(Response.json({ error: "invalid_redirect_uri", error_description: "only loopback redirects" }, { status: 400 })),
    });
    await expect(refused).rejects.toThrow("registering with https://auth.example.com/register was refused (invalid_redirect_uri: only loopback redirects)");
  });
});

describe("the authorization request", () => {
  test("carries the code flow, PKCE S256, its state, the scope, the redirect and the resource", async () => {
    const s = serve({ scopes: ["files:read", "files:write"] });
    const discovery = await discover(s);
    const client = await registerClient(discovery, { redirectUris: [REDIRECT] });
    const { url, state, verifier } = authorizationRequest(discovery, client, { redirectUri: REDIRECT });

    const asked = new URL(url);
    expect(asked.origin + asked.pathname).toBe(`${s.issuer}/authorize`);
    expect(Object.fromEntries(asked.searchParams)).toEqual({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
      scope: "files:read files:write",
      resource: s.mcpUrl,
    });
    // RFC 7636 §4.1: 43 to 128 characters of the unreserved set.
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(state.length).toBeGreaterThanOrEqual(32);
    // Random each time, not derived from anything a second request would repeat.
    const again = authorizationRequest(discovery, client, { redirectUri: REDIRECT, scope: "files:read" });
    expect([again.state, again.verifier]).not.toContain(state);
    expect(again.verifier).not.toBe(verifier);
    expect(new URL(again.url).searchParams.get("scope")).toBe("files:read");
  });

  test("is refused when the server lists its PKCE methods without S256", async () => {
    const s = serve({ challengeMethods: ["plain"] });
    const discovery = await discover(s);
    const client = await registerClient(discovery, { redirectUris: [REDIRECT] });
    expect(() => authorizationRequest(discovery, client, { redirectUri: REDIRECT })).toThrow(/does not offer PKCE with S256 \(it lists plain\)/);
    // A server that lists none is asked with S256 all the same: PKCE is sent, and one that ignores it loses nothing.
    const silent = serve({ challengeMethods: null });
    const quiet = await discover(silent);
    expect(new URL(authorizationRequest(quiet, client, { redirectUri: REDIRECT }).url).searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("the code exchange", () => {
  test("sends the verifier, the redirect URI and the resource, and reads the tokens it is answered with", async () => {
    const s = serve({ expiresIn: 3600 });
    const discovery = await discover(s);
    const client = await registerClient(discovery, { redirectUris: [REDIRECT] });
    const request = authorizationRequest(discovery, client, { redirectUri: REDIRECT });
    const { code, state } = await approve(request.url);
    expect(state).toBe(request.state);

    const tokens = await exchangeCode(discovery, client, { code, verifier: request.verifier, redirectUri: REDIRECT, now: () => 1_000_000 });

    expect(s.tokenForms()).toEqual([
      { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: request.verifier, resource: s.mcpUrl, client_id: client.clientId },
    ]);
    expect(tokens).toEqual({ accessToken: expect.stringMatching(/^at_/), tokenType: "Bearer", refreshToken: expect.stringMatching(/^rt_/), expiresAt: 1_000_000 + 3_600_000 });
  });

  test("with a verifier that is not this request's, is refused as a login to make again — and says neither", async () => {
    const s = serve();
    const discovery = await discover(s);
    const client = await registerClient(discovery, { redirectUris: [REDIRECT] });
    const { url } = authorizationRequest(discovery, client, { redirectUri: REDIRECT });
    const { code } = await approve(url);
    const forged = authorizationRequest(discovery, client, { redirectUri: REDIRECT }).verifier;

    const refused = await exchangeCode(discovery, client, { code, verifier: forged, redirectUri: REDIRECT }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(OAuthLoginRequiredError);
    expect((refused as OAuthLoginRequiredError).code).toBe("invalid_grant");
    expect(String(refused)).not.toContain(code);
    expect(String(refused)).not.toContain(forged);
  });

  test("shows a confidential client's secret the way the server lists — basic first, then post — and post when it lists none", async () => {
    const manualClient = { id: "hand made", secret: "s3cret:value+1" };
    for (const [authMethods, shown] of [
      [["client_secret_post", "client_secret_basic"], "basic"],
      [["client_secret_post"], "post"],
      [undefined, "post"],
    ] as const) {
      const s = serve({ manualClient, registration: false, ...(authMethods ? { authMethods: [...authMethods] } : {}) });
      const discovery = await discover(s);
      const client = await registerClient(discovery, { redirectUris: [REDIRECT], clientId: manualClient.id, clientSecret: manualClient.secret });
      const request = authorizationRequest(discovery, client, { redirectUri: REDIRECT });
      // The server checks the secret either way: a wrong encoding of the pair is refused as invalid_client.
      await exchangeCode(discovery, client, { code: (await approve(request.url)).code, verifier: request.verifier, redirectUri: REDIRECT });

      const sent = s.asRequests.find((r) => r.path === "/token")!;
      const form = Object.fromEntries(new URLSearchParams(sent.body));
      if (shown === "basic") {
        expect(sent.headers.authorization).toBe(`Basic ${btoa("hand+made:s3cret%3Avalue%2B1")}`);
        expect(form).not.toHaveProperty("client_secret");
        expect(form).not.toHaveProperty("client_id");
      } else {
        expect(sent.headers.authorization).toBeUndefined();
        expect(form).toMatchObject({ client_id: manualClient.id, client_secret: manualClient.secret });
      }
    }
  });

  test("shows the secret the way the client's registration said, over what the metadata lists — and none where only none is listed", async () => {
    const sent: { authorization: string | null; form: Record<string, string> }[] = [];
    const record = (_input: string | URL | Request, init?: RequestInit) => {
      sent.push({ authorization: new Headers(init?.headers).get("authorization"), form: Object.fromEntries(new URLSearchParams(String(init?.body))) });
      return Promise.resolve(Response.json({ access_token: "issued-access", token_type: "Bearer" }));
    };
    const base: OAuthDiscovery = { resource: "https://mcp.example.com/mcp", issuer: "https://auth.example.com", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token" };
    const exchange = (discovery: OAuthDiscovery, client: { clientId: string; clientSecret?: string; tokenEndpointAuthMethod?: string }) =>
      exchangeCode(discovery, client, { code: "a-code-value", verifier: "v".repeat(43), redirectUri: REDIRECT, fetch: record });

    await exchange({ ...base, tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"] }, { clientId: "c-1", clientSecret: "c-secret-1", tokenEndpointAuthMethod: "client_secret_post" });
    await exchange({ ...base, tokenEndpointAuthMethods: ["none"] }, { clientId: "c-1", clientSecret: "c-secret-1" });

    expect(sent[0]).toMatchObject({ authorization: null, form: { client_id: "c-1", client_secret: "c-secret-1" } });
    expect(sent[1]!.authorization).toBeNull();
    expect(sent[1]!.form).toMatchObject({ client_id: "c-1" });
    expect(sent[1]!.form).not.toHaveProperty("client_secret");
  });

  test("a token endpoint that cannot be reached is said as that, with where", async () => {
    const discovery: OAuthDiscovery = { resource: "https://mcp.example.com/mcp", issuer: "https://auth.example.com", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token" };
    const unreachable = exchangeCode(discovery, { clientId: "c" }, { code: "a-code-value", verifier: "v".repeat(43), redirectUri: REDIRECT, fetch: () => Promise.reject(new TypeError("connection refused")) });
    await expect(unreachable).rejects.toThrow("could not reach the token endpoint at https://auth.example.com/token: connection refused");
  });

  test("reads an answer that is form-encoded, and an error carried in a 200, as GitHub's token endpoint sends them", async () => {
    const discovery: OAuthDiscovery = { resource: "https://api.example.com/mcp/", issuer: "https://github.example/login/oauth", authorizationEndpoint: "https://github.example/login/oauth/authorize", tokenEndpoint: "https://github.example/login/oauth/access_token" };
    const client = { clientId: "Iv1.abc", clientSecret: "gh-client-secret" };
    const form = (body: string) => () => Promise.resolve(new Response(body, { headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" } }));

    const tokens = await exchangeCode(discovery, client, { code: "code-value-1", verifier: "v".repeat(43), redirectUri: REDIRECT, fetch: form("access_token=gho_abcdefgh&token_type=bearer&scope=repo") });
    expect(tokens).toEqual({ accessToken: "gho_abcdefgh", tokenType: "Bearer", scope: "repo" });

    const refused = exchangeCode(discovery, client, { code: "code-value-1", verifier: "v".repeat(43), redirectUri: REDIRECT, fetch: form("error=bad_verification_code&error_description=The+code+code-value-1+is+incorrect") });
    // The code the server echoed back is cut from what is said.
    await expect(refused).rejects.toThrow("exchanging the login's code was refused (bad_verification_code: The code [redacted] is incorrect)");
  });

  test("refuses an answer with no access token, or a token type no MCP server is sent", async () => {
    const discovery: OAuthDiscovery = { resource: "https://mcp.example.com/mcp", issuer: "https://auth.example.com", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token" };
    const answer = (body: object) => () => Promise.resolve(Response.json(body));
    const exchange = (body: object) => exchangeCode(discovery, { clientId: "c" }, { code: "a-code-value", verifier: "v".repeat(43), redirectUri: REDIRECT, fetch: answer(body) });
    await expect(exchange({ token_type: "Bearer" })).rejects.toThrow(/without an access token/);
    await expect(exchange({ access_token: "abcdefgh", token_type: "mac" })).rejects.toThrow(OAuthError);
    // `expires_in` as a quoted number, which some servers send, is read as one.
    expect((await exchangeCode(discovery, { clientId: "c" }, { code: "a-code-value", verifier: "v".repeat(43), redirectUri: REDIRECT, now: () => 0, fetch: answer({ access_token: "abcdefgh", token_type: "Bearer", expires_in: "60" }) })).expiresAt).toBe(60_000);
  });
});

describe("a refresh", () => {
  const discovery: OAuthDiscovery = { resource: "https://mcp.example.com/mcp", issuer: "https://auth.example.com", authorizationEndpoint: "https://auth.example.com/authorize", tokenEndpoint: "https://auth.example.com/token" };
  const current = { accessToken: "old-access-token", tokenType: "Bearer", refreshToken: "kept-refresh-token", scope: "files:read" };

  test("keeps the refresh token and the scope an answer leaves out, takes the ones it gives, and names the resource", async () => {
    const forms: Record<string, string>[] = [];
    const answer = (body: object) => (_input: string | URL | Request, init?: RequestInit) => {
      forms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      return Promise.resolve(Response.json(body));
    };

    const kept = await refreshTokens(discovery, { clientId: "c-1" }, current, { fetch: answer({ access_token: "new-access-1", token_type: "Bearer" }) });
    expect(kept).toEqual({ accessToken: "new-access-1", tokenType: "Bearer", refreshToken: "kept-refresh-token", scope: "files:read" });
    expect(forms[0]).toEqual({ grant_type: "refresh_token", refresh_token: "kept-refresh-token", resource: discovery.resource, client_id: "c-1" });

    const rotated = await refreshTokens(discovery, { clientId: "c-1" }, current, {
      fetch: answer({ access_token: "new-access-2", token_type: "Bearer", refresh_token: "rotated-refresh-token", scope: "files:read files:write" }),
    });
    expect(rotated).toMatchObject({ refreshToken: "rotated-refresh-token", scope: "files:read files:write" });
  });

  test("of a login with no refresh token is a login needed, and nothing is asked of the server", async () => {
    let asked = 0;
    const { refreshToken: _none, ...noRefresh } = current;
    const refused = refreshTokens(discovery, { clientId: "c-1" }, noRefresh, { fetch: () => Promise.resolve(Response.json({ asked: (asked += 1) })) });
    await expect(refused).rejects.toBeInstanceOf(OAuthLoginRequiredError);
    expect(asked).toBe(0);
  });
});

describe("the whole login", () => {
  test("a 401 with no login, discovery from its challenge, the login, and then initialize and tools/list on its token", async () => {
    const s = serve({ expiresIn: 3600, scopes: ["mcp:tools"] });

    // Before any login: a connection with no credential to give fails as one needing a login, with the challenge.
    const nothingYet: McpAuth = { headers: async () => ({}), unauthorized: async () => false };
    const before = new McpClient({ name: "remote", transport: streamableHttpTransport({ url: s.mcpUrl, auth: nothingYet }), timeoutMs: 5_000 });
    clients.push(before);
    const refused = await before.connect().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(McpAuthRequiredError);
    const challenge = (refused as McpAuthRequiredError).challenge;
    expect(challenge).toContain(`resource_metadata="${s.mcpOrigin}/meta/resource"`);

    const discovery = await discoverOAuth(s.mcpUrl, { challenge });
    const client = await registerClient(discovery, { redirectUris: [REDIRECT] });
    const { url, state, verifier } = authorizationRequest(discovery, client, { redirectUri: REDIRECT });
    const redirect = await approve(url);
    expect(redirect.state).toBe(state);
    const tokens = await exchangeCode(discovery, client, { code: redirect.code, verifier, redirectUri: REDIRECT });

    const stored: unknown[] = [];
    const auth = oauthAuth({ tokens, refresh: async () => Promise.reject(new Error("not expected")), onTokens: (next) => void stored.push(next) });
    const remote = new McpClient({ name: "remote", transport: streamableHttpTransport({ url: s.mcpUrl, auth }), timeoutMs: 5_000 });
    clients.push(remote);
    expect((await remote.connect()).name).toBe("scripted");
    expect((await remote.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
    expect((await remote.callTool("echo", { text: "logged in" })).text).toBe("logged in");

    // Every request after the login carried its token: initialize, the initialized notification, the list, the call.
    const after = s.mcpRequests.filter((r) => r.method === "POST").slice(-4);
    expect(after.map((r) => r.headers.authorization)).toEqual(Array(4).fill(`Bearer ${tokens.accessToken}`));
    expect(stored).toEqual([]);
  });
});
