/**
 * Which exchanges are drawn from the history, and which one is drawn live.
 *
 * This is one decision and it has to be made in one place, because making it in two was a bug that
 * hid the newest exchange in every conversation. The two rules were written separately: "don't draw a
 * turn live if the history already has it", and "don't draw a turn in the history if it is the live
 * one". Both are individually sensible, and together they mean a finished turn that is *both* — which
 * is every conversation's last turn, the moment the transcript loads — is drawn by neither.
 *
 * What that looked like: open a conversation with one exchange in it and get a blank page. Send a
 * message and the older exchanges appear while the new one vanishes. Refresh and the newest is gone
 * again. Reported as "masuk history session tiba2 kosong… gw refresh yang baru ilang, yang lama
 * keload", and all three sentences are this function being two functions.
 *
 * So: decide what is live first, then let the history keep everything else.
 */

import type { ChatTurn, LiveTurn, TurnCause, TurnStep } from "@nouride/wire";

export interface Display {
  /** Drawn as finished exchanges, oldest first. */
  history: ChatTurn[];
  /** Drawn with the live step feed, or null. */
  live: LiveTurn | null;
}

export function splitForDisplay(recorded: ChatTurn[], live: LiveTurn | null, revealing: string | null = null): Display {
  /**
   * Live if it is still working, or if the history has not caught up with it yet, or if its answer is still being
   * shown (`revealing`, the turn `LiveTurnView` says it has not finished writing out).
   *
   * The second covers the moment between a turn ending and the transcript being refetched —
   * without it the answer blinks out of existence for a few hundred milliseconds. The third, an answer that came
   * whole as the turn ended: the history has every word of it a moment later, and drawn from there it was nothing
   * and then everything, where every other answer is written out.
   */
  const shown =
    live && (live.status === "running" || !recorded.some((turn) => turn.id === live.id) || live.id === revealing)
      ? live
      : null;

  return {
    // Everything the daemon has finished, except the one thing being drawn live. `running` is filtered
    // too, defensively: the daemon already withholds those, and a running turn drawn as a finished one
    // is the frozen `… 0 steps` bubble this whole rewrite started with.
    history: recorded.filter((turn) => turn.status !== "running" && turn.id !== shown?.id),
    live: shown,
  };
}

/**
 * The heading of a turn the daemon started, from why it did (`ChatTurn.cause`). It matched the wake-up message's
 * wording before — a rewording in the engine changed what the chat said had happened to a job, with every test green.
 * A turn that gives no reason says only that the daemon started it.
 */
export function systemHeading(cause: TurnCause | undefined): string {
  // An agent asked with `ask_agent` that answered from the background (0.7.19): named, since its answer is what this
  // turn passes on.
  if (cause?.via === "job completion" && cause.asked) {
    switch (cause.outcome) {
      case "finished":
        return `${cause.asked} answered from the background`;
      case "failed":
        return `${cause.asked} stopped short in the background`;
      case "stopped":
        return `${cause.asked}'s work in the background was stopped`;
      case "interrupted":
        return `${cause.asked}'s work in the background was interrupted`;
    }
  }
  if (cause?.via === "job completion") {
    // A helper `delegate` started reports back on its own: it is not a command, and the heading says which.
    const what = cause.helper ? "a background helper" : "a background job";
    switch (cause.outcome) {
      case "finished":
        return `${what} finished`;
      case "failed":
        return cause.helper ? "a background helper stopped short" : "a background job failed";
      case "stopped":
        return `${what} was stopped`;
      case "interrupted":
        return `${what} was interrupted`;
    }
  }
  if (cause?.via === "job quiet") return "a background job is still running";
  if (cause?.via === "cli own words") return "its coding CLI went on by itself";
  if (cause?.via === "cli stopped") return "a restart stopped a command its coding CLI had left running";
  if (cause?.via === "schedule") return "a scheduled job ran";
  return "Nouride started this turn";
}

/**
 * Whether a turn answered a person's edit — its cause is `edit` (the daemon's `EDITED`), whether the message was edited
 * while it waited or after an earlier turn had answered it. What puts the "edited" mark on the person's message. A turn
 * the daemon started is never one, whatever it says its cause is.
 */
export function answersAnEdit(turn: Pick<ChatTurn, "cause" | "system">): boolean {
  return turn.cause?.via === "edit" && turn.system !== true;
}

/**
 * A message said while a turn worked, as drawn: an edit (`editOf`, stream 1.3) is marked "edited" and its text loses the
 * `✎ ` the record puts in front for a reader that knows no `editOf` — the mark says it once, in words.
 */
export function saidAsDrawn(step: Pick<TurnStep, "text" | "editOf">): { text: string; edited: boolean } {
  if (step.editOf === undefined) return { text: step.text, edited: false };
  return { text: step.text.replace(/^✎ /, ""), edited: true };
}
