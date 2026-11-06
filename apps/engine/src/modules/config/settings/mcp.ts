/**
 * The install's MCP servers (0.7.19): the library, `agents/mcp.toml`, and each agent's word on it,
 * `agents/<id>/mcp.toml` (`@nouride/persona`'s `mcp-library.ts` reads both).
 *
 * A server is saved once, into the library; an agent uses it when switched on. Its credential is the library's — a
 * secret named `mcp-lib-<server>`, one login — unless an agent brings its own, kept under `mcp-<agent>-<server>`. The
 * secrets' values never reach a file: the files name them, the store holds them, as everywhere (invariant 3).
 *
 * Every write reloads the agents it reaches, and a reloaded pack reconnects its servers — live, nothing restarted.
 */

import { assertSecretName } from "@nouride/secrets";
import { join, parseToml } from "@nouride/runtime";
import { MCP_FILE, mcpLibraryPath, parseAgentMcp, parseMcpLibrary, readMcpLibrary, renderAgentMcp } from "@nouride/persona";
import { createLogger, type AgentMcpChoice, type McpServerConfig } from "@nouride/shared";
import { editPackFile } from "@/modules/config/config-file.ts";
import { removeMcpServer as removeFromToml, upsertMcpServer, type McpServerEdit } from "@/modules/config/edit-blocks.ts";
import { NAME_PATTERN, type SaveResult, type SettingsDeps } from "./types.ts";

const log = createLogger("config.mcp");

/** The packs, as far as an MCP write needs them: where each is, what it uses, and how to reload it. */
export interface McpPacks {
  agentsDir: string;
  agents(): { id: string; dir: string; mcp: Record<string, AgentMcpChoice> }[];
  reload(id: string): Promise<unknown>;
}

/** A credential sent with a save: a value to keep in the store (the dashboard), or a secret already there to name (the CLI). */
export interface SecretInput {
  value?: string;
  secret?: string;
}

/** The secrets a library server's credential is kept under — not any agent's. */
const librarySecret = (server: string) => `mcp-lib-${server}`;
/** An agent's own credential for a library server. */
const agentSecret = (agentId: string, server: string) => `mcp-${agentId}-${server}`;

const users = (packs: McpPacks, server: string) => packs.agents().filter((agent) => agent.mcp[server]?.on);

async function reloadAll(packs: McpPacks, ids: readonly string[]): Promise<void> {
  for (const id of ids) await packs.reload(id);
}

/** A server's shape refused before anything is written: a pack that loads and then cannot start one fails far from the cause. */
function shapeProblem(server: McpServerEdit): string | null {
  if (!NAME_PATTERN.test(server.name)) return "name may contain only letters, digits, - and _";
  if (server.transport === "stdio" && !server.command?.trim()) return "a stdio server needs a command";
  if (server.transport === "stdio") return null;
  if (!server.url?.trim()) return `transport "${server.transport}" needs a url`;
  let parsed: URL;
  try {
    parsed = new URL(server.url.trim());
  } catch {
    return `"${server.url}" is not a valid URL`;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : `transport "${server.transport}" needs an http or https url`;
}

// ── The library ────────────────────────────────────────────────────────────

/**
 * Add a server to the library, or change the one of that name — and switch it on for `enable`, the agents a person
 * picked while adding it. The keys the form owns are written; a comment or a key written by hand stays.
 *
 * `token` and `envSecrets` are the library's credential: stored under its own names, the file given only those names.
 * Omitted on an update means "keep what is stored", so changing a URL does not need the key pasted again.
 */
export async function saveLibraryServer(deps: SettingsDeps, input: {
  packs: McpPacks;
  actor: string;
  server: McpServerEdit;
  token?: string;
  envSecrets?: Record<string, SecretInput>;
  enable?: readonly string[];
}): Promise<SaveResult & { on?: string[] }> {
  const server = { ...input.server, name: input.server.name.trim() };
  const problem = shapeProblem(server);
  if (problem) return { ok: false, error: problem };
  const unknown = (input.enable ?? []).filter((id) => !input.packs.agents().some((agent) => agent.id === id));
  if (unknown.length > 0) return { ok: false, error: `no agent ${unknown.map((id) => `"${id}"`).join(", ")}` };

  const current = (await readMcpLibrary(input.packs.agentsDir)).servers.find((entry) => entry.name === server.name);
  const credential = await settleCredential(deps, {
    prefix: librarySecret(server.name),
    remote: server.transport !== "stdio",
    ...(input.token ? { token: input.token } : {}),
    ...(input.envSecrets ? { envSecrets: input.envSecrets } : {}),
    current,
  });
  if ("error" in credential) return { ok: false, error: credential.error };

  const reached = users(input.packs, server.name).map((agent) => agent.id);
  const saved = await editPackFile({
    path: mcpLibraryPath(input.packs.agentsDir),
    reload: () => reloadAll(input.packs, reached),
    edit: (text) => {
      const next = upsertMcpServer(text, { ...server, ...credential.fields });
      // The loader's own reading, so nothing is written that the agents would then refuse.
      parseMcpLibrary(parseToml<Record<string, unknown>>(next));
      return next;
    },
  });
  if (!saved.ok) {
    await credential.undo();
    return saved;
  }

  for (const id of input.enable ?? []) {
    const switched = await setAgentMcp(deps, { packs: input.packs, agentId: id, actor: input.actor, name: server.name, on: true });
    if (!switched.ok) return switched;
  }
  log.info("mcp server saved to the library", { server: server.name, enabled: input.enable ?? [], actor: input.actor });
  deps.audit?.record({ action: "mcp_server_configured", actor: input.actor, details: { server: server.name, enabled: input.enable ?? [] } });
  // Who uses it now — those picked and those that already had it — so a change to a server says it is still on for them.
  return { ok: true, restartRequired: false, on: users(input.packs, server.name).map((agent) => agent.id) };
}

/**
 * Take a server out of the library, and out of every agent that used it: their processes stop in the reloads this ends
 * with. Answers who used it, so the caller can forget their logins too.
 */
export async function removeLibraryServer(deps: SettingsDeps, input: {
  packs: McpPacks;
  actor: string;
  name: string;
}): Promise<SaveResult & { users?: string[] }> {
  const holders = input.packs.agents().filter((agent) => agent.mcp[input.name] !== undefined);
  const saved = await editPackFile({
    path: mcpLibraryPath(input.packs.agentsDir),
    reload: async () => {},
    edit: (text) => {
      const next = removeFromToml(text, input.name);
      return next === text ? { refused: `no MCP server "${input.name}" in the library` } : next;
    },
  });
  if (!saved.ok) return saved;
  for (const agent of holders) {
    await writeChoices(agent.dir, () => input.packs.reload(agent.id), (there) => {
      const { [input.name]: _gone, ...rest } = there;
      return rest;
    });
  }
  log.info("mcp server removed from the library", { server: input.name, actor: input.actor });
  deps.audit?.record({ action: "mcp_server_removed", actor: input.actor, details: { server: input.name } });
  return { ok: true, restartRequired: false, users: holders.map((agent) => agent.id) };
}

// ── One agent's word on it ─────────────────────────────────────────────────

/**
 * Switch a library server on or off for one agent, or change the credential it uses there.
 *
 * `credential`: `"library"` drops this agent's own and uses the library's; an object is its own — a token, variables,
 * or `login: true` to log it in for this agent alone. Absent leaves what the agent has.
 *
 * `tools` (0.7.21): the server's tools this agent gets, by the server's names; `null` gives it all of them again.
 * Absent leaves the choice as it is. Names are not checked against the server here — it may not be connected — but
 * when it connects, and a name it does not offer is said in the log and by `nouride doctor`.
 */
export async function setAgentMcp(deps: SettingsDeps, input: {
  packs: McpPacks;
  agentId: string;
  actor: string;
  name: string;
  on?: boolean;
  credential?: "library" | { token?: string; envSecrets?: Record<string, SecretInput>; login?: boolean };
  tools?: readonly string[] | null;
}): Promise<SaveResult> {
  const agent = input.packs.agents().find((entry) => entry.id === input.agentId);
  if (!agent) return { ok: false, error: `no agent "${input.agentId}"` };
  const server = (await readMcpLibrary(input.packs.agentsDir)).servers.find((entry) => entry.name === input.name);
  if (!server) return { ok: false, error: `no MCP server "${input.name}" in the library: add it there first` };

  const before = agent.mcp[input.name];
  const next: AgentMcpChoice = { on: input.on ?? before?.on ?? false, ...ownCredential(before) };
  if (input.tools === null) delete next.tools;
  else if (input.tools !== undefined) {
    const names = [...new Set(input.tools.map((name) => name.trim()))];
    if (names.some((name) => !name)) return { ok: false, error: "a tool's name may not be empty" };
    next.tools = names;
  }
  let undo = async () => {};
  if (input.credential === "library") {
    delete next.envSecrets;
    delete next.authSecret;
    delete next.login;
  } else if (input.credential) {
    const remote = server.transport !== "stdio";
    if (input.credential.login && !remote) return { ok: false, error: "a stdio server has no login: give it its own variables instead" };
    const settled = await settleCredential(deps, {
      prefix: agentSecret(input.agentId, input.name),
      remote,
      ...(input.credential.token ? { token: input.credential.token } : {}),
      ...(input.credential.envSecrets ? { envSecrets: input.credential.envSecrets } : {}),
      // This agent's own, never the library's: a kept variable keeps the secret it named before.
      current: { ...(before?.envSecrets ? { envSecrets: before.envSecrets } : {}), ...(before?.authSecret ? { authSecret: before.authSecret } : {}) },
    });
    if ("error" in settled) return { ok: false, error: settled.error };
    undo = settled.undo;
    if (settled.fields.envSecrets !== undefined) next.envSecrets = settled.fields.envSecrets;
    if (settled.fields.authSecret !== undefined) next.authSecret = settled.fields.authSecret;
    if (input.credential.login !== undefined) {
      if (input.credential.login) next.login = "own";
      else delete next.login;
    }
  }

  const saved = await writeChoices(agent.dir, () => input.packs.reload(input.agentId), (there) => ({ ...there, [input.name]: next }));
  if (!saved.ok) {
    await undo();
    return saved;
  }
  const tools = next.tools ? { tools: next.tools } : {};
  log.info("an agent's MCP server changed", { agent: input.agentId, server: input.name, on: next.on, ...tools, actor: input.actor });
  deps.audit?.record({ action: "mcp_server_switched", actor: input.actor, details: { agent: input.agentId, server: input.name, on: next.on, own: Boolean(next.envSecrets || next.authSecret || next.login), ...tools } });
  return { ok: true, restartRequired: false };
}

/** What the agent's switch holds besides `on` — its own credential, and its `tools` list. */
function ownCredential(choice: AgentMcpChoice | undefined): Omit<AgentMcpChoice, "on"> {
  if (!choice) return {};
  const { on: _on, ...rest } = choice;
  return rest;
}

/**
 * An agent's `mcp.toml`, rewritten whole, the agent reloaded — put back when it no longer loads. The change is applied
 * to what the file holds when the write lands, so two tabs switching two servers keep both.
 */
async function writeChoices(
  packDir: string,
  reload: () => Promise<unknown>,
  change: (there: Record<string, AgentMcpChoice>) => Record<string, AgentMcpChoice>,
): Promise<SaveResult> {
  const path = join(packDir, MCP_FILE);
  const saved = await editPackFile({
    path,
    reload,
    // Generated whole and holding no prose, like `skills.toml`.
    backup: false,
    edit: (text) => renderAgentMcp(change(parseAgentMcp(text.trim() ? parseToml<Record<string, unknown>>(text) : null, path))),
  });
  return saved.ok ? { ok: true, restartRequired: false } : saved;
}

// ── Credentials ────────────────────────────────────────────────────────────

/**
 * A credential sent with a save, as the names the file gets: a remote server's token kept under `prefix`, a stdio
 * server's variables each under `<prefix>-<variable>` — or a secret already in the store, named. Undone when the write
 * is refused, so a refused save never replaces a credential that works.
 */
async function settleCredential(
  deps: Pick<SettingsDeps, "secrets">,
  input: { prefix: string; remote: boolean; token?: string; envSecrets?: Record<string, SecretInput>; current: Pick<McpServerConfig, "envSecrets" | "authSecret"> | undefined },
): Promise<{ fields: { authSecret?: string; envSecrets?: Record<string, string> }; undo: () => Promise<void> } | { error: string }> {
  const undos: (() => Promise<void>)[] = [];
  const undo = async () => {
    for (const step of undos.reverse()) await step();
  };
  const fields: { authSecret?: string; envSecrets?: Record<string, string> } = {};
  const token = input.token?.trim();
  if (token) {
    if (!input.remote) return { error: "a stdio server takes its credential in variables, not a token" };
    try {
      assertSecretName(input.prefix, "an MCP server's credential");
    } catch {
      return { error: "the secret's name would be too long: shorten the server's name" };
    }
    undos.push(await storeUndoably(deps, input.prefix, token));
    fields.authSecret = input.prefix;
  } else if (input.current?.authSecret) {
    fields.authSecret = input.current.authSecret;
  }
  if (input.envSecrets) {
    if (input.remote) return { error: "a remote server's credential is a token; variables are for a stdio server" };
    const table: Record<string, string> = {};
    for (const [variable, wanted] of Object.entries(input.envSecrets)) {
      const fail = async (error: string) => (await undo(), { error });
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) return await fail(`"${variable}" is not an environment variable's name`);
      const value = wanted.value?.trim();
      if (value) {
        const name = `${input.prefix}-${variable.toLowerCase()}`;
        if (name.length > 63) return await fail(`${variable}: the secret's name would be too long; shorten the server's name`);
        undos.push(await storeUndoably(deps, name, value));
        table[variable] = name;
        continue;
      }
      const named = wanted.secret?.trim() ?? input.current?.envSecrets?.[variable];
      if (!named) return await fail(`${variable} has no value: give it one, or take it off`);
      try {
        assertSecretName(named, variable);
      } catch (err) {
        return await fail(err instanceof Error ? err.message : String(err));
      }
      if (deps.secrets.resolve(named) === undefined) return await fail(`${variable} names the secret "${named}", which is not set (nouride secret set ${named})`);
      table[variable] = named;
    }
    fields.envSecrets = table;
  }
  return { fields, undo };
}

/**
 * Store a secret, and return how to put back what the store held before — for a save that may yet be refused. A value
 * the environment overrides was never the store's to read back, and is left as the set made it.
 */
async function storeUndoably(deps: Pick<SettingsDeps, "secrets">, name: string, value: string): Promise<() => Promise<void>> {
  const origin = deps.secrets.origin(name);
  const before = origin === "store" ? deps.secrets.resolve(name) : undefined;
  await deps.secrets.set(name, value);
  return async () => {
    if (before !== undefined) await deps.secrets.set(name, before);
    else if (origin === null) await deps.secrets.delete(name);
  };
}
