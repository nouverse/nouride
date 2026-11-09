/**
 * The turn journal.
 *
 * Every message of a running turn, committed as it happens: the question, each model reply with the
 * tool calls it asks for, each tool result. The model's request to run a tool is committed before the
 * tool runs, and the ids of the calls about to start are committed just before they do — so after a
 * crash the journal says exactly which call was running and which never began.
 *
 * It lives as long as one turn. When the turn ends — however it ends — the journal is folded into the
 * conversation and deleted in the same transaction (`close.ts`, `pipeline/turn.ts`). What is still here
 * at boot is a turn that never ended, and `boot/durable.ts` closes it.
 *
 * A write that fails is logged and swallowed, never thrown: a journal that cannot be written makes a
 * crash cost more, and a turn that died because its journal could not be written would cost everything.
 * Swallowed is not silent: each one is counted, for `/health`, and takes its row's number anyway, so
 * the journal it leaves has a hole a closing can see — and does not read past to say a call never started.
 */

import { createLogger, type ChatMessage, type Port } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";

const log = createLogger("turns.journal");

/** Whose conversation a journal belongs to. Row 0 of every journal. */
export interface JournalHead {
  agentId: string;
  gatewayId: string;
  chatId: string;
  /**
   * A chat turn has a `turn_records` row and a person waiting in the chat; a job turn (cron) has
   * neither, and its own run record says how it ended.
   */
  kind: "chat" | "job";
  startedAt: number;
}

/** One row after the head: a message of the turn, or the ids of tool calls about to run. */
export type JournalEntry = { message: ChatMessage } | { started: string[] };

/** A journal still here at boot, read back whole. */
export interface UnsettledTurn {
  turnId: string;
  head: JournalHead;
  entries: JournalEntry[];
  /** Whether its rows run without a gap: a write that failed left one, and what it held is not here. */
  complete: boolean;
}

/** What the executor writes into while a turn runs. */
export interface TurnJournal {
  readonly turnId: string;
  /** A message of the turn, in the order the model sees it. */
  record(message: ChatMessage): void;
  /** The question as composed, in place of the one the journal was opened with — its words before the files were in. */
  question(message: ChatMessage): void;
  /** The calls about to run — after the message that asked for them, before the first one starts. */
  started(callIds: readonly string[]): void;
  /** Everything recorded so far, in order. */
  entries(): JournalEntry[];
  /** Whether every write so far landed — a closing reads nothing past a hole as having not happened. */
  complete(): boolean;
}

export class TurnJournalStore {
  /** Writes that failed since this process started, and when the last one did — `/health`. */
  private failed = { count: 0, lastAt: null as number | null };

  constructor(private readonly db: SqliteDb) {}

  /** How many journal writes failed since this process started, and when the last one did. */
  failures(): { count: number; lastAt: number | null } {
    return { ...this.failed };
  }

  /**
   * Open a turn's journal with its head and its question.
   *
   * The question is the first entry because it is the one thing every closing needs: a turn that dies
   * before its first model call still leaves the conversation holding what was asked.
   */
  open(turnId: string, head: JournalHead, question: ChatMessage): TurnJournal {
    let seq = 0;
    let lost = 0;
    const write = (entry: JournalHead | JournalEntry, kind: string): void => {
      // Taken whether the row lands or not, so one that does not leaves a gap the reader sees.
      const at = seq++;
      try {
        this.db
          .prepare("INSERT INTO turn_journal (turn_id, seq, at, entry) VALUES (?, ?, ?, ?)")
          .run(turnId, at, Date.now(), JSON.stringify(at === 0 ? { head: entry } : entry));
      } catch (err) {
        lost += 1;
        this.failed = { count: this.failed.count + 1, lastAt: Date.now() };
        log.error("could not journal a turn", { turn_id: turnId, kind, error: String(err) });
      }
    };
    // One commit, not two: a journal with a head and no question is not one any reader wants. Never thrown, as no
    // single write is: a commit that fails takes both rows, and the journal is incomplete from its first entry.
    try {
      this.db.transaction(() => {
        write(head, "head");
        write({ message: question }, "question");
      });
    } catch (err) {
      lost += 2;
      this.failed = { count: this.failed.count + 1, lastAt: Date.now() };
      log.error("could not journal a turn", { turn_id: turnId, kind: "open", error: String(err) });
    }
    return {
      turnId,
      record: (message) => write({ message }, "message"),
      // Row 1, whatever happened to row 0: every write takes its number.
      question: (message) => {
        try {
          this.db.prepare("UPDATE turn_journal SET entry = ? WHERE turn_id = ? AND seq = 1").run(JSON.stringify({ message }), turnId);
        } catch (err) {
          this.failed = { count: this.failed.count + 1, lastAt: Date.now() };
          log.error("could not journal a turn", { turn_id: turnId, kind: "question", error: String(err) });
        }
      },
      started: (callIds) => {
        if (callIds.length > 0) write({ started: [...callIds] }, "started");
      },
      entries: () => this.read(turnId)?.entries ?? [],
      complete: () => lost === 0,
    };
  }

  /** A turn's journal, head and entries — or null when there is none. */
  read(turnId: string): UnsettledTurn | null {
    const rows = this.db
      .prepare<JournalRow>("SELECT seq, entry FROM turn_journal WHERE turn_id = ? ORDER BY seq")
      .all(turnId);
    return parse(turnId, rows);
  }

  /** Delete a turn's journal. Called inside the transaction that folds it into the conversation. */
  clear(turnId: string): void {
    this.db.prepare("DELETE FROM turn_journal WHERE turn_id = ?").run(turnId);
  }

  /**
   * Every journal still here — turns that never ended. Read once, at boot, before anything listens;
   * the table is empty after a clean stop, so this is a scan of nothing.
   */
  unsettled(): UnsettledTurn[] {
    const rows = this.db
      .prepare<JournalRow & { turn_id: string }>("SELECT turn_id, seq, entry FROM turn_journal ORDER BY turn_id, seq")
      .all();
    const byTurn = new Map<string, JournalRow[]>();
    for (const row of rows) byTurn.set(row.turn_id, [...(byTurn.get(row.turn_id) ?? []), row]);
    const out: UnsettledTurn[] = [];
    for (const [turnId, entries] of byTurn) {
      const turn = parse(turnId, entries);
      if (turn) out.push(turn);
      // A journal without a readable head names no conversation to fold into — nothing can be done
      // with it but say so and let it go.
      else {
        log.warn("dropped a turn journal without a readable head", { turn_id: turnId, rows: entries.length });
        this.clear(turnId);
      }
    }
    return out;
  }

  /** Journals open right now — `nouride doctor`, and a test's way of seeing one was left behind. */
  count(): number {
    return this.db.prepare<{ n: number }>("SELECT COUNT(DISTINCT turn_id) AS n FROM turn_journal").get()?.n ?? 0;
  }
}

export type TurnJournalPort = Port<TurnJournalStore>;

interface JournalRow {
  seq: number;
  entry: string;
}

function parse(turnId: string, rows: readonly JournalRow[]): UnsettledTurn | null {
  const [first, ...rest] = rows.map(({ entry: text }) => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  });
  const head = first && typeof first.head === "object" && first.head !== null ? (first.head as JournalHead) : null;
  if (!head) return null;
  const entries: JournalEntry[] = [];
  let unread = 0;
  for (const [index, entry] of rest.entries()) {
    if (entry && typeof entry.message === "object" && entry.message !== null) entries.push({ message: entry.message as ChatMessage });
    else if (entry && Array.isArray(entry.started)) entries.push({ started: entry.started.filter((id): id is string => typeof id === "string") });
    else {
      // A row that does not read is a hole as surely as one never written: what it held is not here, and a closing that
      // read past it would say a call it named never began. Its number, never its content — that is somebody's words.
      log.warn("skipped a turn journal row that could not be read", { turn_id: turnId, seq: rows[index + 1]!.seq });
      unread += 1;
    }
  }
  return { turnId, head, entries, complete: unread === 0 && rows.every((row, index) => row.seq === index) };
}
