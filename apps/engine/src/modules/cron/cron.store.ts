/**
 * Cron jobs in SQLite, and the arithmetic of when each one is next due.
 *
 * The store owns `nextRunAt` and nothing else does. That is the invariant worth stating: a
 * scheduler where two places can advance a schedule is a scheduler that double-fires, and a
 * double-fired `agentTurn` is two provider calls and two messages for one reminder. Every path
 * that ends a run — success, failure, skip, manual force — goes through `settle()`.
 *
 * Validation happens at **create**, not at fire time. A cron expression that cannot parse, a
 * timezone that is not IANA, an interval under the floor: all refused while the caller is still
 * there to read the message. The alternative is a job that sits in the list looking scheduled and
 * throws at 3am into a log nobody is watching.
 */

import { newId, createLogger, type Job, type JobRun, type JobTrigger, type JobPayload, type JobDelivery, type JobSessionMode, type JobTarget, type CronSection, type JobProposal, type Port, type ReachTest, type HeldAction, type JobAllowance } from "@nouride/shared";
import { randomToken, type SqliteDb } from "@nouride/runtime";
import type { AuditLog } from "@/commons/audit.store.ts";
import { nextCronOccurrence, parseCronExpr } from "@/modules/cron/expr.ts";
import { CronValidationError, validateJob, type ValidationRules } from "@/modules/cron/validate.ts";

const log = createLogger("cron.store");

interface Row {
  id: string;
  agent_id: string;
  name: string;
  enabled: number;
  schedule: string;
  payload: string;
  delivery: string | null;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  run_count: number;
  fail_count: number;
  target_gateway_id: string;
  target_chat_id: string;
  session: string;
  keep_after_run: number;
  created_by: string;
  fail_streak: number;
  disabled_reason: string | null;
  webhook_token: string | null;
  reach_test: string | null;
  proposal: string | null;
  turned_on_by: string | null;
  allowed: string | null;
}

interface RunRow {
  id: string;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  result: string | null;
  held: string | null;
}

export interface JobInput {
  agentId: string;
  name: string;
  trigger: JobTrigger;
  payload: JobPayload;
  target: JobTarget;
  session?: JobSessionMode;
  delivery?: JobDelivery;
  keepAfterRun?: boolean;
  createdBy: string;
  enabled?: boolean;
  /** Proposed by an agent (0.8.0, `proposals.ts`): created off, until a person turns it on from its card. */
  proposal?: JobProposal;
}

export interface CronStoreOptions {
  db: SqliteDb;
  config: CronSection;
  /** `[daemon] timezone` — what a cron expression means when the job did not name a zone. */
  timezone: string;
  audit?: AuditLog;
  now?: () => number;
}

export type RunOutcome = (
  | { status: "success"; result?: string }
  | {
      status: "error";
      result: string;
      /** The job's own chat would not take its delivery — so a failure notice sent there would not arrive either. */
      unreachable?: true;
    }
  | { status: "skipped"; result: string }
  | { status: "interrupted"; result: string }
) & {
  /** What its guards held with nobody there to ask (0.8.0) — kept on the run, for a person to allow always. */
  held?: readonly HeldAction[];
};

export class CronStore {
  constructor(private readonly options: CronStoreOptions) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get db(): SqliteDb {
    return this.options.db;
  }

  /** What `validateJob` holds a job to: the clock, the interval floor, the zone a bare expression means. */
  private get rules(): ValidationRules {
    return { now: this.now, minIntervalMs: this.options.config.minIntervalMs, timezone: this.options.timezone };
  }

  // ── Schedule arithmetic ───────────────────────────────────────────────────

  /**
   * The zone a job's expression is read in.
   *
   * Per job, falling back to the daemon's. Both matter: a daemon in UTC serving an operator in
   * Jakarta needs `[daemon] timezone` to be the default, and a job reporting to a team in another
   * country needs to override it.
   */
  private zoneFor(trigger: JobTrigger): string {
    return (trigger.kind === "cron" && trigger.tz) || this.options.timezone;
  }

  /**
   * When this schedule next fires after `after`, or `null` when it never will again.
   *
   * `null` is only ever a one-shot that has already fired. Everything else either has a next
   * occurrence or threw during validation.
   */
  nextRun(trigger: JobTrigger, after: number): number | null {
    switch (trigger.kind) {
      case "at":
        return trigger.at > after ? trigger.at : null;
      case "every":
        // Measured from `after` — the end of the last run, not a fixed grid laid down at creation.
        // A grid means a job that takes longer than its interval queues against itself forever.
        return after + trigger.everyMs;
      case "cron":
        return nextCronOccurrence(parseCronExpr(trigger.expr), after, this.zoneFor(trigger));
      case "webhook":
        // Never, by construction. `due()` reads `next_run_at`, so a null here is what keeps a
        // webhook job out of the ticker entirely rather than needing the ticker to know about it.
        return null;
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /**
   * The job a webhook request is for, or null.
   *
   * A unique index does the matching, so this is one indexed lookup rather than a scan — which
   * matters because it is on an unauthenticated path and a scan there is a free way to make the
   * daemon work for an attacker.
   *
   * No constant-time compare: SQLite is not comparing a secret against a candidate here, it is
   * finding a row by an indexed key. What a timing difference could leak is whether a token exists,
   * which is exactly what the response says anyway.
   */
  byWebhookToken(token: string): Job | null {
    if (!token) return null;
    const row = this.db
      .prepare<Row>("SELECT * FROM cron_jobs WHERE webhook_token = ?")
      .get(token);
    return row ? toJob(row) : null;
  }

  /**
   * Mint a new token for a job, invalidating the old URL immediately.
   *
   * The response to a leak — a URL pasted in a public issue, a repo that went public. Deleting and
   * rebuilding the job would work and would also lose its run history, which is the record you want
   * most at exactly that moment.
   */
  rotateWebhookToken(id: string, actor: string): Job | null {
    const job = this.get(id);
    if (!job || job.trigger.kind !== "webhook") return null;

    const token = randomToken();
    this.db.prepare("UPDATE cron_jobs SET webhook_token = ? WHERE id = ?").run(token, id);
    this.options.audit?.record({
      action: "cron_webhook_rotated",
      agentId: job.agentId,
      actor,
      details: { job: job.id, name: job.name },
    });
    log.info("webhook token rotated", { job: job.id, actor });
    return { ...job, webhookToken: token };
  }

  /** A proposal said yes to (`proposals.ts`): no longer one, and who said it kept — whom its missions run as. */
  settleProposal(id: string, turnedOnBy: string): void {
    this.db.prepare("UPDATE cron_jobs SET proposal = NULL, turned_on_by = ? WHERE id = ?").run(turnedOnBy, id);
  }

  /**
   * A person's *always for this job* (0.8.0): these destinations, for this job's runs, without asking again. One already
   * allowed is not added twice. Audited — it is a standing yes to something the guards would have asked.
   */
  allow(id: string, grant: { keys: readonly string[]; label: string }, by: string): Job | null {
    const job = this.get(id);
    if (!job || grant.keys.length === 0) return job;
    const allowed = job.allowed ?? [];
    if (allowed.some((one) => one.keys.length === grant.keys.length && one.keys.every((key) => grant.keys.includes(key)))) return job;
    const next = [...allowed, { keys: [...grant.keys], label: grant.label, by, at: this.now }];
    this.db.prepare("UPDATE cron_jobs SET allowed = ? WHERE id = ?").run(JSON.stringify(next), id);
    this.options.audit?.record({ action: "cron_allowed", agentId: job.agentId, actor: by, details: { job: id, keys: grant.keys } });
    log.info("a job allowed always", { job: id, keys: grant.keys, by });
    return { ...job, allowed: next };
  }

  /** Take one back: the allowance holding `key` goes, and that is asked again. */
  disallow(id: string, key: string, by: string): Job | null {
    const job = this.get(id);
    if (!job) return null;
    const next = (job.allowed ?? []).filter((one) => !one.keys.includes(key));
    this.db.prepare("UPDATE cron_jobs SET allowed = ? WHERE id = ?").run(next.length > 0 ? JSON.stringify(next) : null, id);
    this.options.audit?.record({ action: "cron_disallowed", agentId: job.agentId, actor: by, details: { job: id, key } });
    const { allowed: _allowed, ...rest } = job;
    return next.length > 0 ? { ...rest, allowed: next } : rest;
  }

  /** A webhook's test through its public address, kept until the next one (`web/hook-reach.ts`). */
  recordReachTest(id: string, test: ReachTest): void {
    this.db.prepare("UPDATE cron_jobs SET reach_test = ? WHERE id = ?").run(JSON.stringify(test), id);
  }

  create(input: JobInput): Job {
    validateJob(input, this.rules);

    const total = this.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM cron_jobs").get();
    if ((total?.n ?? 0) >= this.options.config.maxJobs) {
      throw new CronValidationError(
        `there are already ${total?.n} scheduled jobs, which is the configured ceiling. Delete one first.`,
      );
    }

    const enabled = input.proposal ? false : (input.enabled ?? true);
    const job: Job = {
      id: newId("cron"),
      agentId: input.agentId,
      name: input.name.trim(),
      enabled,
      trigger: input.trigger,
      payload: input.payload,
      delivery: input.delivery ?? { mode: "announce" },
      target: input.target,
      // `fresh` when the caller said nothing: a job that never asked for a history should not be
      // given one, and until this default changed every scheduled job silently appended to the
      // human conversation in its target chat. See `JobSessionMode`.
      session: input.session ?? "fresh",
      keepAfterRun: input.keepAfterRun ?? false,
      createdBy: input.createdBy,
      createdAt: this.now,
      // A disabled job has no next occurrence: it would be a time in the past by the time anyone
      // enabled it, and `enable` recomputes from the moment it is switched on.
      ...(enabled ? { nextRunAt: this.nextRun(input.trigger, this.now) ?? undefined } : {}),
      runCount: 0,
      failCount: 0,
      failStreak: 0,
      // Minted here, not asked for. A token the caller chooses is a token somebody chooses badly,
      // and this one is the entire authentication on a public endpoint.
      ...(input.trigger.kind === "webhook" ? { webhookToken: randomToken() } : {}),
      ...(input.proposal ? { proposal: input.proposal } : {}),
    };

    this.db
      .prepare(
        `INSERT INTO cron_jobs (id, agent_id, name, enabled, schedule, payload, delivery,
           created_at, last_run_at, next_run_at, run_count, fail_count,
           target_gateway_id, target_chat_id, session, keep_after_run, created_by,
           fail_streak, disabled_reason, webhook_token, proposal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(
        job.id,
        job.agentId,
        job.name,
        job.enabled ? 1 : 0,
        JSON.stringify(job.trigger),
        JSON.stringify(job.payload),
        JSON.stringify(job.delivery),
        job.createdAt,
        job.nextRunAt ?? null,
        job.target.gatewayId,
        job.target.chatId,
        job.session,
        job.keepAfterRun ? 1 : 0,
        job.createdBy,
        job.webhookToken ?? null,
        job.proposal ? JSON.stringify(job.proposal) : null,
      );

    this.options.audit?.record({
      action: "cron_create",
      agentId: job.agentId,
      actor: job.createdBy,
      gatewayId: job.target.gatewayId,
      chatId: job.target.chatId,
      details: {
        job: job.id,
        name: job.name,
        trigger: job.trigger,
        payload_kind: job.payload.kind,
        // The whole command, because that is what an audit log is for. An unattended argv is the
        // single most important thing here to be able to read back later.
        ...(job.payload.kind === "command" ? { argv: job.payload.argv } : {}),
        next_run_at: job.nextRunAt,
      },
    });

    log.info("cron job created", { job: job.id, name: job.name, next_run_at: job.nextRunAt });
    this.scheduleChanged();
    return job;
  }

  get(id: string): Job | null {
    const row = this.db.prepare<Row>("SELECT * FROM cron_jobs WHERE id = ?").get(id);
    return row ? toJob(row) : null;
  }

  list(filter: { agentId?: string; includeDisabled?: boolean } = {}): Job[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (!filter.includeDisabled) clauses.push("enabled = 1");

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare<Row>(
        // Due soonest first, then the ones with no next occurrence. `ORDER BY next_run_at` alone
        // sorts NULL first in SQLite, which puts every disabled job above the live ones.
        `SELECT * FROM cron_jobs ${where}
         ORDER BY next_run_at IS NULL, next_run_at ASC`,
      )
      .all(...params);
    return rows.map(toJob);
  }

  /**
   * Change a job in place.
   *
   * A schedule change recomputes `nextRunAt` from now — the pending occurrence belonged to the old
   * trigger, and keeping it means the edit appears not to have taken effect until one more run.
   */
  update(id: string, patch: Partial<JobInput>, actor: string): Job | null {
    const existing = this.get(id);
    if (!existing) return null;

    const merged: JobInput = {
      agentId: patch.agentId ?? existing.agentId,
      name: patch.name ?? existing.name,
      trigger: patch.trigger ?? existing.trigger,
      payload: patch.payload ?? existing.payload,
      target: patch.target ?? existing.target,
      session: patch.session ?? existing.session,
      delivery: patch.delivery ?? existing.delivery,
      keepAfterRun: patch.keepAfterRun ?? existing.keepAfterRun,
      createdBy: existing.createdBy,
    };
    // `at` in the past is refused on create; on update the existing one may legitimately be in the
    // past already, so only a *changed* schedule is re-checked.
    if (patch.trigger || patch.agentId !== undefined) validateJob(merged, this.rules);

    const nextRunAt = existing.enabled
      ? (this.nextRun(merged.trigger, this.now) ?? null)
      : null;

    this.db
      .prepare(
        `UPDATE cron_jobs SET agent_id = ?, name = ?, schedule = ?, payload = ?, delivery = ?,
           target_gateway_id = ?, target_chat_id = ?, session = ?, keep_after_run = ?,
           next_run_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.agentId, merged.name,
        JSON.stringify(merged.trigger),
        JSON.stringify(merged.payload),
        JSON.stringify(merged.delivery ?? { mode: "announce" }),
        merged.target.gatewayId,
        merged.target.chatId,
        merged.session ?? "fresh",
        merged.keepAfterRun ? 1 : 0,
        nextRunAt,
        id,
      );

    this.options.audit?.record({
      action: "cron_update",
      agentId: existing.agentId,
      actor,
      details: { job: id, name: merged.name, next_run_at: nextRunAt },
    });
    this.scheduleChanged();
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean, actor: string): Job | null {
    const existing = this.get(id);
    if (!existing) return null;

    // Recomputed from now, not resumed from the stored occurrence: a job paused for a week would
    // otherwise fire the instant it came back, for a time that has long passed.
    const nextRunAt = enabled ? (this.nextRun(existing.trigger, this.now) ?? null) : null;

    this.db
      .prepare(
        // Enabling clears the auto-disable reason *and* the streak. Leaving the streak would
        // re-disable the job after one more failure, which reads as "enable did not work".
        `UPDATE cron_jobs SET enabled = ?, next_run_at = ?,
           disabled_reason = NULL, fail_streak = CASE WHEN ? = 1 THEN 0 ELSE fail_streak END
         WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, nextRunAt, enabled ? 1 : 0, id);

    this.options.audit?.record({
      action: enabled ? "cron_enable" : "cron_disable",
      agentId: existing.agentId,
      actor,
      details: { job: id, name: existing.name, next_run_at: nextRunAt },
    });
    this.scheduleChanged();
    return this.get(id);
  }

  delete(id: string, actor: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    /**
     * The history goes too — but only here, and that distinction is the point.
     *
     * It used to happen by itself: `cron_runs.job_id` cascaded. That also took the history of every
     * *successfully fired one-shot*, because those are deleted the moment they run — so the
     * successes vanished and the failures were kept. Migration 024 removed the cascade, which means
     * this path has to say what it means.
     *
     * And it does mean it. An operator deleting a job is a decision about the whole thing; a
     * one-shot disappearing on success is bookkeeping. Only the first should erase what happened.
     */
    this.db.prepare("DELETE FROM cron_runs WHERE job_id = ?").run(id);
    this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
    this.options.audit?.record({
      action: "cron_delete",
      agentId: existing.agentId,
      actor,
      details: { job: id, name: existing.name },
    });
    this.scheduleChanged();
    return true;
  }

  // ── The scheduler's side ──────────────────────────────────────────────────

  /**
   * When the soonest enabled job is due, or null when none is — what the scheduler sets its one timer
   * for. Read from `idx_cron_next` alone, which is what makes asking after every write free.
   */
  nextDueAt(): number | null {
    return this.db.prepare<{ at: number | null }>("SELECT MIN(next_run_at) AS at FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL").get()?.at ?? null;
  }

  /**
   * Called after every write that can move a job's next run: create, update, enable, delete, settle.
   *
   * The scheduler sleeps until `nextDueAt` rather than polling (2026-10-15), so a job created for two
   * minutes from now would otherwise wait for whatever the timer was already set to — up to a minute
   * late. Here rather than at each caller because this store is the one place `next_run_at` moves.
   */
  onScheduleChange(listener: () => void): void {
    this.scheduleListener = listener;
  }

  private scheduleListener?: () => void;

  /** The write has happened either way; a timer that could not be set again is the scheduler's to log. */
  private scheduleChanged(): void {
    try {
      this.scheduleListener?.();
    } catch (err) {
      log.warn("could not tell the scheduler a job moved", { error: String(err) });
    }
  }

  /** Jobs due at or before `at`. The one hot query, served by `idx_cron_next`. */
  due(at: number): Job[] {
    return this.db
      .prepare<Row>(
        "SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
      )
      .all(at)
      .map(toJob);
  }

  /**
   * Claim a job for a run, so it cannot be picked up twice.
   *
   * `next_run_at` is cleared as part of the same statement that checks it, and the update is
   * conditional on the value the caller saw. A tick that overruns its interval — an `agentTurn`
   * against a slow provider will — otherwise finds the same job still due and starts it again.
   */
  claim(job: Job): boolean {
    const changed = this.db
      .prepare("UPDATE cron_jobs SET next_run_at = NULL WHERE id = ? AND next_run_at = ?")
      .run(job.id, job.nextRunAt ?? null);
    return changed.changes !== 0;
  }

  /**
   * End a run: count it, advance the trigger, and decide whether the job survives it.
   *
   * The only place `next_run_at` moves forward, and the only place a job disables or deletes
   * itself. Everything a run can do to its job is in one function so the cases cannot disagree —
   * an earlier draft advanced the schedule in the success path and forgot the error path, which
   * turned one failing job into a job that never ran again and never said so.
   */
  settle(job: Job, outcome: RunOutcome): void {
    try {
      this.advance(job, outcome);
    } finally {
      this.scheduleChanged();
    }
  }

  private advance(job: Job, outcome: RunOutcome): void {
    const now = this.now;
    const success = outcome.status === "success";
    // A skip is neither: the job did not run and nothing was wrong with it. Counting skips as
    // failures would auto-disable a nightly job after ten days of the daemon being off overnight.
    const failed = outcome.status === "error";

    if (job.trigger.kind === "at") {
      if (success && !job.keepAfterRun) {
        this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(job.id);
        log.info("one-shot job fired and removed", { job: job.id, name: job.name });
        return;
      }
      // A one-shot has nowhere to advance to, so the ordinary path would leave it enabled with no
      // next occurrence — a row that looks scheduled and never fires again. Disabled with a stated
      // reason instead, so `cron list --all` shows what happened and `cron run` can run it again.
      //
      // `fired` is the one reason here that is not a problem: a one-shot kept by `--keep` after it
      // succeeded. It used to share the failure branch, so a one-shot that ran fine was disabled as
      // `missed` with a warning that it had not fired — found testing 0.7.2 on a live box.
      const reason = success ? "fired" : failed ? "one-shot failed" : outcome.status === "interrupted" ? "interrupted" : "missed";
      this.db
        .prepare(
          `UPDATE cron_jobs SET last_run_at = ?, next_run_at = NULL, run_count = run_count + 1,
             fail_count = fail_count + ?, enabled = 0, disabled_reason = ?
           WHERE id = ?`,
        )
        .run(now, failed ? 1 : 0, reason, job.id);
      if (success) log.info("one-shot job fired and kept", { job: job.id, name: job.name });
      else log.warn("one-shot job did not fire successfully", { job: job.id, name: job.name, status: outcome.status });
      return;
    }

    const streak = failed ? job.failStreak + 1 : success ? 0 : job.failStreak;
    const autoDisable = failed && streak >= this.options.config.failStreakLimit;
    const nextRunAt = autoDisable ? null : (this.nextRun(job.trigger, now) ?? null);

    this.db
      .prepare(
        `UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1,
           fail_count = fail_count + ?, fail_streak = ?, enabled = ?, disabled_reason = ?
         WHERE id = ?`,
      )
      .run(
        now,
        nextRunAt,
        failed ? 1 : 0,
        streak,
        autoDisable ? 0 : job.enabled ? 1 : 0,
        autoDisable ? "consecutive-failures" : null,
        job.id,
      );

    if (autoDisable) {
      log.error("cron job disabled itself after repeated failures", {
        job: job.id,
        name: job.name,
        failures: streak,
      });
      this.options.audit?.record({
        action: "cron_auto_disable",
        agentId: job.agentId,
        actor: "cron",
        details: { job: job.id, name: job.name, consecutive_failures: streak, last_error: outcome.result },
      });
    }
  }

  // ── Run history ───────────────────────────────────────────────────────────

  startRun(jobId: string): JobRun {
    const run: JobRun = { id: newId("run"), jobId, startedAt: this.now, status: "success" };
    /**
     * The job's name is copied onto the run, not joined to it later.
     *
     * A one-shot is deleted the moment it fires, so by the time anybody reads its history the row it
     * would have joined to is gone — that is how every successful `at` job used to vanish from the
     * run list entirely. Copied *at start* rather than at finish, so a run that is still going has a
     * name too, and a job renamed between two runs reads as two names, which is what happened.
     */
    const name = this.db
      .prepare<{ name: string }>("SELECT name FROM cron_jobs WHERE id = ?")
      .get(jobId)?.name;
    this.db
      .prepare(
        "INSERT INTO cron_runs (id, job_id, job_name, started_at, finished_at, status, result) VALUES (?, ?, ?, ?, NULL, 'running', NULL)",
      )
      .run(run.id, run.jobId, name ?? null, run.startedAt);
    return run;
  }

  finishRun(runId: string, outcome: RunOutcome): void {
    this.db
      .prepare("UPDATE cron_runs SET finished_at = ?, status = ?, result = ?, held = ? WHERE id = ?")
      .run(this.now, outcome.status, outcome.result ?? null, outcome.held?.length ? JSON.stringify(outcome.held) : null, runId);
  }

  runs(jobId: string, limit = 20): JobRun[] {
    return this.db
      .prepare<RunRow>("SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(jobId, limit)
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        startedAt: row.started_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
        status: row.status as JobRun["status"],
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.held === null ? {} : { held: JSON.parse(row.held) as HeldAction[] }),
      }));
  }

  /**
   * Recent runs across every job, newest first, with the job's name attached.
   *
   * `runs(jobId)` answers "how has this one been doing", which is the question the Schedule page
   * asks. This answers "what has fired lately", which is the question you ask when something went
   * wrong and you do not yet know which job it was — and it was not answerable at all without
   * opening every job in turn.
   */
  recentRuns(limit = 100): (JobRun & { jobName: string; agentId: string })[] {
    return this.db
      .prepare<RunRow & { job_name: string | null; agent_id: string | null }>(
        // `r.job_name` first, because the join cannot answer for a job that has been deleted — and a
        // successfully fired one-shot always has been. The join is still there for `agent_id`, which
        // is genuinely the job's rather than the run's.
        `SELECT r.*, COALESCE(r.job_name, j.name) AS job_name, j.agent_id AS agent_id
         FROM cron_runs r LEFT JOIN cron_jobs j ON j.id = r.job_id
         ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500)))
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        // A run whose job has since been deleted keeps its history — the row is the record that it
        // happened, and dropping it would make the list disagree with the audit log.
        jobName: row.job_name ?? "(deleted job)",
        agentId: row.agent_id ?? "",
        startedAt: row.started_at,
        ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
        status: row.status as JobRun["status"],
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.held === null ? {} : { held: JSON.parse(row.held) as HeldAction[] }),
      }));
  }

  /** Drop run history past the retention window. `0` days keeps everything. */
  sweepRuns(): number {
    const days = this.options.config.runRetentionDays;
    if (days <= 0) return 0;
    const cutoff = this.now - days * 86_400_000;
    const result = this.db.prepare("DELETE FROM cron_runs WHERE started_at < ?").run(cutoff);
    const removed = result.changes;
    if (removed > 0) log.info("swept cron run history", { removed, older_than_days: days });
    return removed;
  }

  /**
   * Mark runs left mid-flight by a restart.
   *
   * A row that says `running` with no `finished_at` and no process behind it is a lie the
   * dashboard would render as a job still working. Called once at boot, before the ticker starts.
   */
  reconcileInterrupted(): number {
    const result = this.db
      .prepare(
        "UPDATE cron_runs SET status = 'interrupted', finished_at = ?, result = 'interrupted by a daemon restart' WHERE finished_at IS NULL",
      )
      .run(this.now);
    return result.changes;
  }
}

/** Whether a stored string is one of the three modes. Anything else is a row from another version. */
function isSessionMode(value: string): value is JobSessionMode {
  return value === "chat" || value === "isolated" || value === "fresh";
}

function toJob(row: Row): Job {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    enabled: row.enabled === 1,
    // The column is still `schedule`: the field was renamed because a `schedule` holding a
    // webhook reads as a contradiction, and a column rename would be a migration for a word.
    trigger: JSON.parse(row.schedule) as JobTrigger,
    payload: JSON.parse(row.payload) as JobPayload,
    delivery: row.delivery ? (JSON.parse(row.delivery) as JobDelivery) : { mode: "announce" },
    target: { gatewayId: row.target_gateway_id, chatId: row.target_chat_id },
    /**
     * Rows written before `fresh` existed say `chat`, and they keep meaning it.
     *
     * A migration that rewrote them to the new default would change what those jobs *do* — a job
     * built to read its channel's conversation would silently stop doing so — so the default only
     * applies to jobs created from here on.
     */
    session: isSessionMode(row.session) ? row.session : "chat",
    keepAfterRun: row.keep_after_run === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.last_run_at === null ? {} : { lastRunAt: row.last_run_at }),
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    runCount: row.run_count,
    failCount: row.fail_count,
    failStreak: row.fail_streak,
    ...(row.disabled_reason === null ? {} : { disabledReason: row.disabled_reason }),
    ...(row.webhook_token === null ? {} : { webhookToken: row.webhook_token }),
    ...(row.reach_test === null ? {} : { reachTest: JSON.parse(row.reach_test) as ReachTest }),
    ...(row.proposal === null ? {} : { proposal: JSON.parse(row.proposal) as JobProposal }),
    ...(row.turned_on_by === null ? {} : { turnedOnBy: row.turned_on_by }),
    ...(row.allowed === null ? {} : { allowed: JSON.parse(row.allowed) as JobAllowance[] }),
  };
}

/**
 * Scheduled jobs and their runs, as the daemon depends on it.
 *
 * Business logic takes this, never `CronStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type CronPort = Port<CronStore>;
