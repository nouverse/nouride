/**
 * A mission among the things that wait for the person (Home's cards, Work, the count in the menu): which missions
 * those are, and what each waits for in a few words of its own.
 *
 * Every one of them used to say "Waiting for your answer". A draft the person had asked to be kept for later stood
 * there as a question, and a mission that had asked one while it went on working was not there at all.
 */

import type { MissionAnswered, MissionView } from "@nouride/wire";

type Asking = Pick<MissionView, "status" | "waitKind"> & { answers?: readonly MissionAnswered[] };

/**
 * The question it asked that nobody has answered, by the daemon's own rule (`missions/asking.ts`): one asked since
 * questions leave when they are asked, or the one a mission is waiting on. Never an old unanswered line of a mission
 * doing something else, and nothing once it has ended.
 */
export function openQuestion(mission: Asking): MissionAnswered | null {
  const last = mission.answers?.at(-1);
  const ended = mission.status === "done" || mission.status === "failed" || mission.status === "stopped";
  if (!last || last.answer !== undefined || ended) return null;
  return last.asked !== undefined || (mission.status === "waiting" && mission.waitKind === "input") ? last : null;
}

/** At work with a question open: it asked and went on with what did not depend on the answer. */
export function asksWhileWorking(mission: Asking): boolean {
  return mission.status === "running" && openQuestion(mission) !== null;
}

/**
 * Whether it waits for the reader. One at work with a question open does. An approval is counted and answered as one,
 * and a mission paused because its model could not answer tries again by itself: neither is a card. Nor is one the
 * reader only reads, which waits for its own person.
 */
export function waitsForReader(mission: Asking & Pick<MissionView, "seen" | "changeable">): boolean {
  if (mission.changeable === false) return false;
  if (asksWhileWorking(mission)) return true;
  return mission.seen === "needs_you" && mission.waitKind !== "approval" && mission.waitKind !== "retry";
}

/** A question on one line, as a card's line carries it: its options were listed under it, a line each. */
function onOneLine(question: string): string {
  return question.replace(/\s+/g, " ").trim();
}

/** What it waits for, as its card says it: the question where it asked one, else the wait in its own words. */
export function waitingLine(mission: Asking & Pick<MissionView, "startedAt">): string {
  const open = openQuestion(mission);
  if (asksWhileWorking(mission) && open) return `Asks, and works on meanwhile: ${onOneLine(open.question)}`;
  switch (mission.waitKind) {
    case "input":
      return open ? `Waiting for your answer: ${onOneLine(open.question)}` : "Waiting for your answer";
    case "accept":
      return mission.startedAt === null ? "A draft, not started yet. Start it or drop it" : "Its result is ready. Accept it or send it back";
    case "limit":
      return "Stopped at a limit. Let it go on or end it";
    case "stuck":
      return "Stuck. See what stopped it";
    case "unknown_outcome":
      return "Cut off by a restart. Check it, then let it go on";
    default:
      return "Waiting for you";
  }
}
