/**
 * A job of several steps (`payload.kind: "steps"`): a schedule, a webhook or a start by hand whose work is a list a
 * person can read and change, where it was one thing. Run in order; each step is handed what the one before said, and
 * the last one's words are the run's.
 *
 * A list with exits, and nothing more. A step says where the run goes when it is done, when it failed and when it had
 * nothing to say: the next step, the end, or a later step. Never an earlier one, so a run always ends, and there is no
 * mapping of one step's fields onto the next: what a step needs of the one before is its whole output, as text, and
 * deciding what to do about it is an agent's turn.
 *
 * Two steps outlast the process: a mission, and a wait for a person. The run then stops here and says where it stands
 * (`RunState`), which the store keeps; whatever ends the wait calls this again with that state. So a restart is no
 * special case: nothing a waiting run needs is in memory.
 *
 * Nothing here runs anything. The scheduler hands in its own ways of running a command, a turn, a delivery, a mission
 * and a question (`StepHands`), so a step can do nothing a job of one kind could not, under the same guards.
 */

import { sha256Text } from "@nouride/runtime";
import type { HeldAction, Job, JobStep, RunWait, StepGo, StepOutcome } from "@nouride/shared";
import type { RunOutcome, RunState } from "./cron.store.ts";
import { stepTurnMessage, withTriggerBody, type StepBefore } from "./prompts.ts";
import type { JobTurnResult, TriggerContext } from "./scheduler.ts";

/** A job may run this many steps (a starting value): a list a person still reads on one page. */
export const STEPS_MAX = 20;

/** How long a step waits for a person when it does not say (a starting value), and the least and most it may say. */
export const APPROVAL_WAIT_MS = 86_400_000;
export const APPROVAL_WAIT_MIN_MS = 5 * 60_000;
export const APPROVAL_WAIT_MAX_MS = 7 * 86_400_000;

/** How much of what a step said is kept on the run, and shown to a person asked about it. */
const SAID_KEPT = 2000;

type Step<K extends JobStep["kind"]> = Extract<JobStep, { kind: K }>;

/** A delivery made, or why not: `unreachable` when the job's own chat would not take it. */
type Sent = { ok: true } | { ok: false; error: string; unreachable?: true };

export interface StepHands {
  /** A command with no model: what it printed, or why it failed. `input`: a webhook's body, on its standard input. */
  command(step: Step<"command">, input?: string): Promise<{ output: string } | { error: string }>;
  /** What the step of that id said the last time a run of this job ended well, as a hash; nothing on its first run. */
  saidBefore(stepId: string): string | undefined;
  /** One turn of the step's agent. `outside`: the run has read a webhook's payload, so what the turn keeps waits for a person. */
  turn(step: Step<"agentTurn">, message: string, outside: boolean): Promise<JobTurnResult>;
  /** Text to where the job reports, as the job's delivery says. */
  deliver(text: string): Promise<Sent>;
  /** A mission started with `request` as what the run handed it. */
  mission(step: Step<"mission">, request: string | undefined): { started: string } | { busy: string } | { refused: string };
  /**
   * A person asked, where the job reports: the card it was asked on, when it has one to rewrite later. `from`: the
   * question is kept for the end of the quiet hours and asked then, so its time to answer counts from then.
   */
  ask(step: Step<"approval">, text: string): Promise<{ card?: RunState["card"]; from?: number } | undefined>;
  /** The outcomes so far, written down as each step begins and ends: a run at work can be read. */
  progress(outcomes: readonly StepOutcome[]): void;
  /** The daemon is going down: the run stops before its next step. */
  stopping(): boolean;
  now(): number;
}

/** What ended a wait: the mission's result or failure, or a person's answer, or nobody's. */
export type Woke =
  | { kind: "mission"; said: string }
  | { kind: "mission"; failed: string }
  | { kind: "approval"; go: true; by: string }
  | { kind: "approval"; go: false; by?: string };

/** A run that ended, or one that stopped to wait: where it stands and how its steps went so far, for the store to keep. */
export type StepsEnd = { outcome: RunOutcome } | { park: Omit<RunState, "settles" | "byHand">; outcomes: readonly StepOutcome[] };

/** Where a run of steps starts from: its beginning with what set it off, or the state it waited in and what woke it. */
export type StepsFrom = { trigger?: TriggerContext } | { state: RunState; outcomes: readonly StepOutcome[]; woke: Woke };

/** What a step is called where a run says how it went: its place, and its name or what it is. */
export function stepLabel(job: Pick<Job, "agentId">, step: JobStep, index: number, total: number): string {
  const what = step.name?.trim()
    ? `"${step.name.trim()}"`
    : step.kind === "command"
      ? `the command \`${step.argv.join(" ")}\``
      : step.kind === "agentTurn"
        ? `${step.agentId ?? job.agentId}'s turn`
        : step.kind === "mission"
          ? "the mission"
          : step.kind === "approval"
            ? "the wait for a person"
            : "the message";
  return `step ${index + 1} of ${total}, ${what}`;
}

/** Where a step sends the run for how it went, with what a job of that one kind would do when it does not say. */
function exitOf(step: JobStep, went: "done" | "failed" | "empty"): StepGo {
  return went === "done" ? (step.then ?? "next") : went === "failed" ? (step.whenFailed ?? "end") : (step.whenEmpty ?? "end");
}

/** How one step went: done, failed or with nothing to say, each with what it hands on; or the run stops or waits here. */
type Went =
  | { exit: "done"; before?: Said }
  /** `same`: it said what it said last time, and was marked to go on only when that changed. */
  | { exit: "empty"; same?: true }
  | { exit: "failed"; why: string; declined?: StepOutcome["status"] }
  | { halt: RunOutcome }
  | { wait: RunWait; card?: RunState["card"] };

/** What a step said, and whether the chat was already told it: a message was sent as it ran, and a mission reports itself. */
type Said = StepBefore & { told?: true };

/** The run so far, carried from step to step. */
interface Carry {
  before?: Said;
  /** A webhook's body no step has read yet, and whether the run was set off by one. */
  body?: string;
  outside: boolean;
  outcomes: StepOutcome[];
  held: HeldAction[];
  /** What each step marked `onlyChanged` said in this run, as a hash by its id. */
  said: Record<string, string>;
  /** The chat was told something by this run. */
  told: boolean;
}

export async function runSteps(job: Job, steps: readonly JobStep[], hands: StepHands, from: StepsFrom): Promise<StepsEnd> {
  const resumed = "state" in from ? from : undefined;
  const body = resumed ? resumed.state.body : from && "trigger" in from ? from.trigger?.body?.trim() || undefined : undefined;
  const carry: Carry = {
    ...(resumed?.state.before ? { before: resumed.state.before } : {}),
    ...(body ? { body } : {}),
    outside: resumed ? resumed.state.outside === true : body !== undefined,
    outcomes: resumed ? [...resumed.outcomes] : [],
    held: resumed?.state.held ? [...resumed.state.held] : [],
    said: { ...resumed?.state.said },
    told: resumed?.state.told === true,
  };
  const end = (outcome: RunOutcome): StepsEnd => ({
    outcome: {
      ...outcome,
      steps: carry.outcomes,
      ...(carry.held.length > 0 ? { held: carry.held } : {}),
      ...(Object.keys(carry.said).length > 0 ? { said: carry.said } : {}),
      ...(carry.told ? { told: true as const } : {}),
    },
  });

  let index = resumed ? steps.findIndex((step) => step.id === resumed.state.at) : 0;
  // The list was changed while the run waited, and the step it waited in is gone: there is nowhere to go on from.
  if (index < 0) return end({ status: "interrupted", result: "the step it waited in is no longer in the list: the run ended there" });
  let woke = resumed?.woke;

  while (index < steps.length) {
    const step = steps[index]!;
    const label = stepLabel(job, step, index, steps.length);
    if (!woke && hands.stopping()) return end({ status: "interrupted", result: `stopped before ${label}: the daemon was going down` });

    const open = openOutcome(carry.outcomes, step.id);
    const began = woke && open >= 0 ? carry.outcomes[open]!.startedAt : hands.now();
    const mark = (status: StepOutcome["status"], said?: string, more: Partial<StepOutcome> = {}): void => {
      const kept = openOutcome(carry.outcomes, step.id);
      const outcome: StepOutcome = {
        ...(kept >= 0 ? carry.outcomes[kept]! : { id: step.id, kind: step.kind, startedAt: began }),
        status,
        ...(said?.trim() ? { said: said.trim().slice(0, SAID_KEPT) } : {}),
        ...(status === "running" || status === "waiting" ? {} : { ms: hands.now() - began }),
        ...more,
      };
      if (kept >= 0) carry.outcomes[kept] = outcome;
      else carry.outcomes.push(outcome);
      hands.progress(carry.outcomes);
    };

    let went: Went;
    if (woke) {
      went = afterWait(woke, step, hands, carry, mark);
      woke = undefined;
    } else {
      mark("running");
      went = await runStep(job, step, { index, total: steps.length, label, handedOn: goesOn(steps, index, "done") }, hands, carry, mark);
    }

    if ("halt" in went) return end(went.halt);
    if ("wait" in went) {
      return {
        park: {
          at: step.id,
          wait: went.wait,
          ...(carry.before ? { before: carry.before } : {}),
          ...(carry.body ? { body: carry.body } : {}),
          ...(carry.outside ? { outside: true as const } : {}),
          ...(carry.held.length > 0 ? { held: carry.held } : {}),
          ...(Object.keys(carry.said).length > 0 ? { said: carry.said } : {}),
          ...(carry.told ? { told: true as const } : {}),
          ...(went.card ? { card: went.card } : {}),
        },
        outcomes: carry.outcomes,
      };
    }

    const go = exitOf(step, went.exit);
    const next = go === "end" ? -1 : go === "next" ? index + 1 : steps.findIndex((one) => one.id === go.to);
    if (went.exit === "failed") {
      // A person's no, or nobody's answer, is not a failure of the job: its run ends without a failure report.
      if (next < 0 || next >= steps.length) {
        return end(went.declined ? { status: "skipped", result: `${label}: ${went.why}` } : { status: "error", result: `${label} failed: ${went.why}` });
      }
      carry.before = { from: capital(label), said: went.why, failed: true };
    } else if (went.exit === "empty") {
      if (next < 0 || next >= steps.length) return end({ status: "success", result: `${label} ${went.same ? "said the same as last time" : "had nothing to say"}: the run ended there` });
      delete carry.before;
    } else if (went.before) {
      carry.before = went.before;
    }
    if (next < 0 || next >= steps.length) return await finish(carry, hands, end);
    index = next;
  }
  return await finish(carry, hands, end);
}

/** The outcome of a step the run is still at, at work or waiting: the one its end replaces. */
function openOutcome(outcomes: readonly StepOutcome[], id: string): number {
  for (let at = outcomes.length - 1; at >= 0; at -= 1) {
    const one = outcomes[at]!;
    if (one.id === id && (one.status === "running" || one.status === "waiting")) return at;
  }
  return -1;
}

/** Whether a step's reply goes on to another step when it went this way, or is the run's last. */
function goesOn(steps: readonly JobStep[], index: number, went: "done" | "failed" | "empty"): boolean {
  const go = exitOf(steps[index]!, went);
  return go !== "end" && !(go === "next" && index === steps.length - 1);
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The run's own end: its last words, delivered as the job says unless the chat was told them as they were said. */
async function finish(carry: Carry, hands: StepHands, end: (outcome: RunOutcome) => StepsEnd): Promise<StepsEnd> {
  const last = carry.before;
  if (!last) return end({ status: "success", result: "the last step had nothing to say" });
  if (last.told) return end({ status: "success", result: last.said.slice(0, SAID_KEPT) });
  const sent = await hands.deliver(last.said);
  if (sent.ok) carry.told = true;
  return sent.ok ? end({ status: "success", result: last.said.slice(0, SAID_KEPT) }) : end({ status: "error", result: sent.error, ...(sent.unreachable ? { unreachable: true } : {}) });
}

/** What a step marked to go on only when changed is said to have done when it said the same again. */
const SAME = "said the same as last time";

/**
 * Whether a step marked `onlyChanged` said what it said the last time a run of its job ended well. What it said now is
 * kept either way, as a hash: the text may hold what should not be kept twice.
 */
function sameAsBefore(step: JobStep, said: string, hands: StepHands, carry: Carry): boolean {
  if (!step.onlyChanged) return false;
  const hash = sha256Text(said.trim());
  carry.said[step.id] = hash;
  return hands.saidBefore(step.id) === hash;
}

type Mark = (status: StepOutcome["status"], said?: string, more?: Partial<StepOutcome>) => void;

/** One step, begun: how it went, or the wait it started. */
async function runStep(
  job: Job,
  step: JobStep,
  at: { index: number; total: number; label: string; handedOn: boolean },
  hands: StepHands,
  carry: Carry,
  mark: Mark,
): Promise<Went> {
  const failed = (why: string): Went => {
    mark("failed", why);
    return { exit: "failed", why };
  };

  switch (step.kind) {
    case "systemEvent": {
      const sent = await hands.deliver(step.text);
      if (!sent.ok) {
        mark("failed", sent.error);
        return { halt: { status: "error", result: `${at.label} failed: ${sent.error}`, ...(sent.unreachable ? { unreachable: true } : {}) } };
      }
      mark("done", step.text);
      carry.told = true;
      // What the step before said goes on past a message, for the step after it. The chat has been told now, so a run
      // that ends here delivers nothing more.
      return { exit: "done", before: carry.before ? { ...carry.before, told: true } : { from: "The message", said: step.text, told: true } };
    }

    case "command": {
      // A webhook's body no step has read yet is this command's to read, on its standard input: what it prints is what
      // the run goes on with, so a script can drop a call before any agent is woken for it.
      const ran = await hands.command(step, carry.body);
      delete carry.body;
      if ("error" in ran) return failed(ran.error);
      if (!ran.output.trim()) {
        mark("empty", "printed nothing");
        return { exit: "empty" };
      }
      if (sameAsBefore(step, ran.output, hands, carry)) {
        mark("empty", SAME);
        return { exit: "empty", same: true };
      }
      mark("done", ran.output);
      return { exit: "done", before: { from: `The command \`${step.argv.join(" ")}\``, said: ran.output } };
    }

    case "agentTurn": {
      const message = stepTurnMessage(withTriggerBody(step.message, carry.body ? { body: carry.body } : undefined), { place: at.index + 1, total: at.total, handedOn: at.handedOn }, carry.before);
      delete carry.body;
      const turn = await hands.turn(step, message, carry.outside);
      if (turn.held?.length) carry.held.push(...turn.held);
      if (turn.skipped) {
        mark("skipped", turn.skipped);
        return { halt: { status: "skipped", result: `${at.label}: ${turn.skipped}` } };
      }
      if (turn.interrupted) {
        mark("interrupted", turn.interrupted);
        return { halt: { status: "interrupted", result: `${at.label}: ${turn.interrupted}` } };
      }
      if (turn.error) return failed(turn.error);
      if (!turn.text.trim()) {
        mark("empty", "had nothing to report");
        return { exit: "empty" };
      }
      if (sameAsBefore(step, turn.text, hands, carry)) {
        mark("empty", SAME);
        return { exit: "empty", same: true };
      }
      mark("done", turn.text);
      return { exit: "done", before: { from: `${step.agentId ?? job.agentId}`, said: turn.text } };
    }

    case "mission": {
      // Each part named when there are two, so the mission can tell a caller's payload from an earlier step's words.
      const said = carry.before?.said;
      const request = carry.body && said ? `The webhook's payload:\n${carry.body}\n\nWhat the step before said:\n${said}` : carry.body || said || undefined;
      delete carry.body;
      const run = hands.mission(step, request);
      if ("busy" in run) {
        mark("skipped", `mission ${run.busy} is still working`);
        return { halt: { status: "skipped", result: `the last run, mission ${run.busy}, is still working` } };
      }
      if ("refused" in run) return failed(run.refused);
      mark("waiting", `started mission ${run.started}`, { missionId: run.started });
      return { wait: { kind: "mission", step: step.id, missionId: run.started, since: hands.now() } };
    }

    case "approval": {
      const shown = carry.before ? carry.before.said.trim().slice(0, SAID_KEPT) : "";
      const asked = await hands.ask(step, shown);
      mark("waiting", step.ask);
      const since = asked?.from ?? hands.now();
      return { wait: { kind: "approval", step: step.id, since, until: since + (step.timeoutMs ?? APPROVAL_WAIT_MS), ask: step.ask }, ...(asked?.card ? { card: asked.card } : {}) };
    }
  }
}

/** The step a run waited in, now that the wait is over: how it went. */
function afterWait(woke: Woke, step: JobStep, hands: StepHands, carry: Carry, mark: Mark): Went {
  if (woke.kind === "mission") {
    if ("failed" in woke) {
      mark("failed", woke.failed);
      return { exit: "failed", why: woke.failed };
    }
    // A mission tells its chat how it ended, whatever the run does next.
    carry.told = true;
    if (sameAsBefore(step, woke.said, hands, carry)) {
      mark("empty", SAME);
      return { exit: "empty", same: true };
    }
    mark("done", woke.said);
    // A mission tells its chat how it ended, so its words are not delivered a second time as the run's.
    return { exit: "done", before: { from: "The mission", said: woke.said, told: true } };
  }
  if (woke.go) {
    mark("done", `${woke.by} said yes`, { by: woke.by });
    // A yes hands on what the step before said: the wait itself says nothing.
    return { exit: "done", ...(carry.before ? { before: carry.before } : {}) };
  }
  const why = woke.by ? `${woke.by} said no` : "nobody answered in time";
  mark(woke.by ? "declined" : "expired", why, woke.by ? { by: woke.by } : {});
  return { exit: "failed", why, declined: woke.by ? "declined" : "expired" };
}
