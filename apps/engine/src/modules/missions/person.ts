/**
 * What a person says to a mission: stop it, let it go on, answer its question, accept its result — or a
 * proposal, which their yes starts. The same four from a chat (`/mission`), the CLI and the dashboard, as the signed-in
 * person or the operator; never from an agent, which cannot raise its own limit.
 */

import { clip, createLogger, ownerIdentity } from "@nouride/shared";
import { openQuestion } from "./asking.ts";
import { carryWait } from "./carry.ts";
import { limitsNear } from "./decide.ts";
import { workedMs } from "./page.ts";
import type { Missions } from "./missions.ts";
import type { MissionsDeps } from "./deps.ts";
import { handOver, type TellWhere } from "./tell.ts";
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
  | "working"
  | "paused"
  | "waiting"
  | "not-yours";

export type Refused = { refused: string; why: RefusedWhy };

/**
 * `said`, `where`: where words handed to a mission that was not waiting for them went, in the chat's words and as the
 * dashboard words it (`tell.ts`): an answer given to a mission that went on working.
 */
export type Acted = { mission: Mission; said?: string; where?: TellWhere } | Refused;

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

/**
 * Paused: its turn at work cut, its background jobs ended as a limit ends them, and the mission left waiting as
 * `paused` until someone says to go on. Nothing of it is lost: its checklist, its folder and its repository are kept,
 * so another mission in that repository waits behind it; its agent's slot is free, and the time it is paused counts
 * against no limit and draws no reminder. A mission could only be stopped for good before.
 *
 * For one that is running or queued. One being checked, one already waiting for a person and a draft are refused, each
 * with what can be said to it instead: nothing of theirs is running to pause. `agent`: the agent that paused it through
 * its `work` tool, kept beside `by`: an agent goes on only with a mission it paused itself.
 */
export function pauseMission(missions: Missions, deps: MissionsDeps, id: string, by: string, agent?: string): Acted {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  const name = named(mission);
  if (isFinal(mission.status)) return { refused: `Mission ${name} has already ended (${mission.status}).`, why: "ended" };
  if (mission.status === "checking") return { refused: `Mission ${name}'s checks are running now, and nothing of its own is at work to pause. To end it: /mission stop ${name}.`, why: "checking" };
  if (mission.status === "waiting") {
    if (mission.waitKind === "paused") return { refused: `Mission ${name} is already paused, by ${mission.pausedBy ?? "someone"}. To go on: /mission continue ${name}.`, why: "paused" };
    if (mission.startedAt === null) return { refused: `Mission ${name} is a draft that has not started, so there is nothing to pause.`, why: "not-started" };
    return { refused: `Mission ${name} is waiting for a person already (${mission.waitKind ?? "?"}), and nothing of it is running to pause.`, why: "waiting" };
  }
  // A queued one has no turn and no job; a running one's turn is cut here, and its end then decides nothing, as after
  // a limit (`Missions.turnEnded`).
  if (mission.status === "running") {
    deps.stopTurn(mission);
    for (const job of missions.jobsOf(mission)) deps.jobs?.kill(job.id, `mission ${mission.id} paused`);
  }
  mission.pausedBy = by;
  mission.pausedByAgent = agent ?? null;
  log.info("a mission paused", { mission: mission.id, by, was: mission.status, ...(agent ? { agent } : {}) });
  missions.wait(mission, "paused", `paused by ${by}`);
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
 * A draft is the one open mission that goes at once: nothing of it has run, so there is nothing to stop first.
 * Work in its folder nobody committed is refused too, by name, unless `force`; a folder the person named is never
 * touched, nor its branch.
 */
export async function deleteMission(missions: Missions, deps: MissionsDeps, id: string, by: string, how: { force?: boolean } = {}): Promise<Deleted> {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  const draft = mission.status === "waiting" && mission.waitKind === "accept" && mission.startedAt === null;
  if (!isFinal(mission.status) && !draft) return { refused: `Mission ${named(mission)} is ${mission.status}. Stop it first, then delete it.`, why: "open" };
  if (!how.force && !draft) {
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
  if (mission.waitKind === "paused") return resumePaused(missions, deps, mission, by, note);
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

/**
 * On from a pause, at any time. One that was at work gets a turn from its checklist, told its last turn was cut: what
 * that turn was doing may be half done. One paused while it was queued, which never started, is queued again and
 * starts when a slot and its repository allow. The time it was paused is in neither's hours.
 */
function resumePaused(missions: Missions, deps: MissionsDeps, mission: Mission, by: string, note?: string): Acted {
  const paused = mission.pausedBy ?? "someone";
  mission.pausedBy = null;
  mission.pausedByAgent = null;
  missions.freshStart(mission.id);
  if (mission.startedAt === null) {
    // Before it started is not time it waited while working (as for a proposal's yes, `acceptMission`).
    mission.waitingSince = null;
    missions.resume(mission);
    mission.status = "queued";
    deps.store.save(mission);
    deps.changed?.(mission);
    log.info("a mission paused while queued goes on: queued again", { mission: mission.id, by });
    missions.schedule();
    return { mission: deps.store.get(mission.id) ?? mission };
  }
  missions.resume(mission);
  deps.store.save(mission);
  deps.changed?.(mission);
  log.info("a paused mission goes on", { mission: mission.id, by });
  missions.queueTurn(
    mission,
    `${by} said to go on after a pause (${paused} paused it)${note ? `: ${note}` : "."} The turn you were in was cut off and your background jobs were ended. Go on from your checklist: look at what the step you were on left before you repeat it, and start again any job you still need.`,
    true,
  );
  return { mission: deps.store.get(mission.id) ?? mission };
}

/**
 * Answer its question. One that waits for the answer goes on with it, as the next turn. One that asked and went on
 * working (`keep_working`, `asking.ts`), or waits on something else by now, has it put on its record and handed over as
 * a `tell` is: into the turn at work, or kept for the next. Nothing is resumed by it: what a mission waits on is moved
 * by what that wait takes.
 */
export function answerMission(missions: Missions, deps: MissionsDeps, id: string, text: string, by: string): Acted {
  const mission = missions.find(id);
  if (!mission) return { refused: `No mission ${id}.`, why: "missing" };
  const open = openQuestion(mission);
  if (!open) return { refused: `Mission ${named(mission)} has no question waiting.`, why: "no-question" };
  const answer = text.trim();
  if (!answer) return { refused: "Say the answer after the mission's id.", why: "empty" };
  // A command is the person's to the daemon, not words for the agent: typed into the answer box on the live box,
  // `/mission accept … --outside` reached the agent as its answer, which cannot accept its own work, and it went round.
  if (/^\/mission\b/i.test(answer)) {
    return { refused: `That is a command, not an answer. Send it as a message of its own. To accept mission ${named(mission)} as it is: /mission accept ${named(mission)}.`, why: "command" };
  }
  open.answer = answer;
  if (mission.status === "waiting" && mission.waitKind === "input") {
    missions.resume(mission);
    deps.store.save(mission);
    deps.changed?.(mission);
    // It had said it was done before this answer came, and that was not taken: the turn the answer starts says so, since
    // a turn on a model remembers nothing of the last.
    const again = open.finished ? " You said the mission was done while this question was open, and that was not taken. Do what the answer changes, then call `mission` done again." : "";
    missions.queueTurn(mission, `${by} answered your question: ${answer}${again}`);
    return { mission };
  }
  log.info("a mission's question answered while it was not waiting for it", { mission: mission.id, by, status: mission.status, wait: mission.waitKind });
  // The chat's line that its mission asks is taken back, as a resume does for one that waited.
  if (deps.notes) void carryWait(deps.notes, mission, null).catch((err: unknown) => log.warn("a chat's line for its mission's question could not be updated", { mission: mission.id, error: String(err) }));
  const handed = handOver(deps, mission, `Answer to your question "${clip(open.question.trim(), 200)}": ${answer}`, by);
  return { mission: deps.store.get(mission.id) ?? mission, said: `Answered. ${handed.said.replace(/^Told\. /, "")}`, where: handed.where };
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
  // Paused before it ever started: there is no work to accept as it stands.
  if (mission.waitKind === "paused" && mission.startedAt === null) {
    return { refused: `Mission ${named(mission)} was paused before it started, so there is nothing to accept. To go on: /mission continue ${named(mission)}; to drop it: /mission stop ${named(mission)}.`, why: "not-started" };
  }
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
    // And where it was nobody's (an agent proposed it on its own), it is theirs from here: whoever said yes.
    if (mission.owner === null && as) mission.owner = ownerIdentity(as.gatewayId, as.senderId) ?? null;
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
