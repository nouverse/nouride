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

import type { JobDelivery, JobPayload, JobScript, JobStep, StepGo, TogetherStep } from "@nouride/shared";
import { assertTimezone, nextCronOccurrence, parseCronExpr } from "@/modules/cron/expr.ts";
import type { JobInput } from "@/modules/cron/cron.store.ts";
import { CHECK_MAX, CHECKS_MAX, GOAL_MAX, REVIEW_MAX } from "@/modules/missions/limits.ts";
import { SCRIPT_MAX_BYTES } from "./job-command.ts";
import { APPROVAL_WAIT_MAX_MS, APPROVAL_WAIT_MIN_MS, STEPS_MAX } from "./steps.ts";
import { TOGETHER_MAX, TOGETHER_MIN } from "./together.ts";

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
  // Told nobody, it would never turn off: the mark would read as a promise it cannot keep.
  if (delivery?.once && delivery.mode === "none") {
    throw new CronValidationError("a job that tells nobody cannot turn itself off once it has told: give it somewhere to report.", "delivery");
  }
  validateLasts(input);
}

/**
 * How long a job lasts must be a time it can run in: it is on a clock, and one that runs every so often has a run
 * inside it. One that would end before it ever ran does nothing and then says it gave up. A pattern's runs are not
 * counted: how far apart they are depends on the day it is asked, and a rule that refuses on a Friday what it took on
 * a Monday is not one.
 */
export function validateLasts(input: Pick<JobInput, "trigger" | "delivery">): void {
  const lasts = input.delivery?.lasts;
  if (lasts === undefined) return;
  if (!Number.isFinite(lasts) || lasts <= 0) throw new CronValidationError("how long a job lasts is a length of time: \"6h\", \"30d\".", "schedule");
  const { trigger } = input;
  if (trigger.kind !== "every" && trigger.kind !== "cron") {
    throw new CronValidationError("only a job that runs again and again on a clock can last a set time: this one runs once, or when it is called or started.", "schedule");
  }
  if (trigger.kind === "every" && trigger.everyMs > lasts) {
    throw new CronValidationError("it would end before its first run: let it last longer than the time between two runs.", "schedule");
  }
}

/**
 * What a job does, held to its rules when only that is changed: every step of a list, and a job of one command, which
 * may keep a script with rules of its own. The other kinds are held when a job is made, as they were: a job in the
 * field made under an older rule is not refused its next save for it.
 */
export function validateDoes(input: Pick<JobInput, "payload" | "session" | "delivery" | "agentId">): void {
  if (input.payload.kind === "steps") validateSteps(input);
  else if (input.payload.kind === "command") doesProblems(input.payload, input.delivery);
}

/** What one thing a job does must be: a job of one kind, or one step of several. */
function doesProblems(does: Exclude<JobPayload, { kind: "steps" }> | Exclude<JobStep, { kind: "approval" | "parallel" }> | TogetherStep, delivery: JobDelivery | undefined): void {
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
    if (does.script !== undefined) scriptProblems(does.script, does.argv);
  }
}

/** A secret's name as the store keeps one: what a script may name to be handed. */
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * What a script a job keeps must be: text the machine can start a program with, a line of what it does, and a program
 * to run it. Whether that program is on the machine, and whether its agent holds the secrets it names, is asked where
 * the job is made (`scripts.ts`), since both are facts about an agent and not about the text.
 */
function scriptProblems(script: JobScript, argv: readonly string[]): void {
  if (typeof script !== "object" || script === null || typeof script.text !== "string" || !script.text.trim()) {
    throw new CronValidationError("a script needs its text.", "command");
  }
  // A NUL ends a string where the program is started, so the rest of the text would never reach its file.
  if (script.text.includes("\0")) throw new CronValidationError("a script is text: this one holds a NUL byte.", "command");
  const bytes = new TextEncoder().encode(script.text).length;
  if (bytes > SCRIPT_MAX_BYTES) {
    throw new CronValidationError(`a script is at most ${SCRIPT_MAX_BYTES} bytes, the most this machine starts a program with, and this one is ${bytes}: keep the long part in a file it reads.`, "command");
  }
  if (typeof script.about !== "string" || !script.about.trim()) {
    throw new CronValidationError("a script says what it does, in a line (`about`): a person turning it on reads that before the text.", "command");
  }
  // The program is the script's own line where one is given: a first argument that is itself the text would run it twice over.
  if (!argv[0]?.trim() || /\s/.test(argv[0])) throw new CronValidationError("a script names the program that runs it, one word: `sh`, `python3`, `bun`.", "command");
  const secrets = script.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some((name) => typeof name !== "string" || !SECRET_NAME.test(name))) {
    throw new CronValidationError("a script's `secrets` are the names of secrets its agent holds, each one name.", "command");
  }
}

const STEP_KINDS = ["systemEvent", "agentTurn", "command", "mission", "approval", "parallel"];
/** What a step may be, as a refusal says it. */
export const STEP_IS = "a message, an agent's turn, a command, a mission, a wait for a person or several steps at the same time";
/** A step's id: short, and safe in a button's data and an address. */
const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/**
 * What a job of several steps must be, said with the step's number so whoever wrote the list finds it. Called for a
 * new job and for a change to one (`validateDoes`): a list is edited far more often than a job of one kind is.
 */
function validateSteps(input: Pick<JobInput, "payload" | "session" | "delivery" | "agentId">): void {
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
      throw new CronValidationError(`${at} must be ${STEP_IS}.`, "steps");
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
    // A message says the words it was given and a wait says none of its own: neither has anything that could change.
    if (step.onlyChanged && (step.kind === "systemEvent" || step.kind === "approval")) {
      throw new CronValidationError(`${at}: only a command, an agent's turn or a mission can go on only when what it said has changed.`, "steps");
    }
    if (step.kind === "approval") approvalProblems(step, at);
    else if (step.kind === "parallel") togetherProblems(step, at, place, input.agentId, input.delivery);
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

/**
 * What steps started together must be: two to five, each an agent's turn or a command with an id of its own, and no
 * agent twice. Two turns of one agent at once would be one agent in one conversation answering two things: they are
 * steps of their own, one after the other.
 */
function togetherProblems(step: Extract<JobStep, { kind: "parallel" }>, at: string, place: Map<string, number>, jobAgent: string, delivery: JobDelivery | undefined): void {
  const parts = step.steps;
  if (!Array.isArray(parts) || parts.length < TOGETHER_MIN || parts.length > TOGETHER_MAX) {
    throw new CronValidationError(`${at}: steps at the same time are ${TOGETHER_MIN} to ${TOGETHER_MAX}.`, "steps");
  }
  const agents = new Set<string>();
  for (const [index, part] of parts.entries()) {
    const which = `${at}, part ${index + 1}`;
    if (!part || typeof part !== "object" || (part.kind !== "agentTurn" && part.kind !== "command")) {
      throw new CronValidationError(`${which} must be an agent's turn or a command: a mission or a wait for a person is a step of its own.`, "steps");
    }
    if (typeof part.id !== "string" || !STEP_ID.test(part.id) || place.has(part.id)) {
      throw new CronValidationError(`${which} needs an id no other step of the job has: lower-case letters, digits, - and _, at most 24.`, "steps");
    }
    place.set(part.id, place.get(step.id)!);
    try {
      doesProblems(part, delivery);
    } catch (err) {
      if (err instanceof CronValidationError) throw new CronValidationError(`${which}: ${err.message}`, "steps");
      throw err;
    }
    if (part.kind !== "agentTurn") continue;
    if (part.agentId !== undefined && !part.agentId.trim()) throw new CronValidationError(`${which} names no agent: leave the agent out for the job's own.`, "steps");
    const agent = part.agentId ?? jobAgent;
    if (agents.has(agent)) throw new CronValidationError(`${at}: ${agent} has two turns at the same time. An agent takes one at a time: give the second a step of its own.`, "steps");
    agents.add(agent);
  }
}

function approvalProblems(step: Extract<JobStep, { kind: "approval" }>, at: string): void {
  if (typeof step.ask !== "string" || !step.ask.trim()) throw new CronValidationError(`${at}: a wait for a person needs the question it asks.`, "steps");
  if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < APPROVAL_WAIT_MIN_MS || step.timeoutMs > APPROVAL_WAIT_MAX_MS)) {
    throw new CronValidationError(`${at}: it waits between ${APPROVAL_WAIT_MIN_MS / 60_000} minutes and ${APPROVAL_WAIT_MAX_MS / 86_400_000} days.`, "steps");
  }
}

function missionProblems(payload: { goal: string; checks?: string[]; review?: string | false; draft?: unknown }, delivery: JobDelivery | undefined): void {
  if (!payload.goal.trim()) throw new CronValidationError("a mission needs a goal: what should be true when a run is done.", "goal");
  // Said or left out: a `draft` that is anything else would start a mission its writer meant to wait.
  if (payload.draft !== undefined && payload.draft !== true) throw new CronValidationError("a mission's `draft` is true, to draft it for a person to start, or left out, to start it.", "goal");
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
