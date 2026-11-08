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
