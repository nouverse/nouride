/**
 * When to *look*, not what to conclude.
 *
 * ## The mistake this file used to make
 *
 * The first two versions tried to be clever here. Version one counted tool failures in one turn.
 * Version two added a table of Indonesian and English regexes for "bukan gitu" / "still broken", so
 * a conversation where the person kept correcting the agent would fire.
 *
 * Both were putting the intelligence in the wrong place. A regex over sentiment is a judgement about
 * *meaning*, and it fails in the way judgements-by-pattern always fail: silently, and only for people
 * whose phrasing nobody thought of. Someone working in Javanese, or Spanish, or simply saying "hmm,
 * try the other approach" gets nothing, and nothing anywhere says why. A detector you cannot tell is
 * broken is worse than one that is obviously crude.
 *
 * ## What it does instead
 *
 * Hermes Agent (`tmp/hermes-agent`, `agent/turn_finalizer.py`) settles this with one line:
 * `_iters_since_skill >= _skill_nudge_interval`. A counter of accumulated work. No language, no
 * sentiment, no failure classification — when enough has happened, go and *ask the model* whether
 * anything was learned. Every hard question is in their `_SKILL_REVIEW_PROMPT`, where a model reads
 * the actual conversation.
 *
 * That division is right and this file now follows it. Everything here is structural and free:
 * counting, exit codes, a name that has not been seen before. Whether the turn was a *struggle*,
 * whether the person was correcting or just chatting, whether the lesson generalizes — none of that
 * is decided here. It is decided in `synthesis.ts`, by something that can actually read.
 *
 * What we do not copy is the cost. Hermes forks a whole agent per review (~30K tokens by their own
 * note); this stays one `chat` call, with no harness and no judge model beside it, which is the entire point.
 */

import type { ToolStep, Trigger } from "./types.ts";

/**
 * Ways a person says "write that down".
 *
 * The one place a phrase table is still right, and the difference is that this matches a *command*
 * rather than a mood. "Catet jadi skill" is an instruction with the feature's own noun in it; there
 * is no inference to get wrong. A miss here is also cheap: every agent holds `skill_create` and will
 * simply do it itself.
 */
const EXPLICIT_REQUEST: RegExp[] = [
  // catet jadi skill ya / catat ilmunya jadi skill / dicatet jadi skill
  /\b(?:di)?cat[ae]t\w*\b[^.!?\n]{0,40}\bskill\b/i,
  // simpen jadi skill / simpan sebagai skill / disimpan jadi skill
  /\b(?:di)?simp[ae]n\w*\b[^.!?\n]{0,40}\bskill\b/i,
  // jadiin skill / jadikan skill dong
  /\bjadi(?:in|kan)\b[^.!?\n]{0,40}\bskill\b/i,
  // bikin skill / buat skill baru
  /\b(?:bikin|buat)\b[^.!?\n]{0,40}\bskill\b/i,
  // save this as a skill / remember this as a skill / turn this into a skill
  /\b(?:save|remember|turn|write|document|record)\b[^.!?\n]{0,40}\bskill\b/i,
  // make a skill out of this / create a skill for this
  /\b(?:make|create|add)\b[^.!?\n]{0,20}\bskill\b/i,
];

export function isExplicitRequest(text: string): boolean {
  return EXPLICIT_REQUEST.some((pattern) => pattern.test(text));
}

export interface TriggerInput {
  /** What the person typed this turn, before the harness wrapped it. */
  userText: string;
  /** Every tool call the turn made, in order. */
  steps: ToolStep[];
  /** Failures in one turn before a recovery is worth a look. `TUNING.minToolFailures`. */
  minToolFailures: number;
  /**
   * Model round-trips accumulated in this conversation since the last time the loop looked.
   *
   * Hermes' unit exactly (`_iters_since_skill`), and the right one. A turn is at least one
   * iteration and gains one for every round of tool use, so a hard turn counts for more than an
   * easy one and a long conversation of short exchanges reaches the same total more slowly. It also
   * counts a conversation where the agent runs *nothing* and simply keeps being redirected, which
   * is the case that has no other structural evidence at all.
   *
   * Measured live before it was chosen: a five-turn conversation where the person redirected the
   * agent four times came to exactly 10 iterations and 10 tool-calls-plus-messages. The first draft
   * of this counted the latter against a threshold of 12 and missed it by two.
   */
  effort: number;
  /** Iterations before the loop stops to consider what it learned. `TUNING.reflectAfter`. */
  reflectAfter: number;
  /**
   * Tools this agent succeeded with for the first time ever, this turn.
   *
   * Passed in rather than derived here: answering it needs the database, and a detector that reads
   * a table cannot be tested by calling it. See `ToolMemory`.
   */
  unfamiliarTools?: string[];
}

/**
 * The first rule that matches, or nothing.
 *
 * Called only after a turn that actually finished and replied. A turn that timed out or died halfway
 * has nothing to teach except that it did not work.
 *
 * Order is cheapest-and-most-certain first. Every one of these is a reason to *spend a triage call*
 * looking, and none of them is a claim that a skill exists — the pass declines most of the time, and
 * that is the design working rather than a shortfall in the rules here.
 */
export function detectTrigger(input: TriggerInput): Trigger | null {
  if (isExplicitRequest(input.userText)) {
    return { kind: "user_request", reason: "you asked for this to be written down as a skill" };
  }

  const recovery = detectRecovery(input.steps, input.minToolFailures);
  if (recovery) return recovery;

  if (input.effort >= Math.max(1, input.reflectAfter)) {
    return {
      kind: "sustained_effort",
      reason: `${input.effort} rounds of work in this conversation`,
    };
  }

  const unfamiliar = input.unfamiliarTools ?? [];
  if (unfamiliar.length > 0) {
    return {
      kind: "first_integration",
      reason: `first successful use of ${unfamiliar.slice(0, 3).join(", ")}`,
    };
  }

  return null;
}

/**
 * Failures, then a success after the last of them.
 *
 * Kept alongside the counter because it costs nothing and it is *precise*: it catches a single turn
 * that fought its way to an answer, which the counter would only reach several turns later. "After
 * the last one" is the load-bearing half — a turn that succeeded three times and then failed twice
 * ended broken, and writing that procedure down is precisely how a shared pool poisons itself.
 */
function detectRecovery(steps: ToolStep[], minToolFailures: number): Trigger | null {
  const failures = steps.filter((step) => !step.ok);
  if (failures.length < Math.max(1, minToolFailures)) return null;

  let lastFailure = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (!steps[index]?.ok) {
      lastFailure = index;
      break;
    }
  }
  const recovered = steps.slice(lastFailure + 1).some((step) => step.ok);
  if (!recovered) return null;

  const names = [...new Set(failures.map((step) => step.name))];
  return {
    kind: "error_recovery",
    reason: `${failures.length} tool failures (${names.join(", ")}), then it worked`,
  };
}
