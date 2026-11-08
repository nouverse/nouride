/**
 * `tell` (0.8.10, RFC_MISSION_STEERING): a person's words for a mission while it works. A mission could be stopped,
 * answered, let go on and accepted, and told nothing: a person who saw it go the wrong way stopped it and started again,
 * or waited hours for it to ask. msn_3d28e0 worked 3h41m in three turns, one prompt 2h42m long.
 *
 * Recorded on the mission first, then delivered where it stands: into the turn at work, read before its next step — a
 * coding CLI's through `_session/steering` (`external-agents/steering.ts`) — or kept for its next turn, whose page shows
 * it. Never a change to the goal, the checks or the limits, and never a resume: what moves a waiting mission is still a
 * person's answer, continue or accept, and the reply says which.
 */

import { createLogger, newId } from "@nouride/shared";
import type { Missions } from "./missions.ts";
import type { MissionsDeps } from "./deps.ts";
import { TELL_MAX, TOLD_KEPT } from "./limits.ts";
import { shortId } from "./page.ts";
import { isFinal, type Mission, type Told } from "./types.ts";

const log = createLogger("missions");

/** Where words taken into a running turn go: its next step, its coding CLI's prompt, or after that prompt ends. */
export type SteerOutcome = { taken: true; when: "next_step" | "into_cli" | "after_prompt" } | { taken: false; why: "full" | "ending" | "none" };

/**
 * Where a person's words went (0.8.23): into the turn at work, kept for the next and what that waits on. `said` is it in
 * the chat's words, with the `/mission` command that moves it; the dashboard's route words it from this, for a page whose
 * buttons do what those commands do.
 */
export type TellWhere =
  | "next_step"
  | "into_cli"
  | "after_prompt"
  | "turn_full"
  | "next_turn"
  | "queued"
  | "checks_then_accept"
  | "checks_then_turn"
  | "answer"
  | "limit"
  | "unstarted"
  | "accept"
  | "approval"
  | "stuck"
  | "unknown_outcome"
  | "retry"
  | "kept";

/** `why` a tell was refused, for the dashboard's words at its route (0.8.20); `length` and `max` for one too long. */
export type TellAnswer =
  | { mission: Mission; said: string; where: TellWhere }
  | { refused: string; why: "missing" | "ended" | "empty" }
  | { refused: string; why: "long"; length: number; max: number };

/**
 * Tell a mission something. `by` is the person, as the other verbs write them; `via` the agent that passed their words on
 * from its chat (`work` action tell). Answered with where the words went, for the person.
 */
export function tellMission(missions: Missions, deps: MissionsDeps, id: string, text: string, by: string, via?: string): TellAnswer {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  if (isFinal(mission.status)) return { refused: `Mission ${shortId(mission.id)} has already ended (${mission.status}): nothing would read it now.`, why: "ended" };
  const words = text.trim();
  if (!words) return { refused: `Tell it what? /mission tell ${shortId(mission.id)} <what it should know>`, why: "empty" };
  if (words.length > TELL_MAX) {
    return { refused: `That is ${words.length} characters, and a tell is ${TELL_MAX} at most: put the rest in a file and tell it where.`, why: "long", length: words.length, max: TELL_MAX };
  }
  const now = (deps.now ?? Date.now)();
  const told: Told = { id: newId("tel"), by, at: now, text: words, ...(via ? { via } : {}) };
  // Saved before it is handed over: a restart in between leaves it unread, and the next turn's page carries it.
  mission.told = [...mission.told, told].slice(-TOLD_KEPT);
  mission.updatedAt = now;
  deps.store.save(mission);
  deps.changed?.(mission);
  const where = delivered(mission, told, deps);
  log.info("a person told a mission", { mission: mission.id, by, ...(via ? { via } : {}), status: mission.status, chars: words.length });
  return { mission: deps.store.get(mission.id) ?? mission, said: chatWords(where, shortId(mission.id)), where };
}

/** Into its turn when one is at work; otherwise where it is kept, by what moves the mission. */
function delivered(mission: Mission, told: Told, deps: MissionsDeps): TellWhere {
  if (mission.status === "running") {
    const steered = deps.steerTurn?.(mission, told) ?? { taken: false, why: "none" };
    if (steered.taken) return steered.when;
    return steered.why === "full" ? "turn_full" : "next_turn";
  }
  if (mission.status === "queued") return "queued";
  if (mission.status === "checking") return waitsForAccept(mission) ? "checks_then_accept" : "checks_then_turn";
  switch (mission.waitKind) {
    case "input":
      return "answer";
    case "limit":
      return "limit";
    case "accept":
      return mission.startedAt === null ? "unstarted" : "accept";
    case "approval":
    case "stuck":
    case "unknown_outcome":
    case "retry":
      return mission.waitKind;
    default:
      return "kept";
  }
}

/** Where the words went, said for the person in a chat: with the `/mission` command that moves it on, where one does. */
function chatWords(where: TellWhere, id: string): string {
  switch (where) {
    case "next_step":
      return "Told. It reads this before its next step.";
    case "into_cli":
      return "Told. Its coding CLI is given this in the turn it is working on: at once, or once the command it is running ends.";
    case "after_prompt":
      return "Told. Its coding CLI reads this once the prompt it is working on ends.";
    case "turn_full":
      return "Kept for its next turn: the turn at work has read all it reads in one turn.";
    case "next_turn":
      return "Kept for its next turn, which reads it first.";
    case "queued":
      return "Kept: it has not started yet, and its first turn reads this.";
    case "checks_then_accept":
      return "Kept: its checks are running. If they fail, its next turn reads this; if they pass, it waits for your accept, with this shown.";
    case "checks_then_turn":
      return "Kept: its checks are running. If they fail, its next turn reads this; if they pass, it goes one more turn to read this before it ends.";
    case "answer":
      return `Kept for its next turn. It is waiting for your answer: /mission answer ${id} <your answer>.`;
    case "limit":
      return `Kept for its next turn. It is waiting at its limit: /mission continue ${id} lets it go on.`;
    case "unstarted":
      return `Kept: it has not started. /mission accept ${id} starts it, and its first turn reads this.`;
    case "accept":
      return `Kept. It is waiting for your accept: /mission accept ${id} takes it as it is, /mission continue ${id} has it work on what you said.`;
    case "approval":
      return "Kept for its next turn. It is waiting for an approval to be answered, and goes on with this once it is.";
    case "stuck":
      return `Kept for its next turn. It is stuck: /mission continue ${id} lets it try again with this.`;
    case "unknown_outcome":
      return `Kept for its next turn. It waits for you to say whether to go on: /mission continue ${id}.`;
    case "retry":
      return "Kept for its next turn: its model could not answer, and it tries again by itself.";
    case "kept":
      return "Kept for its next turn.";
  }
}

/** Where a pass leaves it waiting for a person rather than done (`checking.ts` `passed`). */
export function waitsForAccept(mission: Pick<Mission, "accept" | "checks" | "jobId">): boolean {
  return mission.accept || (mission.checks.length === 0 && mission.jobId === null);
}

/** What it was told and has not read. */
export function unreadTold(mission: Pick<Mission, "told">): Told[] {
  return mission.told.filter((one) => one.read === undefined);
}

/** Marked read in the turn running now — the one after the turns it has finished. True where any was unread. */
export function markRead(mission: Mission, ids: readonly string[]): boolean {
  const turn = mission.turnsUsed + 1;
  let marked = false;
  mission.told = mission.told.map((one) => {
    if (one.read !== undefined || !ids.includes(one.id)) return one;
    marked = true;
    return { ...one, read: turn };
  });
  return marked;
}
