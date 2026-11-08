/**
 * What the chat a mission came from is told — and only this (MISSIONS §11): *started* with how to stop it; *needs you*,
 * with what; *done*, with its result; *ended*, with why. The whole report follows a result as `report.md`, and then the
 * files (`Missions.end`, `Missions.wait`). And, between them, a progress line
 * the daemon writes from the checklist, at most one every half hour. The chat stays quiet: the work is on the mission's
 * page.
 */

import type { MissionWaitKind } from "@nouride/wire";
import { clip, plural } from "@nouride/shared";
import { worktreeBranch } from "./worktree.ts";
import type { KeptPlan } from "@/modules/notes/store.ts";
import { shortId } from "./page.ts";
import type { Mission } from "./types.ts";

/**
 * Between a notice's parts — its first line, the result or question, the branch, what to send, the page — an empty line
 * (0.8.11). Each on the next line, a done notice in WhatsApp read as one block: "Mission … done", the result and
 * "Branch: …" ran together, and the owner asked for the space.
 */
export const GAP = "\n\n";

/**
 * *Started* (0.8.7): the goal, what decides it is done counted, how to stop it. The checks and the reviewer's words were
 * here in full, and a long brief made the notice a page the person scrolled past; they are in `/mission show`. The goal
 * is whole since 0.8.11: cut to its first hundred characters, a person read half of what they had asked for. It is at
 * most `GOAL_MAX`, and a gateway splits a long message itself.
 */
export function startedNotice(mission: Pick<Mission, "id" | "goal" | "checks" | "reviewOn" | "accept" | "jobId">, said?: string): string {
  const id = shortId(mission.id);
  const judged = [
    mission.checks.length > 0 ? `${mission.checks.length} ${plural(mission.checks.length, "check")}` : "",
    mission.reviewOn ? "reviewer" : "",
    mission.accept || (mission.checks.length === 0 && mission.jobId === null) ? "you accept" : "",
  ].filter(Boolean);
  // Started without a draft, on the person's own words (0.8.11, `now`): they are the ground it stands on, so they are said.
  const asked = said?.trim() ? `\nStarted at once, as asked: "${said.trim()}"` : "";
  return `▶ ${id}: ${mission.goal.trim()}${GAP}${judged.join(" + ") || "you accept"} · stop: /mission stop ${id}${asked}`;
}

/**
 * A notice with the mission's page under it, where a link goes into its chat (0.8.11, `web/links.ts`): *started*, *needs
 * you* and *done*. The chat said "the work is on the mission's page" and linked nothing.
 */
export function paged(text: string, page: string | null | undefined): string {
  return page ? `${text}${GAP}Page: ${page}` : text;
}

/** How much of a question one notice carries; past it, the rest is named, never dropped unsaid. */
export const QUESTION_CHARS = 3000;

export function queuedNotice(mission: Pick<Mission, "id">, behind: string): string {
  return `⏳ Mission ${shortId(mission.id)} is queued: ${behind}. It starts by itself.`;
}

/**
 * *Needs you*, by what it waits for. `detail` is the question, the limit, the call — whatever the wait is about; `gives`,
 * at a limit, what going on gives it ("100M more tokens").
 */
export function needsYouNotice(mission: Pick<Mission, "id" | "checks" | "workdir" | "branch" | "summary">, kind: MissionWaitKind, detail: string, gives?: string): string {
  const id = shortId(mission.id);
  switch (kind) {
    case "input": {
      // Never clipped unsaid (0.8.7): a question cut at 800 characters lost the options it ended with, and the person
      // answered half a question. Past what one notice carries, it says where the whole of it is.
      const whole = detail.trim();
      const cut = clip(whole, QUESTION_CHARS, QUESTION_CHARS);
      const shown = cut === whole ? whole : `${cut}\n(The question goes on: /mission show ${id} has all of it)`;
      // In words first: a reply reaches the agent, which answers the mission for the person (`work` answer) — live on
      // Discord, "blue" did. Only the command was said, so a person took it for the one way (0.8.12).
      return `❓ Mission ${id} asks: ${shown}${GAP}Answer: reply to this in your own words, or /mission answer ${id} <your answer> · or accept it as it is: /mission accept ${id}`;
    }
    case "approval":
      return `✋ Mission ${id} needs you: nothing else can move until you answer ${detail}.`;
    case "limit":
      return `⏸ Mission ${id} reached ${detail}. It is waiting: /mission continue ${id} ${gives ? `gives it ${gives}` : "lets it go on"}, /mission accept ${id} accepts it as it is, /mission stop ${id} ends it.`;
    case "accept": {
      // What it passed, not a stock line: one with no checks passed none. Then its result (its whole report follows as
      // `report.md`), what else the person decides on — the reviewer's notes, words told and not read — and in a
      // worktree, the branch to look at first.
      const branch = worktreeBranch(mission);
      const passed = mission.checks.length > 0 ? "passed its checks" : "is done";
      return [`☑ Mission ${id} ${passed}.`, mission.summary?.trim() ?? "", detail.trim(), branch ? `Branch: ${branch}` : "", `Accept: /mission accept ${id}, or /mission continue ${id} with what is missing.`]
        .filter(Boolean)
        .join(GAP);
    }
    case "unknown_outcome":
      return `⚠ Mission ${id} was cut off by a restart in the middle of ${detail}, and whether it ran is unknown. Check, then /mission continue ${id} or /mission stop ${id}.`;
    case "stuck":
      return `⚠ Mission ${id} is stuck: ${clip(detail.trim(), 600)}${GAP}/mission continue ${id} to try again, /mission accept ${id} to accept it as it is, /mission stop ${id} to end it.`;
    case "retry":
      // Said once, when it pauses: each try after is quiet, and only its going on again or a person's turn is told.
      return `⏸ Mission ${id} paused because its model could not answer: ${clip(detail.trim(), 400)}${GAP}It tries again by itself, further apart each time, for about a day. /mission continue ${id} to try now, /mission stop ${id} to end it.`;
  }
}

/** A paused mission's model answered again (`retry`): said once, so the person knows it is no longer stalled. */
export function goesOnNotice(mission: Pick<Mission, "id">, tries: number): string {
  return `▶ Mission ${shortId(mission.id)} goes on: its model answered again${tries > 1 ? ` after ${tries} tries` : ""}.`;
}

/**
 * *Done* (0.8.11): how it ended, its result, its branch. Its whole report follows as `report.md`, then its files; the
 * report cut to 1,500 characters here, and a `Files:` line naming the code it changed, are gone.
 */
export function doneNotice(mission: Pick<Mission, "id" | "summary" | "reviewed" | "checks" | "workdir" | "branch" | "reason">, accepted: boolean): string {
  // What happened, not what was asked for: a reviewer that could not run left a person to accept, and is not "reviewed".
  // A done mission has a reason only when a person closed it without its checks passing — done outside them, or
  // accepted as it stood (`person.ts`): the reason says which, and by whom. Saying they passed would be the one claim
  // the notice must not make.
  const how = mission.reason ?? [mission.checks.length > 0 ? "checks passed" : "", mission.reviewed ? "reviewed" : "", accepted ? "accepted" : ""].filter(Boolean).join(", ");
  // A mission in a worktree of its own ends with its branch (§8): where its work is, whether or not it was merged.
  const branch = worktreeBranch(mission);
  return [`✓ Mission ${shortId(mission.id)} done${how ? ` (${how})` : ""}.`, mission.summary?.trim() ?? "", branch ? `Branch: ${branch}` : ""].filter(Boolean).join(GAP);
}

/** *Ended*, failed or stopped: why, in place of a result. A report it has follows as `report.md`. */
export function endedNotice(mission: Pick<Mission, "id" | "status">, why: string): string {
  return `✗ Mission ${shortId(mission.id)} ${mission.status === "stopped" ? "stopped" : "ended"}: ${clip(why.trim(), 600)}`;
}

/** A progress line, written from the checklist — never by the model, so it costs nothing and claims nothing more. */
export function progressNotice(mission: Pick<Mission, "id">, plan: KeptPlan): string {
  const finished = plan.steps.filter((step) => step.state === "done" || step.state === "skipped");
  const last = finished.at(-1);
  return `… Mission ${shortId(mission.id)}: ${finished.length} of ${plan.steps.length} steps done${last ? ` (last: ${clip(last.text.trim(), 160)})` : ""}`;
}

export function warnNotice(mission: Pick<Mission, "id">, what: string): string {
  return `Mission ${shortId(mission.id)} has used 80% of ${what}.`;
}

export function followUpNotice(mission: Pick<Mission, "id">, waitingFor: string): string {
  return `⏰ Mission ${shortId(mission.id)} is still waiting for you: ${clip(waitingFor.trim(), 400)}`;
}
