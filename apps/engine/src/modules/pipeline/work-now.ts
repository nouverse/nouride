/**
 * What else is at work, said on the message a turn answers: the other agents of its chat, and the rest of the box.
 *
 * An agent was told who shares its chat and what each is for, and nothing that moves. It tagged an agent already at
 * work there, started a build beside one a mission was running, and learned of neither. The daemon holds all of it
 * (the turns, the jobs, the missions): it is what `/status` draws.
 *
 * On the message and never in the prompt, as `loadNote` is (`messages.ts`): a line that moves by the minute in the
 * cached part would write the whole prefix again on every turn. Nothing is said when nothing else is at work.
 *
 * **Whose words.** The request a turn is on, a helper's goal, a command line: each is what somebody asked. It is said
 * only where this chat's reader may know it: work in this chat, or work the person this turn answers began. Anything
 * else is named by its kind, its folder and its time. An agent told in one person's chat what another asked it in
 * private repeats it, and each person's chats are their own.
 *
 * It tells and locks nothing. The agent is the one that waits, or works somewhere else.
 */

import { clipTrimmed, type LoadedAgent, type MessageEnvelope, oneLine } from "@nouride/shared";
import type { JobRecord } from "@/modules/jobs/jobs.store.ts";
import { duration } from "@/modules/jobs/wake-text.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { findPerson } from "@/modules/people/match.ts";
import { goalLine } from "@/modules/tools/builtins/delegate-brief.ts";
import type { ActiveTurn } from "./active-turns.ts";
import { isSystemEvent } from "./deps.ts";
import { requestQuote } from "./steering.ts";
import type { TurnContext } from "./turn-context.ts";

/** Another agent this chat can reach, and what it is doing here. */
export interface RoomMate {
  id: string;
  asleep: boolean;
  /** Its turn in this chat, if it has one. `about` is empty for work the chat never saw asked (a peer's, a job's). */
  turn?: { about: string; startedAt?: number; parked: boolean };
}

/** The other agents of a room, while one of them is at work there or asleep. */
export function roomNote(mates: readonly RoomMate[], now: number): string | null {
  const lines = mates.flatMap((mate) => {
    if (mate.turn) {
      const about = mate.turn.about ? ` on "${mate.turn.about}"` : "";
      const parked = mate.turn.parked ? ", waiting for an approval here" : "";
      return [`${mate.id} is at work${about}${since(mate.turn.startedAt, now)}${parked}`];
    }
    return mate.asleep ? [`${mate.id} is asleep and takes no work until a person wakes it`] : [];
  });
  if (lines.length === 0) return null;
  // What a tag does to one at work (`ActiveTurns.holdHandover`): said, so an agent neither waits on it nor tags it twice.
  const waits = mates.some((mate) => mate.turn) ? " A tag to one at work here waits until it is done: say all you need in one message." : "";
  return `(In this chat now: ${lines.join("; ")}.${waits})`;
}

/** One piece of work running on the box besides the turn's own. */
export interface WorkNow {
  kind: "turn" | "scheduled" | "helper" | "ask" | "mission" | "command";
  /** The agent doing it. */
  agentId: string;
  /** An ask's asker. */
  askedBy?: string;
  /** Whether what was asked may be said in this chat: see the header. */
  open: boolean;
  /** What was asked: a request, a goal, a command line. Said only when `open`. */
  what: string;
  /** Where it works, where the daemon knows: a mission's folder, a command's. */
  folder?: string;
  startedAt?: number;
}

/** How many are named. A starting value: past it the rest are counted, so a busy box does not fill the message. */
export const WORK_SHOWN = 6;

/** The rest of the box, while anything else runs: the reading agent's own work first, then the oldest. */
export function boxNote(work: readonly WorkNow[], me: string, now: number): string | null {
  if (work.length === 0) return null;
  const mine = (one: WorkNow) => one.agentId === me || one.askedBy === me;
  const sorted = [...work].sort((a, b) => Number(mine(b)) - Number(mine(a)) || (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const shown = sorted.slice(0, WORK_SHOWN).map((one) => workLine(one, me, now));
  const rest = sorted.length - shown.length;
  return (
    `(Also at work on this box now: ${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}. ` +
    `Before you write or run something where one of these is working, wait for it or work somewhere else.)`
  );
}

function workLine(one: WorkNow, me: string, now: number): string {
  const who = (id: string) => (id === me ? "you" : id);
  const whose = one.agentId === me ? "yours" : `${one.agentId}'s`;
  const said = one.open ? one.what : "";
  const where = one.folder ? ` in ${one.folder}` : "";
  const time = since(one.startedAt, now);
  switch (one.kind) {
    case "turn":
      return `${who(one.agentId)}, in another chat${said ? `, on "${said}"` : ""}${time}`;
    case "scheduled":
      return `${who(one.agentId)}, on a scheduled run${time}`;
    case "helper":
      return `a helper of ${whose}${said ? ` on "${said}"` : ""}${time}`;
    case "ask":
      return `${who(one.agentId)}, at work for ${who(one.askedBy ?? "")}${said ? ` on "${said}"` : ""}${time}`;
    case "mission":
      return `a mission of ${whose}${said ? ` "${said}"` : ""}${where}${time}`;
    case "command":
      return `a command of ${whose}${where}${said ? `: \`${said}\`` : ""}${time}`;
  }
}

function since(startedAt: number | undefined, now: number): string {
  return startedAt === undefined ? "" : ` (${duration(Math.max(0, now - startedAt))} so far)`;
}

/** Who a message is from, as the people matcher takes it. */
export interface Sender {
  gatewayId: string;
  senderId: string;
}

/** What the daemon holds, as `workNow` reads it. */
export interface WorkSources {
  /** The agent whose turn this is, and the chat it runs in. */
  me: string;
  at: { gatewayId: string; chatId: string; room: boolean };
  /** The person this turn answers. None for a turn no person began (a job's, an agent's hand-over). */
  reader?: Sender;
  /** The other agents this chat can reach, as OTHER AGENTS names them. */
  mates: readonly string[];
  /** Every enabled agent, this one among them. */
  agents: readonly string[];
  /** Every turn running now. */
  turns: Iterable<ActiveTurn>;
  /** An agent's turn in this chat, its own or a peer's. */
  turnHere(agentId: string): ActiveTurn | undefined;
  /** Whether an agent waits on an approval in this chat. */
  parkedHere(agentId: string): boolean;
  asleep(agentId: string): boolean;
  /** An agent's jobs still running: commands, helpers, asks. */
  jobs(agentId: string): readonly JobRecord[];
  /** The missions at work. */
  missions: readonly Mission[];
  /** Whether two senders are one person. */
  samePerson(a: Sender, b: Sender): boolean;
  /** What an agent is called, to take its address off a quoted request. */
  namesOf(agentId: string): readonly string[];
}

/** At most this much of a goal or a command, on one line. */
const WHAT_MAX = 80;

const short = (text: string) => clipTrimmed(oneLine(text), WHAT_MAX).replace(/[`"]/g, "'");

export function workNow(src: WorkSources): { mates: RoomMate[]; work: WorkNow[] } {
  const here = (one: { gatewayId: string; chatId: string }) => one.gatewayId === src.at.gatewayId && one.chatId === src.at.chatId;
  const readers = (sender: Sender | null) => sender !== null && src.reader !== undefined && src.samePerson(sender, src.reader);

  const mates: RoomMate[] = !src.at.room
    ? []
    : src.mates.map((id) => {
        const turn = src.turnHere(id);
        const asked = turn?.trigger && !isSystemEvent(turn.trigger) ? requestQuote(turn.trigger.text, src.namesOf(id)) : "";
        return {
          id,
          asleep: src.asleep(id),
          ...(turn ? { turn: { about: asked, ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }), parked: src.parkedHere(id) } } : {}),
        };
      });

  const work: WorkNow[] = [];
  for (const turn of src.turns) {
    // This chat's turns are the room's line, or this turn itself; a mission's turn is its mission, below.
    if (here(turn) || turn.gatewayId === MISSION_GATEWAY_ID) continue;
    const asked = turn.trigger && !isSystemEvent(turn.trigger) ? turn.trigger : null;
    const open = asked !== null && readers({ gatewayId: asked.gatewayId, senderId: asked.senderId });
    work.push({
      kind: turn.trigger ? "turn" : "scheduled",
      agentId: turn.agentId,
      open,
      what: asked ? requestQuote(asked.text, src.namesOf(turn.agentId)) : "",
      ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    });
  }
  for (const agentId of src.agents) {
    for (const job of src.jobs(agentId)) {
      // The reading agent's own, begun in this chat, it knows already: it started them here (`helpersNote`).
      if (agentId === src.me && here(job)) continue;
      const open = here(job) || readers(job.senderId ? { gatewayId: job.gatewayId, senderId: job.senderId } : null);
      const base = { open, startedAt: job.startedAt };
      if (job.kind === "ask" && job.ask) work.push({ ...base, kind: "ask", agentId: job.ask.agent, askedBy: agentId, what: short(job.ask.task) });
      else if (job.kind === "helper") work.push({ ...base, kind: "helper", agentId, what: short(job.brief ? goalLine(job.brief) : job.command) });
      else work.push({ ...base, kind: "command", agentId, what: short(job.command), folder: job.cwd });
    }
  }
  for (const mission of src.missions) {
    // A mission's own turn is not told of itself.
    if (src.at.gatewayId === MISSION_GATEWAY_ID && src.at.chatId === mission.id) continue;
    work.push({
      kind: "mission",
      agentId: mission.agentId,
      open: here(mission) || readers({ gatewayId: mission.gatewayId, senderId: mission.startedBy }),
      what: short(mission.goal),
      folder: mission.workdir,
      startedAt: mission.startedAt ?? mission.createdAt,
    });
  }
  return { mates, work };
}

/**
 * The sources, read from what the pipeline holds. `reader` is the person the turn answers, and none where no person
 * began it: then only this chat's own work is said in words.
 */
export function sourcesFrom(ctx: TurnContext, agent: LoadedAgent, envelope: MessageEnvelope, reader: Sender | undefined): WorkSources {
  const { registry, jobs, missionCommands, approvals, config } = ctx.deps;
  const personOf = (sender: Sender) => findPerson(config.people, sender)?.name;
  return {
    me: agent.config.id,
    at: { gatewayId: envelope.gatewayId, chatId: envelope.chatId, room: envelope.chatType !== "dm" },
    ...(reader ? { reader } : {}),
    mates: ctx.otherAgentsFor(agent.config.id, envelope)?.names ?? [],
    agents: registry.enabled().map((one) => one.config.id),
    turns: ctx.activeTurns.values(),
    turnHere: (id) => ctx.turnIn(id, envelope.chatId, envelope.gatewayId),
    parkedHere: (id) => approvals.pending().some((request) => request.agentId === id && request.gateway === envelope.gatewayId && request.chatId === envelope.chatId),
    asleep: (id) => registry.isPaused(id),
    jobs: (id) => jobs?.running(id) ?? [],
    missions: missionCommands?.running() ?? [],
    samePerson: (a, b) => {
      if (a.gatewayId === b.gatewayId && a.senderId === b.senderId) return true;
      const person = personOf(a);
      return person !== undefined && person === personOf(b);
    },
    namesOf: (id) => [id, registry.get(id)?.config.displayName ?? ""],
  };
}

/** The lines a turn's message carries: the room's, then the box's. */
export function workNotes(src: WorkSources, now: number): string[] {
  const { mates, work } = workNow(src);
  return [roomNote(mates, now), boxNote(work, src.me, now)].filter((note): note is string => note !== null);
}
