/**
 * The `missions` table (`069_baseline.sql`): one row per mission, written whole.
 *
 * One table, on purpose. Each fact a mission needs is kept once, where it already lives: its checklist is the plan its
 * conversation keeps (`modules/notes/`), its jobs report to its conversation as every job does (the chat id is the
 * mission's id, on `web:mission`), and *asleep* is kept where Pause is. A fact in two places is the half a restore puts
 * behind the other.
 *
 * Whole rather than column by column: every change to a mission is a decision about several of its fields at once — a
 * status, its reason, when it started waiting — and a store with a setter per field is a store where one of them gets
 * forgotten. The service (`missions.ts`) decides; this keeps.
 */

import type { SqliteDb } from "@nouride/runtime";
import { newId, type Port } from "@nouride/shared";
import type { Answered, Mission, MissionStatus, Told, WaitKind } from "./types.ts";

interface Row {
  id: string;
  agent_id: string;
  started_by: string;
  by_agent: string | null;
  gateway_id: string;
  chat_id: string;
  goal: string;
  checks: string;
  review: string | null;
  review_on: number;
  accept: number;
  status: string;
  wait_kind: string | null;
  reason: string | null;
  report: string | null;
  summary: string | null;
  files: string;
  last_check: string | null;
  answers: string;
  told: string;
  workdir: string;
  branch: string | null;
  parent_id: string | null;
  untrusted: number;
  job_id: string | null;
  request: string | null;
  reviewed: number;
  limit_hours: number;
  limit_turns: number;
  limit_tokens: number;
  turns_used: number;
  tokens_used: number;
  cli_turns: number;
  cli_unreported: number;
  helpers_since: number | null;
  resumes: number;
  waited_ms: number;
  waiting_since: number | null;
  warned_at: number | null;
  followed_up_at: number | null;
  progress_at: number | null;
  progress_done: number;
  nudged_at: number | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  ended_at: number | null;
}

/** Every column, written whole — `toRow` gives the values in this order. */
const UPSERT = `INSERT INTO missions (
  id, agent_id, started_by, by_agent, gateway_id, chat_id, goal, checks, review, review_on, accept, status,
  wait_kind, reason, report, files, last_check, answers, workdir, parent_id, untrusted, job_id, request, reviewed,
  limit_hours, limit_turns, limit_tokens, turns_used, tokens_used, resumes, waited_ms, waiting_since, warned_at,
  followed_up_at, progress_at, progress_done, nudged_at, created_at, started_at, updated_at, ended_at, branch, told,
  summary, cli_turns, cli_unreported, helpers_since
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  agent_id = excluded.agent_id, started_by = excluded.started_by, by_agent = excluded.by_agent,
  gateway_id = excluded.gateway_id, chat_id = excluded.chat_id, goal = excluded.goal, checks = excluded.checks,
  review = excluded.review, review_on = excluded.review_on, accept = excluded.accept, status = excluded.status,
  wait_kind = excluded.wait_kind, reason = excluded.reason, report = excluded.report, files = excluded.files,
  last_check = excluded.last_check, answers = excluded.answers, workdir = excluded.workdir,
  parent_id = excluded.parent_id, untrusted = excluded.untrusted, job_id = excluded.job_id,
  request = excluded.request, reviewed = excluded.reviewed, limit_hours = excluded.limit_hours,
  limit_turns = excluded.limit_turns, limit_tokens = excluded.limit_tokens, turns_used = excluded.turns_used,
  tokens_used = excluded.tokens_used, resumes = excluded.resumes, waited_ms = excluded.waited_ms,
  waiting_since = excluded.waiting_since, warned_at = excluded.warned_at, followed_up_at = excluded.followed_up_at,
  progress_at = excluded.progress_at, progress_done = excluded.progress_done, nudged_at = excluded.nudged_at,
  created_at = excluded.created_at, started_at = excluded.started_at, updated_at = excluded.updated_at,
  ended_at = excluded.ended_at, branch = excluded.branch, told = excluded.told, summary = excluded.summary,
  cli_turns = excluded.cli_turns, cli_unreported = excluded.cli_unreported, helpers_since = excluded.helpers_since`;

/** A list that must parse to strings — read back from a JSON column this store wrote. */
function strings(text: string): string[] {
  const value: unknown = JSON.parse(text);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function answered(text: string): Answered[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const one = entry as Partial<Answered> | null;
    return one && typeof one.question === "string" && typeof one.at === "number"
      ? [{ question: one.question, at: one.at, ...(typeof one.answer === "string" ? { answer: one.answer } : {}) }]
      : [];
  });
}

function told(text: string): Told[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const one = entry as Partial<Told> | null;
    if (!one || typeof one.id !== "string" || typeof one.by !== "string" || typeof one.at !== "number" || typeof one.text !== "string") return [];
    return [{ id: one.id, by: one.by, at: one.at, text: one.text, ...(typeof one.via === "string" ? { via: one.via } : {}), ...(typeof one.read === "number" ? { read: one.read } : {}) }];
  });
}

function fromRow(row: Row): Mission {
  return {
    id: row.id,
    agentId: row.agent_id,
    startedBy: row.started_by,
    byAgent: row.by_agent,
    gatewayId: row.gateway_id,
    chatId: row.chat_id,
    goal: row.goal,
    checks: strings(row.checks),
    review: row.review,
    reviewOn: row.review_on === 1,
    accept: row.accept === 1,
    status: row.status as MissionStatus,
    waitKind: row.wait_kind as WaitKind | null,
    reason: row.reason,
    report: row.report,
    summary: row.summary,
    files: strings(row.files),
    lastCheck: row.last_check,
    answers: answered(row.answers),
    told: told(row.told),
    workdir: row.workdir,
    branch: row.branch,
    parentId: row.parent_id,
    untrusted: row.untrusted === 1,
    jobId: row.job_id,
    request: row.request,
    reviewed: row.reviewed === 1,
    limits: { hours: row.limit_hours, turns: row.limit_turns, tokens: row.limit_tokens },
    turnsUsed: row.turns_used,
    tokensUsed: row.tokens_used,
    cliTurns: row.cli_turns,
    cliUnreported: row.cli_unreported,
    helpersSince: row.helpers_since,
    resumes: row.resumes,
    waitedMs: row.waited_ms,
    waitingSince: row.waiting_since,
    warnedAt: row.warned_at,
    followedUpAt: row.followed_up_at,
    progressAt: row.progress_at,
    progressDone: row.progress_done,
    nudgedAt: row.nudged_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

function toRow(mission: Mission): unknown[] {
  return [
    mission.id, mission.agentId, mission.startedBy, mission.byAgent, mission.gatewayId, mission.chatId, mission.goal,
    JSON.stringify(mission.checks), mission.review, mission.reviewOn ? 1 : 0, mission.accept ? 1 : 0, mission.status,
    mission.waitKind, mission.reason, mission.report, JSON.stringify(mission.files), mission.lastCheck,
    JSON.stringify(mission.answers), mission.workdir, mission.parentId, mission.untrusted ? 1 : 0, mission.jobId,
    mission.request, mission.reviewed ? 1 : 0, mission.limits.hours,
    mission.limits.turns, mission.limits.tokens, mission.turnsUsed, mission.tokensUsed, mission.resumes, mission.waitedMs,
    mission.waitingSince, mission.warnedAt, mission.followedUpAt, mission.progressAt, mission.progressDone,
    mission.nudgedAt, mission.createdAt, mission.startedAt, mission.updatedAt, mission.endedAt, mission.branch,
    JSON.stringify(mission.told), mission.summary, mission.cliTurns, mission.cliUnreported, mission.helpersSince,
  ];
}

export class MissionStore {
  constructor(private readonly db: SqliteDb) {}

  /** A fresh id: `msn_` and hex, the chat id of its conversation too. */
  static newId(): string {
    return newId("msn");
  }

  save(mission: Mission): void {
    this.db.prepare(UPSERT).run(...(toRow(mission) as (string | number | null)[]));
  }

  get(id: string): Mission | null {
    const row = this.db.prepare<Row>("SELECT * FROM missions WHERE id = ?").get(id);
    return row ? fromRow(row) : null;
  }

  /** Every mission not yet final, oldest first — what the dispatcher and the timers look at. */
  open(): Mission[] {
    return this.db
      .prepare<Row>("SELECT * FROM missions WHERE status IN ('queued', 'running', 'waiting', 'checking') ORDER BY created_at, id")
      .all()
      .map(fromRow);
  }

  /** The newest first, for the lists — `agentId` narrows to one agent's. */
  recent(limit: number, agentId?: string): Mission[] {
    const rows = agentId
      ? this.db.prepare<Row>("SELECT * FROM missions WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(agentId, limit)
      : this.db.prepare<Row>("SELECT * FROM missions ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    return rows.map(fromRow);
  }

  /** An agent's own missions, newest first: the ones it works and the ones it started for someone (the `work` tool). */
  ownedBy(agentId: string, limit: number): Mission[] {
    return this.db
      .prepare<Row>("SELECT * FROM missions WHERE agent_id = ? OR by_agent = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(agentId, agentId, limit)
      .map(fromRow);
  }

  /** A job's run still open (0.8.0): a job runs one at a time, so a run due meanwhile is skipped. */
  openForJob(jobId: string): Mission | null {
    const row = this.db
      .prepare<Row>("SELECT * FROM missions WHERE job_id = ? AND status IN ('queued', 'running', 'waiting', 'checking') ORDER BY created_at DESC LIMIT 1")
      .get(jobId);
    return row ? fromRow(row) : null;
  }

  /** The missions reporting to one chat, newest first — what `/mission` lists there. */
  forChat(gatewayId: string, chatId: string, limit = 50): Mission[] {
    return this.db
      .prepare<Row>("SELECT * FROM missions WHERE gateway_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(gatewayId, chatId, limit)
      .map(fromRow);
  }

  /** Missions an agent started since `since` — what `agent_missions_per_day` counts. */
  startedByAgentSince(agentId: string, since: number): number {
    const row = this.db
      .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM missions WHERE by_agent = ? AND created_at >= ?")
      .get(agentId, since);
    return row?.n ?? 0;
  }

  /** One mission's record, removed — its conversation was deleted (`Missions.forget`). */
  remove(id: string): void {
    this.db.prepare("DELETE FROM missions WHERE id = ?").run(id);
  }

  /**
   * Final missions that ended more than `retentionDays` ago, removed: `[retention] session_days`, the window of the
   * conversation each one ran in. Its page is that conversation's record, and kept past it, it opened onto turns already
   * gone. One still open is never swept, however old. `0` keeps everything.
   */
  sweep(retentionDays: number, now: number = Date.now()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    return Number(this.db.prepare("DELETE FROM missions WHERE status IN ('done', 'failed', 'stopped') AND ended_at < ?").run(cutoff).changes ?? 0);
  }

  /** Final missions that ended in [`after`, `before`) — whose folders the sweep removes. */
  endedBetween(after: number, before: number): Mission[] {
    return this.db
      .prepare<Row>("SELECT * FROM missions WHERE status IN ('done', 'failed', 'stopped') AND ended_at >= ? AND ended_at < ? ORDER BY ended_at")
      .all(after, before)
      .map(fromRow);
  }
}

export type MissionsPort = Port<MissionStore>;
