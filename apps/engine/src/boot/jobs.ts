/**
 * The job store and the pipeline, joined — after both exist, because each needs the other: the store
 * wakes the pipeline, and the pipeline starts jobs. A constructor argument either way would be a cycle.
 *
 * Three things go through here: a job that ends, the watchdog for the ones still running
 * (`modules/jobs/watchdog.ts`), and — later, once the inbox is reopened — the jobs the previous daemon left
 * behind.
 */

import type { AgentRegistry } from "@nouride/persona";
import { processGroupActivity } from "@nouride/runtime";
import { createLogger, resolveQuietAfterMs, type GlobalConfig } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import { INTERRUPTED_REPORT_MAX, INTERRUPTED_REPORT_WINDOW_MS, type JobRecord, type JobStop, type JobStore } from "@/modules/jobs/jobs.store.ts";
import type { JobWakePort } from "@/modules/jobs/wakes.store.ts";
import { JobWatchdog, quietJobMessage } from "@/modules/jobs/watchdog.ts";
import type { Pipeline } from "@/modules/pipeline/index.ts";

const log = createLogger("jobs.watchdog");

/** Enough of the log to judge "still running normally" by. */
const TAIL_BYTES = 1500;

/** Wires the first two, and returns the watchdog's timer for shutdown to clear. */
export function wireJobs(params: {
  jobs: JobStore;
  registry: Pick<AgentRegistry, "get">;
  /** Read at every tick: `[jobs]` and an agent's own override are both reloadable. */
  config: () => GlobalConfig;
  pipeline: Pick<Pipeline, "wakeForJob" | "wakeForQuietJob">;
}): ReturnType<typeof setInterval> {
  const { jobs, registry, pipeline } = params;
  jobs.setOnComplete((completion) => pipeline.wakeForJob(completion));

  const watchdog = new JobWatchdog({
    // Newest first and capped at a hundred: running jobs are recent, and a daemon with a hundred
    // running at once has a problem this is not going to be the one to find.
    running: () => jobs.listSnapshots({ limit: 100 }).filter((job) => job.status === "running"),
    quietAfterMs: (agentId) =>
      resolveQuietAfterMs(registry.get(agentId)?.config.jobQuietAfterMinutes, params.config().jobs.quietAfterMinutes),
    // A job leads its own process group (`job-spawn.ts`), so its pid names everything it started.
    activity: (job) => (job.pid ? processGroupActivity(job.pid) : null),
    notify: (quiet) => {
      log.info("a background job has been quiet; telling its agent", {
        job: quiet.job.id,
        agent_id: quiet.job.agentId,
        running_s: Math.round(quiet.runningMs / 1000),
        quiet_s: Math.round(quiet.quietMs / 1000),
        nth: quiet.nth,
      });
      void jobs
        .tail(quiet.job.id, TAIL_BYTES)
        .catch(() => "")
        .then((tail) => pipeline.wakeForQuietJob(quiet.job, quietJobMessage(quiet, tail)))
        // Said here rather than as a rejection nobody caught: the next notice, at twice the wait, tries again.
        .catch((err: unknown) => log.error("could not wake the agent of a quiet job", { job: quiet.job.id, agent_id: quiet.job.agentId, error: String(err) }));
    },
  });
  return watchdog.start();
}

/**
 * The jobs that died with the *previous* daemon, now that there is a pipeline to carry the news.
 *
 * Marking their rows `interrupted` at boot fixed the job list and left the person waiting: an agent that had
 * said "I will tell you when it finishes" never said anything again. The wake-up goes through the same
 * queue as a normal completion, so it is ordered behind whatever the conversation is doing and an empty
 * turn still says nothing.
 *
 * Called once the inbox is reopened (`boot/durable.ts`): a message somebody sent before the restart is
 * answered before an event of the restart itself. Observed on a box the other way round: a person's
 * queued message waited half a minute behind its agent re-running the job the restart had killed.
 */
export function reportInterruptedJobs(params: {
  jobs: JobStore;
  orphanedJobs: JobRecord[];
  pipeline: Pick<Pipeline, "wakeForJob">;
  wakes?: Pick<JobWakePort, "unwoken">;
  /** Where a stop the deadline made is still written down, when its wake-up was lost — the row says only `killed`. */
  audit?: Pick<AuditPort, "ofActions">;
  now?: number;
}): void {
  params.jobs.reportInterrupted(params.orphanedJobs, (completion) => params.pipeline.wakeForJob(completion));
  reportUnwokenJobs(params);
}

/**
 * And the jobs that finished just before the restart, whose wake-up was still in the queue when it went.
 *
 * The queue is memory, so that wake-up is gone; `jobs.woke_at` says it was never taken. The same bounds as
 * interrupted jobs — six hours, three at most — for the same reason: a crash loop must not turn into a
 * flood, and yesterday's result is archaeology.
 */
function reportUnwokenJobs(params: Parameters<typeof reportInterruptedJobs>[0]): void {
  if (!params.wakes) return;
  const now = params.now ?? Date.now();
  const ids = params.wakes.unwoken(now - INTERRUPTED_REPORT_WINDOW_MS, INTERRUPTED_REPORT_MAX);
  const stops = ids.length > 0 ? deadlineStops(params.audit) : new Map<string, JobStop>();
  for (const id of ids) {
    const job = params.jobs.get(id);
    if (!job) continue;
    const stop = job.status === "killed" ? stops.get(id) : undefined;
    void params.jobs
      .tail(id)
      .then((tail) => params.pipeline.wakeForJob({ job, tail, ...(stop ? { stop } : {}) }))
      .catch((err: unknown) => log.error("could not report a job whose wake-up was lost", { job: id, error: String(err) }));
  }
  if (ids.length > 0) log.info("reporting jobs whose wake-up a restart lost", { count: ids.length });
}

/**
 * The jobs the deadline stopped, from the audit log's `job_deadline` rows — the newest two hundred, which reach past
 * the six hours a lost wake-up is still reported in. Without it the restart re-delivers such a job as plain "was
 * stopped", which reads as a stop somebody chose, with silence allowed.
 */
function deadlineStops(audit: Pick<AuditPort, "ofActions"> | undefined): Map<string, JobStop> {
  const stops = new Map<string, JobStop>();
  for (const entry of audit?.ofActions(["job_deadline"]) ?? []) {
    const { job, max_ms: limitMs } = entry.details ?? {};
    if (typeof job === "string" && typeof limitMs === "number" && !stops.has(job)) stops.set(job, { by: "deadline", limitMs });
  }
  return stops;
}
