/**
 * What a cron job must be before it is written.
 *
 * Validation happens at **create**, not at fire time: a cron expression that cannot parse, a timezone
 * that is not IANA, an interval under the floor — all refused while the caller is still there to read
 * the message. The alternative is a job that sits in the list looking scheduled and throws at 3am into
 * a log nobody is watching.
 *
 * A function of its input and three facts rather than a method, so the store keeps only what it owns —
 * the rows and `next_run_at` — and this can be read without the SQL around it.
 */

import type { JobDelivery, JobPayload } from "@nouride/shared";
import { assertTimezone, nextCronOccurrence, parseCronExpr } from "@/modules/cron/expr.ts";
import type { JobInput } from "@/modules/cron/cron.store.ts";
import { CHECK_MAX, CHECKS_MAX, GOAL_MAX, REVIEW_MAX } from "@/modules/missions/limits.ts";

/**
 * A field of a job a refusal is about (0.8.23), which the dashboard's form names: its name, agent and chat, when it
 * runs, what it does (a reminder's text, an agent's message, a command, a mission's goal, checks and review), and where
 * it reports.
 */
export type CronField = "name" | "agent" | "target" | "schedule" | "kind" | "text" | "message" | "command" | "goal" | "checks" | "review" | "delivery";

/** Refused input, phrased for whoever sent it — an operator on a CLI or a model reading a tool result. */
export class CronValidationError extends Error {
  constructor(message: string, readonly field?: CronField) {
    super(message);
    this.name = "CronValidationError";
  }
}

/** The three facts a job is held to: the clock, `[cron] min_interval_ms`, and `[daemon] timezone`. */
export interface ValidationRules {
  now: number;
  minIntervalMs: number;
  /** What a cron expression means when the job did not name a zone. */
  timezone: string;
}

/** Everything refused before a job is written. Throws `CronValidationError` with the reason. */
export function validateJob(input: JobInput, rules: ValidationRules): void {
  if (!input.name.trim()) throw new CronValidationError("a job needs a name.", "name");
  // Refused here rather than discovered at run time: a job with no agent was accepted, sat for
  // hours, and failed the moment it was due with "agent  is not loaded" (2026-10-06, an agent's
  // `nouride cron add` without `--agent`).
  if (!input.agentId.trim()) throw new CronValidationError("a job needs an agent to run it: pass `--agent <id>` (`agentId`).", "agent");
  if (!input.target.gatewayId || !input.target.chatId) {
    throw new CronValidationError("a job needs a target conversation: the gateway instance id and the chat id it is about.", "target");
  }

  const { trigger } = input;
  if (trigger.kind === "at") {
    if (!Number.isFinite(trigger.at)) throw new CronValidationError("`at` must be a timestamp.", "schedule");
    if (trigger.at <= rules.now) {
      throw new CronValidationError("that time has already passed.", "schedule");
    }
  }
  if (trigger.kind === "every") {
    if (!Number.isFinite(trigger.everyMs) || trigger.everyMs < rules.minIntervalMs) {
      throw new CronValidationError(
        `the shortest interval allowed is ${Math.round(rules.minIntervalMs / 1000)}s.`,
        "schedule",
      );
    }
  }
  if (trigger.kind === "cron") {
    if (trigger.tz) assertTimezone(trigger.tz);
    // Throws with the field and the reason. Parsed here so the error reaches the caller rather
    // than the first tick after they have gone.
    parseCronExpr(trigger.expr);
    nextCronOccurrence(parseCronExpr(trigger.expr), rules.now, (trigger.tz || rules.timezone));
  }

  const { payload } = input;
  if (payload.kind === "systemEvent" && !payload.text.trim()) {
    throw new CronValidationError("a system event needs text to deliver.", "text");
  }
  if (payload.kind === "agentTurn" && !payload.message.trim()) {
    throw new CronValidationError("an agent turn needs a message.", "message");
  }
  if (payload.kind === "mission") missionProblems(payload, input.delivery);
  if (payload.kind === "command") {
    if (!Array.isArray(payload.argv) || payload.argv.length === 0) {
      throw new CronValidationError("a command needs an argv array.", "command");
    }
    if (payload.argv.some((a) => typeof a !== "string")) {
      throw new CronValidationError("every argv entry must be a string.", "command");
    }
  }

  const delivery = input.delivery;
  if (delivery?.mode === "webhook" && !delivery.webhookUrl) {
    throw new CronValidationError("webhook delivery needs a URL.", "delivery");
  }
  // One or the other, never half: a delivery override naming a chat but no gateway would be
  // resolved against the target's gateway, which is a different conversation than was asked for.
  if (delivery && (delivery.gatewayId ? !delivery.chatId : !!delivery.chatId)) {
    throw new CronValidationError(
      "a delivery override needs both a gateway id and a chat id, or neither.",
      "delivery",
    );
  }
}

function missionProblems(payload: Extract<JobPayload, { kind: "mission" }>, delivery: JobDelivery | undefined): void {
  if (!payload.goal.trim()) throw new CronValidationError("a mission needs a goal: what should be true when a run is done.", "goal");
  if (payload.goal.length > GOAL_MAX) throw new CronValidationError(`keep a mission's goal under ${GOAL_MAX} characters: write the detail to a file and name its absolute path in the goal.`, "goal");
  const checks = payload.checks ?? [];
  if (checks.length > CHECKS_MAX || checks.some((check) => typeof check !== "string" || !check.trim() || check.length > CHECK_MAX)) {
    throw new CronValidationError(`a mission takes at most ${CHECKS_MAX} checks, each one command under ${CHECK_MAX} characters.`, "checks");
  }
  if (typeof payload.review === "string" && payload.review.length > REVIEW_MAX) {
    throw new CronValidationError(`keep the review criteria under ${REVIEW_MAX} characters.`, "review");
  }
  // A run tells a chat when it is done, needs someone, or ends: with nowhere to say it, nobody would ever know.
  if (delivery && delivery.mode !== "announce") throw new CronValidationError("a mission reports to a chat: its delivery is `announce`.", "delivery");
}
