/**
 * Logging an agent's remote MCP servers in to the accounts they act as (0.7.19) — the engine's half of `@nouride/mcp`'s
 * OAuth client.
 *
 * **Detected, not configured.** A remote server with no credential of its own is tried with none; one that answers 401
 * is "needs login", its challenge kept for the discovery a login starts from. Once a person has logged it in, its tokens
 * are in the secret store and the rest is in `mcp_oauth`, and it is reached with them — renewed by themselves, each new
 * pair stored in one write before it is used. A login the server stops taking is said twice: to the operator, once, and
 * to the agent, in the error its call gets.
 *
 * **Whose login.** A library server (`agents/mcp.toml`) has one login, `shared`, for every agent that uses it; an agent
 * may have its own instead (`login = "own"` in its `mcp.toml`). The loader decides which (`McpServerConfig.loginAs`);
 * here a login is kept, found and renewed by that holder — the agent's id, or `shared`.
 *
 * **Only a person logs in.** Starting and finishing take a dashboard admin or the operator's terminal, a login started
 * by one is finished only by the same one, and an agent running the CLI is put in front of a person (`own-cli.ts`). No
 * route answers with a token, a code or a verifier, and none of them is logged.
 */

import {
  authorizationRequest,
  discoverOAuth,
  exchangeCode,
  OAuthError,
  OAuthLoginRequiredError,
  oauthAuth,
  refreshTokens,
  registerClient,
  type McpAuth,
  type OAuthClient,
  type OAuthDiscovery,
  type OAuthHttpOptions,
  type OAuthTokens,
} from "@nouride/mcp";
import type { SecretStore } from "@nouride/secrets";
import { createLogger, type McpServerConfig } from "@nouride/shared";
import { readMcpLibrary, SHARED_LOGIN } from "@nouride/persona";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { McpLoginStore } from "./logins.store.ts";
import { PendingLogins } from "./pending.ts";
import { hasOwnCredential, loginLinkFor, loginSecrets, redirectAnswer, redirectUriFor, type DashboardAddress } from "./where.ts";

const log = createLogger("mcp.login");

/** A server tried with no credential: a 401 is not retried, and says whether it wants a login. */
const NO_LOGIN: McpAuth = { headers: async () => ({}), unauthorized: async () => false };

export interface McpLoginsOptions {
  store: McpLoginStore;
  secrets: Pick<SecretStore, "resolve" | "setMany" | "deleteMany">;
  /** The packs: what each agent's servers are and whose login each uses — and a reload, once a login changed. */
  registry: {
    get(id: string): { config: { mcpServers: McpServerConfig[] } } | undefined;
    all(): { config: { id: string; mcpServers: McpServerConfig[] } }[];
    reload(id: string): Promise<unknown>;
  };
  /** `agents/`, for the library's own servers — the shared login of one no agent has switched on yet. */
  agentsDir: string;
  dashboard: DashboardAddress;
  audit?: AuditPort;
  notifier?: { alert(key: string, text: string): Promise<boolean> };
  /** The global `fetch` unless a test hands its own. */
  fetch?: OAuthHttpOptions["fetch"];
  now?: () => number;
}

/** What the MCP page shows about a server's login. Never a token. */
export interface McpLoginView {
  scope: string | null;
  loggedInBy: string;
  loggedInAt: number;
  expiresAt: number | null;
}

export type LoginOutcome<T> = T | { error: string; status: 400 | 404 };

export class McpLogins {
  private readonly pending: PendingLogins;
  /** Logins waiting for a person, by holder and server, with the challenge of the 401 that said so. */
  private readonly waitingFor = new Map<string, { holder: string; server: string; challenge: string | null }>();
  private readonly now: () => number;

  constructor(private readonly options: McpLoginsOptions) {
    this.now = options.now ?? Date.now;
    this.pending = new PendingLogins(this.now);
  }

  /** Whose login an agent's server is reached with: the library's, or the agent's own. */
  holderOf(agentId: string, server: string): string {
    return this.options.registry.get(agentId)?.config.mcpServers.find((entry) => entry.name === server)?.loginAs ?? agentId;
  }

  /**
   * The credential a server is reached with: none from here for a stdio server or one with its own; its login, for a
   * server logged in to; and for any other remote one, no credential — so a 401 says it wants one.
   */
  credentialFor(agentId: string, config: McpServerConfig): McpAuth | undefined {
    if (config.transport === "stdio" || hasOwnCredential(config)) return undefined;
    return this.stored(config.loginAs ?? agentId, config.name) ?? NO_LOGIN;
  }

  /**
   * The server refused an agent for want of a login — at connect, or a call: its login waits for a person now. Said
   * to the operator when a login it had stopped working; what the agent whose call it was is told is returned.
   */
  refused(agentId: string, server: string, challenge: string | null): string {
    const holder = this.holderOf(agentId, server);
    const key = keyOf(holder, server);
    const before = this.waitingFor.get(key);
    this.waitingFor.set(key, { holder, server, challenge: challenge ?? before?.challenge ?? null });
    const hadLogin = this.options.store.get(holder, server) !== undefined;
    const whose = holder === SHARED_LOGIN ? "the library's" : `${holder}'s`;
    if (!before && hadLogin) {
      log.warn("an MCP server's login stopped working: it needs a person to log in again", { holder, server });
      void this.options.notifier
        ?.alert(`mcp_login:${holder}:${server}`, `The MCP server "${server}" (${whose} login) needs logging in again: its login stopped working. Log in at ${this.link(holder, server)}.`)
        .catch(() => {});
    }
    return `The MCP server "${server}" needs a person to log in${hadLogin ? " again" : ""} before its tools work: ${this.link(holder, server)}. Tell them, since you cannot log in for them.`;
  }

  /** The server took an agent's credential: its login waits for nobody. */
  accepted(agentId: string, server: string): void {
    this.waitingFor.delete(keyOf(this.holderOf(agentId, server), server));
  }

  /** Agents' servers waiting for a person to log in: every agent a waiting login reaches. */
  waiting(): { agentId: string; server: string }[] {
    return [...this.waitingFor.values()].flatMap(({ holder, server }) => this.usersOf(holder, server).map((agentId) => ({ agentId, server })));
  }

  /** Whether this holder's login of a server waits for a person. */
  isWaiting(holder: string, server: string): boolean {
    return this.waitingFor.has(keyOf(holder, server));
  }

  view(holder: string, server: string): McpLoginView | undefined {
    const login = this.options.store.get(holder, server);
    return login ? { scope: login.scope, loggedInBy: login.loggedInBy, loggedInAt: login.loggedInAt, expiresAt: login.expiresAt } : undefined;
  }

  /** Where a person logs this login in. */
  link(holder: string, server: string): string {
    return loginLinkFor(this.options.dashboard, holder, server);
  }

  /**
   * A login started by `by`: the authorization server found from the 401's challenge, a client registered (or the one
   * given), and the address the person opens. The verifier and the rest wait here for the redirect.
   */
  async start(input: { holder: string; server: string; by: string; clientId?: string; clientSecret?: string }): Promise<LoginOutcome<{ url: string }>> {
    const config = await this.serverFor(input.holder, input.server);
    const whose = input.holder === SHARED_LOGIN ? "in the library" : `on ${input.holder}`;
    if (!config) return { error: `no MCP server "${input.server}" ${whose}`, status: 404 };
    if (config.transport === "stdio" || !config.url) return { error: `"${input.server}" runs on this machine: a stdio server's credential is env_secrets, not a login`, status: 400 };
    if (hasOwnCredential(config)) return { error: `"${input.server}" has a credential of its own (auth_secret, or an Authorization header). Take it off to log in instead`, status: 400 };
    if (!loginSecrets(input.holder, input.server)) return { error: `the names "${input.server}"'s login would be kept under are too long. Give the server a shorter name`, status: 400 };
    const http = this.http();
    const redirectUri = redirectUriFor(this.options.dashboard);
    try {
      const discovery = await discoverOAuth(config.url, { challenge: this.waitingFor.get(keyOf(input.holder, input.server))?.challenge ?? null, ...http });
      const given = input.clientId?.trim() ? { clientId: input.clientId.trim(), ...(input.clientSecret?.trim() ? { clientSecret: input.clientSecret.trim() } : {}) } : {};
      const client = await registerClient(discovery, { redirectUris: [redirectUri], ...given, ...http });
      const request = authorizationRequest(discovery, client, { redirectUri });
      this.pending.add({ state: request.state, verifier: request.verifier, redirectUri, discovery, client, holder: input.holder, server: input.server, startedBy: input.by });
      log.info("an MCP server's login started", { holder: input.holder, server: input.server, issuer: discovery.issuer });
      return { url: request.url };
    } catch (err) {
      if (err instanceof OAuthError) return { error: err.message, status: 400 };
      throw err;
    }
  }

  /**
   * A login finished: the code exchanged, the tokens stored — the pair in one write — and every agent that uses this
   * login reloaded so it connects with them. Only for the person who started it.
   */
  async finish(input: { code?: unknown; state?: unknown; url?: unknown }, by: string, actor: string): Promise<LoginOutcome<{ ok: true; holder: string; server: string; scope?: string }>> {
    const answer = redirectAnswer(input);
    if ("error" in answer) {
      if (answer.state) this.pending.take(answer.state, by);
      return { error: answer.error, status: 400 };
    }
    const login = this.pending.take(answer.state, by);
    if (!login) return { error: "no login is waiting for that: it was finished already, waited more than ten minutes, or was started by somebody else. Start it again", status: 400 };
    let tokens: OAuthTokens;
    try {
      tokens = await exchangeCode(login.discovery, login.client, { code: answer.code, verifier: login.verifier, redirectUri: login.redirectUri, now: this.now, ...this.http() });
    } catch (err) {
      if (err instanceof OAuthError) return { error: err.message, status: 400 };
      throw err;
    }
    await this.keep(login.holder, login.server, tokens, login.client, actor, login.discovery);
    this.waitingFor.delete(keyOf(login.holder, login.server));
    await this.reloadUsers(login.holder, login.server);
    this.options.audit?.record({ action: "mcp_server_logged_in", actor, details: { holder: login.holder, server: login.server } });
    return { ok: true, holder: login.holder, server: login.server, ...(tokens.scope ? { scope: tokens.scope } : {}) };
  }

  /** Logged out: its tokens and the rest gone, and the agents that used it reloaded without them. */
  async logout(holder: string, server: string, actor: string): Promise<LoginOutcome<{ ok: true }>> {
    if (!(await this.serverFor(holder, server))) return { error: `no MCP server "${server}" ${holder === SHARED_LOGIN ? "in the library" : `on ${holder}`}`, status: 404 };
    await this.drop(holder, server);
    await this.reloadUsers(holder, server);
    this.options.audit?.record({ action: "mcp_server_logged_out", actor, details: { holder, server } });
    return { ok: true };
  }

  /** A server taken away: its login goes with it, so no token is left behind for nothing. */
  async forget(holder: string, server: string): Promise<void> {
    await this.drop(holder, server);
  }

  /** The tokens of a login, and the client it was made as: secrets in the store, the rest in the table. */
  private async keep(holder: string, server: string, tokens: OAuthTokens, client: OAuthClient, actor: string, discovery: OAuthDiscovery): Promise<void> {
    const names = loginSecrets(holder, server)!;
    await this.options.secrets.setMany({
      [names.access]: tokens.accessToken,
      ...(tokens.refreshToken ? { [names.refresh]: tokens.refreshToken } : {}),
      ...(client.clientSecret ? { [names.client]: client.clientSecret } : {}),
    });
    // What an earlier login kept and this one has none of goes, so it is never sent for this one.
    await this.options.secrets.deleteMany([...(tokens.refreshToken ? [] : [names.refresh]), ...(client.clientSecret ? [] : [names.client])]);
    this.options.store.put({
      agentId: holder,
      server,
      discovery,
      clientId: client.clientId,
      tokenMethod: client.tokenEndpointAuthMethod ?? null,
      expiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? null,
      loggedInBy: actor,
      loggedInAt: this.now(),
    });
    log.info("an MCP server is logged in", { holder, server, by: actor });
  }

  private async drop(holder: string, server: string): Promise<void> {
    const names = loginSecrets(holder, server);
    if (names) await this.options.secrets.deleteMany([names.access, names.refresh, names.client]);
    this.options.store.remove(holder, server);
    this.waitingFor.delete(keyOf(holder, server));
  }

  /**
   * The credential of a stored login: its tokens, renewed by themselves and each new pair written back in one write
   * before it is used. A renewal the server refuses makes the server wait for a person, and says so.
   */
  private stored(holder: string, server: string): McpAuth | undefined {
    const login = this.options.store.get(holder, server);
    const names = loginSecrets(holder, server);
    const accessToken = names ? this.options.secrets.resolve(names.access) : undefined;
    if (!login || !names || !accessToken) return undefined;
    const refreshToken = this.options.secrets.resolve(names.refresh);
    const clientSecret = this.options.secrets.resolve(names.client);
    const client: OAuthClient = { clientId: login.clientId, ...(clientSecret ? { clientSecret } : {}), ...(login.tokenMethod ? { tokenEndpointAuthMethod: login.tokenMethod } : {}) };
    const http = this.http();
    return oauthAuth({
      tokens: {
        accessToken,
        tokenType: "Bearer",
        ...(login.expiresAt === null ? {} : { expiresAt: login.expiresAt }),
        ...(refreshToken ? { refreshToken } : {}),
        ...(login.scope ? { scope: login.scope } : {}),
      },
      now: this.now,
      refresh: async (current) => {
        try {
          return await refreshTokens(login.discovery, client, current, { now: this.now, ...http });
        } catch (err) {
          if (err instanceof OAuthLoginRequiredError) this.refused(holder, server, null);
          throw err;
        }
      },
      onTokens: async (next) => {
        await this.options.secrets.setMany({ [names.access]: next.accessToken, ...(next.refreshToken ? { [names.refresh]: next.refreshToken } : {}) });
        this.options.store.renewed(holder, server, next.expiresAt ?? null, next.scope ?? null);
      },
    });
  }

  /** The agents reached with this holder's login of a server. */
  private usersOf(holder: string, server: string): string[] {
    return this.options.registry
      .all()
      .filter((agent) => agent.config.mcpServers.some((entry) => entry.name === server && (entry.loginAs ?? agent.config.id) === holder))
      .map((agent) => agent.config.id);
  }

  /** The server a holder logs in to: an agent's own, or the library's — which no agent may have switched on yet. */
  private async serverFor(holder: string, server: string): Promise<McpServerConfig | undefined> {
    if (holder !== SHARED_LOGIN) return this.options.registry.get(holder)?.config.mcpServers.find((entry) => entry.name === server && entry.loginAs === holder);
    return (await readMcpLibrary(this.options.agentsDir)).servers.find((entry) => entry.name === server);
  }

  /** Reconnect every agent this login reaches, with it or without it. */
  private async reloadUsers(holder: string, server: string): Promise<void> {
    for (const id of this.usersOf(holder, server)) await this.options.registry.reload(id);
  }

  private http(): OAuthHttpOptions {
    return this.options.fetch ? { fetch: this.options.fetch } : {};
  }
}

function keyOf(agentId: string, server: string): string {
  return `${agentId}\u0000${server}`;
}
