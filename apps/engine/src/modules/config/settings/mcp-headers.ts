/**
 * One header of an MCP server, set or taken off, the rest of it as it was — the server's other keys, and every agent's
 * switch on it. `rm` then `add` was the only way to change a header before, and it lost which agents had the server on.
 *
 * On the library's server (`agents/mcp.toml`) a header is a literal (`headers`) or a stored secret's name
 * (`header_secrets`); on one agent's switch (`agents/<id>/mcp.toml`), only a secret: the agent's own credential over
 * the library's, as its `auth_secret` is. A literal is the server's, the same for every agent on it.
 */

import { parseToml } from "@nouride/runtime";
import { mcpLibraryPath, parseMcpLibrary, readMcpLibrary } from "@nouride/persona";
import { createLogger, type McpServerConfig } from "@nouride/shared";
import { editPackFile } from "@/modules/config/config-file.ts";
import { upsertMcpServer, type McpServerEdit } from "@/modules/config/edit-blocks.ts";
import { reloadAll, users, writeChoices, type McpField, type McpPacks } from "./mcp.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("config.mcp");

/** A header's name as HTTP takes one. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export interface HeaderChange {
  packs: McpPacks;
  actor: string;
  server: string;
  header: string;
  /** Absent with `secret` too: the header taken off. */
  value?: string;
  /** A stored secret's name: sent as the secret holds it. */
  secret?: string;
  /** One agent's own, on its switch: a secret only. Absent: the library's server, for every agent on it. */
  agentId?: string;
}

/** Set one header of a server, or take it off where neither `value` nor `secret` is given. */
export async function changeServerHeader(deps: Pick<SettingsDeps, "secrets" | "audit">, change: HeaderChange): Promise<SaveResult<McpField>> {
  const header = change.header.trim();
  if (!HEADER_NAME.test(header)) return { ok: false, field: "name", error: `"${change.header}" is not a header's name` };
  if (change.value !== undefined && change.secret !== undefined) return { ok: false, field: "token", error: "a header is a value or a secret's name, not both" };
  if (change.secret !== undefined && !deps.secrets.inventory().some((entry) => entry.name === change.secret)) {
    return { ok: false, field: "token", error: `no secret "${change.secret}": store it first (nouride secrets set ${change.secret})` };
  }
  const server = (await readMcpLibrary(change.packs.agentsDir)).servers.find((entry) => entry.name === change.server);
  if (!server) return { ok: false, field: "name", error: `no MCP server "${change.server}" in the library` };
  if (server.transport === "stdio") return { ok: false, field: "name", error: `"${change.server}" is a stdio server, which has no headers: its credential is a variable (--env)` };

  const saved = change.agentId ? await agentHeader(change, header) : await libraryHeader(change, server, header);
  if (!saved.ok) return saved;
  const what = change.secret !== undefined ? "secret" : change.value !== undefined ? "value" : "removed";
  log.info("an MCP server's header changed", { server: change.server, header, what, ...(change.agentId ? { agent: change.agentId } : {}), actor: change.actor });
  deps.audit?.record({ action: "mcp_server_configured", actor: change.actor, details: { server: change.server, header, what, ...(change.agentId ? { agent: change.agentId } : {}) } });
  return { ok: true, restartRequired: false };
}

/** The library's server: its headers as they are, this one (in any case) replaced or gone, the rest of it kept. */
async function libraryHeader(change: HeaderChange, server: McpServerConfig, header: string): Promise<SaveResult<McpField>> {
  const without = (table: Record<string, string> | undefined) => Object.fromEntries(Object.entries(table ?? {}).filter(([name]) => name.toLowerCase() !== header.toLowerCase()));
  const headers = { ...without(server.headers), ...(change.value !== undefined ? { [header]: change.value } : {}) };
  const headerSecrets = { ...without(server.headerSecrets), ...(change.secret !== undefined ? { [header]: change.secret } : {}) };
  // Every key the writer owns, as the server has it now: the writer takes one it is not sent off the block.
  const edit: McpServerEdit = {
    name: server.name,
    transport: server.transport,
    ...(server.url ? { url: server.url } : {}),
    ...(server.authSecret ? { authSecret: server.authSecret } : {}),
    ...(server.authHeader ? { authHeader: server.authHeader } : {}),
    headers,
    headerSecrets,
  };
  const saved = await editPackFile({
    path: mcpLibraryPath(change.packs.agentsDir),
    reload: () => reloadAll(change.packs, users(change.packs, server.name).map((agent) => agent.id)),
    edit: (text) => {
      const next = upsertMcpServer(text, edit);
      // The loader's own reading: a header another key already sets, or a literal that looks like a key, is refused.
      parseMcpLibrary(parseToml<Record<string, unknown>>(next));
      return next;
    },
  });
  return saved.ok ? { ok: true, restartRequired: false } : saved;
}

/** One agent's switch: its own secret header over the library's, or its own taken off (the library's then holds). */
async function agentHeader(change: HeaderChange, header: string): Promise<SaveResult<McpField>> {
  if (change.value !== undefined) return { ok: false, field: "token", error: "a header's value is the server's, the same for every agent: set it without --agent; one agent's own is a secret" };
  const agent = change.packs.agents().find((entry) => entry.id === change.agentId);
  if (!agent) return { ok: false, field: "agents", error: `no agent "${change.agentId}"` };
  return await writeChoices(agent.dir, () => change.packs.reload(agent.id), (there) => {
    const choice = there[change.server] ?? { on: false };
    const own = Object.fromEntries(Object.entries(choice.headerSecrets ?? {}).filter(([name]) => name.toLowerCase() !== header.toLowerCase()));
    if (change.secret !== undefined) own[header] = change.secret;
    const { headerSecrets: _before, ...rest } = choice;
    return { ...there, [change.server]: { ...rest, ...(Object.keys(own).length > 0 ? { headerSecrets: own } : {}) } };
  });
}
