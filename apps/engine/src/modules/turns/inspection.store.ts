/**
 * One turn, with everything recorded about it — what `nouride turns show` prints.
 *
 * The record says what was asked and answered, and its steps what the agent did. What the turn *cost*, and how
 * long its model calls took, is in `llm_usage`; its tool calls with their full arguments are in `audit_log`. Until
 * 0.7.3 nothing joined them: usage knew the session, the audit the chat, and two turns a minute apart in one chat
 * shared every row. Each row now carries its turn's id (`069_baseline.sql`), and this reads the four together.
 *
 * A store that only reads: it writes nothing, and the tables it reads each keep their own store for that.
 */

import type { SqliteDb } from "@nouride/runtime";
import type { StopReason, TurnEventData } from "@nouride/shared";
import type { TurnCause } from "@nouride/wire";
import { contextOfTurn, stepsOfTurn } from "@/modules/events/turn-events.store.ts";
import { childrenOf, parseCause, toRecord, type TurnRecord, type TurnRow, type TurnStep } from "./turns.store.ts";

/** One provider call the turn made — its own agent's, or a helper's or a peer's charged to it. */
export interface ModelCall {
  at: number;
  agentId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Null for a model with no published price — never a guessed zero. */
  usd: number | null;
  /** Absent on a row from before 0.7.3, or from a provider that did not report it. */
  latencyMs?: number;
  attempts?: number;
  /** Who answered, when a gateway in between said (`069_baseline.sql`). */
  upstream?: { provider?: string; model?: string; attempts?: number };
  /** What the call was for, and how it is billed (`069_baseline.sql`) — absent on a row from before 0.7.8. */
  purpose?: string;
  basis?: string;
  /** True when its counts are this daemon's estimate: the provider reported none. */
  estimated?: boolean;
  /**
   * Why the provider says it ended (`069_baseline.sql`) — `max_tokens` is a reply cut at the output limit.
   * Absent when the provider gave no reason, and on a row from before 0.7.26.
   */
  stopReason?: StopReason;
}

/** The calls, added up in the same query that reads the record. */
export interface TurnTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** What the priced calls cost. `unpriced` says how many calls are not in it. */
  usd: number;
  unpriced: number;
  latencyMs: number;
  slowestMs: number;
  /** Attempts past the first, over every call: how often a provider made the turn ask again. */
  retries: number;
}

/** A row the audit log kept during the turn: a tool call, mostly, with its arguments redacted as stored. */
export interface AuditedAction {
  at: number;
  action: string;
  details: Record<string, unknown> | null;
}

export interface TurnInspection {
  turn: TurnRecord;
  totals: TurnTotals;
  calls: ModelCall[];
  steps: TurnStep[];
  audit: AuditedAction[];
  /**
   * The delegates' own turns this one started (0.7.26): a helper working in the background, an ask moved there — each a
   * turn of its own, read by its id. Their model calls are in `calls` above, counted here. Absent from a daemon before.
   */
  delegated?: HandedOff[];
  /** What each of its model requests carried (0.7.26, `context` rows), oldest first. Absent from a daemon before. */
  contexts?: TurnEventData["context"][];
}

/** A delegate's own turn, as the turn that started it lists it. Its `cause` names the job and this turn. */
export type HandedOff = Pick<TurnRecord, "id" | "agentId" | "status" | "prompt" | "startedAt" | "endedAt" | "cause">;

/** One line of `nouride turns`. */
export interface TurnSummary {
  id: string;
  agentId: string;
  status: TurnRecord["status"];
  prompt: string;
  startedAt: number;
  endedAt?: number;
  calls: number;
  usd: number | null;
  /** Why it started, when not as a message sent as it reads — an edit (`EDITED`) is marked in the list. */
  cause?: TurnCause;
}

type TotalsRow = TurnRow & {
  calls: number;
  call_input: number;
  call_output: number;
  call_cached: number;
  call_usd: number;
  call_unpriced: number;
  call_latency: number;
  call_slowest: number;
  call_retries: number;
};

export class TurnInspector {
  constructor(private readonly db: SqliteDb) {}

  /**
   * The turn with this id — or the one this prefix names, so the id `nouride turns` printed can be shortened. Null
   * when there is none, or when a prefix names more than one.
   */
  inspect(id: string): TurnInspection | null {
    return inspectTurn(this.db, id);
  }

  /** The newest turns, with what each cost — one agent's when it is named. */
  recent(options: { limit: number; agentId?: string }): TurnSummary[] {
    return recentTurns(this.db, options);
  }
}

function inspectTurn(db: SqliteDb, id: string): TurnInspection | null {
  const turnId = resolveId(db, id);
  if (!turnId) return null;
  // The join: the record by its key, its calls added up from the index that covers them.
  const row = db
    .prepare<TotalsRow>(
      `SELECT r.*,
              COUNT(u.turn_id) AS calls,
              COALESCE(SUM(u.input_tokens), 0) AS call_input,
              COALESCE(SUM(u.output_tokens), 0) AS call_output,
              COALESCE(SUM(u.cached_input_tokens), 0) AS call_cached,
              COALESCE(SUM(u.estimated_cost_usd), 0) AS call_usd,
              COALESCE(SUM(CASE WHEN u.turn_id IS NOT NULL AND u.estimated_cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS call_unpriced,
              COALESCE(SUM(u.latency_ms), 0) AS call_latency,
              COALESCE(MAX(u.latency_ms), 0) AS call_slowest,
              COALESCE(SUM(u.attempts - 1), 0) AS call_retries
         FROM turn_records r
         LEFT JOIN llm_usage u ON u.turn_id = r.id
        WHERE r.id = ?
        GROUP BY r.id`,
    )
    .get(turnId);
  if (!row) return null;
  return {
    turn: toRecord(row),
    totals: {
      calls: row.calls,
      inputTokens: row.call_input,
      outputTokens: row.call_output,
      cachedInputTokens: row.call_cached,
      usd: row.call_usd,
      unpriced: row.call_unpriced,
      latencyMs: row.call_latency,
      slowestMs: row.call_slowest,
      retries: row.call_retries,
    },
    calls: modelCalls(db, turnId),
    steps: stepsOfTurn(db, turnId),
    audit: db
      .prepare<{ timestamp: number; action: string; details: string | null }>(
        "SELECT timestamp, action, details FROM audit_log WHERE turn_id = ? ORDER BY timestamp",
      )
      .all(turnId)
      .map((entry) => ({ at: entry.timestamp, action: entry.action, details: parseDetails(entry.details) })),
    delegated: handedOff(db, turnId, row.session_id),
    contexts: contextOfTurn(db, turnId),
  };
}

function recentTurns(db: SqliteDb, options: { limit: number; agentId?: string }): TurnSummary[] {
  const agent = options.agentId ?? null;
  return db
    .prepare<{ id: string; agent_id: string; status: TurnRecord["status"]; prompt: string; started_at: number; ended_at: number | null; cause: string | null; calls: number; usd: number | null }>(
      `SELECT r.id, r.agent_id, r.status, r.prompt, r.started_at, r.ended_at, r.cause,
              (SELECT COUNT(*) FROM llm_usage u WHERE u.turn_id = r.id) AS calls,
              (SELECT SUM(u.estimated_cost_usd) FROM llm_usage u WHERE u.turn_id = r.id) AS usd
         FROM turn_records r
        WHERE (? IS NULL OR r.agent_id = ?)
        ORDER BY r.started_at DESC
        LIMIT ?`,
    )
    .all(agent, agent, options.limit)
    .map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status,
      prompt: row.prompt,
      startedAt: row.started_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      calls: row.calls,
      usd: row.usd,
      ...(parseCause(row.cause) ?? {}),
    }));
}

/**
 * The delegates' own turns a turn started, oldest first: in conversations that are children of its own, naming it as
 * the turn that asked (`cause.parent`).
 */
function handedOff(db: SqliteDb, turnId: string, sessionId: string): HandedOff[] {
  return db
    .prepare<Pick<TurnRow, "id" | "agent_id" | "status" | "prompt" | "started_at" | "ended_at" | "cause">>(
      `SELECT id, agent_id, status, prompt, started_at, ended_at, cause FROM turn_records
        WHERE session_id > ? AND session_id < ? AND json_extract(cause, '$.parent') = ?`,
    )
    .all(...childrenOf(sessionId), turnId)
    // A handful, in order here: across child conversations no index holds them by when they started.
    .sort((a, b) => a.started_at - b.started_at)
    .map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      status: row.status as TurnRecord["status"],
      prompt: row.prompt,
      startedAt: row.started_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(parseCause(row.cause ?? null) ?? {}),
    }));
}

/** Every provider call the turn made, oldest first — read from the covering index alone. */
function modelCalls(db: SqliteDb, turnId: string): ModelCall[] {
  return db
    .prepare<{
      timestamp: number; agent_id: string; model: string; provider: string; input_tokens: number; output_tokens: number;
      cached_input_tokens: number | null; estimated_cost_usd: number | null; latency_ms: number | null; attempts: number | null;
      upstream_provider: string | null; upstream_model: string | null; upstream_attempts: number | null;
      purpose: string | null; basis: string | null; estimated: number | null; stop_reason: StopReason | null;
    }>(
      `SELECT timestamp, agent_id, model, provider, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd,
              latency_ms, attempts, upstream_provider, upstream_model, upstream_attempts, purpose, basis, estimated,
              stop_reason
         FROM llm_usage WHERE turn_id = ? ORDER BY timestamp`,
    )
    .all(turnId)
    .map((call) => ({
      at: call.timestamp,
      agentId: call.agent_id,
      model: call.model,
      provider: call.provider,
      inputTokens: call.input_tokens,
      outputTokens: call.output_tokens,
      ...(call.cached_input_tokens === null ? {} : { cachedInputTokens: call.cached_input_tokens }),
      usd: call.estimated_cost_usd,
      ...(call.latency_ms === null ? {} : { latencyMs: call.latency_ms }),
      ...(call.attempts === null ? {} : { attempts: call.attempts }),
      ...(call.upstream_provider !== null || call.upstream_model !== null || call.upstream_attempts !== null
        ? {
            upstream: {
              ...(call.upstream_provider === null ? {} : { provider: call.upstream_provider }),
              ...(call.upstream_model === null ? {} : { model: call.upstream_model }),
              ...(call.upstream_attempts === null ? {} : { attempts: call.upstream_attempts }),
            },
          }
        : {}),
      ...(call.purpose === null ? {} : { purpose: call.purpose }),
      ...(call.basis === null ? {} : { basis: call.basis }),
      ...(call.estimated === 1 ? { estimated: true } : {}),
      ...(call.stop_reason === null ? {} : { stopReason: call.stop_reason }),
    }));
}

/**
 * The full id, from the id or a prefix of one. A range on the primary key rather than `LIKE`, which SQLite will not
 * take to an index for a case-sensitive key — and a prefix two turns share answers nothing rather than guessing.
 */
function resolveId(db: SqliteDb, id: string): string | null {
  const exact = db.prepare<{ id: string }>("SELECT id FROM turn_records WHERE id = ?").get(id);
  if (exact) return exact.id;
  if (id.length < 6) return null;
  const matches = db
    .prepare<{ id: string }>("SELECT id FROM turn_records WHERE id >= ? AND id < ? LIMIT 2")
    .all(id, `${id}\u{10FFFF}`);
  return matches.length === 1 ? matches[0]!.id : null;
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
