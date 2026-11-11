/**
 * A scheduled job's or a webhook's run, as a mission (0.8.0): a trigger and a mission template,
 * not a second engine. The job says what the work is; each run is a mission started as the person who turned the job
 * on, reporting to the job's chat, ending at the reviewer — and one at a time, so a run due while the last still works
 * is skipped rather than stacked behind it.
 */

import type { Job } from "@nouride/shared";
import { deliveryTarget } from "@/modules/cron/addressing.ts";
import type { Missions } from "./missions.ts";
import type { MissionsPort } from "./missions.store.ts";
import { isFinal } from "./types.ts";

export type JobRun = { started: string } | { busy: string } | { refused: string };

export function startJobRun(
  deps: { missions: Pick<Missions, "start">; store: Pick<MissionsPort, "openForJob"> },
  job: Job,
  body: string | undefined,
): JobRun {
  if (job.payload.kind !== "mission") return { refused: `job ${job.id} does not run a mission` };
  const open = deps.store.openForJob(job.id);
  if (open) return { busy: open.id };
  const reportTo = deliveryTarget(job);
  const started = deps.missions.start({
    agentId: job.agentId,
    goal: job.payload.goal,
    ...(job.payload.checks ? { checks: job.payload.checks } : {}),
    ...(job.payload.review !== undefined ? { review: job.payload.review } : {}),
    // The person who turned it on from its card; a job a person made themselves runs as whoever made it.
    startedBy: job.turnedOnBy ?? job.createdBy,
    gatewayId: reportTo.gatewayId,
    chatId: reportTo.chatId,
    jobId: job.id,
    ...(body?.trim() ? { request: body } : {}),
  });
  return "refused" in started ? started : { started: started.mission.id };
}

/** How a mission a job's step started stands: still at work, ended with what it has to say, or ended badly. */
export type MissionEnd = { working: true } | { said: string } | { failed: string };

/**
 * The same, read for a step that waits for the mission (`cron/step-runs.ts`): null when there is none by that id.
 * What it has to say is its summary, the few sentences its chat is told, or the whole report when it wrote none.
 */
export function jobMissionEnd(store: Pick<MissionsPort, "get">, id: string): MissionEnd | null {
  const mission = store.get(id);
  if (!mission) return null;
  if (!isFinal(mission.status)) return { working: true };
  if (mission.status === "done") return { said: mission.summary?.trim() || mission.report?.trim() || "the mission is done" };
  return { failed: `the mission ${mission.status === "stopped" ? "was stopped" : "failed"}${mission.reason ? `: ${mission.reason}` : ""}` };
}
