/**
 * How long a background job may be quiet before its agent says it is still running — for the daemon,
 * and for one agent. See `JobsSection.quietAfterMinutes` for what the number does.
 *
 * Whole minutes, 0 to a day. 0 is off. Past a day a notice is a message about a job nobody remembers
 * starting, which is the case `0` exists for; below a minute the watchdog, which looks once a minute,
 * could not keep the promise.
 */

import { createLogger, maxBackgroundRefusal } from "@nouride/shared";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { editPackFile } from "@/modules/config/config-file.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

export const JOB_QUIET_MINUTES_MAX = 24 * 60;

function refusal(minutes: number, where: string): string | null {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > JOB_QUIET_MINUTES_MAX) {
    return `${where} must be a whole number of minutes from 0 (off) to ${JOB_QUIET_MINUTES_MAX}, got ${minutes}`;
  }
  return null;
}

/** The daemon's wait. Live at the watchdog's next tick, which reads it every time. */
export async function setJobQuietMinutes(deps: SettingsDeps, params: { minutes: number; actor?: string }): Promise<SaveResult> {
  const refused = refusal(params.minutes, "[jobs] quiet_after_minutes");
  if (refused) return { ok: false, error: refused };

  const previous = deps.config.jobs.quietAfterMinutes;
  if (params.minutes === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "jobs", { quiet_after_minutes: params.minutes }));
  if (!saved.ok) return saved;

  log.info("job quiet wait changed", { minutes: params.minutes, previous, actor: params.actor });
  deps.audit?.record({ action: "job_quiet_after_changed", actor: params.actor, details: { minutes: params.minutes, previous } });
  return { ok: true, restartRequired: false };
}

/**
 * One agent's own wait, or `null` to follow the daemon.
 *
 * `null` removes the key rather than writing today's default, for the reason the turn budget gives:
 * a number copied from the global stops tracking it the day somebody moves the global.
 */
export async function saveAgentJobQuietMinutes(deps: SettingsDeps, input: {
  agentConfigPath: string;
  /** Reloads the agent: the write is checked by it, and put back when the pack no longer loads. */
  reload: () => Promise<unknown>;
  minutes: number | null;
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  if (input.minutes !== null) {
    const refused = refusal(input.minutes, "[jobs] quiet_after_minutes");
    if (refused) return { ok: false, error: refused };
  }

  const saved = await editPackFile({
    path: input.agentConfigPath,
    reload: input.reload,
    edit: (source) =>
      input.minutes === null
        ? removeTomlKey(source, "jobs", "quiet_after_minutes")
        : upsertTomlTable(source, "jobs", { quiet_after_minutes: input.minutes }),
  });
  if (!saved.ok) return saved;

  log.info("agent job quiet wait changed", { agent: input.agentId, minutes: input.minutes, actor: input.actor });
  deps.audit?.record({
    action: "agent_job_quiet_after_changed",
    actor: input.actor,
    details: { agent: input.agentId, minutes: input.minutes },
  });
  return { ok: true, restartRequired: false };
}

/**
 * How many helpers one agent may have working in the background at once — `[delegate] max_background` in its pack — or
 * `null` to follow the daemon's (0.7.15). Live: the pack is reloaded by the write, and the limit is read as each helper
 * starts and as each turn's toolset is resolved, so the next one is held to it. 0 turns them off for this agent.
 */
export async function saveAgentMaxBackground(deps: SettingsDeps, input: {
  agentConfigPath: string;
  /** Reloads the agent: the write is checked by it, and put back when the pack no longer loads. */
  reload: () => Promise<unknown>;
  value: number | null;
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  if (input.value !== null) {
    const refused = maxBackgroundRefusal(input.value, "[delegate] max_background");
    if (refused) return { ok: false, error: refused };
  }

  const saved = await editPackFile({
    path: input.agentConfigPath,
    reload: input.reload,
    edit: (source) =>
      input.value === null
        ? removeTomlKey(source, "delegate", "max_background")
        : upsertTomlTable(source, "delegate", { max_background: input.value }),
  });
  if (!saved.ok) return saved;

  log.info("agent background helper limit changed", { agent: input.agentId, max_background: input.value, actor: input.actor });
  deps.audit?.record({
    action: "agent_max_background_changed",
    actor: input.actor,
    details: { agent: input.agentId, max_background: input.value },
  });
  return { ok: true, restartRequired: false };
}
