/**
 * What one agent did for another, kept once it has ended: an `ask` and a mission another agent started.
 *
 * An ask answered inside the asking turn runs under that turn, with no history and no record of its own, so once it
 * ended nothing said it had happened: the helper's own chats held no trace of the work, and the asker could not be told
 * what followed it. One row each, written where the work ends, read as a turn's message is composed (`work-done.ts`).
 *
 * Small on purpose: what was asked and how it ended are cut as they are written, and rows a week old go with the next
 * one written, so the table is bounded by how much the agents ask of each other in a week.
 */

import { clipTrimmed, oneLine, type Port } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

/** How much of what was asked is kept, and of how it ended, and of the helper's later answer. Starting values. */
export const TASK_KEPT = 200;
export const OUTCOME_KEPT = 400;
export const SAID_KEPT = 300;
/** A row older than this is removed when one is written. */
export const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** How many a read returns at most: the lines said are fewer, after the ones whose words belong elsewhere. */
const READ_MAX = 12;

export interface WorkDone {
  id: number;
  kind: "ask" | "mission";
  /** The agent that did it. */
  helper: string;
  /** The agent that asked. */
  asker: string;
  /** The chat it was asked from, and the person the asking turn answered: none where no person began it. */
  gatewayId: string;
  chatId: string;
  senderId: string | null;
  task: string;
  outcome: string;
  /** A job's or a mission's id, where there is one to read the rest from. */
  ref: string | null;
  endedAt: number;
  /** The helper's next answer to the same person in a private chat of its own: when, and how it began. */
  saidAt: number | null;
  said: string | null;
}

export type WorkDoneInput = Pick<WorkDone, "kind" | "helper" | "asker" | "gatewayId" | "chatId" | "senderId" | "task" | "outcome" | "ref">;

interface Row {
  id: number;
  kind: string;
  helper: string;
  asker: string;
  gateway_id: string;
  chat_id: string;
  sender_id: string | null;
  task: string;
  outcome: string;
  ref: string | null;
  ended_at: number;
  said_at: number | null;
  said: string | null;
}

/** On one line, cut, with nothing that closes a quote: these are said inside one, in another agent's message. */
const kept = (text: string, max: number): string => clipTrimmed(oneLine(text), max).replace(/[`"]/g, "'");

const toRecord = (row: Row): WorkDone => ({
  id: row.id,
  kind: row.kind === "mission" ? "mission" : "ask",
  helper: row.helper,
  asker: row.asker,
  gatewayId: row.gateway_id,
  chatId: row.chat_id,
  senderId: row.sender_id,
  task: row.task,
  outcome: row.outcome,
  ref: row.ref,
  endedAt: row.ended_at,
  saidAt: row.said_at,
  said: row.said,
});

export class WorkDoneStore {
  constructor(
    private readonly db: SqliteDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** Work that ended just now. An agent's work for itself is not another's: nothing is kept. */
  record(input: WorkDoneInput): void {
    if (input.helper === input.asker) return;
    const at = this.now();
    this.db.prepare("DELETE FROM work_for_another WHERE ended_at < ?").run(at - KEPT_MS);
    this.db
      .prepare("INSERT INTO work_for_another (kind, helper, asker, gateway_id, chat_id, sender_id, task, outcome, ref, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.kind, input.helper, input.asker, input.gatewayId, input.chatId, input.senderId, kept(input.task, TASK_KEPT), kept(input.outcome, OUTCOME_KEPT), input.ref, at);
  }

  /** What an agent did for others since `since`, newest first. */
  byHelper(helper: string, since: number): WorkDone[] {
    return this.db
      .prepare<Row>(
        "SELECT id, kind, helper, asker, gateway_id, chat_id, sender_id, task, outcome, ref, ended_at, said_at, said FROM work_for_another WHERE helper = ? AND ended_at >= ? ORDER BY ended_at DESC, id DESC LIMIT ?",
      )
      .all(helper, since, READ_MAX)
      .map(toRecord);
  }

  /** What others did for an agent since `since` and have talked of with a person since, the latest talk first. */
  talkedOf(asker: string, since: number): WorkDone[] {
    return this.db
      .prepare<Row>(
        "SELECT id, kind, helper, asker, gateway_id, chat_id, sender_id, task, outcome, ref, ended_at, said_at, said FROM work_for_another WHERE asker = ? AND ended_at >= ? AND said_at IS NOT NULL ORDER BY said_at DESC, id DESC LIMIT ?",
      )
      .all(asker, since, READ_MAX)
      .map(toRecord);
  }

  /** The helper answered the person this work was for, in a private chat of its own: when, where, and how the answer began. */
  said(id: number, reply: string, where: { gatewayId: string; chatId: string }): void {
    this.db
      .prepare("UPDATE work_for_another SET said_at = ?, said = ?, said_gateway_id = ?, said_chat_id = ? WHERE id = ?")
      .run(this.now(), kept(reply, SAID_KEPT), where.gatewayId, where.chatId, id);
  }

  /**
   * A conversation was deleted: the work its agent asked for from it goes with it, and so does an answer its agent gave
   * in it, kept on work it did. Deleted means nowhere: neither is said in another chat afterwards. How many rows went.
   */
  forgetChat(agentId: string, gatewayId: string, chatId: string): number {
    this.db
      .prepare("UPDATE work_for_another SET said_at = NULL, said = NULL, said_gateway_id = NULL, said_chat_id = NULL WHERE helper = ? AND said_gateway_id = ? AND said_chat_id = ?")
      .run(agentId, gatewayId, chatId);
    return this.db.prepare("DELETE FROM work_for_another WHERE asker = ? AND gateway_id = ? AND chat_id = ?").run(agentId, gatewayId, chatId).changes;
  }
}

/** What one agent did for another, as the daemon depends on it — see `Port` in `@nouride/shared`. */
export type WorkDonePort = Port<WorkDoneStore>;
