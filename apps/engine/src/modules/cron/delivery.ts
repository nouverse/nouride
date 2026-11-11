/**
 * Where a run's words go: into the chat its job reports to, to a URL, or nowhere, as the job says. And the notice a
 * failed run sends, since nobody was watching it fail.
 */

import { createLogger, toUserMessage, type Job } from "@nouride/shared";
import { deliveryTarget } from "./addressing.ts";
import type { RunOutcome } from "./cron.store.ts";
import type { CronExecutors } from "./scheduler.ts";

const log = createLogger("cron");

/** Output past this is cut before it becomes a chat message. Chat platforms chunk; humans do not. */
const MAX_DELIVERED_CHARS = 4000;

/** A run's text delivered, or why not — `unreachable` when the job's own chat would not take it. */
export type Delivered = { ok: true } | { ok: false; error: string; unreachable?: true };

/** A run whose output did not land is a failed run, and says whether its chat was the reason. */
export function undelivered(delivered: Extract<Delivered, { ok: false }>): RunOutcome {
  return { status: "error", result: delivered.error, ...(delivered.unreachable ? { unreachable: true } : {}) };
}

/** Route a run's output according to the job's delivery mode. */
export async function deliverResult(executors: Pick<CronExecutors, "deliver" | "webhook">, now: number, job: Job, text: string): Promise<Delivered> {
  const trimmed = text.length > MAX_DELIVERED_CHARS ? `${text.slice(0, MAX_DELIVERED_CHARS)}\n…(truncated)` : text;

  switch (job.delivery.mode) {
    case "none":
      return { ok: true };

    case "webhook": {
      if (!executors.webhook || !job.delivery.webhookUrl) {
        return { ok: false, error: "webhook delivery is not available on this daemon" };
      }
      try {
        await executors.webhook(job.delivery.webhookUrl, { job: job.id, name: job.name, agentId: job.agentId, firedAt: now, text: trimmed });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `webhook failed: ${toUserMessage(err)}` };
      }
    }

    case "announce": {
      const target = deliveryTarget(job);
      const sent = await executors.deliver(target, trimmed, { agentId: job.agentId, job: job.name });
      return sent.ok ? { ok: true } : { ok: false, error: `could not deliver to ${target.gatewayId} ${target.chatId}: ${sent.reason}`, unreachable: true };
    }
  }
}

/**
 * Tell somebody the job failed.
 *
 * Best-effort and never allowed to throw: this runs inside the error path, and a failure alert
 * that fails must not replace the failure it was reporting on. Suppressed for `none` delivery —
 * a job explicitly told to stay quiet does not get to be loud only when it breaks.
 *
 * Not into a chat that has just refused the run's own delivery: the notice was refused the same way, one more call
 * and one more error line for nobody. That failure goes to the daemon's alert channel, which is where an operator
 * hears that something unattended stopped working — once per job per cooldown, not once per run.
 */
export async function reportFailure(executors: Pick<CronExecutors, "deliver" | "alert">, job: Job, outcome: Extract<RunOutcome, { status: "error" }>): Promise<void> {
  if (job.delivery.mode === "none") return;
  const detail = outcome.result.slice(0, 1000);
  try {
    if (outcome.unreachable) {
      await executors.alert?.(`cron_unreachable:${job.id}`, `Scheduled job "${job.name}" failed: ${detail}`);
      return;
    }
    await executors.deliver(deliveryTarget(job), `Scheduled job **${job.name}** failed.\n${detail}`);
  } catch (err) {
    log.warn("cron failure notice could not be delivered", { job: job.id, error: String(err) });
  }
}
