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

import type { JobDelivery, JobPayload, JobStep, StepGo } from "@nouride/shared";
import { assertTimezone, nextCronOccurrence, parseCronExpr } from "@/modules/cron/expr.ts";
import type { JobInput } from "@/modules/cron/cron.store.ts";
import { CHECK_MAX, CHECKS_MAX, GOAL_MAX, REVIEW_MAX } from "@/modules/missions/limits.ts";
import { APPROVAL_WAIT_MAX_MS, APPROVAL_WAIT_MIN_MS, STEPS_MAX } from "./steps.ts";

/**
 * A field of a job a refusal is about (0.8.23), which the dashboard's form names: its name, agent and chat, when it
 * runs, what it does (a reminder's text, an agent's message, a command, a mission's goal, checks and review, or its
 * steps), and where it reports.
 */
export type CronField = "name" | "agent" | "target" | "schedule" | "kind" | "text" | "message" | "command" | "goal" | "checks" | "review" | "delivery" | "steps";

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
  if (payload.kind === "steps") validateSteps(input);
  else doesProblems(payload, input.delivery);

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

/** What one thing a job does must be: a job of one kind, or one step of several. */
function doesProblems(does: Exclude<JobPayload, { kind: "steps" }> | Exclude<JobStep, { kind: "approval" }>, delivery: JobDelivery | undefined): void {
  if (does.kind === "systemEvent" && !does.text.trim()) {
    throw new CronValidationError("a system event needs text to deliver.", "text");
  }
  if (does.kind === "agentTurn" && !does.message.trim()) {
    throw new CronValidationError("an agent turn needs a message.", "message");
  }
  if (does.kind === "mission") missionProblems(does, delivery);
  if (does.kind === "command") {
    if (!Array.isArray(does.argv) || does.argv.length === 0) {
      throw new CronValidationError("a command needs an argv array.", "command");
    }
    if (does.argv.some((a) => typeof a !== "string")) {
      throw new CronValidationError("every argv entry must be a string.", "command");
    }
  }
}

const STEP_KINDS = ["systemEvent", "agentTurn", "command", "mission", "approval"];
/** A step's id: short, and safe in a button's data and an address. */
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/**
 * What a job of several steps must be, said with the step's number so whoever wrote the list finds it. Called for a
 * new job and for a change to one (`cron.store.ts`): a list is edited far more often than a job of one kind is.
 */
export function validateSteps(input: Pick<JobInput, "payload" | "session" | "delivery">): void {
  if (input.payload.kind !== "steps") return;
  const steps = input.payload.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new CronValidationError("a job of steps needs at least one step.", "steps");
  if (steps.length > STEPS_MAX) throw new CronValidationError(`a job runs at most ${STEPS_MAX} steps.`, "steps");
  // Each turn's words go to the next step, so none is put into a person's chat as a message from them would be.
  if (input.session === "chat") {
    throw new CronValidationError("a job of steps keeps its own history: its session is `fresh` or `isolated`, not the chat's.", "steps");
  }
  const place = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    const at = `step ${index + 1}`;
    if (!step || typeof step !== "object" || !STEP_KINDS.includes(step.kind)) {
      throw new CronValidationError(`${at} must be a message, an agent's turn, a command, a mission or a wait for a person.`, "steps");
    }
    if (typeof step.id !== "string" || !STEP_ID.test(step.id)) {
      throw new CronValidationError(`${at} needs an id of its own: lower-case letters, digits, - and _, at most 24.`, "steps");
    }
    if (place.has(step.id)) throw new CronValidationError(`${at} has the id of step ${place.get(step.id)! + 1} (${step.id}): each step's id is its own.`, "steps");
    place.set(step.id, index);
  }
  for (const [index, step] of steps.entries()) {
    const at = `step ${index + 1}`;
    if ((step.kind === "agentTurn" || step.kind === "mission") && step.agentId !== undefined && !step.agentId.trim()) {
      throw new CronValidationError(`${at} names no agent: leave the agent out for the job's own.`, "steps");
    }
    if (step.kind === "approval") approvalProblems(step, at);
    else {
      try {
        doesProblems(step, input.delivery);
      } catch (err) {
        if (err instanceof CronValidationError) throw new CronValidationError(`${at}: ${err.message}`, "steps");
        throw err;
      }
    }
    for (const [exit, go] of [["then", step.then], ["whenFailed", step.whenFailed], ["whenEmpty", step.whenEmpty]] as const) {
      exitProblems(go, exit, at, index, place);
    }
  }
}

/** An exit is the next step, the end, or a later step: a jump back would be a loop, and one to nowhere a run that stops unexplained. */
function exitProblems(go: StepGo | undefined, exit: string, at: string, index: number, place: ReadonlyMap<string, number>): void {
  if (go === undefined || go === "next" || go === "end") return;
  const to = typeof go === "object" && go !== null && typeof go.to === "string" ? place.get(go.to) : undefined;
  if (to === undefined) throw new CronValidationError(`${at}: \`${exit}\` is "next", "end", or { to: the id of a later step }.`, "steps");
  if (to <= index) throw new CronValidationError(`${at}: \`${exit}\` points at step ${to + 1}, which is not after it. A run only goes forward.`, "steps");
}

function approvalProblems(step: Extract<JobStep, { kind: "approval" }>, at: string): void {
  if (typeof step.ask !== "string" || !step.ask.trim()) throw new CronValidationError(`${at}: a wait for a person needs the question it asks.`, "steps");
  if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < APPROVAL_WAIT_MIN_MS || step.timeoutMs > APPROVAL_WAIT_MAX_MS)) {
    throw new CronValidationError(`${at}: it waits between ${APPROVAL_WAIT_MIN_MS / 60_000} minutes and ${APPROVAL_WAIT_MAX_MS / 86_400_000} days.`, "steps");
  }
}

function missionProblems(payload: { goal: string; checks?: string[]; review?: string | false }, delivery: JobDelivery | undefined): void {
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
