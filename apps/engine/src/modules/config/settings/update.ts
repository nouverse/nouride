/**
 * `[update] track` (0.8.18, PLAN §3.3): which releases this install is offered, `latest` or `lts`. Live: the update
 * check reads it from the running config each time (`followUpdateTrack`), so the next check follows a save.
 */

import { createLogger, UPDATE_TRACKS, type UpdateTrack } from "@nouride/shared";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

export async function setUpdateTrack(deps: SettingsDeps, params: { track: string; actor?: string }): Promise<SaveResult> {
  if (!(UPDATE_TRACKS as readonly string[]).includes(params.track)) {
    return { ok: false, error: `[update] track must be one of ${UPDATE_TRACKS.map((track) => `"${track}"`).join(", ")}, got ${JSON.stringify(params.track)}` };
  }
  const track = params.track as UpdateTrack;
  const previous = deps.config.update.track;
  if (track === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "update", { track }));
  if (!saved.ok) return saved;

  log.info("update track changed", { track, previous, actor: params.actor });
  deps.audit?.record({ action: "update_track_changed", actor: params.actor, details: { track, previous } });
  return { ok: true, restartRequired: false };
}
