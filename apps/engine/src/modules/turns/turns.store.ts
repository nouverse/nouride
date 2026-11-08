/**
 * What each turn did — persisted, appendable, and readable while it is still happening.
 *
 * `session_messages` holds what was *said*: the messages, capped to the last N turns, which is what
 * the model needs and nothing more. This holds what *happened*: the tool calls in order, the
 * reasoning lines, how long it took, what came back, and — while it runs — how far it has got.
 *
 * The reason it is a table and not memory is one bug reported three ways. The dashboard chat kept the
 * steps and the clock in React state, so a refresh re-sent the message from the URL, a reload showed
 * `1 step · 1s` for a turn that had run eleven tools, and a turn still working was invisible to the
 * page that started it. A view assembled in a browser cannot survive the browser.
 *
 * Bounded by retention, like every other table that only grows — `sweep` is called from the same daily
 * pass as sessions and usage.
 *
 * This class keeps the records; the steps live in the event stream, written and read by the one subclass,
 * `EventedTurnStore` (`modules/events/turn-events.store.ts`).
 */

import { createLogger, newId, TURN_SECONDS_MAX, type Port, type TurnEventData, type TurnStepKind } from "@nouride/shared";
import type { SqliteDb } from "@nouride/runtime";
import type { TurnCause, TurnStatus } from "@nouride/wire";

const log = createLogger("turns");

/**
 * What a boot found left over from the last one.
 *
 * The count is for the log line; the conversations are for the people who were waiting. Kept
 * together because a caller that has one almost always wants the other.
 */
export interface InterruptedTurns {
  turns: number;
  /** One per turn, with its id: a turn that is taken up again is not also reported gone (`boot/durable.ts`). */
  conversations: { turnId: string; gatewayId: string; chatId: string }[];
  /**
   * A delegate's own turns closed with them (0.7.26): no conversation's, so neither reported to a chat nor taken up
   * again — the jobs they ran as are (`JobStore.interruptOrphaned`).
   */
  delegated: string[];
}

/**
 * The causes of a delegate's own turn (`pipeline/delegated-turn.ts`, 0.7.26): a helper `delegate` started in the
 * background, an agent `ask_agent` asked once its turn moved there. Recorded in the chat they work for, and no turn of
 * its conversation.
 */
const DELEGATED = ["delegate", "ask_agent"] as const;

/** Whether a turn is a delegate's own, by its cause. */
export function isDelegated(cause: TurnCause | undefined): cause is TurnCause & { via: (typeof DELEGATED)[number] } {
  return (DELEGATED as readonly string[]).includes(cause?.via ?? "");
}

/** `?, ?, …` for an `IN` list — bound, never spliced. */
const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/**
 * The chat's own turns: every read of a conversation — its transcript, its live view, what memory files, what a restart
 * takes up — says this, so none of them can count a delegate's turn as something said in the chat. One clause, so
 * they cannot disagree about which turns those are.
 */
const OWN = `(cause IS NULL OR json_extract(cause, '$.via') NOT IN (${DELEGATED.map((via) => `'${via}'`).join(", ")}))`;

/** The bounds of a conversation's children's ids, `<id>:…` — a range the session index reads, never a `LIKE`. */
export function childrenOf(sessionId: string): [string, string] {
  // `;` is the character after `:`: every id that starts with `<id>:` sorts between the two.
  return [`${sessionId}:`, `${sessionId};`];
}

/**
 * A file that arrived with the question.
 *
 * Metadata only. The file itself is in the agent's attachment store; this is what lets a transcript
 * say "three screenshots" a week later without opening anything.
 */
export interface TurnAttachment {
  name: string;
  mimeType: string;
  /** `image` | `file` | `audio` | `video` | `voice` — the gateway's own classification. */
  kind: string;
  bytes?: number;
  /** Who sent it: the person, or the agent with `send_file`. */
  direction: "in" | "out";
  /**
   * Absolute path on disk. **Never sent to a client.**
   *
   * The dashboard reaches a file by index through a route that reads this, so the path stays on the
   * daemon: a client that was handed one could ask for any file this process can open, and the whole
   * point of addressing by index is that the browser never names a path at all.
   */
  path?: string;
}

export interface TurnStep {
  seq: number;
  at: number;
  kind: TurnStepKind;
  text: string;
  /** The call a `tool`, `tool_done` or `waiting` step pairs by, and the tool — from the stream; absent before 0.7.6. */
  callId?: string;
  name?: string;
  /** A result: whether it failed, and how (`tool_done.outcome`, 1.1). */
  error?: boolean;
  outcome?: string;
  /** A `steer` that is a person's edit: the message it changes (`steer.editOf`, 1.3). */
  editOf?: string;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  agentId: string;
  gatewayId: string;
  chatId: string;
  messageId?: string;
  senderId?: string;
  status: TurnStatus;
  prompt: string;
  /** Grows while the turn runs, so a reader sees the answer being written. */
  reply: string;
  error?: string;
  model?: string;
  toolCalls: number;
  /**
   * Model round trips. The number that decides what the turn cost.
   *
   * Five tool calls in one round trip and five in five are the same work at very different prices,
   * because every round trip re-sends the whole conversation. Recorded so that is a fact somebody can
   * read rather than a guess from step timestamps.
   */
  iterations?: number;
  inputTokens?: number;
  outputTokens?: number;
  startedAt: number;
  endedAt?: number;
  attachments?: TurnAttachment[];
  /** Set on a turn the daemon started — see `TurnCause`. */
  cause?: TurnCause;
}

/** A record with its steps. What a transcript is made of. */
export interface TurnView extends TurnRecord {
  steps: TurnStep[];
}

/** The cause of a scheduled job's own turn (`pipeline/job-turns.ts`): its `job` is the job's id. */
export const SCHEDULED = "schedule";
/** The cause of a turn answering a person's edit (`pipeline/edits.ts`): `of` is the message edited. */
export const EDITED = "edit";

export interface BeginTurn {
  sessionId: string;
  agentId: string;
  gatewayId: string;
  chatId: string;
  prompt: string;
  messageId?: string;
  senderId?: string;
  attachments?: TurnAttachment[];
  cause?: TurnCause;
}

export interface FinishTurn {
  status: Exclude<TurnStatus, "running">;
  reply?: string;
  error?: string;
  model?: string;
  toolCalls?: number;
  iterations?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export abstract class TurnStore {
  constructor(protected readonly db: SqliteDb) {}

  /**
   * Insertion order for *turns*, for the ones that share a millisecond — see `forChat`. `id` is a random
   * UUID, so it orders stably but arbitrarily, and `turn_records` is WITHOUT ROWID, so there is no
   * implicit insertion order to fall back on. Not to be confused with a step's number, which orders the
   * steps *inside* one turn.
   *
   * Per process, and reset by a restart, which is why `started_at` has to stay the primary key of
   * the sort: a restart moves the clock by far more than a millisecond, so the counter never has to
   * be comparable across runs.
   */
  private inserted = 0;

  begin(input: BeginTurn): string {
    const id = newId("turn");
    const now = Date.now();
    this.inserted += 1;
    this.db
      .prepare(
        `INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, message_id,
                                   sender_id, status, prompt, reply, started_at, attachments, cause, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, '', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.gatewayId,
        input.chatId,
        input.messageId ?? null,
        input.senderId ?? null,
        input.prompt,
        now,
        input.attachments?.length ? JSON.stringify(input.attachments) : null,
        input.cause ? JSON.stringify(input.cause) : null,
        this.inserted,
      );
    return id;
  }

  /**
   * A finished exchange with no model in it.
   *
   * A slash command answered by a hook is not a turn — no provider call, no tools, nothing to watch —
   * but from the conversation's side it is a question and an answer, and a transcript that omits it
   * has a hole where the person typed `/status`. Written complete, in one insert, because there was
   * never a moment when it was in progress.
   */
  note(input: BeginTurn & { reply: string }): string {
    const id = newId("turn");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, message_id,
                                   sender_id, status, prompt, reply, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.gatewayId,
        input.chatId,
        input.messageId ?? null,
        input.senderId ?? null,
        input.prompt,
        input.reply,
        now,
        now,
      );
    return id;
  }

  /**
   * Replace the attachment list.
   *
   * Used once, when the inbound files have been copied into the agent's own directory and the upload
   * paths recorded at `begin` are no longer the durable ones.
   */
  setAttachments(turnId: string, attachments: TurnAttachment[]): void {
    this.db
      .prepare("UPDATE turn_records SET attachments = ? WHERE id = ?")
      .run(attachments.length > 0 ? JSON.stringify(attachments) : null, turnId);
  }

  /**
   * Add one file to a turn, keeping whatever is already there.
   *
   * Read-modify-write rather than a JSON append, because a turn can send several files and the read
   * is one indexed lookup. Not concurrent with itself: `send_file` runs inside the tool loop, which is
   * serialised for anything that is not parallel-safe.
   */
  addAttachment(turnId: string, attachment: TurnAttachment): void {
    const row = this.db
      .prepare<{ attachments: string | null }>("SELECT attachments FROM turn_records WHERE id = ?")
      .get(turnId);
    if (!row) return;
    const existing = parseAttachments(row.attachments)?.attachments ?? [];
    this.setAttachments(turnId, [...existing, attachment]);
  }

  /**
   * The turn running right now in one conversation, if any.
   *
   * How an outbound file finds the turn that produced it. Keyed by all three, not just the chat: two
   * agents can be working in one room, and a file belongs to the one that sent it.
   */
  runningFor(agentId: string, gatewayId: string, chatId: string): string | null {
    const row = this.db
      .prepare<{ id: string }>(
        `SELECT id FROM turn_records
         WHERE status = 'running' AND agent_id = ? AND gateway_id = ? AND chat_id = ? AND ${OWN}
         ORDER BY started_at DESC, seq DESC LIMIT 1`,
      )
      .get(agentId, gatewayId, chatId);
    return row?.id ?? null;
  }

  /**
   * Append one step to a turn: its number, from 1 within the turn, or 0 when it was not written. The steps are
   * rows of the event stream — `EventedTurnStore`. `detail` is kept with the step and never shown in the live view.
   */
  abstract step(turnId: string, kind: TurnStepKind, text: string, detail?: Record<string, unknown>): number;

  /**
   * Steps taken back off a turn: what was drawn for a message it never read (`steer-accept.ts`). That message is
   * the next turn's question, and drawn in both it reads as sent twice — `TurnContext.releaseTurn`. Said, not
   * deleted: the stream only grows, and every reader leaves out what was taken back.
   */
  abstract unstep(turnId: string, seqs: readonly number[]): void;

  /** A model call of a running turn under way, said to whoever watches it and kept nowhere — `EventedTurnStore`. */
  abstract pulse(turnId: string, text: string): void;

  /** What one model request of a turn carried (0.7.26) — a row of the stream, not a step: `EventedTurnStore`. */
  abstract context(turnId: string, line: TurnEventData["context"]): void;

  /** Steps numbered after `after`, in order, with what was taken back left out. The poll. */
  abstract stepsSince(turnId: string, after?: number): TurnStep[];

  /** The steps of each turn, keyed by turn id — what `withSteps` attaches. */
  protected abstract stepsFor(turnIds: readonly string[]): Map<string, TurnStep[]>;

  /**
   * Replace the partial answer.
   *
   * A whole-value write, not an append, because the caller holds the accumulated text anyway and a
   * `reply = reply || ?` would be one more way for a retried write to double a paragraph.
   */
  setReply(turnId: string, reply: string): void {
    this.db.prepare("UPDATE turn_records SET reply = ? WHERE id = ?").run(reply, turnId);
  }

  finish(turnId: string, patch: FinishTurn): void {
    this.db
      .prepare(
        `UPDATE turn_records SET status = ?, ended_at = ?,
           reply = COALESCE(?, reply),
           error = ?, model = COALESCE(?, model),
           tool_calls = COALESCE(?, tool_calls),
           iterations = COALESCE(?, iterations),
           input_tokens = COALESCE(?, input_tokens),
           output_tokens = COALESCE(?, output_tokens)
         WHERE id = ?`,
      )
      .run(
        patch.status,
        Date.now(),
        patch.reply ?? null,
        patch.error ?? null,
        patch.model ?? null,
        patch.toolCalls ?? null,
        patch.iterations ?? null,
        patch.inputTokens ?? null,
        patch.outputTokens ?? null,
        turnId,
      );
  }

  get(id: string): TurnRecord | null {
    const row = this.db.prepare<TurnRow>("SELECT * FROM turn_records WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  /**
   * Turns a restart closed since `since` — `pipeline/restart-resume.ts`. Bounded by `started_at` so the read
   * is the recent index and not the table: a turn starts at most `TURN_SECONDS_MAX` before it is cut.
   */
  interruptedSince(since: number): TurnRecord[] {
    return this.db.prepare<TurnRow>(`SELECT * FROM turn_records WHERE started_at >= ? AND status = 'interrupted' AND ended_at >= ? AND ${OWN} ORDER BY started_at`).all(since - TURN_SECONDS_MAX * 1000, since).map(toRecord);
  }

  /** Whether a turn started since `since` with this message id — a resumption, `resume:<turn>`, already ran. */
  startedFor(messageId: string, since: number): boolean {
    return Boolean(this.db.prepare<{ n: number }>("SELECT 1 AS n FROM turn_records WHERE started_at >= ? AND message_id = ? LIMIT 1").get(since, messageId));
  }

  /**
   * What a person last wrote in a chat, as its turn read it — a message of theirs a model answers or answered, the turn
   * still running included (the one starting a mission is), not a command, a wake-up or another agent's ask on their
   * behalf — or null (0.8.8). A mission's page quotes it: an agent-started mission's goal is in English, and nothing
   * else on the page said what language its person reads.
   */
  lastSaid(gatewayId: string, chatId: string, senderId: string): string | null {
    const row = this.db
      .prepare<{ prompt: string }>(
        `SELECT prompt FROM turn_records WHERE gateway_id = ? AND chat_id = ? AND sender_id = ? AND cause IS NULL
           AND NOT (status = 'done' AND model IS NULL) AND prompt NOT LIKE '/%' ORDER BY started_at DESC, seq DESC LIMIT 1`,
      )
      .get(gatewayId, chatId, senderId);
    return row?.prompt.trim() || null;
  }

  /** Whether anything started in this chat after `since` — a person who has moved on since a turn failed. */
  startedInChatSince(gatewayId: string, chatId: string, since: number): boolean {
    return Boolean(this.db.prepare<{ n: number }>(`SELECT 1 AS n FROM turn_records WHERE gateway_id = ? AND chat_id = ? AND started_at > ? AND ${OWN} LIMIT 1`).get(gatewayId, chatId, since));
  }

  /**
   * The turns of one conversation, oldest first, with their steps.
   *
   * Two queries rather than a join: a join returns the record once per step, and the transcript is
   * assembled in the client anyway. Bounded — a conversation with more turns than this has a
   * transcript nobody is scrolling to the top of.
   */
  forSession(sessionId: string, limit = 100): TurnView[] {
    const rows = this.db
      .prepare<TurnRow>(
        "SELECT * FROM turn_records WHERE session_id = ? ORDER BY started_at DESC, seq DESC LIMIT ?",
      )
      .all(sessionId, limit)
      .reverse();
    return this.withSteps(rows);
  }

  /**
   * Attach each row's steps, in one extra read rather than a join.
   *
   * A join returns the record once per step and the transcript is assembled by the caller anyway.
   * Shared by every reader of a transcript so the fan-in cannot drift between them.
   */
  private withSteps(rows: TurnRow[]): TurnView[] {
    if (rows.length === 0) return [];
    const steps = this.stepsFor(rows.map((row) => row.id));
    return rows.map((row) => ({ ...toRecord(row), steps: steps.get(row.id) ?? [] }));
  }

  /**
   * The steps a chat's turns took, counted as each turn's own line counts them — a call, or a wait on a person — and a
   * turn recorded without its steps by its tool calls (0.8.0). A mission's page says it beside its turns; tool calls
   * alone said 8 above turns listed as 8 and 3.
   */
  stepsIn(gatewayId: string, chatId: string): number {
    const rows = this.db
      .prepare<{ id: string; tool_calls: number }>("SELECT id, tool_calls FROM turn_records WHERE gateway_id = ? AND chat_id = ?")
      .all(gatewayId, chatId);
    const steps = this.stepsFor(rows.map((row) => row.id));
    const counted = (id: string) => (steps.get(id) ?? []).filter((step) => step.kind === "tool" || step.kind === "waiting").length;
    return rows.reduce((sum, row) => sum + (counted(row.id) || row.tool_calls), 0);
  }

  /**
   * The connection one of these accounts last wrote from, newest first (0.8.0): where a message meant only for them goes
   * when they named none — the morning line. A sender id is unique only within its platform, so the caller checks the
   * connection's platform against the account's; a few rows are read for that.
   */
  lastFrom(senderIds: readonly string[]): { gatewayId: string; senderId: string }[] {
    if (senderIds.length === 0) return [];
    return this.db
      .prepare<{ gateway_id: string; sender_id: string }>(
        `SELECT gateway_id, sender_id FROM turn_records WHERE sender_id IN (${marks(senderIds)}) ORDER BY started_at DESC LIMIT 20`,
      )
      .all(...senderIds)
      .map((row) => ({ gatewayId: row.gateway_id, senderId: row.sender_id }));
  }

  /**
   * The turns of one *room*, oldest first, across every agent in it.
   *
   * `forSession` is one agent's side of a conversation, which is the right unit for a DM and half a
   * transcript in a room: several agents share a chat and each gets its own session, so reading the
   * room one session at a time returns several monologues that have to be merged by timestamp
   * afterwards — and a merge outside SQLite cannot page.
   *
   * The columns for this were in the first turn-records migration and nothing ever queried them. That
   * is what a room needed to be *readable* rather than merely runnable: agents were already sharing a
   * chat in the dashboard — the same `chat_id` with a session under two different agents — and no
   * query could return that as one conversation.
   *
   * Keyed on the connection as well as the chat because a chat id is only unique within one: two
   * platforms can hand out the same channel id, and the dashboard's has no namespace at all.
   *
   * `seq` breaks the tie on `started_at`, and it is not decoration. Two agents tagged in one
   * message, or two quick messages on a fast machine, land in the same millisecond; with no tiebreak
   * SQLite returns them in whatever order the scan produced, so the same transcript read twice could
   * show a reply above the message it answered. Found as a test that failed roughly one run in four
   * under load and passed every time on an idle machine.
   *
   * `id` was the obvious tiebreak and the wrong one: it is a random UUID, so it makes the order
   * stable and still arbitrary — which fixes the flapping and not the wrongness. `seq` is insertion
   * order, so a room reads back the way it happened.
   */
  forChat(gatewayId: string, chatId: string, limit = 200): TurnView[] {
    const rows = this.db
      .prepare<TurnRow>(
        `SELECT * FROM turn_records WHERE gateway_id = ? AND chat_id = ? AND ${OWN}
         ORDER BY started_at DESC, seq DESC LIMIT ?`,
      )
      .all(gatewayId, chatId, limit)
      .reverse();
    return this.withSteps(rows);
  }

  /**
   * One chat's exchanges in a window, oldest first — what memory builds an episode from.
   *
   * The turn log rather than the session's context, because the context is what compaction rewrites
   * and `/new` clears; the log is the conversation as it happened. Left out: running turns, whose
   * answer is not written yet (the cut that asked stops before them), and `note` rows — a command's
   * reply or a harness notice, done without a model, which are not what anybody said.
   */
  exchangesBetween(gatewayId: string, chatId: string, after: number, until: number): TurnExchange[] {
    return this.db
      .prepare<{ agent_id: string; sender_id: string | null; prompt: string; reply: string; started_at: number; ended_at: number | null }>(
        `SELECT agent_id, sender_id, prompt, reply, started_at, ended_at FROM turn_records
         WHERE gateway_id = ? AND chat_id = ? AND started_at > ? AND started_at <= ?
           AND status <> 'running' AND NOT (status = 'done' AND model IS NULL) AND ${OWN}
         ORDER BY started_at, seq`,
      )
      .all(gatewayId, chatId, after, until)
      .map((row) => ({
        agentId: row.agent_id,
        ...(row.sender_id ? { senderId: row.sender_id } : {}),
        prompt: row.prompt,
        reply: row.reply,
        startedAt: row.started_at,
        endedAt: row.ended_at ?? row.started_at,
      }));
  }

  /** Chats with a turn started after `after`, and when their first running turn began, if one is. */
  chatsActiveSince(after: number): { gatewayId: string; chatId: string; runningSince: number | null }[] {
    return this.db
      .prepare<{ gateway_id: string; chat_id: string; running_since: number | null }>(
        `SELECT gateway_id, chat_id, MIN(CASE WHEN status = 'running' THEN started_at END) AS running_since
         FROM turn_records WHERE started_at > ? AND ${OWN} GROUP BY gateway_id, chat_id`,
      )
      .all(after)
      .map((row) => ({ gatewayId: row.gateway_id, chatId: row.chat_id, runningSince: row.running_since }));
  }

  /**
   * Every turn still running in one room, oldest first, with their steps.
   *
   * A room can have several at once — a message naming two agents runs both — so the live view there
   * is a list where a one-to-one conversation's is a single turn. `latestForSession` cannot answer
   * this: it is scoped to one agent and returns the newest turn whether or not it is running, which in
   * a room means showing one of two workers and calling the other one finished.
   *
   * Only running rows, because a finished turn belongs to the transcript. The partial index on
   * `status = 'running'` is what makes this cheap enough to poll.
   */
  runningForChat(gatewayId: string, chatId: string): TurnView[] {
    const rows = this.db
      .prepare<TurnRow>(
        `SELECT * FROM turn_records
         WHERE gateway_id = ? AND chat_id = ? AND status = 'running' AND ${OWN}
         ORDER BY started_at, seq`,
      )
      .all(gatewayId, chatId);
    return this.withSteps(rows);
  }

  /** The newest turn of a conversation, whether or not it is still running. */
  latestForSession(sessionId: string): TurnRecord | null {
    const row = this.db
      .prepare<TurnRow>(
        "SELECT * FROM turn_records WHERE session_id = ? ORDER BY started_at DESC, seq DESC LIMIT 1",
      )
      .get(sessionId);
    return row ? toRecord(row) : null;
  }

  /**
   * Which conversations are working right now.
   *
   * One indexed scan for a whole session list, rather than a query per row: the list is what shows
   * the spinner, and a spinner that costs a hundred queries is a spinner that gets removed.
   */
  runningSessions(): Set<string> {
    const rows = this.db
      .prepare<{ session_id: string }>(
        // A delegate's own turn is no conversation at work: the nightly pass would wait out a four-hour helper.
        `SELECT DISTINCT session_id FROM turn_records WHERE status = 'running' AND ${OWN}`,
      )
      .all();
    return new Set(rows.map((r) => r.session_id));
  }

  /**
   * The first thing asked in each conversation, for naming it in a list.
   *
   * One query for every session rather than one per row: the alternative is a hundred queries to
   * label a hundred list items, which is how a list stops having labels.
   *
   * `ROW_NUMBER() OVER (PARTITION BY …)` rather than `MIN(rowid)`, which is what this was. Two
   * reasons, and the second is the one that matters. `rowid` is SQLite's implicit key and has no
   * equivalent anywhere else, so the query only ran on one engine — that is what the portability
   * check now refuses. And it was relying on insert order to mean "earliest", which is true of an
   * append-only table until it is not: a restored backup, a re-inserted row, or a future migration
   * that rebuilds the table all reorder it silently.
   *
   * `started_at` is the ordering that says what was actually meant, with `id` as a tie-break so two
   * identical queries cannot disagree.
   *
   * ## What that tie-break can and cannot promise
   *
   * `id` is a random `newId`, so among turns sharing a millisecond it picks a *stable* winner rather
   * than the earliest one. `rowid` did give insertion order, and this is the one thing lost by
   * dropping it: the table has no column recording what was inserted first.
   *
   * Left that way deliberately. Two turns of *one session* in the same millisecond needs the same
   * person to send two messages within a millisecond — a human cannot, and messages that do arrive
   * back to back are merged by the batcher into a single turn. A room creates its turns in different
   * sessions, which this query partitions by. So the reachable cost is a conversation labelled with
   * its second question instead of its first, and the alternative — a monotonic column, a migration,
   * a backfill and a counter seeded at boot — is machinery for a list label.
   *
   * The subquery alias is required: Postgres refuses a derived table without one, and SQLite does
   * not care. Exactly the class of difference the SQL check exists to keep out of a port.
   */
  titles(): Map<string, string> {
    const rows = this.db
      .prepare<{ session_id: string; prompt: string }>(
        `SELECT session_id, prompt FROM (
           SELECT session_id, prompt,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY started_at, id) AS rn
           FROM turn_records
         ) AS ranked
         WHERE rn = 1`,
      )
      .all();
    return new Map(rows.map((row) => [row.session_id, row.prompt]));
  }

  /**
   * Every turn of one conversation, gone. The stream's rows are forgotten by `EventedTurnStore`, in the same
   * transaction.
   *
   * Counted before the delete rather than taken from `changes`: the driver reports cascaded step rows
   * in that number, so a conversation with one turn and one step deleted "2 turns" — which is the kind
   * of figure that ends up in an audit log and is then believed.
   */
  deleteForSession(sessionId: string): number {
    const row = this.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM turn_records WHERE session_id = ?")
      .get(sessionId);
    // Its delegates' turns go with it — a helper's brief and report are this conversation's — and are not counted: the
    // number is what the person had, said back to them by `/reset`.
    this.db.prepare(`DELETE FROM turn_records WHERE session_id > ? AND session_id < ? AND NOT ${OWN}`).run(...childrenOf(sessionId));
    this.db.prepare("DELETE FROM turn_records WHERE session_id = ?").run(sessionId);
    return row?.n ?? 0;
  }

  /**
   * The turns of a conversation's delegates (0.7.26): in conversations of their own, each a child of this one
   * (`childSessionId`: `<this>:sub:…`, `<this>:peer:…`), and marked by their cause — a thread's conversation can begin
   * with this one's id too, and is not one of them.
   */
  protected delegatesOf(sessionId: string): string[] {
    return this.db
      .prepare<{ id: string }>(`SELECT id FROM turn_records WHERE session_id > ? AND session_id < ? AND NOT ${OWN}`)
      .all(...childrenOf(sessionId))
      .map((row) => row.id);
  }

  /**
   * Rows left `running` by a daemon that is no longer running them.
   *
   * The same fix `JobStore.interruptOrphaned` makes, for the same reason: a client polling a turn
   * that died with the process waits for an event that can never arrive, and "still working" is the
   * one lie a progress indicator must not tell.
   *
   * Returns the conversations as well as the count, so somebody can actually be told. A dashboard
   * reading the row learns the turn is over; the person who asked the question in Telegram does not,
   * and until this reported addresses there was no way to reach them.
   */
  interruptOrphaned(now: number = Date.now()): InterruptedTurns {
    /**
     * Read before the update, because after it there is nothing left to select.
     *
     * The addresses are what makes the sweep reportable: until this returned them, a turn that died
     * with the process was marked `interrupted` and the person waiting on it was told nothing —
     * ever. `boot/interrupted.ts` sends them a line once the gateways are up.
     *
     * The whole row set rather than a count, and then de-duplicated by the caller: two agents busy
     * in one room are two rows and one conversation.
     */
    const orphaned = this.db
      .prepare<{ id: string; gateway_id: string; chat_id: string; cause: string | null }>(
        `SELECT id, gateway_id, chat_id, cause FROM turn_records WHERE status = 'running'`,
      )
      .all();
    const delegated = orphaned.filter((row) => isDelegated(parseCause(row.cause)?.cause));

    const result = this.db
      .prepare(
        `UPDATE turn_records SET status = 'interrupted', ended_at = ?,
           error = COALESCE(error, 'the daemon restarted while this turn was running')
         WHERE status = 'running'`,
      )
      .run(now);
    const changed = Number(result.changes ?? 0);
    if (changed > 0) log.info("turns interrupted by a restart", { turns: changed });

    return {
      turns: changed,
      conversations: orphaned.filter((row) => !delegated.includes(row)).map((row) => ({ turnId: row.id, gatewayId: row.gateway_id, chatId: row.chat_id })),
      delegated: delegated.map((row) => row.id),
    };
  }

  /**
   * Delete turns older than `retentionDays`.
   *
   * `started_at`, not `ended_at`: an interrupted row has no end, and keying on a column that can be
   * null is how a sweep quietly stops sweeping. `0` disables it, the same off position the other
   * retention knobs use.
   */
  sweep(retentionDays: number, now: number = Date.now()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    const result = this.db.prepare("DELETE FROM turn_records WHERE started_at < ?").run(cutoff);
    return Number(result.changes ?? 0);
  }
}

/** One question and its answer, as memory reads the turn log. */
export interface TurnExchange {
  agentId: string;
  senderId?: string;
  prompt: string;
  reply: string;
  startedAt: number;
  endedAt: number;
}

export interface TurnRow {
  id: string;
  session_id: string;
  agent_id: string;
  gateway_id: string;
  chat_id: string;
  message_id: string | null;
  sender_id: string | null;
  status: string;
  prompt: string;
  reply: string;
  error: string | null;
  model: string | null;
  tool_calls: number;
  iterations: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  started_at: number;
  ended_at: number | null;
  attachments: string | null;
  cause?: string | null;
}

export function toRecord(row: TurnRow): TurnRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    gatewayId: row.gateway_id,
    chatId: row.chat_id,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.sender_id ? { senderId: row.sender_id } : {}),
    status: row.status as TurnStatus,
    prompt: row.prompt,
    reply: row.reply,
    ...(row.error ? { error: row.error } : {}),
    ...(row.model ? { model: row.model } : {}),
    toolCalls: row.tool_calls,
    ...(row.iterations === null ? {} : { iterations: row.iterations }),
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(parseAttachments(row.attachments) ?? {}),
    ...(parseCause(row.cause ?? null) ?? {}),
  };
}

/** Like the attachments: a column that does not read is a turn with no stated cause, not one that cannot open. */
export function parseCause(raw: string | null): { cause: TurnCause } | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<TurnCause> | null;
    return value && typeof value.via === "string" ? { cause: value as TurnCause } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A malformed column reads as "nothing attached" rather than throwing.
 *
 * The same rule the session context follows: losing the note that a file was sent is bad, and a
 * transcript that cannot be opened at all is worse.
 */
function parseAttachments(raw: string | null): { attachments: TurnAttachment[] } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length > 0
      ? { attachments: parsed as TurnAttachment[] }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One turn, its steps and its cost, as the daemon depends on it.
 *
 * Business logic takes this, never `TurnStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type TurnsPort = Port<TurnStore>;
