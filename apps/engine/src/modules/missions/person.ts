/**
 * What a person says to a mission: stop it, let it go on, answer its question, accept its result — or a
 * proposal, which their yes starts. The same four from a chat (`/mission`), the CLI and the dashboard, as the signed-in
 * person or the operator; never from an agent, which cannot raise its own limit.
 */

import { createLogger } from "@nouride/shared";
import { limitsNear } from "./decide.ts";
import { workedMs } from "./page.ts";
import type { Missions } from "./missions.ts";
import type { MissionsDeps } from "./deps.ts";
import { isFinal, type Mission } from "./types.ts";

const log = createLogger("missions");

/**
 * Why a person's word to a mission was refused (0.8.20). `refused` is said for the chat and the CLI; the dashboard's words
 * are worded at its route from `why`, never read out of that sentence.
 */
export type RefusedWhy =
  | "missing"
  | "ended"
  | "open"
  | "not-waiting"
  | "question"
  | "no-question"
  | "empty"
  | "command"
  | "not-started"
  | "checking"
  | "working";

export type Refused = { refused: string; why: RefusedWhy };

export type Acted = { mission: Mission } | Refused;

/** Who said it, in a chat: their id on the connection they said it on. Absent from the dashboard and the CLI. */
export type Sayer = { gatewayId: string; senderId: string };

function named(mission: Mission): string {
  return mission.id.slice(0, 10);
}

export function stopMission(missions: Missions, deps: MissionsDeps, id: string, by: string): Acted {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  if (isFinal(mission.status)) return { refused: `Mission ${named(mission)} has already ended (${mission.status}).`, why: "ended" };
  deps.stopTurn(mission);
  missions.end(mission, "stopped", `stopped by ${by}`);
  return { mission: deps.store.get(mission.id) ?? mission };
}

/** A delete refused over work nobody committed names it: the one refusal `force` gets past. */
export type Deleted = Acted | { refused: string; why: "unsaved"; unsaved: string[] };

/**
 * Deleted by a person (0.8.13): an ended mission's record and the folder the daemon made for it — its conversation is
 * the caller's to end, as deleting a conversation does. Before, a mission went only with its conversation, from the
 * chat list, and test missions lingered on the live box for want of a way out.
 *
 * One still open is refused rather than stopped on the way: a delete that also stops is two decisions in one click.
 * Work in its folder nobody committed is refused too, by name, unless `force`; a folder the person named is never
 * touched, nor its branch.
 */
export async function deleteMission(missions: Missions, deps: MissionsDeps, id: string, by: string, how: { force?: boolean } = {}): Promise<Deleted> {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  if (!isFinal(mission.status)) return { refused: `Mission ${named(mission)} is ${mission.status}. Stop it first, then delete it.`, why: "open" };
  if (!how.force) {
    // Removed here when nothing in it is uncommitted; `forget` below then finds the folder already gone.
    const unsaved = (await deps.remove?.(mission, { keepUnsaved: true })) ?? [];
    if (unsaved.length > 0) {
      return { refused: `Mission ${named(mission)}'s folder holds work nobody committed: ${unsaved.join(", ")}. Commit it there first.`, why: "unsaved", unsaved };
    }
  }
  missions.forget(mission.id, by);
  log.info("mission deleted", { mission: mission.id, by, forced: how.force === true });
  return { mission };
}

export function continueMission(missions: Missions, deps: MissionsDeps, id: string, by: string, note?: string, as?: Sayer): Acted {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  if (mission.status !== "waiting") return { refused: `Mission ${named(mission)} is ${mission.status}, not waiting for you.`, why: "not-waiting" };
  if (mission.waitKind === "input") return { refused: `It asked a question. Answer it: /mission answer ${named(mission)} <your answer>.`, why: "question" };
  if (mission.waitKind === "accept" && mission.startedAt === null) return acceptMission(missions, deps, id, by, as);
  // Sent back from its accept with nothing said — the chat's button: "said to go on." told the agent nothing to do.
  const sentBack = mission.waitKind === "accept" && !note;
  if (mission.waitKind === "limit") {
    // Each limit it reached rises by its setting, counted from where it stands, and so does one at 80% of itself or more
    // — left, it stopped the mission again a minute on; the others stay as they were. All three rose: going on after its
    // token limit took msn_3d28e0's 100 turns, one used, to 101 and its 8 hours to 8.960713333333333 (0.8.8). Read again
    // as the wait read them — or, where none reads so now, those it was stopped at: a CLI turn stopped on its estimate
    // may end with a count under them, and went on with nothing more. None left near, the 80% notice is owed again.
    const settings = deps.settings();
    const now = (deps.now ?? Date.now)();
    const readNow = limitsNear(mission, now, missions.inForce(mission));
    const reached = readNow.length > 0 ? readNow : missions.limitsStoppedAt(mission.id);
    mission.limits = {
      turns: reached.includes("turns") ? mission.turnsUsed + settings.limitTurns : mission.limits.turns,
      tokens: reached.includes("tokens") ? mission.tokensUsed + settings.limitTokens : mission.limits.tokens,
      // Up to the minute: a limit is shown in minutes, so the one shown is the one it stops at.
      hours: reached.includes("hours") ? Math.ceil(workedMs(mission, now) / 60_000 + settings.limitHours * 60) / 60 : mission.limits.hours,
    };
    mission.warnedAt = null;
  }
  missions.freshStart(mission.id);
  missions.resume(mission);
  deps.store.save(mission);
  deps.changed?.(mission);
  // Behind a turn still in flight, not dropped for it: a CLI turn the minute's check stopped at a limit takes up to half
  // a minute to end, and a continue pressed then was lost — the mission sat with no turn until its hour's nudge (a
  // review of affb384f). That turn's end decides nothing (`turnEnded`), so this is its next.
  missions.queueTurn(mission, sentBack ? `${by} sent its result back without saying what is missing. Check the work against the goal again, then call \`mission\` done.` : `${by} said to go on${note ? `: ${note}` : "."}`, true);
  return { mission };
}

export function answerMission(missions: Missions, deps: MissionsDeps, id: string, text: string, by: string): Acted {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  if (mission.status !== "waiting" || mission.waitKind !== "input") return { refused: `Mission ${named(mission)} has no question waiting.`, why: "no-question" };
  const answer = text.trim();
  if (!answer) return { refused: "Say the answer after the mission's id.", why: "empty" };
  // A command is the person's to the daemon, not words for the agent: typed into the answer box on the live box,
  // `/mission accept … --outside` reached the agent as its answer, which cannot accept its own work, and it went round.
  if (/^\/mission\b/i.test(answer)) {
    return { refused: `That is a command, not an answer. Send it as a message of its own. To accept mission ${named(mission)} as it is: /mission accept ${named(mission)}.`, why: "command" };
  }
  const last = mission.answers.at(-1);
  if (last && last.answer === undefined) last.answer = answer;
  missions.resume(mission);
  deps.store.save(mission);
  deps.changed?.(mission);
  missions.queueTurn(mission, `${by} answered your question: ${answer}`);
  return { mission };
}

/**
 * Accept its result. A mission waiting for anything else — a question, a limit, stuck on a check — is accepted as it
 * stands: the person has looked and is satisfied, and that is theirs to say (0.8.7). Before, `/mission accept` said only
 * "not waiting for an accept" to a mission stuck on a check it could never pass, and the person had no way to close it
 * as done; it went round until the agent gave it up as failed with the work merged. Its record says the checks did not
 * pass, never that they did. One still at work, or still being checked, is not done yet, and the refusal says what is.
 */
export function acceptMission(missions: Missions, deps: MissionsDeps, id: string, by: string, as?: Sayer): Acted {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  if (isFinal(mission.status)) return { refused: `Mission ${named(mission)} has already ended (${mission.status}).`, why: "ended" };
  if (mission.status !== "waiting") return notWaiting(mission);
  if (mission.waitKind !== "accept") {
    log.info("a mission accepted as it stands", { mission: mission.id, by, wait: mission.waitKind });
    deps.stopTurn(mission);
    const why = mission.checks.length > 0 ? `accepted by ${by} as it stood, without its checks passing` : `accepted by ${by} as it stood`;
    missions.end(mission, "done", why, undefined, true);
    return { mission: deps.store.get(mission.id) ?? mission };
  }
  if (mission.startedAt === null) {
    // A proposal: the person's yes starts it — and, said in its own chat, it runs as them: their approval level and
    // People entry, and a question in a group theirs to answer. It ran as the daemon, whose turn proposed it.
    if (as && as.gatewayId === mission.gatewayId) mission.startedBy = as.senderId;
    log.info("a proposed mission accepted, so it starts", { mission: mission.id, by, runs_as: mission.startedBy });
    // Its wait for the yes is before it started, not time it waited while working: counted as such, a proposal
    // accepted 60 hours on read 0h worked for 60 hours, and its hours limit never fired.
    mission.waitingSince = null;
    missions.resume(mission);
    mission.status = "queued";
    deps.store.save(mission);
    deps.changed?.(mission);
    missions.schedule();
    return { mission: deps.store.get(mission.id) ?? mission };
  }
  missions.end(mission, "done", undefined, undefined, true);
  return { mission: deps.store.get(mission.id) ?? mission };
}

/** Why one not waiting cannot be accepted now — and what can be said to it instead. */
function notWaiting(mission: Mission): Refused {
  const id = named(mission);
  if (mission.status === "queued") return { refused: `Mission ${id} has not started yet, so there is nothing to accept. To drop it: /mission stop ${id}.`, why: "not-started" };
  if (mission.status === "checking") return { refused: `Mission ${id}'s checks are running now; it tells this chat how they went.`, why: "checking" };
  return {
    refused: `Mission ${id} is still working and has not said it is done. To close it as done another way: /mission accept ${id} --outside "<where>"; to end it: /mission stop ${id}.`,
    why: "working",
  };
}

/**
 * Done outside its checks (0.8.7): the work landed another way — merged by hand, done in another mission — and a person,
 * or the agent the mission is, closes it as accepted with a note saying where. Its checks are not run: what they would
 * check is somewhere else now. Any mission not yet ended. Its own report stays: the note is the reason it was closed.
 */
export function acceptOutside(missions: Missions, deps: MissionsDeps, id: string, note: string, by: string): Acted {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  if (isFinal(mission.status)) return { refused: `Mission ${named(mission)} has already ended (${mission.status}).`, why: "ended" };
  const where = note.trim();
  if (!where) return { refused: "Say where it was done: a note after the id.", why: "empty" };
  log.info("a mission closed as done outside its checks", { mission: mission.id, by });
  deps.stopTurn(mission);
  missions.end(mission, "done", `accepted by ${by}, done outside its checks: ${where}`, mission.report ? undefined : `Done outside its checks: ${where}`, true);
  return { mission: deps.store.get(mission.id) ?? mission };
}
