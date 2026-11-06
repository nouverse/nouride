/**
 * When a round may start, and what a turn owes before it is allowed to end.
 *
 * Pulled out of the loop as decisions, not as a framework. There are exactly two points where the
 * executor asks "is this turn allowed to go on / to be over", and every answer at both of them was
 * learned from a turn that went wrong live — so each rule carries its reason with it, and each is a
 * pure function a test can reach without scripting a provider.
 *
 * Not here, on purpose: a tool asking to end the turn (`finishTurn`) and the owed-report note. Those
 * are things a *round* does to what the model reads next, not decisions about whether the turn goes
 * on, and folding them into one abstraction would make both harder to read.
 */

import type { StopReason } from "@nouride/shared";
import { outOfTimeForAnotherRound } from "./deadline.ts";

/**
 * Why a turn was wrapped up, when the reason is that it ran out — of clock, or of rounds — with work still to do.
 *
 * Named because a delegated turn's handoff reads them (`tools/handoff.ts`): the wrap-up call ends the loop with
 * `stop`, so a helper cut off by either one handed back `success` with a summary that said it had not finished.
 */
export const OUT_OF_TIME = "turn deadline";
export const OUT_OF_ROUNDS = "iteration cap";
/** Ended by `SameAnswers` (`nudges.ts`): the same call kept giving the same answer, and the work was not done. */
export const SAME_ANSWER = "same_answer";

export type RoundDecision =
  | { kind: "proceed" }
  | { kind: "stop" }
  | { kind: "wrap_up"; instruction: string; reason: string };

/** Asked at the top of every round, before anything is sent. */
export function beforeRound(input: {
  aborted: boolean;
  toolCallCount: number;
  deadlineAt?: number;
  maxTurnDurationMs: number;
  now: number;
}): RoundDecision {
  // Stopped from outside — `/stop`, a reset, shutdown. Nothing to say: the pipeline tells the person.
  if (input.aborted) return { kind: "stop" };
  /**
   * Out of clock, but not out of clock for *speaking* — see `deadline.ts`.
   *
   * Guarded on having done something: a turn that reaches its deadline before its first tool
   * result has nothing to summarize, and a wrap-up there would replace one unhelpful message
   * with another. With work behind it, the reply is the whole point.
   */
  if (
    input.toolCallCount > 0 &&
    outOfTimeForAnotherRound({
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
      maxTurnDurationMs: input.maxTurnDurationMs,
      now: input.now,
    })
  ) {
    return { kind: "wrap_up", instruction: wrapUpPrompt("deadline"), reason: OUT_OF_TIME };
  }
  return { kind: "proceed" };
}

/** Where the loop ended up, as the settle rules read it. */
export interface SettleState {
  iterations: number;
  maxIterations: number;
  stopReason: StopReason;
  finalText: string;
  toolCallCount: number;
  aborted: boolean;
}

/** One more call, tools withheld, with this instruction — or nothing, and the turn is over. */
export type Rescue = { instruction: string; reason: string } | null;

const ITERATION_CAP_PROMPT =
  "[system] Tool call limit reached. Summarize what you found or changed so far, then ask how to proceed. Do not request more tools.";

const EMPTY_REPLY_PROMPT =
  "[system] Your last reply came back empty. Say what you found or changed, in one short" +
  " message, and stop. Do not request more tools.";

/** The loop ran out of rounds while the model still wanted tools. */
function iterationCap(state: SettleState): Rescue {
  return state.iterations >= state.maxIterations && state.stopReason === "tool_calls"
    ? { instruction: ITERATION_CAP_PROMPT, reason: OUT_OF_ROUNDS }
    : null;
}

/**
 * A turn that did work and then said nothing gets one more chance to speak.
 *
 * The loop exits with no text whenever the model returns a final message that is empty — no
 * tool calls, no content. It happens: a reasoning model spends its whole response on thinking,
 * or a shredded context leaves it nothing to say. The turn was *not* a failure, so the pipeline
 * had no honest fallback for it and shipped a guess instead — "an approval timed out or was
 * denied", printed live to a chat where no approval had been anywhere near it, after 22 tool
 * calls that had all succeeded.
 *
 * The rescue already existed for the iteration cap, which is the same problem arrived at from
 * the other direction, so it is the same call. Skipped when the turn was aborted: the signal is
 * already dead, the provider call would fail on it, and "I ran out of time" is something the
 * pipeline can say without asking the model.
 */
function emptyReply(state: SettleState): Rescue {
  return !state.finalText.trim() && state.toolCallCount > 0 && !state.aborted
    ? { instruction: EMPTY_REPLY_PROMPT, reason: "empty reply after tool calls" }
    : null;
}

/**
 * Checked in this order, once each, after the loop.
 *
 * Order matters and is the old code's order: a capped turn is wrapped up first, and if *that* reply
 * comes back empty the empty-reply rule still gets its turn. Once each, because a rule that fired and
 * got nothing better must not fire forever — `wrapUp` has a last-resort sentence for that.
 */
export const SETTLE_RULES: ReadonlyArray<(state: SettleState) => Rescue> = [iterationCap, emptyReply];

/**
 * One final prompt when a tool wants the turn to stop early.
 *
 * The background-job case is the one that matters today: once detached work has started, another
 * tool round only burns time and invites the model to keep poking at a job it has already been told
 * it will hear about later.
 */
export function wrapUpPrompt(reason: string, turn: { asked?: boolean } = {}): string {
  // Another agent asked this turn (`ask_agent`): the job's end goes to that agent, never to this one (`job-wakes.ts`), and
  // "I'll follow up when it finishes" was a promise nothing could keep — on 0.8.7 the asking agent got the result and
  // had to ask again, three times in one evening.
  if (reason === "background_started" && turn.asked) {
    return (
      "[system] A background job has just been started. You are answering the agent that asked you: the job's end is" +
      " reported to that agent, not to you, and you are not woken when it finishes. In one short answer, say what is" +
      " running, with its job id, what you found before it, and that the agent that asked gets its result. Do not" +
      " promise to follow up, and do not call more tools."
    );
  }
  if (reason === "background_started") {
    return (
      "[system] A background job has just been started. In one short reply, confirm what is now" +
      " running in the background. Match the tone to the kind of work:\n" +
      "- If it is a finite task (install, build, test, deploy, clone, download, upload), say it is running and that" +
      " you will follow up with the result when it finishes.\n" +
      "- If it is a long-running service (dev server, preview, watcher, tunnel), say it has been" +
      " started, give the address or port it was started on, and say you have not checked it yet." +
      " Do not promise to report back; instead invite them to let you know if they need changes or" +
      " want it stopped.\n" +
      "Do not call more tools, do not greet, and do not ask what else is needed."
    );
  }
  if (reason === "helper_started") {
    /**
     * A helper is now working in the background (`delegate`, 0.7.15), and the turn ends so the person can talk to the
     * agent meanwhile. Its result arrives as a message of its own, so the one thing this reply must not do is say what
     * it found: the agent has not seen it. The person's language, because the brief was English and the reply is not.
     */
    return (
      "[system] A helper has just been started in the background, and this turn ends now so the person can talk to you" +
      " meanwhile. In one short reply, in the person's language: say what it is working on, and that you will report" +
      " when it is done. Its result comes to you as a message of its own, so do not guess what it will find. If they" +
      " also asked something you can answer without tools, answer it in the same reply. Do not call more tools and do" +
      " not greet."
    );
  }
  if (reason === "ask_in_background") {
    /**
     * An agent this one asked is still working, now in the background (`ask_agent`, 0.7.19), and the turn ends so the
     * person can talk to it meanwhile. The answer arrives as a message of its own: this reply says who is on what, and
     * must not guess what they will find.
     */
    return (
      "[system] An agent you asked is still working, now in the background, and this turn ends now so the person can talk" +
      " to you meanwhile. In one short reply, in the person's language: say who is working on what, and that you will pass" +
      " their answer on when it comes. It comes to you as a message of its own, so do not guess what it will say. If this" +
      " turn found anything else they asked for, say it too. Do not call more tools and do not greet."
    );
  }
  if (reason === "deadline") {
    /**
     * Written to produce a *report*, not an apology.
     *
     * The message this replaces — "I ran out of time on that one and stopped part-way" — was the
     * pipeline talking, and all it could say was that something had happened, never what. The model
     * has the whole turn in front of it and is the only thing that can say which parts landed.
     * Naming the unfinished half matters as much as the finished one: the next question is always
     * "so did it work", and a summary that omits what is still in flight invites the assumption
     * that it did.
     */
    return (
      "[system] This turn is out of time and ends after this message. Do not call any more tools." +
      " In one short reply say what you actually did and what you found, then what is still" +
      " unfinished or still running and how they can pick it up. If you were waiting on something" +
      " that has not finished, say what you were waiting on rather than guessing at its outcome."
    );
  }
  if (reason === SAME_ANSWER) {
    // `nudges.ts`, `SameAnswers`: the turn was polling for something that only arrives after it.
    return (
      "[system] The same call kept giving the same answer, so this turn ends here. In one short reply, in the person's" +
      " language: say what you did and what you are waiting on. It comes to you as a message of its own, so do not" +
      " guess what it will be. Do not call more tools."
    );
  }
  return "[system] Summarize the state so far in one short reply. Do not request more tools.";
}
