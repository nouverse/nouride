/**
 * `[cron] quiet_hours`: the hours of the day in which what automations would say to a chat is kept, and sent as one
 * message when they end (`modules/cron/quiet.ts`). One setting for the install, in the daemon's time zone.
 *
 * Written `"22:00-07:00"`; empty takes the key out, which is none. Live: the scheduler reads it each time something is
 * about to be said.
 */

import { createLogger, formatQuietHours, parseQuietHours } from "@nouride/shared";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

export async function setQuietHours(deps: SettingsDeps, params: { hours: string; actor?: string }): Promise<SaveResult> {
  const asked = params.hours.trim();
  const span = asked === "" ? null : parseQuietHours(asked);
  if (asked !== "" && span === null) {
    return { ok: false, error: `[cron] quiet_hours must be two different times of the day, as "22:00-07:00", or empty for none; got "${asked}"` };
  }
  const hours = span ? formatQuietHours(span) : "";
  const previous = deps.config.cron.quietHours.trim();
  if (hours === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => (hours === "" ? removeTomlKey(source, "cron", "quiet_hours") : upsertTomlTable(source, "cron", { quiet_hours: hours })));
  if (!saved.ok) return saved;

  log.info("quiet hours changed", { hours, previous, actor: params.actor });
  deps.audit?.record({ action: "quiet_hours_changed", actor: params.actor, details: { hours, previous } });
  return { ok: true, restartRequired: false };
}
