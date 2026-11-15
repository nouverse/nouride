/**
 * Work between agents that has ended, said on the message a turn answers: what this agent did for another lately, and
 * what an agent that worked for this one has since said to the same person.
 *
 * Nestor handed Nix a step of a benchmark with `ask`. Nix's report went back to Nestor, and that was all of it: when the
 * person pasted Nestor's message into their own chat with Nix, Nix read it as news and checked the code from nothing,
 * having no trace of the work it had just done; and Nestor knew nothing of what the person and Nix then settled. An
 * ask runs under the asking turn, with no history and no record of its own, so both holes are one: nothing kept it.
 *
 * On the message and never in the prompt, as `work-now.ts` is, and with its rule for **whose words**: what was asked,
 * how it ended and what was said after are said only where this chat's reader may know them. The helper's answer to a
 * person is told to the asker only on a turn that answers that same person, and only a private chat's is ever kept: a
 * room's words stay in the room.
 *
 * **Once in a chat.** A message is kept as it was sent, so a line on every message of a day would be in the chat's
 * history as many times. Each line is said where the conversation does not hold it yet, as the dashboard's pages are
 * (`pageNotes`), and its times are a clock's, not "two hours ago", so the line is the same text each time it is made.
 * A summary that took the place of the message that held it has it said again.
 *
 * Every line is the daemon's, made of ids, times and cut text in quotes. No agent writes into another's message.
 */

import { type ChatMessage, createLogger, messageText, type Person } from "@nouride/shared";
import { localTime, safeTimeZone } from "@/commons/clock.ts";
import type { Mission } from "@/modules/missions/types.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import type { WorkDone, WorkDoneInput, WorkDoneStore } from "./work-done.store.ts";
import { samePersonIn, type Sender } from "./work-now.ts";

const log = createLogger("pipeline.work-done");

/** How long ago work may have ended and still be said. A starting value. */
export const DONE_WITHIN_MS = 24 * 60 * 60 * 1000;
/** How many are said: what this agent did for others, and what others who worked for it have said since. */
export const HELPED_SHOWN = 3;
export const TALKED_SHOWN = 2;

export interface DoneSources {
  /** The chat this turn runs in. */
  at: { gatewayId: string; chatId: string };
  /** The person this turn answers. None for a turn no person began. */
  reader?: Sender;
  /** What this agent did for others lately, newest first. */
  helped: readonly WorkDone[];
  /** What others did for this agent lately and have talked of with a person since, the latest talk first. */
  talked: readonly WorkDone[];
  samePerson(a: Sender, b: Sender): boolean;
  /** The daemon's timezone: a time is said as the clock on each message says it. */
  timeZone: string;
  /** Whether this conversation already holds a line. */
  held(line: string): boolean;
}

const clock = (at: number, src: DoneSources): string => {
  const local = localTime(at, safeTimeZone(src.timeZone));
  return `${local.day} ${local.time}`;
};

/** The person a piece of work was for is the one this turn answers. */
const forReader = (row: WorkDone, src: DoneSources): boolean =>
  row.senderId !== null && src.reader !== undefined && src.samePerson({ gatewayId: row.gatewayId, senderId: row.senderId }, src.reader);

const askedHere = (row: WorkDone, src: DoneSources): boolean => row.gatewayId === src.at.gatewayId && row.chatId === src.at.chatId;

/** What this agent did for others: in words where this chat may know them, by its kind and its time anywhere else. */
export function helpedNote(src: DoneSources): string | null {
  const lines = src.helped
    .slice(0, HELPED_SHOWN)
    .map((row) => {
      const what = row.kind === "mission" ? "A mission" : "A job";
      if (!askedHere(row, src) && !forReader(row, src)) return `${what} for ${row.asker}, ended ${clock(row.endedAt, src)}, asked from a chat whose words are not this one's.`;
      return `${what} for ${row.asker}, ended ${clock(row.endedAt, src)}${row.ref ? ` (${row.ref})` : ""}: asked "${row.task}"; it ended ${row.outcome}.`;
    })
    .filter((line) => !src.held(line));
  if (lines.length === 0) return null;
  return `(Work you did for another agent lately. It is in no chat's history of yours, and a person may speak of it here as something you know: ${lines.join(" ")})`;
}

/** What an agent that worked for this one has since said to the person this turn answers, in a chat of their own. */
export function talkedNote(src: DoneSources): string | null {
  const lines = src.talked
    .filter((row) => row.saidAt !== null && row.said && forReader(row, src))
    .slice(0, TALKED_SHOWN)
    .map((row) => `Since ${row.helper} worked for you on "${row.task}" (ended ${clock(row.endedAt, src)}), it has answered the person you are answering in a chat of their own, at ${clock(row.saidAt!, src)}. That answer began: "${row.said}".`)
    .filter((line) => !src.held(line));
  if (lines.length === 0) return null;
  return `(What they settled there is not in this chat: ${lines.join(" ")})`;
}

/** Whether a conversation holds a line already: in a message of the person's, where a turn's notes are kept as sent. */
export function heldIn(history: readonly ChatMessage[], line: string): boolean {
  return history.some((message) => message.role === "user" && messageText(message.content).includes(line));
}

/** The lines a turn's message carries. */
export function doneNotes(src: DoneSources): string[] {
  return [helpedNote(src), talkedNote(src)].filter((note): note is string => note !== null);
}

/** What the daemon holds, as `doneNotes` reads it. Nothing where the store is not there. */
export function doneSources(
  store: Pick<WorkDoneStore, "byHelper" | "talkedOf"> | undefined,
  input: { me: string; at: { gatewayId: string; chatId: string }; reader: Sender | undefined; people: readonly Person[]; now: number; timeZone: string; held: (line: string) => boolean },
): DoneSources {
  const since = input.now - DONE_WITHIN_MS;
  return {
    at: input.at,
    ...(input.reader ? { reader: input.reader } : {}),
    helped: store?.byHelper(input.me, since) ?? [],
    talked: store?.talkedOf(input.me, since) ?? [],
    samePerson: samePersonIn(input.people),
    timeZone: input.timeZone,
    held: input.held,
  };
}

/** How a helper's work ended, in one line: its state, why where it says, and its own words. */
const ended = (report: Pick<SubAgentHandoff, "status" | "summary" | "reason">): string =>
  `${report.status}${report.reason ? ` (${report.reason})` : ""}${report.summary.trim() ? `: ${report.summary.trim()}` : ""}`;

/**
 * An ask that ended, as the row kept of it. Null for one a restart stopped at a step: it is taken up by the next boot
 * and ends then, and a row now would say it had ended twice.
 */
export function askDone(input: {
  helper: string;
  asker: string;
  from: { gatewayId: string; chatId: string; senderId?: string | undefined };
  task: string;
  report: Pick<SubAgentHandoff, "status" | "summary" | "reason">;
  job?: string | undefined;
  paused?: boolean | undefined;
}): WorkDoneInput | null {
  if (input.paused) return null;
  return {
    kind: "ask",
    helper: input.helper,
    asker: input.asker,
    gatewayId: input.from.gatewayId,
    chatId: input.from.chatId,
    senderId: input.from.senderId ?? null,
    task: input.task,
    outcome: ended(input.report),
    ref: input.job ?? null,
  };
}

/** A mission another agent started, once it has ended, as the row kept of it. Null for one a person started, or its own agent. */
export function missionDone(mission: Pick<Mission, "id" | "agentId" | "byAgent" | "gatewayId" | "chatId" | "startedBy" | "goal" | "status" | "reason" | "report">): WorkDoneInput | null {
  if (!mission.byAgent || mission.byAgent === mission.agentId) return null;
  return {
    kind: "mission",
    helper: mission.agentId,
    asker: mission.byAgent,
    gatewayId: mission.gatewayId,
    chatId: mission.chatId,
    senderId: mission.startedBy || null,
    task: mission.goal,
    outcome: `${mission.status}${mission.reason ? ` (${mission.reason})` : ""}${mission.report?.trim() ? `: ${mission.report.trim()}` : ""}`,
    ref: mission.id,
  };
}

/** Keep work that ended. Never a failure of the work it is kept of: a row that could not be written is said in the log. */
export function keepDone(store: Pick<WorkDoneStore, "record"> | undefined, row: WorkDoneInput | null): void {
  if (!store || !row) return;
  try {
    store.record(row);
  } catch (err) {
    log.warn("work one agent did for another could not be kept for their chats", { helper: row.helper, asker: row.asker, error: String(err) });
  }
}

/**
 * The helper has answered a person in a private chat of its own: kept on each piece of its recent work that was for
 * that person, for the asker to be told. A room's answer is never kept, nor one to a turn no person began.
 */
export function keepSaid(
  store: Pick<WorkDoneStore, "byHelper" | "said"> | undefined,
  input: { me: string; at: { gatewayId: string; chatId: string }; private: boolean; reader: Sender | undefined; reply: string; people: readonly Person[]; now: number },
): void {
  const { reader } = input;
  if (!store || !input.private || !reader || !input.reply.trim()) return;
  const same = samePersonIn(input.people);
  try {
    for (const row of store.byHelper(input.me, input.now - DONE_WITHIN_MS)) {
      if (row.senderId !== null && same({ gatewayId: row.gatewayId, senderId: row.senderId }, reader)) store.said(row.id, input.reply, { gatewayId: input.at.gatewayId, chatId: input.at.chatId });
    }
  } catch (err) {
    log.warn("an answer could not be kept on the work it follows", { agent_id: input.me, error: String(err) });
  }
}
