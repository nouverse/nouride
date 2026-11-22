/**
 * The steps a `parallel` step starts together: agents' turns and commands, each handed what the step before said, all
 * begun at once. The step ends when the last of them has, and what they said is joined here, each under its name, with
 * no model between: a person who asked three agents the same morning question reads three answers, not a fourth
 * agent's account of them.
 *
 * One that failed makes the whole step's failed exit, and what the others said is kept beside the reason, so the step
 * a failure goes on to has both. One whose agent is asleep or busy is a failure of that one, not the end of the run,
 * as it is for a step alone: the others' work stands. Only the daemon going down ends the run here.
 *
 * Nothing here knows where the run goes next or what the run keeps: `steps.ts` reads what this returns.
 */

import type { HeldAction, Job, JobStep, StepOutcome, TogetherStep } from "@nouride/shared";
import { handedTo, STEP_SAID_MAX, stepTurnMessage, withTriggerBody, type StepBefore } from "./prompts.ts";
import type { StepHands } from "./steps.ts";

/** At least two, or it is a step alone; at most this many (a starting value): each is a turn or a command at once. */
export const TOGETHER_MIN = 2;
export const TOGETHER_MAX = 5;

/** How much of what one of them said is kept on the run, as a step's own words are. */
const SAID_KEPT = 2000;

type Group = Extract<JobStep, { kind: "parallel" }>;

/** How the steps started together went, as one: what they said joined, and why the step failed when one of them did. */
export interface TogetherEnd {
  went: "done" | "failed" | "empty" | "interrupted";
  /** What they said, each under its name; with `failed`, the ones that failed among them, with why. */
  said: string;
  /** With `failed` or `interrupted`: which, and why, in one line. */
  why?: string;
  parts: StepOutcome[];
  held: HeldAction[];
}

/** What one of them is called over its words: its name, or whose turn or which command it is. */
function partName(job: Pick<Job, "agentId">, part: TogetherStep): string {
  if (part.name?.trim()) return part.name.trim();
  return part.kind === "command" ? (part.script ? part.script.about.trim() : `\`${part.argv.join(" ")}\``) : (part.agentId ?? job.agentId);
}

type PartEnd = { said: string } | { empty: true } | { failed: string } | { interrupted: string };

export async function runTogether(
  job: Job,
  step: Group,
  at: { place: number; total: number; handedOn: boolean },
  hands: Pick<StepHands, "command" | "turn" | "now">,
  given: { body?: string; before?: StepBefore; outside: boolean },
  /** Told as each of them begins and ends, so a run at work can be read. */
  note: (parts: readonly StepOutcome[]) => void,
): Promise<TogetherEnd> {
  const began = hands.now();
  const parts: StepOutcome[] = step.steps.map((part) => ({ id: part.id, kind: part.kind, status: "running", startedAt: began }));
  const held: HeldAction[] = [];
  note(parts);
  const settle = (index: number, status: StepOutcome["status"], said: string): void => {
    parts[index] = { ...parts[index]!, status, ...(said.trim() ? { said: said.trim().slice(0, SAID_KEPT) } : {}), ms: hands.now() - began };
    note(parts);
  };

  const one = async (part: TogetherStep, index: number): Promise<PartEnd> => {
    if (part.kind === "command") {
      // Each reads the webhook's body the run was set off with: they start from the same thing. A script kept in the job
      // reads what the step before said where there is no body, as one that is a step alone does.
      const ran = await hands.command(part, given.body ?? (part.script ? handedTo(given.before) : undefined));
      if ("error" in ran) return settle(index, "failed", ran.error), { failed: ran.error };
      if (!ran.output.trim()) return settle(index, "empty", "printed nothing"), { empty: true };
      return settle(index, "done", ran.output), { said: ran.output };
    }
    const message = stepTurnMessage(withTriggerBody(part.message, given.body ? { body: given.body } : undefined), { ...at, together: step.steps.length }, given.before);
    const turn = await hands.turn(part, message, given.outside);
    if (turn.held?.length) held.push(...turn.held);
    if (turn.interrupted) return settle(index, "interrupted", turn.interrupted), { interrupted: turn.interrupted };
    // Asleep or busy: this one did not run. The others did, and their work is not thrown away for it.
    if (turn.skipped) return settle(index, "failed", turn.skipped), { failed: turn.skipped };
    if (turn.error) return settle(index, "failed", turn.error), { failed: turn.error };
    if (!turn.text.trim()) return settle(index, "empty", "had nothing to report"), { empty: true };
    return settle(index, "done", turn.text), { said: turn.text };
  };

  // Started in the order they are written, none waiting for another. One that throws is that one's failure: the
  // others are still at work and what they say is kept.
  const ends = await Promise.all(
    step.steps.map((part, index) =>
      one(part, index).catch((err: unknown): PartEnd => {
        const why = err instanceof Error ? err.message : String(err);
        settle(index, "failed", why);
        return { failed: why };
      }),
    ),
  );

  const names = step.steps.map((part) => partName(job, part));
  const stopped = ends.flatMap((end, index) => ("interrupted" in end ? [`${names[index]}: ${end.interrupted}`] : []));
  const failures = ends.flatMap((end, index) => ("failed" in end ? [`${names[index]}: ${end.failed}`] : []));
  const spoke = ends.flatMap((end, index) => ("said" in end ? [{ name: names[index]!, said: end.said.trim() }] : []));
  const said = joined(spoke, ends.flatMap((end, index) => ("failed" in end ? [{ name: names[index]!, why: end.failed }] : [])));

  if (stopped.length > 0) return { went: "interrupted", said, why: stopped.join("; "), parts, held };
  if (failures.length > 0) return { went: "failed", said, why: failures.join("; "), parts, held };
  if (spoke.length === 0) return { went: "empty", said: "", parts, held };
  return { went: "done", said, parts, held };
}

/**
 * What they said as one text: each under its name, in the order they are written, then the ones that failed with why.
 * Together they are held to what a step is shown of the one before it: when they are longer, each is cut to its share,
 * so one long answer does not push the others out.
 */
function joined(spoke: readonly { name: string; said: string }[], failed: readonly { name: string; why: string }[]): string {
  const total = spoke.reduce((sum, one) => sum + one.said.length, 0);
  const share = spoke.length > 0 ? Math.floor(STEP_SAID_MAX / spoke.length) : STEP_SAID_MAX;
  const cut = (text: string): string => (total > STEP_SAID_MAX && text.length > share ? `${text.slice(0, share)}\n…(cut, ${text.length} characters in all)` : text);
  return [...spoke.map((one) => `**${one.name}**\n${cut(one.said)}`), ...failed.map((one) => `**${one.name}** failed: ${one.why}`)].join("\n\n");
}
