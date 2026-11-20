/**
 * The Missions board's decisions, apart from drawing them: which column a mission is in, how it ended, the line its card
 * leads with and its one time line, which column a phone opens on, and what an old link's tab now means. Pure, so each
 * is tested on its own (`tests/missions-board.test.ts`).
 *
 * Three stages and a history, read only: a mission moves on its own, so there is nothing to drag. **Backlog** is the
 * drafts, which run when a person starts them; **Working** is at work (queued, running, checking, or waiting on someone
 * who is not the reader, or held up for its model and trying again by itself); **Needs you** waits on the reader (a question, approvals, a limit, a result to accept, or a
 * mission paused, under its own "Paused" tag with Resume) and never holds a draft. **Finished** is done, failed or stopped, within its own span: what has been, not a stage, so on a
 * wide page it is a list under the three and only on a phone a fourth tab.
 */

import type { MissionView } from "@nouride/wire";
import { asksWhileWorking, openQuestion } from "@/commons/lib/mission-waits";
import { ago } from "@/commons/lib/format";
import { dayOf, fullWhen } from "@/commons/lib/when";
import { isDraft, isHeldUp, isPaused, needsYouSaid, triesAgain, waitsElsewhere } from "./mission";

export type Column = "backlog" | "working" | "needs" | "finished";
export type Outcome = "done" | "failed" | "stopped";

/** A phone's tabs, in order; on a wide page the first three are the columns and Finished the list under them. */
export const COLUMNS: readonly { id: Column; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "working", label: "Working" },
  { id: "needs", label: "Needs you" },
  { id: "finished", label: "Finished" },
];

/** The three a mission is still open in: the columns of a wide page. */
export const STAGES: readonly Column[] = ["backlog", "working", "needs"];

/**
 * How many a column shows before "Show N more", the same in every column: a backlog of forty drafts pushed Working and
 * Needs you out of sight, as a week of finished ones had.
 */
export const SHOWN = 5;

/** How far back Finished goes: a week unless chosen, a month at most, the daemon's own bound (`GET /missions?days=`). */
export const FINISHED_SPANS = [7, 14, 21, 30] as const;
export type FinishedSpan = (typeof FINISHED_SPANS)[number];
export const FINISHED_SPAN: FinishedSpan = 7;

/**
 * The column a mission is in. One that waits on someone who is not the reader is at work as they see it; one at work
 * that asked the reader a question needs them, since the answer is theirs to give.
 */
export function columnOf(mission: Pick<MissionView, "seen" | "status" | "waitKind" | "startedAt" | "changeable"> & { answers?: MissionView["answers"] }): Column {
  if (isDraft(mission)) return "backlog";
  if (mission.seen === "done" || mission.seen === "ended") return "finished";
  if (waitsElsewhere(mission) || isHeldUp(mission)) return "working";
  if (mission.seen === "needs_you") return "needs";
  return asksWhileWorking(mission) && mission.changeable !== false ? "needs" : "working";
}

/** How a finished mission ended. */
export function outcomeOf(mission: Pick<MissionView, "status">): Outcome {
  return mission.status === "failed" ? "failed" : mission.status === "stopped" ? "stopped" : "done";
}

/** The words on a card's badge. */
export function badgeOf(mission: MissionView): string {
  const column = columnOf(mission);
  if (column === "backlog") return "Draft";
  if (column === "finished") return { done: "Done", failed: "Failed", stopped: "Stopped" }[outcomeOf(mission)];
  if (column === "working") {
    if (waitsElsewhere(mission)) return `Waiting for ${mission.person?.name ?? "an admin"}`;
    if (isHeldUp(mission)) return "Held up";
    return mission.status === "queued" ? "Queued" : mission.status === "checking" ? "Checking" : "Working";
  }
  if (asksWhileWorking(mission) || mission.waitKind === "input") return "Needs you · a question";
  return { approval: "Needs you · approval", limit: "Needs you · a limit", accept: "Needs you · accept", stuck: "Needs you · stuck", unknown_outcome: "Needs you · check", retry: "Needs you", input: "Needs you · a question", paused: "Paused" }[mission.waitKind ?? "retry"];
}

/** What it takes to be done, said for a draft: its checks, then the person's accept or the reviewer, where either is on. */
export function doneWhen(mission: Pick<MissionView, "checks" | "accept" | "reviewOn">): string {
  const checks = mission.checks.length;
  const passing = checks === 0 ? "it says it is done" : `${checks} check${checks === 1 ? "" : "s"} pass`;
  return mission.accept ? `${passing}, then you accept` : mission.reviewOn ? `${passing}, then a reviewer signs it off` : passing;
}

/** The one line that matters on a card, by its column: when it is done, what it does now, what it asks, how it ended. */
export function cardLine(mission: MissionView, now: number = Date.now()): { label: string; text: string } | null {
  const column = columnOf(mission);
  if (column === "backlog") return { label: "Done when", text: doneWhen(mission) };
  if (column === "needs") {
    if (isPaused(mission)) return { label: "Paused", text: `by ${mission.pausedBy ?? "someone"}. Its work so far is kept. Resume lets it go on.` };
    const asked = openQuestion(mission);
    return { label: asked ? "Asks" : "Needs", text: asked ? asked.question.replace(/\s+/g, " ").trim() : needsYouSaid(mission) };
  }
  if (column === "working") {
    if (waitsElsewhere(mission)) return { label: "Waits", text: `Only ${mission.person?.name ?? "an admin"} can answer what it waits for.` };
    if (isHeldUp(mission)) return { label: "Held up", text: `Its model could not answer. ${triesAgain(mission.retryAt, now)}` };
    if (mission.status === "queued") return { label: "Queued", text: mission.reason ?? "waits for a free slot" };
    if (mission.status === "checking") return { label: "Now", text: "running its checks" };
    return { label: "Now", text: mission.checklist?.active ?? (mission.checklist ? "between steps" : "writing its checklist") };
  }
  const outcome = outcomeOf(mission);
  if (outcome === "failed") return mission.reason ? { label: "Why", text: mission.reason } : null;
  // The daemon writes who stopped it as "stopped by <who>" (`missions/person.ts`).
  if (outcome === "stopped") return mission.reason ? { label: "By", text: mission.reason.replace(/^stopped by\s+/i, "") } : null;
  return null;
}

/** The moments of a mission its time line leaves out, each whole: when it was made, started, has waited since, ended. */
export function whenLines(mission: MissionView): { label: string; at: number }[] {
  const column = columnOf(mission);
  return [
    { label: "Created", at: mission.createdAt },
    ...(mission.startedAt !== null ? [{ label: "Started", at: mission.startedAt }] : []),
    ...(column === "needs" ? [{ label: isPaused(mission) ? "Paused since" : "Waiting since", at: mission.updatedAt }] : []),
    ...(isHeldUp(mission) && column === "working" ? [{ label: "Held up since", at: mission.updatedAt }] : []),
    ...(column === "finished" ? [{ label: "Ended", at: mission.endedAt ?? mission.updatedAt }] : []),
  ];
}

/** Those moments in one line: what the time line shows when hovered or reached by keyboard. */
export function whenTip(mission: MissionView): string {
  return whenLines(mission).map((line) => `${line.label} ${fullWhen(line.at)}`).join(" · ");
}

/** The day beside the time line where nothing can be hovered (a phone): the day it speaks of, or the day work began. */
export function dayBeside(mission: MissionView, now: number = Date.now()): string {
  const column = columnOf(mission);
  if (column === "backlog") return dayOf(mission.createdAt, now);
  // Held up, its line says since when it is: the day of that, not the day work began.
  if (column === "working") return isHeldUp(mission) ? dayOf(mission.updatedAt, now) : `since ${dayOf(mission.startedAt ?? mission.createdAt, now)}`;
  if (column === "needs") return dayOf(mission.updatedAt, now);
  return dayOf(mission.endedAt ?? mission.updatedAt, now);
}

/** The card's one time line. */
export function timeLine(mission: MissionView, now: number = Date.now()): string {
  const column = columnOf(mission);
  if (column === "backlog") return `drafted ${ago(mission.createdAt, now)}`;
  if (column === "needs") return `${isPaused(mission) ? "paused" : openQuestion(mission) ? "asked" : "waiting since"} ${ago(mission.updatedAt, now)}`;
  if (column === "working" && isHeldUp(mission)) return `held up ${ago(mission.updatedAt, now)}`;
  if (column === "working") return mission.activeAt !== undefined ? `last step ${ago(mission.activeAt, now)}` : `started ${ago(mission.startedAt ?? mission.createdAt, now)}`;
  return `${outcomeOf(mission) === "stopped" ? "stopped" : "ended"} ${ago(mission.endedAt ?? mission.updatedAt, now)}`;
}

/** The bar's fill: done green, failed its own red (never the primary orange, nor the theme's `error`), stopped grey, the rest primary. */
export function barFill(mission: Pick<MissionView, "seen" | "status" | "waitKind" | "startedAt" | "changeable">): string {
  if (columnOf(mission) !== "finished") return "bg-primary";
  return { done: "bg-success", failed: "bg-failed", stopped: "bg-base-content/35" }[outcomeOf(mission)];
}

/** Which column a phone opens on: Needs you when anything does, Working otherwise. */
export function phoneOpening(counts: Readonly<Record<Column, number>>): Column {
  return counts.needs > 0 ? "needs" : "working";
}

/**
 * What a link's `tab` means now that the tabs are columns: the column that holds it, and how it ended where the tab
 * named that. The six old tabs (All, Needs you, Working, Done, Failed, Stopped) and the four columns by their own names.
 */
export function fromLink(tab: string | undefined): { column: Column; outcome?: Outcome } | null {
  switch (tab) {
    case "needs_you":
    case "needs":
      return { column: "needs" };
    case "working":
      return { column: "working" };
    case "backlog":
      return { column: "backlog" };
    case "done":
    case "failed":
    case "stopped":
      return { column: "finished", outcome: tab };
    case "finished":
      return { column: "finished" };
    default:
      return null;
  }
}
