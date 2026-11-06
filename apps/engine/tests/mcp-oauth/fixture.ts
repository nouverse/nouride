/**
 * The install's MCP library with one remote server, behind the fake authorization server `@nouride/mcp`'s tests run
 * against (`packages/mcp/tests/fixtures/oauth-servers.ts`), two agents that may use it, and the login service over
 * them — a real secret store, a migrated database, a registry that reads the packs again on every reload (as the
 * loader does: library, then each agent's switches), and a notifier that keeps what it is asked to say.
 *
 * By default `nouva` uses the server with the library's login; `own` gives it a login of its own, `nix` uses it too.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import { effectiveMcpServers, readAgentMcp, readMcpLibrary, SHARED_LOGIN } from "@nouride/persona";
import type { AgentMcpChoice, McpServerConfig } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { McpLogins, type McpLoginsOptions } from "@/modules/mcp-oauth/index.ts";
import { McpLoginStore } from "@/modules/mcp-oauth/logins.store.ts";
import { oauthServers, type OAuthScript } from "../../../../packages/mcp/tests/fixtures/oauth-servers.ts";
import { tempDir } from "../helpers.ts";

export { approve, challengeOf } from "../../../../packages/mcp/tests/fixtures/oauth-servers.ts";

/** The library's server block, for the fake MCP server at `url`, with whatever else a test writes into it. */
export const serverBlock = (url: string, extra: string[] = []): string =>
  ["[[servers]]", 'name = "fake"', 'transport = "streamable-http"', `url = "${url}"`, ...extra, ""].join("\n");

type Agent = { config: { id: string; mcp?: Record<string, AgentMcpChoice>; mcpServers: McpServerConfig[] } };

export interface LoginBench {
  servers: ReturnType<typeof oauthServers>;
  logins: McpLogins;
  /** The packs as a registry has them: what the control routes and the logins both read. */
  registry: { get(id: string): (Agent & { dir: string }) | undefined; all(): Agent[]; reload(id: string): Promise<unknown> };
  store: McpLoginStore;
  secrets: SecretStore;
  dir: string;
  agentsDir: string;
  db: SqliteDb;
  alerts: { key: string; text: string }[];
  /** Reloads so far, of every agent. */
  reloads: () => number;
  /** Whose login nouva's server is reached with: `shared`, or `nouva`. */
  holder: string;
  /** The server as nouva uses it now. */
  server: () => McpServerConfig;
  close: () => Promise<void>;
}

export async function loginBench(
  script: OAuthScript = {},
  options: {
    extra?: string[];
    /** nouva logs in on its own, rather than with the library's login. */
    own?: boolean;
    /** nix uses the server too. */
    nix?: boolean;
    secrets?: (real: SecretStore) => McpLoginsOptions["secrets"];
    fetch?: McpLoginsOptions["fetch"];
    now?: () => number;
    publicUrl?: string;
  } = {},
): Promise<LoginBench> {
  const servers = oauthServers(script);
  const dir = tempDir("mcp-login");
  const agentsDir = join(dir, "agents");
  const db = await openAndMigrate(join(dir, "t.db"));
  const secrets = await SecretStore.open(dir, {});
  writeFileSync(join(dir, "config.toml"), "");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, "mcp.toml"), serverBlock(servers.mcpUrl, options.extra));
  const ids = ["nouva", ...(options.nix ? ["nix"] : [])];
  for (const id of ids) {
    mkdirSync(join(agentsDir, id), { recursive: true });
    writeFileSync(join(agentsDir, id, "mcp.toml"), ["[servers.fake]", "on = true", ...(id === "nouva" && options.own ? ['login = "own"'] : []), ""].join("\n"));
  }
  const load = async (id: string) => {
    const library = await readMcpLibrary(agentsDir);
    const mcp = await readAgentMcp(join(agentsDir, id), id);
    return { dir: join(agentsDir, id), config: { id, mcp, mcpServers: effectiveMcpServers(id, library.servers, mcp) } };
  };
  const agents = new Map<string, Agent & { dir: string }>();
  for (const id of ids) agents.set(id, await load(id));
  let reloads = 0;
  const alerts: { key: string; text: string }[] = [];
  const store = new McpLoginStore(db);
  const registry = {
    get: (id: string) => agents.get(id),
    all: () => [...agents.values()],
    reload: async (id: string) => {
      reloads += 1;
      agents.set(id, await load(id));
    },
  };
  const logins = new McpLogins({
    store,
    secrets: options.secrets ? options.secrets(secrets) : secrets,
    registry,
    agentsDir,
    dashboard: { publicUrl: options.publicUrl ?? "", port: 18254 },
    notifier: { alert: async (key, text) => (alerts.push({ key, text }), true) },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    servers,
    logins,
    registry,
    store,
    secrets,
    dir,
    agentsDir,
    db,
    alerts,
    reloads: () => reloads,
    holder: options.own ? "nouva" : SHARED_LOGIN,
    server: () => agents.get("nouva")!.config.mcpServers[0]!,
    close: async () => {
      await servers.stop();
      db.close();
      removePath(dir);
    },
  };
}
