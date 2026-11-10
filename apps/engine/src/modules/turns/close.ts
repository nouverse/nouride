/**
 * Closing a turn that did not finish.
 *
 * One function for every way a turn ends early: `/stop`, a provider error after its retries, the
 * turn's deadline, a shutdown, and — at the next boot — a process that died without a signal. It takes
 * what the journal holds and returns messages a provider accepts:
 *
 * - **Every tool call gets exactly one result.** Both providers refuse a call without one, and an
 *   unclosed call poisons every later turn in the conversation. A call that was running when the turn
 *   was cut off is said to be cut off, and may have partly run; one that never started is said to have
 *   done nothing. Neither is run again — the harness never repeats a call on the model's behalf.
 * - **The last word is the assistant's,** a note saying what happened, so the next message from the
 *   person never sits next to a question or a tool result.
 *
 * Pure, so the crash at every boundary can be tested by closing every prefix of a journal.
 */

import { clip, messageText, type ChatMessage, oneLine } from "@nouride/shared";
import type { CutCall } from "./cut-calls.ts";
import { describeToolCall } from "@/commons/activity.ts";
import type { JournalEntry } from "./journal.store.ts";

/** Why a turn ended before it finished. */
export type InterruptCause =
  | { kind: "restart" }
  | { kind: "stopped" }
  | { kind: "deadline" }
  | { kind: "error"; message: string };

export interface ClosedTurn {
  /** The turn's messages, from the question on: every call answered, the assistant's word last. */
  messages: ChatMessage[];
  /**
   * The answer, when the journal already held it: the turn finished and only its settle was lost, so
   * this is delivered rather than reported as an interruption.
   */
  answer?: string;
  /** The calls that returned, described the way the progress line describes them. */
  done: string[];
  /** The calls that were running when the turn was cut off. They may have partly run. */
  cut: string[];
  /** The same calls as they were made — what taking the turn up again reads (`cut-calls.ts`). */
  cutCalls: CutCall[];
  /** The calls asked for but never started. Nothing happened. */
  notStarted: string[];
  /**
   * Set when the journal has a hole — a write that failed. What it held is not here, so no call is said
   * not to have started, and the report says the list may be short.
   */
  incomplete?: true;
}

/** How the cause reads inside a sentence: "cut off by a restart". */
function phrase(cause: InterruptCause): string {
  switch (cause.kind) {
    case "restart":
      return "a restart";
    case "stopped":
      return "a stop";
    case "deadline":
      return "the turn's time limit";
    case "error":
      return "an error";
  }
}

/** The assistant's last word on a turn that did not finish — written into the conversation. */
function closingNote(cause: InterruptCause, worked: boolean): string {
  // The words `/stop` has always left, kept: they are what the next turn reads, and they are right.
  if (cause.kind === "stopped") {
    return "[harness] They stopped me here, before I answered. The request above still stands unless they say otherwise.";
  }
  const why = cause.kind === "error" ? `I could not finish this: ${cause.message}` : `I was interrupted here by ${phrase(cause)}, before I finished`;
  return worked
    ? `[harness] ${why}. What I did so far is above; asked to continue, I pick up from there.`
    : `[harness] ${why}. The request above still stands; asked to continue, I start on it.`;
}

function cutOff(cause: InterruptCause): string {
  return `[interrupted] Cut off by ${phrase(cause)} while it ran. It was not run again, and it may have partly run: check before running it again.`;
}

function neverStarted(cause: InterruptCause): string {
  return `[interrupted] Not started: the turn was cut off by ${phrase(cause)} before this ran. Nothing happened.`;
}

/**
 * Close a turn from its journal entries.
 *
 * Synthetic results go right after the real results of the round that asked for them, in the order
 * the model asked — the shape the executor itself produces, so nothing downstream can tell a closed
 * round from a finished one except by reading what the result says.
 */
export function closeTurn(
  entries: readonly JournalEntry[],
  cause: InterruptCause,
  options: { now?: number; complete?: boolean } = {},
): ClosedTurn {
  const now = options.now ?? Date.now();
  const complete = options.complete ?? true;
  // An empty reply with no calls carries nothing, and kept it would sit beside the answer that replaced it.
  const journaled = entries.flatMap((entry) =>
    "message" in entry && !(entry.message.role === "assistant" && !entry.message.toolCalls?.length && !messageText(entry.message.content).trim()) ? [entry.message] : [],
  );
  const started = new Set(entries.flatMap((entry) => ("started" in entry ? entry.started : [])));
  const answered = new Set(journaled.flatMap((message) => (message.role === "tool" && message.toolCallId ? [message.toolCallId] : [])));

  const messages: ChatMessage[] = [];
  const done: string[] = [];
  const cut: string[] = [];
  const cutCalls: CutCall[] = [];
  const notStarted: string[] = [];

  for (let i = 0; i < journaled.length; i += 1) {
    const message = journaled[i]!;
    messages.push(message);
    const calls = message.role === "assistant" ? (message.toolCalls ?? []) : [];
    if (calls.length === 0) continue;
    // The round's own results follow the assistant message; a closed call goes after the last of them.
    while (i + 1 < journaled.length && journaled[i + 1]!.role === "tool") messages.push(journaled[++i]!);
    for (const call of calls) {
      const described = describeToolCall(call.name, call.arguments);
      if (answered.has(call.id)) {
        done.push(described);
        continue;
      }
      // Past a hole, a start that was not recorded may still have happened: cut off, never "nothing happened".
      const running = started.has(call.id) || !complete;
      (running ? cut : notStarted).push(described);
      if (running) cutCalls.push({ name: call.name, arguments: call.arguments });
      messages.push({ role: "tool", toolCallId: call.id, content: running ? cutOff(cause) : neverStarted(cause), timestamp: now });
    }
  }

  const last = messages.at(-1);
  // The answer was written and the turn simply never settled: there is nothing to close.
  if (last && last.role === "assistant" && !(last.toolCalls?.length) && messageText(last.content).trim() && cut.length + notStarted.length === 0) {
    return { messages, answer: messageText(last.content), done, cut, cutCalls, notStarted, ...(complete ? {} : { incomplete: true as const }) };
  }

  messages.push({ role: "assistant", content: closingNote(cause, done.length + cut.length > 0), timestamp: now });
  return { messages, done, cut, cutCalls, notStarted, ...(complete ? {} : { incomplete: true as const }) };
}

/** At most this many calls named per list; the rest are counted. */
const LISTED = 4;

function list(items: readonly string[]): string {
  const shown = items.slice(0, LISTED).map((item) => `\`${item}\``).join(", ");
  return items.length > LISTED ? `${shown} and ${items.length - LISTED} more` : shown;
}

/**
 * How a turn a restart cut off goes on from there, which is what its report ends on. It used to end on one promise
 * whatever came next, "I'll carry on once I'm back": true of a daemon back in minutes, and after a power cut of an
 * hour the last thing its person heard.
 */
export type Onward =
  /** Said as the daemon stops: it cannot know how long it will be down, so it says what each case brings. */
  | { kind: "if-soon"; withinMs: number }
  /** Said at boot of a turn lost moments ago, which is being taken up. */
  | { kind: "now" }
  /** Said at boot of a turn cut off too long ago to take up unasked: its person is asked. */
  | { kind: "asked"; agoMs: number }
  /** Said at boot of a turn that is neither: a mission's, a schedule's, one left for a person to check, or one too old to ask about. */
  | { kind: "kept"; agoMs?: number };

/** A stretch of time as a person says it: "20 minutes", "1 hour", "2 days". */
function span(ms: number): string {
  const said = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return said(minutes, "minute");
  const hours = Math.round(minutes / 60);
  return hours < 24 ? said(hours, "hour") : said(Math.round(hours / 24), "day");
}

/** How a report or a question opens: by what cut the turn off, or, once that is a while ago, by how long ago. */
function opening(agoMs: number | undefined): string {
  return agoMs === undefined ? "I was interrupted by a restart" : `I was cut off ${span(agoMs)} ago`;
}

const ASK_TO_CARRY_ON = `I have not carried on by myself, since it was a while ago. Say "continue" and I will pick it up.`;

/**
 * What the person is told about a turn a restart cut off — built from the journal, never asked of the
 * model, so it cannot claim work that did not happen. It ends on what happens next (`Onward`), and promises
 * nothing that may not.
 */
export function interruptionReport(closed: ClosedTurn, prompt: string, onward: Onward): string {
  const quoted = clip(oneLine(prompt), 80);
  const unrecorded = closed.incomplete ? ` Part of what I did could not be recorded, so this may not be all of it. Check before running anything again.` : "";
  const ago = onward.kind === "asked" || onward.kind === "kept" ? onward.agoMs : undefined;
  if (closed.done.length + closed.cut.length === 0) {
    const next =
      onward.kind === "if-soon"
        ? `Your message is kept. If I'm back within ${span(onward.withinMs)} I'll answer it by myself; after that I'll ask you first.`
        : onward.kind === "now"
          ? `Your message is kept, and I'm answering it now. If I don't, say "continue".`
          : onward.kind === "asked"
            ? `Your message is kept. I have not answered it by myself, since it was a while ago. Say "continue" and I will.`
            : "Your message is kept.";
    return `⚠️ ${opening(ago)} before I could answer "${quoted}".${unrecorded} ${next}`;
  }
  const parts = [`⚠️ ${opening(ago)} while working on "${quoted}".`];
  if (closed.done.length) parts.push(`Done: ${list(closed.done)}.`);
  if (closed.cut.length) parts.push(`Cut off: ${list(closed.cut)} (${closed.cut.length === 1 ? "it" : "they"} may have partly run).`);
  if (closed.notStarted.length) parts.push(`Not started: ${list(closed.notStarted)}.`);
  if (unrecorded) parts.push(unrecorded.trim());
  parts.push(
    onward.kind === "if-soon"
      ? `Everything I did is kept. If I'm back within ${span(onward.withinMs)} I'll carry on by myself; after that I'll ask you first.`
      : onward.kind === "now"
        ? `Everything I did is kept, and I'm carrying on now. If I don't, say "continue".`
        : onward.kind === "asked"
          ? `Everything I did is kept. ${ASK_TO_CARRY_ON}`
          : "Everything I did is kept.",
  );
  return parts.join(" ");
}

/**
 * What a chat is asked at boot about a turn the last process's shutdown stopped longer ago than a turn is taken up
 * unasked. Its person was told what it had done as it stopped, so this says only what, how long ago, and how to go on.
 */
export function resumeQuestion(prompt: string, agoMs: number): string {
  return `${opening(agoMs)} while working on "${clip(oneLine(prompt), 80)}". ${ASK_TO_CARRY_ON}`;
}

/** What that question's message reads once its Continue was pressed: taken up now, or already taken up before. */
export function resumeSettled(prompt: string, now: boolean): string {
  const quoted = clip(oneLine(prompt), 80);
  return now ? `I was cut off while working on "${quoted}". Carrying on now, as asked.` : `I was cut off while working on "${quoted}". I have carried on with it already.`;
}

/** The sentence added to an error reply when the turn had done work worth keeping. */
export function keptSentence(closed: ClosedTurn): string | null {
  return closed.done.length + closed.cut.length > 0 ? `What I did so far is kept: say "continue" and I will pick up from there.` : null;
}

/**
 * What a turn its provider ended promises its person, last in its reply — `pipeline/provider-resume.ts`. Only said:
 * that a turn promised it is a mark on its record (`FinishTurn.retryPromised`), so these words are free to change.
 */
const RETRY_PROMISE = `I'll try again in a few minutes, or say "continue".`;

/**
 * The words that promise was made in before a turn's record carried the mark, and the only trace of one made then.
 * Never reworded, whatever `RETRY_PROMISE` becomes: a turn that failed under them minutes before the update that
 * brought the mark is found by them at that update's own restart, and by nothing else. The next minor deletes this
 * and its reader: a promise is kept within the few minutes its timer waits, so none made then is still owed.
 */
const RETRY_PROMISE_BEFORE_THE_MARK = `I'll try again in a few minutes, or say "continue".`;

/** The same, for a turn its provider ended that will be tried again by itself — `pipeline/provider-resume.ts`. */
export function retrySentence(closed: ClosedTurn): string {
  return closed.done.length + closed.cut.length > 0 ? `What I did so far is kept, and ${RETRY_PROMISE}` : RETRY_PROMISE;
}

/**
 * Whether a turn's stored reply made that promise in the words it had before the record carried a mark. Read at boot,
 * for a turn the mark does not find: the timer that kept the promise lived in the process a restart ended.
 */
export function promisedRetryBeforeTheMark(reply: string): boolean {
  return reply.endsWith(RETRY_PROMISE_BEFORE_THE_MARK);
}
