/**
 * The install's MCP servers (0.7.19): one library, `agents/mcp.toml`, and each agent's word on it,
 * `agents/<id>/mcp.toml` — the shape skills have, for the same reasons.
 *
 * ```toml
 * # agents/mcp.toml
 * [[servers]]
 * name = "notion"
 * transport = "streamable-http"
 * url = "https://mcp.notion.com/mcp"
 *
 * # agents/nox/mcp.toml
 * [servers.notion]
 * on = true
 * login = "own"
 * ```
 *
 * A server is added once and switched on per agent, its credential the library's — one login, one secret — unless an
 * agent brings its own. **Off by default**, unlike a skill: a server is tools that act on an account and a process this
 * machine runs, which an agent gets because someone chose to give it them, never because one was added for another.
 *
 * Read here; written by the engine (`config/edit-blocks.ts`, from the dashboard and `nouride mcp`). A pack declares no
 * server of its own since 0.7.19, and 0.8.0 refuses one that does (`config.ts`).
 */

import { join, parseToml, readTextFileIfExists } from "@nouride/runtime";
import { ConfigError, createLogger, type AgentMcpChoice, type McpServerConfig } from "@nouride/shared";
import { mcpSecretName, mcpToolList, parseMcpServers } from "./config.ts";

/** `agents/mcp.toml` — the library — and, inside a pack, that agent's choices. */
export const MCP_FILE = "mcp.toml";

/** The login a library server is reached with when an agent has none of its own. Never an agent's id: `shared` is a reserved directory. */
export const SHARED_LOGIN = "shared";

export function mcpLibraryPath(agentsDir: string): string {
  return join(agentsDir, MCP_FILE);
}

export interface McpLibrary {
  servers: McpServerConfig[];
  /** Why the file could not be read: the servers are then none, and every agent loads without them. */
  error?: string;
}

const log = createLogger("persona.mcp");

let held: { path: string; text: string | null; library: McpLibrary } | undefined;

/**
 * The library, read again only when the file changed — every agent's load asks. A library that does not parse is
 * reported and read as empty: one typo there must not keep every agent from starting, as a typo in one pack keeps
 * only that one.
 */
export async function readMcpLibrary(agentsDir: string): Promise<McpLibrary> {
  const path = mcpLibraryPath(agentsDir);
  // Kept by what the file says, not when it changed: two writes in one millisecond share an mtime on Linux, and a save
  // followed at once by the agents' reload read the library from before the save (CI, 2026-10-19). The file is small;
  // reading it is cheap — parsing it again, and saying a broken one again for every agent, is what is saved.
  const text = await readTextFileIfExists(path);
  if (held?.path === path && held.text === text) return held.library;
  let library: McpLibrary;
  try {
    library = { servers: parseMcpLibrary(text?.trim() ? parseToml<Record<string, unknown>>(text) : null) };
  } catch (err) {
    library = { servers: [], error: err instanceof Error ? err.message : String(err) };
    // Once per change of the file, not once per agent that reads it.
    log.error("agents/mcp.toml does not load, so no agent has its MCP servers until it is fixed", { error: library.error });
  }
  held = { path, text, library };
  return library;
}

export function parseMcpLibrary(raw: Record<string, unknown> | null): McpServerConfig[] {
  return parseMcpServers(raw?.servers, "agents/mcp.toml", "[[servers]]").map((server) => {
    // Which tools an agent gets is that agent's to say (`agents/<id>/mcp.toml`): a list here would choose for every agent.
    const { auth: _mark, tools, ...rest } = server;
    if (tools) log.warn("agents/mcp.toml: tools is chosen per agent (in agents/<id>/mcp.toml, or nouride mcp tools) and is ignored here", { server: server.name });
    return rest;
  });
}

type Raw = Record<string, unknown>;
const isTable = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** `agents/<id>/mcp.toml`: server name → this agent's choice. Strict, as `skills.toml` is: a typo is said, not shrugged at. */
export function parseAgentMcp(raw: Raw | null, where: string): Record<string, AgentMcpChoice> {
  if (!raw || raw.servers === undefined) return {};
  if (!isTable(raw.servers)) throw new ConfigError(`${where} [servers] must be tables, one per server: [servers.<name>]`);
  const choices: Record<string, AgentMcpChoice> = {};
  for (const [name, value] of Object.entries(raw.servers)) {
    const at = `${where} [servers.${name}]`;
    if (!isTable(value)) throw new ConfigError(`${at} must be a table`);
    if (typeof value.on !== "boolean") throw new ConfigError(`${at} on must be true or false`);
    const choice: AgentMcpChoice = { on: value.on };
    if (value.env_secrets !== undefined) {
      if (!isTable(value.env_secrets)) throw new ConfigError(`${at} env_secrets must be a table of VARIABLE = "secret_name"`);
      choice.envSecrets = {};
      for (const [variable, secret] of Object.entries(value.env_secrets)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new ConfigError(`${at} env_secrets: "${variable}" is not an environment variable's name`);
        choice.envSecrets[variable] = mcpSecretName(secret, `${at} env_secrets.${variable}`);
      }
    }
    if (value.auth_secret !== undefined) choice.authSecret = mcpSecretName(value.auth_secret, `${at} auth_secret`);
    if (value.login !== undefined) {
      if (value.login !== "own") throw new ConfigError(`${at} login must be "own" (absent, the library's login is used)`);
      choice.login = "own";
    }
    if (value.tools !== undefined) choice.tools = mcpToolList(value.tools, `${at} tools`);
    choices[name] = choice;
  }
  return choices;
}

/** A TOML key as written: bare when it can be, quoted when it cannot. */
const key = (name: string) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));

/**
 * An agent's choices as the whole file. Generated, like `skills.toml` — one table per server it has a word on, sorted,
 * and nothing else to keep.
 */
export function renderAgentMcp(choices: Record<string, AgentMcpChoice>): string {
  const lines = [
    "# The install's MCP servers (agents/mcp.toml) this agent uses. A server not listed here, or listed with",
    "# on = false, is off. Its credential is the library's unless set here: env_secrets / auth_secret name",
    "# secrets, and login = \"own\" logs it in for this agent alone. tools = [\"…\"] gives it only those of the",
    "# server's tools; left out, it has all of them.",
    "#",
    "# Written by the dashboard (Configure → MCP, and the agent's External tools) and `nouride mcp`.",
  ];
  for (const [name, choice] of Object.entries(choices).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push("", `[servers.${key(name)}]`, `on = ${choice.on}`);
    if (choice.envSecrets && Object.keys(choice.envSecrets).length > 0) {
      lines.push(`env_secrets = { ${Object.entries(choice.envSecrets).map(([variable, secret]) => `${key(variable)} = ${JSON.stringify(secret)}`).join(", ")} }`);
    }
    if (choice.authSecret) lines.push(`auth_secret = ${JSON.stringify(choice.authSecret)}`);
    if (choice.login) lines.push(`login = "${choice.login}"`);
    if (choice.tools) lines.push(`tools = [${choice.tools.map((tool) => JSON.stringify(tool)).join(", ")}]`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * The servers an agent uses: each library server it switched on, with its own credential laid over the library's —
 * variable by variable — and the login it is reached with.
 *
 * A `per_agent` server takes nothing of the library's credential: only what the agent brings, and its own login.
 */
export function effectiveMcpServers(
  agentId: string,
  library: readonly McpServerConfig[],
  choices: Record<string, AgentMcpChoice>,
): McpServerConfig[] {
  const chosen: McpServerConfig[] = [];
  for (const server of library) {
    const choice = choices[server.name];
    if (!choice?.on) continue;
    const { envSecrets, authSecret, perAgent, ...rest } = server;
    const shared = perAgent !== true;
    const variables = { ...(shared ? envSecrets : {}), ...choice.envSecrets };
    const credential = choice.authSecret ?? (shared ? authSecret : undefined);
    chosen.push({
      ...rest,
      ...(perAgent ? { perAgent } : {}),
      ...(Object.keys(variables).length > 0 ? { envSecrets: variables } : {}),
      ...(credential ? { authSecret: credential } : {}),
      loginAs: choice.login === "own" || !shared ? agentId : SHARED_LOGIN,
      ...(choice.tools ? { tools: choice.tools } : {}),
    });
  }
  return chosen;
}

/** An agent's choices from its pack: its file, or none. */
export async function readAgentMcp(packDir: string, agentId: string): Promise<Record<string, AgentMcpChoice>> {
  const path = join(packDir, MCP_FILE);
  const text = await readTextFileIfExists(path);
  return parseAgentMcp(text?.trim() ? parseToml<Raw>(text) : null, `agents/${agentId}/${MCP_FILE}`);
}
