/**
 * `[mcp_server]` — Nouride as an MCP server, on or off.
 *
 * **Live.** `/mcp` reads the flag on every request, so turning it on or off needs no restart.
 */

import { createLogger } from "@nouride/shared";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings.mcp-server");

export async function setMcpServerEnabled(deps: SettingsDeps, params: { enabled: boolean; actor?: string }): Promise<SaveResult> {
  const previous = deps.config.mcpServer.enabled;
  if (previous === params.enabled) return { ok: true, restartRequired: false };
  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "mcp_server", { enabled: params.enabled }));
  if (!saved.ok) return saved;
  log.info("mcp server switched", { enabled: params.enabled, actor: params.actor });
  deps.audit?.record({ action: "mcp_server_changed", actor: params.actor, details: { enabled: params.enabled, previous } });
  return { ok: true, restartRequired: false };
}
