/**
 * What a person is told when they write to an agent that is working (`[queue] steer_reply`, `[queue] steer_ack`), from
 * the dashboard. Live: the pipeline reads both off the config on every steered message.
 */

import { createLogger } from "@nouride/shared";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

/** Either or both; a key left out is left as it is. */
export async function setSteering(deps: SettingsDeps, params: { reply?: boolean; ack?: boolean; actor?: string }): Promise<SaveResult> {
  const queue = deps.config.queue;
  const patch: Record<string, boolean> = {};
  if (params.reply !== undefined && params.reply !== queue.steerReply) patch.steer_reply = params.reply;
  if (params.ack !== undefined && params.ack !== queue.steerAck) patch.steer_ack = params.ack;
  if (Object.keys(patch).length === 0) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "queue", patch));
  if (!saved.ok) return saved;

  log.info("steering replies changed", { ...patch, actor: params.actor });
  deps.audit?.record({ action: "steering_changed", actor: params.actor, details: patch });
  return { ok: true, restartRequired: false };
}
