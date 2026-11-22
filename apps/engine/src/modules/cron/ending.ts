/**
 * A job that lasts a set time, at its end (`JobDelivery.lasts`): turned off, with why, and where it reports told.
 *
 * Told, because a watch that stopped looking without a word reads as one still looking: "tell me when the build is
 * done", for a build that never finished, was silence for good. Written down as a run that did not run, so the job's
 * history says when it stopped and why. Apart from the scheduler, which only decides that the moment has come.
 */

import { createLogger, type Job } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { CronPort } from "./cron.store.ts";
import type { Delivered } from "./delivery.ts";
import { lastsWords } from "./parse.ts";

const log = createLogger("cron");

/** Why a job that lasts a set time is off once that time is up: `disabled_reason`, which its page puts into words. */
export const ENDED = "ended";

/**
 * What it says as it turns itself off. The daemon's own words, not a run's: nothing ran. One set to tell once says that
 * what it watched for did not happen, since silence would leave a person still waiting.
 */
export function endedNotice(job: Pick<Job, "name" | "delivery">): string {
  const ran = job.delivery.lasts === undefined ? "its time" : lastsWords(job.delivery.lasts);
  const saw = job.delivery.once ? " What it watched for did not happen in that time." : "";
  return `⏹ **${job.name}** has run for ${ran} and turned itself off.${saw} Turn it on again on the Automations page to keep it going.`;
}

export interface EndingHands {
  store: Pick<CronPort, "startRun" | "finishRun" | "turnOff">;
  audit?: AuditPort;
  /** The notice to where the job reports, as a run's words go: kept for the end of the quiet hours inside them. */
  say(job: Job, runId: string, text: string): Promise<Delivered>;
}

/** End it. Never throws: it runs on the scheduler's tick, where nothing is above it to catch. */
export async function endJob(job: Job, hands: EndingHands): Promise<void> {
  try {
    const run = hands.store.startRun(job.id);
    hands.store.finishRun(run.id, { status: "skipped", result: "its time was up: it turned itself off" });
    hands.store.turnOff(job.id, ENDED);
    hands.audit?.record({ action: "cron_ended", agentId: job.agentId, actor: "cron", details: { job: job.id, name: job.name, lasts: job.delivery.lasts ?? null } });
    log.info("a job ran its time and turned itself off", { job: job.id, name: job.name, lasts_ms: job.delivery.lasts });
    const said = await hands.say(job, run.id, endedNotice(job));
    if (!said.ok) log.warn("a job that ended could not say so where it reports", { job: job.id, error: said.error });
  } catch (err) {
    log.error("ending a job that ran its time threw", { job: job.id, error: String(err) });
  }
}
