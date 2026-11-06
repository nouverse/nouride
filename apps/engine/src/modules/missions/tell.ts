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

/** `why` a tell was refused, for the dashboard's words at its route (0.8.20); `length` and `max` for one too long. */
export type TellAnswer =
  | { mission: Mission; said: string }
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
  const said = delivered(mission, told, deps);
  log.info("a person told a mission", { mission: mission.id, by, ...(via ? { via } : {}), status: mission.status, chars: words.length });
  return { mission: deps.store.get(mission.id) ?? mission, said };
}

/** Into its turn when one is at work; otherwise where it is kept and what moves the mission — said for the person. */
function delivered(mission: Mission, told: Told, deps: MissionsDeps): string {
  const id = shortId(mission.id);
  if (mission.status === "running") {
    const steered = deps.steerTurn?.(mission, told) ?? { taken: false, why: "none" };
    if (steered.taken) {
      if (steered.when === "next_step") return "Told. It reads this before its next step.";
      if (steered.when === "into_cli") return "Told. Its coding CLI is given this in the turn it is working on: at once, or once the command it is running ends.";
      return "Told. Its coding CLI reads this once the prompt it is working on ends.";
    }
    if (steered.why === "full") return "Kept for its next turn: the turn at work has read all it reads in one turn.";
    return "Kept for its next turn, which reads it first.";
  }
  if (mission.status === "queued") return "Kept: it has not started yet, and its first turn reads this.";
  if (mission.status === "checking") {
    const then = waitsForAccept(mission) ? "it waits for your accept, with this shown" : "it goes one more turn to read this before it ends";
    return `Kept: its checks are running. If they fail, its next turn reads this; if they pass, ${then}.`;
  }
  switch (mission.waitKind) {
    case "input":
      return `Kept for its next turn. It is waiting for your answer: /mission answer ${id} <your answer>.`;
    case "limit":
      return `Kept for its next turn. It is waiting at its limit: /mission continue ${id} lets it go on.`;
    case "accept":
      return mission.startedAt === null
        ? `Kept: it has not started. /mission accept ${id} starts it, and its first turn reads this.`
        : `Kept. It is waiting for your accept: /mission accept ${id} takes it as it is, /mission continue ${id} has it work on what you said.`;
    case "approval":
      return "Kept for its next turn. It is waiting for an approval to be answered, and goes on with this once it is.";
    case "stuck":
      return `Kept for its next turn. It is stuck: /mission continue ${id} lets it try again with this.`;
    case "unknown_outcome":
      return `Kept for its next turn. It waits for you to say whether to go on: /mission continue ${id}.`;
    case "retry":
      return "Kept for its next turn: its model could not answer, and it tries again by itself.";
    default:
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
