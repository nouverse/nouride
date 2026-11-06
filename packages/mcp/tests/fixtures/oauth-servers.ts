/**
 * An authorization server and an MCP server behind it, each on its own socket — what a login to a remote MCP server
 * crosses, and nothing faked between the client and the wire.
 *
 * The authorization server publishes its metadata where a test says (RFC 8414 path insertion, or one of OpenID
 * Connect's two forms), registers clients (RFC 7591), answers an authorization request the way a person approving it
 * would — a redirect carrying a code — and exchanges and refreshes at its token endpoint, holding each to what a real
 * one checks: the PKCE verifier against the challenge, the redirect URI, the resource, the client and its secret, a
 * code used once, a refresh token rotated. The MCP server answers 401 with a challenge until it is sent an access token
 * issued for its own resource, and then speaks MCP through the scripted server (`server.ts`) — over Streamable HTTP at
 * `/mcp` and the legacy SSE shape at `/sse`. Every request to either is recorded.
 *
 * Used by this package's tests and by the engine's login tests (`apps/engine/tests/mcp-oauth`), and run on its own for
 * an end-to-end check against a real daemon — `bun packages/mcp/tests/fixtures/oauth-servers.ts --serve <port>` prints
 * what to do with it (the bottom of this file).
 */

import { createHash, randomUUID } from "node:crypto";
import { serveHttp } from "@nouride/runtime";
import { scriptedServer } from "./server.ts";

export interface OAuthScript {
  /** Where the MCP server's resource metadata is: named in the 401's challenge (the default), only at a well-known URI, or nowhere. */
  prm?: "challenge" | "path" | "root" | "none";
  /** The `resource` its metadata declares — the MCP endpoint's own URL unless a test says; null leaves the field out. */
  prmResource?: string | null;
  /** `scopes_supported` in the resource metadata. */
  scopes?: string[];
  /** The `scope` the 401's challenge names. */
  challengeScope?: string;
  /** The issuer's path on the authorization server — none unless a test says. */
  issuerPath?: string;
  /** Which metadata document the authorization server publishes: RFC 8414's (the default), or OpenID Connect's. */
  metadata?: "oauth" | "oidc-insert" | "oidc-append";
  /** Whether it registers clients — yes unless a test says. */
  registration?: boolean;
  /** `code_challenge_methods_supported`: S256 unless a test says, null to leave it out. */
  challengeMethods?: string[] | null;
  /** `token_endpoint_auth_methods_supported`, when a test wants one listed. */
  authMethods?: string[];
  /** `expires_in` on every token issued, in seconds — none unless a test says. */
  expiresIn?: number;
  /** Answer every refresh with `invalid_grant`, as a server that revoked the login does. */
  refusesRefresh?: boolean;
  /** A client registered by hand, whose secret the token endpoint then requires. */
  manualClient?: { id: string; secret: string };
  /** Declare `tools.listChanged`, so a client opens the GET stream. */
  listChanged?: boolean;
  /** Ports to listen on — the MCP server's and the authorization server's — rather than any free one. */
  ports?: { mcp: number; authorization: number };
}

/** One request either server was sent. */
export interface Seen {
  method: string;
  /** Path and query. */
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/** Both servers, started. `stop()` when done. */
export function oauthServers(script: OAuthScript = {}) {
  const asRequests: Seen[] = [];
  const mcpRequests: Seen[] = [];
  /** Every code and token issued, in order — what a test searches the logs for. */
  const issued: string[] = [];
  let count = 0;
  const fresh = (kind: string): string => {
    const value = `${kind}_${(count += 1)}_${randomUUID()}`;
    issued.push(value);
    return value;
  };

  const clients = new Map<string, { secret?: string; redirectUris?: string[] }>();
  if (script.manualClient) clients.set(script.manualClient.id, { secret: script.manualClient.secret });
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string }>();
  const accessTokens = new Map<string, string>();
  const refreshTokens = new Map<string, { clientId: string; resource: string }>();
  let refreshes = 0;
  /** While set, a refresh is counted on arrival and answered only once it settles — `holdRefreshes()`. */
  let refreshGate: Promise<void> | undefined;

  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const push = (message: object): void => {
    for (const stream of streams) stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  };
  const core = scriptedServer({ capabilities: { tools: script.listChanged ? { listChanged: true } : {} } }, push);

  const record = async (req: Request, into: Seen[]): Promise<{ url: URL; body?: string }> => {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.text() : undefined;
    into.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers.entries()), ...(body === undefined ? {} : { body }) });
    return { url, ...(body === undefined ? {} : { body }) };
  };

  // ── the authorization server ──────────────────────────────────────────────────────────────────────────────────────
  const issuerPath = script.issuerPath ?? "";
  const authorizationServer = serveHttp({
    port: script.ports?.authorization ?? 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { url, body } = await record(req, asRequests);
      const kind = script.metadata ?? "oauth";
      const metadataAt = {
        oauth: `/.well-known/oauth-authorization-server${issuerPath}`,
        "oidc-insert": `/.well-known/openid-configuration${issuerPath}`,
        "oidc-append": `${issuerPath}/.well-known/openid-configuration`,
      }[kind];
      if (req.method === "GET" && url.pathname === metadataAt) return Response.json(metadata(issuer));
      if (req.method === "POST" && url.pathname === `${issuerPath}/register` && script.registration !== false) return register(JSON.parse(body ?? "{}"));
      if (req.method === "GET" && url.pathname === `${issuerPath}/authorize`) return authorize(url.searchParams);
      if (req.method === "POST" && url.pathname === `${issuerPath}/token`) return await token(req.headers, new URLSearchParams(body));
      return new Response("not found", { status: 404 });
    },
  });
  const issuer = `http://127.0.0.1:${authorizationServer.port}${issuerPath}`;

  function metadata(named: string): Record<string, unknown> {
    return {
      issuer: named,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      ...(script.registration === false ? {} : { registration_endpoint: `${issuer}/register` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      ...(script.challengeMethods === null ? {} : { code_challenge_methods_supported: script.challengeMethods ?? ["S256"] }),
      ...(script.authMethods ? { token_endpoint_auth_methods_supported: script.authMethods } : {}),
    };
  }

  function register(asked: Record<string, unknown>): Response {
    const clientId = `client_${(count += 1)}`;
    clients.set(clientId, { redirectUris: asked.redirect_uris as string[] });
    return Response.json({ ...asked, client_id: clientId, client_id_issued_at: 1_700_000_000 }, { status: 201 });
  }

  function authorize(params: URLSearchParams): Response {
    const clientId = params.get("client_id") ?? "";
    const client = clients.get(clientId);
    const redirectUri = params.get("redirect_uri") ?? "";
    const challenge = params.get("code_challenge");
    if (!client || params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" || !challenge) {
      return new Response("not an authorization request this server takes", { status: 400 });
    }
    if (client.redirectUris && !client.redirectUris.includes(redirectUri)) return new Response("that redirect was never registered", { status: 400 });
    const code = fresh("code");
    codes.set(code, { clientId, redirectUri, challenge, resource: params.get("resource") ?? "" });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state") ?? "");
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  async function token(headers: Headers, form: URLSearchParams): Promise<Response> {
    const refused = (error: string, status = 400): Response => Response.json({ error, error_description: `this server refused it: ${error}` }, { status });
    let clientId = form.get("client_id") ?? "";
    let secret = form.get("client_secret") ?? undefined;
    const basic = headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const [id = "", password = ""] = atob(basic.slice("Basic ".length)).split(":").map((half) => decodeURIComponent(half.replace(/\+/g, " ")));
      [clientId, secret] = [id, password];
    }
    const client = clients.get(clientId);
    if (!client || (client.secret !== undefined && client.secret !== secret)) return refused("invalid_client", 401);

    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code") ?? "";
      const grant = codes.get(code);
      codes.delete(code);
      const verified = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === grant?.challenge;
      if (!grant || !verified || grant.clientId !== clientId || grant.redirectUri !== form.get("redirect_uri") || grant.resource !== form.get("resource")) {
        return refused("invalid_grant");
      }
      return issue(clientId, grant.resource);
    }
    if (form.get("grant_type") === "refresh_token") {
      refreshes += 1;
      await refreshGate;
      const presented = form.get("refresh_token") ?? "";
      const held = refreshTokens.get(presented);
      if (script.refusesRefresh || !held || held.clientId !== clientId || held.resource !== form.get("resource")) return refused("invalid_grant");
      refreshTokens.delete(presented);
      return issue(clientId, held.resource);
    }
    return refused("unsupported_grant_type");
  }

  function issue(clientId: string, resource: string): Response {
    const accessToken = fresh("at");
    const refreshToken = fresh("rt");
    accessTokens.set(accessToken, resource);
    refreshTokens.set(refreshToken, { clientId, resource });
    return Response.json({ access_token: accessToken, token_type: "bearer", refresh_token: refreshToken, ...(script.expiresIn ? { expires_in: script.expiresIn } : {}) });
  }

  // ── the MCP server ────────────────────────────────────────────────────────────────────────────────────────────────
  const resourceServer = serveHttp({
    port: script.ports?.mcp ?? 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const { url, body } = await record(req, mcpRequests);
      // What an end-to-end run drives from outside (`--serve`): every token revoked, every refresh refused from now on.
      if (req.method === "POST" && url.pathname === "/__revoke") return (accessTokens.clear(), Response.json({ revoked: true }));
      if (req.method === "POST" && url.pathname === "/__refuse-refresh") return ((script.refusesRefresh = true), Response.json({ refusing: true }));
      if (req.method === "GET" && url.pathname === "/__state") return Response.json({ refreshes, tokens: accessTokens.size });
      const prm = script.prm ?? "challenge";
      const declared = script.prmResource === undefined ? mcpUrl : script.prmResource;
      const resourceMetadata = (): Response =>
        Response.json({
          ...(declared === null ? {} : { resource: declared }),
          authorization_servers: [issuer],
          ...(script.scopes ? { scopes_supported: script.scopes } : {}),
        });
      if (req.method === "GET") {
        if (url.pathname === "/meta/resource" && prm === "challenge") return resourceMetadata();
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp" && prm === "path") return resourceMetadata();
        if (url.pathname === "/.well-known/oauth-protected-resource" && prm === "root") return resourceMetadata();
        // A 2025-03-26 server: no resource metadata, and its own origin as its authorization server.
        if (url.pathname === "/.well-known/oauth-authorization-server" && prm === "none") return Response.json(metadata(mcpOrigin));
      }
      if (!["/mcp", "/sse", "/messages"].includes(url.pathname)) return new Response("not found", { status: 404 });

      const presented = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (accessTokens.get(presented) !== (declared ?? mcpUrl)) {
        const params = [
          'error="invalid_token"',
          ...(prm === "challenge" ? [`resource_metadata="${mcpOrigin}/meta/resource"`] : []),
          ...(script.challengeScope ? [`scope="${script.challengeScope}"`] : []),
        ];
        return new Response("a login is needed", { status: 401, headers: { "www-authenticate": `Bearer ${params.join(", ")}` } });
      }
      if (url.pathname === "/mcp" && req.method === "POST") {
        const answer = core.handle(JSON.parse(body ?? "{}"));
        return answer ? Response.json(answer) : new Response(null, { status: 202 });
      }
      if (url.pathname === "/mcp") return new Response(null, { status: req.method === "GET" ? 405 : 200 });
      if (url.pathname === "/messages" && req.method === "POST") {
        const answer = core.handle(JSON.parse(body ?? "{}"));
        if (answer) push(answer);
        return new Response(null, { status: 202 });
      }
      let opened: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.add((opened = controller));
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
        },
        cancel: () => void streams.delete(opened!),
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const mcpOrigin = `http://127.0.0.1:${resourceServer.port}`;
  const mcpUrl = `${mcpOrigin}/mcp`;

  return {
    issuer,
    mcpOrigin,
    mcpUrl,
    sseUrl: `${mcpOrigin}/sse`,
    asRequests,
    mcpRequests,
    issued,
    core,
    /** Refresh requests the token endpoint has answered, or is answering. */
    refreshes: () => refreshes,
    /**
     * Hold every refresh from now on — counted as it arrives, answered once the function returned is called — so a test
     * can have requests meet a renewal while it is still running, by what has happened rather than by how long it took.
     */
    holdRefreshes: (): (() => void) => {
      let release: () => void = () => {};
      refreshGate = new Promise<void>((resolve) => (release = resolve));
      return () => {
        refreshGate = undefined;
        release();
      };
    },
    /** Requests to the token endpoint, read as the forms they were. */
    tokenForms: () => asRequests.filter((r) => r.path === `${issuerPath}/token`).map((r) => Object.fromEntries(new URLSearchParams(r.body))),
    /** Make the MCP server refuse every token issued so far, as one that revoked them — or saw them expire — does. */
    revokeAll: () => accessTokens.clear(),
    /** Answer every refresh from now on with `invalid_grant`: the login is lost. */
    refuseRefreshes: () => void (script.refusesRefresh = true),
    /**
     * Whether `notifications/initialized` has reached the MCP server. `connect()` resolves before it has — it is sent
     * unawaited — so a test that revokes the token waits for this first, or the notification meets the revocation too.
     */
    initialized: () => mcpRequests.some((r) => r.body?.includes('"notifications/initialized"') === true),
    /** The `Authorization` each request to the MCP server carried, in order. */
    bearers: () => mcpRequests.filter((r) => ["/mcp", "/sse", "/messages"].some((path) => r.path.startsWith(path))).map((r) => r.headers.authorization),
    stop: () => {
      for (const stream of streams) {
        try {
          stream.close();
        } catch {
          // Already gone from the client's side.
        }
      }
      return Promise.all([authorizationServer.stop(true), resourceServer.stop(true)]);
    },
  };
}

/** What an MCP server answers a request with no credential: its 401's `WWW-Authenticate`, which a login starts from. */
export async function challengeOf(url: string): Promise<string | null> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (response.status !== 401) throw new Error(`expected a 401 from ${url}, and it answered ${response.status}`);
  return response.headers.get("www-authenticate");
}

/**
 * What a person's browser does with the authorization URL once they approve: follows it to the redirect, and reads
 * the code and the state off that.
 */
export async function approve(url: string): Promise<{ code: string; state: string }> {
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  if (response.status !== 302 || !location) throw new Error(`the authorization server answered ${response.status}: ${await response.text()}`);
  const back = new URL(location);
  return { code: back.searchParams.get("code") ?? "", state: back.searchParams.get("state") ?? "" };
}

/**
 * `bun packages/mcp/tests/fixtures/oauth-servers.ts --serve <port> [--expires-in <seconds>]` — both servers on this
 * machine, for logging a real daemon in end to end: the MCP server on `<port>`, its authorization server on
 * `<port + 1>`. Every login is approved at once and the browser sent straight back, so a login is the redirect alone.
 */
if (import.meta.main) {
  const at = process.argv.indexOf("--serve");
  const port = Number(process.argv[at + 1]);
  const expiresAt = process.argv.indexOf("--expires-in");
  const expiresIn = expiresAt < 0 ? undefined : Number(process.argv[expiresAt + 1]);
  if (at < 0 || !Number.isInteger(port) || port <= 0 || port > 65_534 || (expiresIn !== undefined && !(expiresIn > 0))) {
    console.error("usage: bun packages/mcp/tests/fixtures/oauth-servers.ts --serve <port> [--expires-in <seconds>]   (the authorization server takes <port + 1>)");
    process.exit(2);
  }
  const servers = oauthServers({ ports: { mcp: port, authorization: port + 1 }, ...(expiresIn ? { expiresIn } : {}) });
  console.log(
    [
      `MCP server, behind OAuth:  ${servers.mcpUrl}`,
      `authorization server:      ${servers.issuer}  (approves every login, and sends the browser straight back)`,
      "",
      "Add it to the library, with no token, on for the agents that should share it:",
      `  nouride mcp add --name fake --url ${servers.mcpUrl} --agent <id> --agent <other>`,
      "It shows as needing a login. Log it in on Configure → MCP (Connect), once for all of them, or:",
      "  nouride mcp login --server fake          (--agent <id> for an agent switched to a login of its own)",
      `  curl -s -o /dev/null -w '%{redirect_url}\\n' '<the address it prints>'   # the address to paste back`,
      "",
      `Every token revoked — the next call renews the login:  curl -X POST ${servers.mcpOrigin}/__revoke`,
      `Every refresh refused from now on — a lost login:      curl -X POST ${servers.mcpOrigin}/__refuse-refresh`,
      `Refreshes so far, and tokens alive:                     curl ${servers.mcpOrigin}/__state`,
    ].join("\n"),
  );
}
