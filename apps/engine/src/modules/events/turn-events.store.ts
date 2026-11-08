/**
 * `TurnStore`, its steps kept in the event stream (`events.store.ts`).
 *
 * The records are `turn_records`, the base class's; everything a turn does as it runs is a row of the stream —
 * its start and end, each step, a step taken back, and the answer as it is written, only what is new each time,
 * so a long answer is not written again at every flush: a reader adds them up.
 *
 * The stream is the one place a turn's steps are.
 */

import type { SqliteDb } from "@nouride/runtime";
import { TURN_STEP_KINDS, type EventCut, type TurnEventData, type TurnEventKind, type TurnStepKind } from "@nouride/shared";
import { EDITED, isDelegated, TurnStore, type BeginTurn, type FinishTurn, type InterruptedTurns, type TurnStep } from "@/modules/turns/turns.store.ts";
import type { EventInput, EventsPort } from "./events.store.ts";

const DAY_MS = 24 * 60 * 60_000;
/** A step's text and a prompt are cut here, and say so (`cut`); an answer's text is split here into rows, never cut. */
const TEXT_MAX = 2_000;
/** The answer a turn's end and a command's answer carry, beside its whole length (`replyChars`). */
const REPLY_MAX = 4_000;

/** `value` cut to `max`, and — when it was — the key to name in `cut`. */
function clipped(key: string, value: string, max = TEXT_MAX): { value: string; cut: string[] } {
  return value.length > max ? { value: value.slice(0, max), cut: [key] } : { value, cut: [] };
}

/** `truncated` and `cut`, for the keys a writer cut itself — nothing when it cut none. */
function said(cut: readonly string[]): EventCut {
  return cut.length > 0 ? { truncated: true, cut: [...cut] } : {};
}

/**
 * Steps kept per turn.
 *
 * Generous — a long agentic turn genuinely runs fifty tools — and still a cap, because the one thing a step log
 * must not do is turn a runaway loop into an unbounded one. Past it one `note` says so, marked `capped`, and the
 * remarks stop. A tool call, its result and a wait for a person are still written: a reader pairs a call with its
 * result, and a wait is somebody being asked something.
 */
const MAX_STEPS = 500;
const PAST_THE_CAP: ReadonlySet<TurnStepKind> = new Set(["tool", "tool_done", "waiting"]);
/** The kinds that are steps — and `unstep`, which takes some back — as the JSON array the reads bind. */
const STEP_ROWS = JSON.stringify([...TURN_STEP_KINDS, "unstep"]);

interface Where {
  agentId: string;
  gatewayId: string;
  chatId: string;
  /** How much of the answer the stream has been given. */
  replied: number;
}

/** A running turn's next step number, and whether its log has been capped. */
interface Counter {
  next: number;
  capped: boolean;
}

interface StepEventRow {
  turn_id: string;
  at: number;
  kind: string;
  data: string;
}

export class EventedTurnStore extends TurnStore {
  /** Each running turn's place, so a step's row says whose and where without a read. Dropped as it finishes. */
  private readonly live = new Map<string, Where>();
  /**
   * Each running turn's step numbers, in memory: the alternative is reading the turn's steps back before every
   * one. A turn this process did not begin — taken up after a restart — counts on from its highest step, read once.
   */
  private readonly counters = new Map<string, Counter>();
  /** Each turn's request lines not yet written: they go with its next row (`context`). */
  private readonly lines = new Map<string, TurnEventData["context"][]>();

  constructor(
    db: SqliteDb,
    private readonly events: EventsPort,
  ) {
    super(db);
  }

  /** Each write of a record with its row is one transaction (`EventStore.batch`): a follower never sees one alone. */
  override begin(input: BeginTurn): string {
    return this.events.batch(() => {
      const id = super.begin(input);
      this.live.set(id, { agentId: input.agentId, gatewayId: input.gatewayId, chatId: input.chatId, replied: 0 });
      this.counters.set(id, { next: 1, capped: false });
      const prompt = clipped("prompt", input.prompt);
      // A turn answering an edit says which message was edited (1.3) — from its cause, the one place the record keeps it.
      const editOf = input.cause?.via === EDITED ? input.cause.of : undefined;
      // A delegate's own turn says whose it is (1.4): a reader following the chat leaves it out of the conversation.
      const delegated = isDelegated(input.cause) ? { via: input.cause.via, by: input.agentId } : {};
      this.emit(id, "turn", { phase: "start", sessionId: input.sessionId, prompt: prompt.value, ...(input.messageId ? { messageId: input.messageId } : {}), ...(input.senderId ? { senderId: input.senderId } : {}), ...(editOf ? { editOf } : {}), ...delegated, ...said(prompt.cut) });
      return id;
    });
  }

  /** A slash command's answer: a turn with no model in it, written whole. */
  override note(input: BeginTurn & { reply: string }): string {
    return this.events.batch(() => {
      const id = super.note(input);
      const prompt = clipped("prompt", input.prompt);
      // The answer's whole length beside it, as a turn's end has: cut at 4,000, it said nothing of what was left.
      const data = { phase: "note" as const, prompt: prompt.value, reply: input.reply.slice(0, REPLY_MAX), replyChars: input.reply.length, ...said(prompt.cut) };
      this.events.append({ kind: "turn", turnId: id, agentId: input.agentId, gatewayId: input.gatewayId, chatId: input.chatId, data });
      return id;
    });
  }

  /**
   * `step` and `text` are written after `detail`, so a detail can never stand in for either. A `tool_done` whose
   * detail carries `audit` — the call's audit row (`tools/audited.ts`) — is written as an `audit` row of its own,
   * first, in the same transaction as the step: a follower is told a result and its audit together.
   */
  override step(turnId: string, kind: TurnStepKind, text: string, detail?: Record<string, unknown>): number {
    const counter = this.counters.get(turnId) ?? this.recount(turnId);
    if (!counter) return 0;
    if (counter.next > MAX_STEPS && !PAST_THE_CAP.has(kind)) {
      if (!counter.capped) {
        counter.capped = true;
        this.emit(turnId, "note", { step: counter.next++, text: `step log capped at ${MAX_STEPS}: tool calls and waits are still recorded`, capped: true });
      }
      return 0;
    }
    const step = counter.next++;
    const { audit, ...rest } = detail ?? {};
    const line = clipped("text", text);
    const data = { ...rest, step, text: line.value, ...said(line.cut) } as unknown as TurnEventData[TurnStepKind];
    return this.events.batch(() => {
      if (kind === "tool_done" && audit && typeof audit === "object") this.emit(turnId, "audit", audit as TurnEventData["audit"]);
      return this.emit(turnId, kind, data) > 0 ? step : 0;
    });
  }

  /** Said, not deleted: every reader leaves out a step a later `unstep` names. */
  override unstep(turnId: string, seqs: readonly number[]): void {
    if (seqs.length > 0) this.emit(turnId, "unstep", { steps: [...seqs] });
  }

  /** Only of a turn still running: a pulse is now or never. */
  override pulse(turnId: string, text: string): void {
    const where = this.live.get(turnId);
    if (where) this.events.pulse({ turnId, agentId: where.agentId, gatewayId: where.gatewayId, chatId: where.chatId, text });
  }

  /**
   * Kept, unlike a pulse: what a request carried is read back with the turn (`contextOfTurn`). Not a step, no number.
   * Held until the turn writes its next row — the request's first answer, a step, its end — and written in that row's
   * commit: never a commit of its own, which a Box's card would take once a request.
   */
  override context(turnId: string, line: TurnEventData["context"]): void {
    this.lines.set(turnId, [...(this.lines.get(turnId) ?? []), line]);
  }

  override stepsSince(turnId: string, after = 0): TurnStep[] {
    const steps = stepsOf(this.db, [turnId]).get(turnId) ?? [];
    return after > 0 ? steps.filter((step) => step.seq > after) : steps;
  }

  protected override stepsFor(turnIds: readonly string[]): Map<string, TurnStep[]> {
    return stepsOf(this.db, turnIds);
  }

  /**
   * The most frequent write of a long answer — every 400 ms or 240 characters — so one commit, not two. What is new
   * goes in rows of at most 2,000 characters, each with its own `from`: one row over the size bound had its text cut,
   * and the rows stopped adding up to the answer.
   */
  override setReply(turnId: string, reply: string): void {
    this.events.batch(() => {
      super.setReply(turnId, reply);
      const where = this.live.get(turnId);
      const from = where && reply.length >= where.replied ? where.replied : 0;
      if (where) where.replied = reply.length;
      for (let at = from; at < reply.length; at += TEXT_MAX) this.emit(turnId, "reply", { from: at, text: reply.slice(at, at + TEXT_MAX) });
    });
  }

  override finish(turnId: string, patch: FinishTurn): void {
    this.events.batch(() => {
      super.finish(turnId, patch);
      this.emit(turnId, "turn", {
        phase: "end",
        status: patch.status,
        ...(patch.reply !== undefined ? { reply: patch.reply.slice(0, REPLY_MAX), replyChars: patch.reply.length } : {}),
        ...(patch.error ? { error: patch.error.slice(0, 1_000) } : {}),
        ...(patch.model ? { model: patch.model } : {}),
        ...(patch.toolCalls !== undefined ? { toolCalls: patch.toolCalls } : {}),
        ...(patch.inputTokens !== undefined ? { inputTokens: patch.inputTokens, outputTokens: patch.outputTokens ?? 0 } : {}),
      });
    });
    this.live.delete(turnId);
    this.counters.delete(turnId);
    this.lines.delete(turnId);
  }

  /**
   * Turns a restart cut off, each ended in the stream as in its record — `interrupted`. A follower, or an editor
   * driving a turn, waited for an end that never came; a turn taken up again is a new turn, with a start of its own.
   */
  override interruptOrphaned(now: number = Date.now()): InterruptedTurns {
    return this.events.batch(() => {
      const interrupted = super.interruptOrphaned(now);
      for (const turnId of [...interrupted.conversations.map((conversation) => conversation.turnId), ...interrupted.delegated]) {
        if (turnId) this.emit(turnId, "turn", { phase: "end", status: "interrupted", error: "the daemon restarted while this turn was running" });
      }
      return interrupted;
    });
  }

  /**
   * A conversation's turns and everything they streamed, in one transaction. A turn of it still running is
   * forgotten here too, so what it writes after this — its end, a last step — goes nowhere (`emit`).
   */
  override deleteForSession(sessionId: string): number {
    return this.events.batch(() => {
      const own = this.db.prepare<{ id: string }>("SELECT id FROM turn_records WHERE session_id = ?").all(sessionId).map((row) => row.id);
      // And its delegates' turns, which the record deletes with it.
      const ids = [...own, ...this.delegatesOf(sessionId)];
      for (const id of ids) {
        this.live.delete(id);
        this.counters.delete(id);
        this.lines.delete(id);
      }
      this.events.forget(ids);
      return super.deleteForSession(sessionId);
    });
  }

  /** The turns' retention is the stream's: one history, read two ways. */
  override sweep(retentionDays: number, now: number = Date.now()): number {
    const removed = super.sweep(retentionDays, now);
    if (retentionDays > 0) this.events.sweep(now - retentionDays * DAY_MS);
    return removed;
  }

  /** The row's `seq`, or 0 — for a turn with no record, too: it was deleted, and its writes go nowhere. */
  private emit<K extends TurnEventKind>(turnId: string, kind: K, data: TurnEventData[K] & EventCut): number {
    const where = this.live.get(turnId) ?? this.adopt(turnId);
    if (!where) return 0;
    const row = (k: TurnEventKind, d: unknown) =>
      this.events.append({ kind: k, turnId, agentId: where.agentId, gatewayId: where.gatewayId, chatId: where.chatId, data: d } as unknown as EventInput);
    // The request lines held for this turn go first, in this row's commit (`context`).
    const held = this.lines.get(turnId);
    if (held) {
      this.lines.delete(turnId);
      for (const line of held) row("context", line);
    }
    return row(kind, data);
  }

  /** A turn this process did not begin — taken up after a restart — read once and remembered while it runs. */
  private adopt(turnId: string): Where | undefined {
    const record = this.get(turnId);
    if (!record) return undefined;
    const where = { agentId: record.agentId, gatewayId: record.gatewayId, chatId: record.chatId, replied: record.reply.length };
    if (record.status === "running") this.live.set(turnId, where);
    return where;
  }

  /** Its counter, from the highest step it ever had, taken back or not. */
  private recount(turnId: string): Counter | undefined {
    const record = this.get(turnId);
    if (!record) return undefined;
    let highest = 0;
    let capped = false;
    for (const row of stepRows(this.db, [turnId])) {
      const data = parse(row.data);
      if (typeof data?.step === "number") highest = Math.max(highest, data.step);
      if (data?.capped === true) capped = true;
    }
    const counter = { next: highest + 1, capped };
    if (record.status === "running") this.counters.set(turnId, counter);
    return counter;
  }
}

/** What each model request of one turn carried (`context` rows, 1.4), oldest first — what `nouride turns show` prints. */
export function contextOfTurn(db: SqliteDb, turnId: string): TurnEventData["context"][] {
  return db
    .prepare<{ data: string }>("SELECT data FROM events WHERE turn_id = ? AND kind = 'context' ORDER BY seq")
    .all(turnId)
    .flatMap((row) => {
      const data = parse(row.data);
      return data && typeof data.request === "number" ? [data as unknown as TurnEventData["context"]] : [];
    });
}

/** The steps of one turn, as `nouride turns show` reads them — the same read a transcript's turns get. */
export function stepsOfTurn(db: SqliteDb, turnId: string): TurnStep[] {
  return stepsOf(db, [turnId]).get(turnId) ?? [];
}

/** Each turn's steps, read from the stream. */
function stepsOf(db: SqliteDb, turnIds: readonly string[]): Map<string, TurnStep[]> {
  const byTurn = new Map<string, StepEventRow[]>();
  for (const row of stepRows(db, turnIds)) byTurn.set(row.turn_id, [...(byTurn.get(row.turn_id) ?? []), row]);
  return new Map([...byTurn].map(([id, rows]) => [id, assemble(rows)] as const));
}

function stepRows(db: SqliteDb, turnIds: readonly string[]): StepEventRow[] {
  return db
    .prepare<StepEventRow>(
      `SELECT turn_id, at, kind, data FROM events
       WHERE turn_id IN (SELECT value FROM json_each(?)) AND kind IN (SELECT value FROM json_each(?))
       ORDER BY turn_id, seq`,
    )
    .all(JSON.stringify(turnIds), STEP_ROWS);
}

/**
 * One turn's step rows, in the order they were written, as its steps. An `unstep` takes back only what came
 * before it — a number handed out again after it is a new step — and a row that does not parse is skipped, not
 * a transcript that fails to open.
 */
function assemble(rows: readonly StepEventRow[]): TurnStep[] {
  const steps: TurnStep[] = [];
  for (const row of rows) {
    const data = parse(row.data);
    if (row.kind === "unstep") {
      const gone = new Set(Array.isArray(data?.steps) ? data.steps : []);
      for (let i = steps.length - 1; i >= 0; i -= 1) if (gone.has(steps[i]!.seq)) steps.splice(i, 1);
    } else if (typeof data?.step === "number") {
      steps.push({
        seq: data.step,
        at: row.at,
        kind: row.kind as TurnStepKind,
        text: typeof data.text === "string" ? data.text : "",
        // What a reader pairs a call by and reads a result off, so it never parses the line's words for them.
        ...(typeof data.callId === "string" ? { callId: data.callId } : {}),
        ...(typeof data.name === "string" ? { name: data.name } : {}),
        ...(typeof data.error === "boolean" ? { error: data.error } : {}),
        ...(typeof data.outcome === "string" ? { outcome: data.outcome } : {}),
        ...(typeof data.editOf === "string" ? { editOf: data.editOf } : {}),
      });
    }
  }
  return steps;
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
