/**
 * A mission's turns as its page's timeline (0.8.8): newest first, each with why it started — in words a person reads,
 * not the wake-up the daemon wrote for the model — how it went, and how long after the one before it began. Turns that
 * failed the same way in a row are one entry: msn_2fa88b's first three each said "Claude Code did not start: … session
 * limit", three blocks of the same words. Pure, so each reading is tested on its own (`tests/missions-timeline.test.ts`).
 */

import type { ChatTurn } from "@nouride/wire";
import { whyStarted } from "./mission";

/** What started a turn, as the timeline marks it. */
export type ReasonKind = "start" | "next" | "person" | "told" | "answer" | "job" | "approval" | "working" | "retry" | "restart" | "other";

export interface Reason {
  kind: ReasonKind;
  text: string;
}

/** The mission page's "Why this turn:" — every line of it, up to the checklist's line that follows it (`page.ts`). */
function whyBlock(prompt: string): string | null {
  const block = /^Why this turn: ([\s\S]*?)\nChecklist:/m.exec(prompt)?.[1];
  return block?.trim() || null;
}

/**
 * Why a turn started, read from what the daemon wrote it — its page's "Why this turn:", which for a wake-up is the
 * wake-up's whole text. Each pattern is a sentence the daemon writes (`jobs/*-wake-text.ts`, `missions/*`); a turn none
 * matches reads as `whyStarted` says it.
 */
export function reasonOf(turn: Pick<ChatTurn, "prompt" | "cause" | "system">): Reason {
  const why = whyBlock(turn.prompt) ?? "";
  const answered = /The answer from (\S+) has arrived/.exec(why);
  if (answered) return { kind: "answer", text: `${answered[1]} answered` };
  const helper = /Background helper \S+ \(".*?"\) (finished|was stopped|was interrupted|stopped)/.exec(why);
  if (helper) return { kind: "job", text: `a background helper ${helper[1] === "stopped" ? "stopped short" : helper[1]}` };
  const job = /Background job \S+ (finished|failed|was stopped|was killed|was interrupted)/.exec(why);
  if (job) return { kind: "job", text: `a background job ${job[1]}` };
  // "[still working \u2014 not finished]" before 0.8.16, in the turns stored then.
  const working = /^\[still working(?: \u2014|,) not finished\] (\S+) has been working on .* for ([^(]+?) \(/.exec(why);
  if (working) return { kind: "working", text: `${working[1]} still working, ${working[2]} in` };
  const approval = /^\[system\] \S+ has just (approved|refused) the `([^`]+)` call/.exec(why);
  if (approval) return { kind: "approval", text: `${approval[2]} ${approval[1]}` };
  const said = whyStarted(turn);
  if (/^the mission starts/i.test(said)) return { kind: "start", text: "the mission started" };
  if (/^continue/i.test(said)) return { kind: "next", text: "on to the next step" };
  if (/ said to go on| answered your question/.test(said)) return { kind: "person", text: said };
  // `checking.ts` (0.8.10): its checks passed with a person's words still unread.
  if (/while they ran a person told you something/.test(said)) return { kind: "told", text: "to read what a person told it during its checks" };
  if (/model could not answer/.test(said)) return { kind: "retry", text: "tried again after its model failed" };
  if (/the daemon restarted/.test(said)) return { kind: "restart", text: "after a restart" };
  return { kind: "other", text: said.startsWith("[") ? "a system event" : said };
}

/** A wait before a turn shorter than this is the daemon's own pace between turns, not worth a line. */
const WAIT_SHOWN_MS = 2 * 60_000;

export type TimelineEntry =
  | { kind: "turn"; number: number; turn: ChatTurn; reason: Reason; waitedMs: number | null }
  /** Failed turns in a row with the same error, oldest `from` to newest `to`: one entry, its error said once. */
  | { kind: "repeat"; from: number; to: number; turns: ChatTurn[]; error: string; waitedMs: number | null };

const sameFailure = (turn: ChatTurn, error: string | undefined): boolean => turn.status === "failed" && Boolean(error) && (turn.error ?? "").trim() === error;

/** The turns, newest first, with what came before each: the wait before it, and failures in a row folded into one. */
export function timelineOf(turns: readonly ChatTurn[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let index = 0;
  while (index < turns.length) {
    const turn = turns[index]!;
    const before = turns[index - 1];
    const ended = before ? (before.endedAt ?? before.startedAt + (before.durationMs ?? 0)) : null;
    const waited = ended === null ? null : turn.startedAt - ended;
    const waitedMs = waited !== null && waited >= WAIT_SHOWN_MS ? waited : null;
    const error = turn.status === "failed" ? turn.error?.trim() : undefined;
    let last = index;
    while (error && turns[last + 1] && sameFailure(turns[last + 1]!, error)) last += 1;
    if (last > index) {
      entries.push({ kind: "repeat", from: index + 1, to: last + 1, turns: turns.slice(index, last + 1), error: error!, waitedMs });
    } else {
      entries.push({ kind: "turn", number: index + 1, turn, reason: reasonOf(turn), waitedMs });
    }
    index = last + 1;
  }
  return entries.reverse();
}
