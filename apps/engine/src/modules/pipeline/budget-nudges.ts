/**
 * What a long run is told, and when — the two uses of `commons/budget-watch.ts` (0.7.25).
 *
 * Seen live: a delegate given a destructive job spent fourteen minutes on a production machine chasing a root cause
 * nobody had asked it to chase, and nothing in the harness said a word to it or to the agent waiting on it. There is
 * still no kill — the turn's clock (`llm.limits.max_turn_duration_ms`) is the only hard stop. What there is now is a nudge at
 * `[agents] nudge_after_minutes` (5) and then at each doubling (10, 20, 40…):
 *
 * - **A delegate** — a helper `delegate` runs, an agent `ask_agent` asked — reads a note before its next step: stop and
 *   report honestly if stuck. Once it is a job in the background, the agent that started it is told too, as a system
 *   event in its chat (`JobWakes.quiet`): it can wait, tell the person, or stop it.
 * - **A chat turn somebody is waiting on** reads a note too: send a one-line status, and stop if stuck.
 *
 * The note is read at a step boundary, never mid-call: `TurnRequest.harnessNote`, taken by the executor where it takes
 * a message the person sent meanwhile.
 */

import { BudgetWatch, type Nudge } from "@/commons/budget-watch.ts";
import { SAY_NOTHING } from "@/commons/silence.ts";

/** `[agents] nudge_after_minutes` in milliseconds. Zero, a negative or a non-number is off. */
export function nudgeBaseMs(minutes: number): number {
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/** A point on the schedule as a person says it: "5 min", or seconds for a base under a minute. */
export function sinceSaid(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** The note in front of a delegate. Nobody is watching it, so it is told what an honest stop looks like. */
export function delegateNote(ms: number): string {
  return (
    `[harness] You have been on this for ${sinceSaid(ms)}. If you are stuck, or it will take much longer, stop now and ` +
    "report honestly: what is done, what is not, where it is stuck, what you would need."
  );
}

/**
 * The note in a chat turn somebody is waiting on. The words beside a tool call reach the chat (`preamble.ts`). With
 * `mission`, the turn may hand what is left to a mission (0.8.0): a reply that grew is moved, not restarted.
 */
export function replyNote(ms: number, mission = false): string {
  return (
    `[harness] This reply has run ${sinceSaid(ms)}. Send the person a one-line status if you have not recently (a line ` +
    "written beside your next tool call reaches them), and if you are stuck, say so and stop." +
    (mission
      ? " If the rest will take much longer, hand it to a mission (`mission`, action start): this task's notes and plan go " +
        "with it, it goes on by itself, and the chat is free again."
      : "")
  );
}

/** What the agent that started a delegate in the background is told, in its own chat. */
export function leadNudgeText(params: { who: string; task: string; ms: number; job: string }): string {
  return [
    `[still working, not finished] ${params.who} has been working on "${params.task}" for ${sinceSaid(params.ms)} (${params.job}); ` +
      "it was asked to stop and report if it is stuck.",
    "",
    `You can wait, tell the person, or stop it with \`nouride jobs kill ${params.job}\`. It has no result yet. Do not ` +
      `report one. If the person needs to hear nothing now, ${SAY_NOTHING}.`,
  ].join("\n");
}

/** A turn's pending note and its watch: the executor takes the note, the caller stops the watch when the turn ends. */
export interface TurnNudges {
  take: () => string | null;
  stop: () => void;
}

/**
 * Watch one turn: at each nudge the note `say` writes waits for the turn's next step — one at a time, the newest — and
 * `also` hears the nudge (a delegate's lead, its job's log). Undefined when nudges are off.
 */
export function watchTurn(baseMs: number, say: (ms: number) => string, also?: (nudge: Nudge) => void): TurnNudges | undefined {
  if (baseMs <= 0) return undefined;
  let pending: string | null = null;
  const watch = new BudgetWatch({
    baseMs,
    what: "a long turn",
    onNudge: (nudge) => {
      pending = say(nudge.dueMs);
      also?.(nudge);
    },
  }).start();
  return {
    take: () => {
      const note = pending;
      pending = null;
      return note;
    },
    stop: () => watch.stop(),
  };
}
