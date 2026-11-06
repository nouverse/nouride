/**
 * Work that outlives a turn.
 *
 * The one foundational difference from Claude Code, and it is a shape rather than a tool: every `exec`
 * blocked its turn, capped at 300s — the same value as `max_turn_duration_ms`, so a five-minute command
 * could never use its own budget before the turn killed it. Two limits that had never been compared.
 *
 * On a server that rules out most of what is worth doing: a test suite, a build, `docker compose up`,
 * tailing a log until an error appears. A turn stays short; the *work* is what gets to be long.
 *
 * ## How the agent finds out
 *
 * It is **woken**, not polled. When a job ends, a synthetic message goes into the conversation that
 * started it, so the agent reacts in its own voice with its own history — rather than the operator
 * discovering a finished build by asking. Polling would also mean the agent burns a turn to learn
 * nothing, which is the cost pattern this is supposed to remove.
 *
 * ## What a restart does
 *
 * Kills the children. Deliberate, and the honest choice: we cannot tell `bun test` (safe to orphan)
 * from `docker compose up -d` (meant to outlive us), and a daemon that leaves unknown processes behind
 * is worse than one that stops them. The *records* are persisted, so a job interrupted by a restart is
 * reported as interrupted instead of being waited on forever.
 *
 * ## What runs too long
 *
 * Runs on, unless the operator set `[security] job_max_ms`: then a job that is not a service is stopped once it has
 * run that long, recorded `killed` like any stop, and its agent is told it ran out of time (`deadline.ts`).
 */

import { agentReadableMode, type BackgroundHandle, ensureDir, isProcessAlive, join, readTextFile, removePath, setFileMode, type SqliteDb, statFile, type TextFilter } from "@nouride/runtime";
import { contained, createLogger, newId, type ExecPolicySection, type SandboxOptions, type Port } from "@nouride/shared";
import type { AuditLog } from "@/commons/audit.store.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import type { HelperBrief } from "@/modules/tools/builtins/delegate-brief.ts";
import { JobDeadlines } from "./deadline.ts";
import { HelperJobs, type HelperRow, type HelperStart, type StartAsk, type StartHelper } from "./helper-jobs.ts";
import { spawnJob } from "./job-spawn.ts";

const log = createLogger("jobs");

export type JobStatus = "running" | "succeeded" | "failed" | "killed" | "interrupted";

/**
 * A command `exec` started; a helper `delegate` started in the background (0.7.15, `helper-jobs.ts`); or another agent's
 * turn an `ask_agent` moved there when it outlasted its wait (0.7.19, `pipeline/background-ask.ts`). The last two are
 * turns in this process, not processes — `backgroundTurns`.
 */
export type JobKind = "command" | "helper" | "ask";

/**
 * Who an ask in the background asked, and what — kept in the `brief` column, which holds what a turn job was given to do:
 * a helper's brief, or this. No column of its own: the row is read by its kind, and an older daemon reading it lists it
 * as a command (0.7.19).
 */
export interface AskedWork {
  /** The agent asked — the one doing the work. The row's own agent is the one that asked, and is woken with the answer. */
  agent: string;
  task: string;
}

export interface JobRecord {
  id: string;
  agentId: string;
  gatewayId: string;
  chatId: string;
  command: string;
  cwd: string;
  status: JobStatus;
  pid: number | null;
  exitCode: number | null;
  logPath: string;
  startedAt: number;
  endedAt: number | null;
  /** Opt-in: what to do when the job finishes. Appended to the wake message as an explicit instruction. */
  onComplete: string | null;
  kind: JobKind;
  /** A helper's brief — what it was asked to do. Null for a command and an ask. */
  brief: HelperBrief | null;
  /** An ask's agent and task. Null for a command and a helper. */
  ask: AskedWork | null;
  /** What a helper or an asked agent handed back when it ended — or stopped for a restart. Null for a command, and while it runs. */
  report: SubAgentHandoff | null;
  /** The turn that started it, and the person that turn answered — kept for a helper and an ask. */
  turnId: string | null;
  senderId: string | null;
}

export interface JobSnapshot extends JobRecord {
  logBytes: number;
  logUpdatedAt: number | null;
  processAlive: boolean | null;
  /** Started as a server, meant to run until stopped: no quiet notices, no deadline, not in the way of an update. */
  service: boolean;
}

interface Row {
  id: string;
  agent_id: string;
  gateway_id: string;
  chat_id: string;
  command: string;
  cwd: string;
  status: string;
  pid: number | null;
  exit_code: number | null;
  log_path: string;
  started_at: number;
  ended_at: number | null;
  on_complete: string | null;
  kind: string;
  brief: string | null;
  report: string | null;
  turn_id: string | null;
  sender_id: string | null;
}

interface DuplicateRow {
  id: string;
}

/**
 * How old an interrupted job may be and still be worth waking somebody about.
 *
 * Six hours. Long enough to cover a crash overnight that somebody is still waiting on in the morning,
 * short enough that a job from a previous day does not arrive in a conversation that has been reset
 * since — where it reads as the agent bringing up something nobody remembers asking for.
 */
export const INTERRUPTED_REPORT_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * How many get said out loud, newest first.
 *
 * A daemon that crash-loops with four jobs running would otherwise report them on every boot. The rest
 * are in `nouride jobs`, which is where a full accounting belongs.
 */
export const INTERRUPTED_REPORT_MAX = 3;

export interface JobCompletion {
  job: JobRecord;
  /** First lines of the log, for the wake-up message. The rest stays on disk. */
  tail: string;
  /** Set when the daemon stopped it — the row says only `killed`, as it does for a stop somebody asked for. */
  stop?: JobStop;
  /** Processes the kernel stopped for memory among the agents' commands while it ran — what its exit may not show. */
  oomKills?: number;
}

/**
 * Why the daemon stopped a job nobody asked it to stop: it ran for `[security] job_max_ms` (`limitMs`). A union of
 * one, so another reason — a ceiling of its own — is a new member, not another optional flag beside this one.
 */
export type JobStop = { by: "deadline"; limitMs: number };

export interface JobStoreOptions {
  db: SqliteDb;
  /** `data/jobs`. One log file per job. */
  logDir: string;
  audit?: AuditLog;
  /**
   * Per agent. A cap, not a queue: an agent that has this many jobs running is told to wait, because
   * silently queueing would make `background: true` behave like a foreground call at the worst moment.
   */
  maxConcurrentPerAgent: number;
  /** Called when a job ends, so the pipeline can wake the agent. */
  onComplete?: (completion: JobCompletion) => void;
  now?: () => number;
  /** The agent's credentials, as `exec` hands them to a command — masked out of its jobs' logs as they are written (S5). */
  secrets?: (agentId: string) => Record<string, string>;
  /** `[security.exec]`, read when a job starts: the ceilings a foreground command gets, which a job now gets too (S5). */
  limits?: () => Pick<ExecPolicySection, "maxMemoryMb" | "maxCpuSeconds">;
  /** `[security] job_max_ms`, read when a job starts: how long one that is not a service may run. `0` never stops one. */
  maxMs?: () => number;
  /** Between a stop's SIGTERM and its SIGKILL. The runtime's five seconds when absent; a test shortens it. */
  stopGraceMs?: number;
  /** The deadline timers, for a test that counts them. */
  deadlines?: JobDeadlines;
}


/** Enough of the log to react to. The full file is on disk and readable with `read`. */
const TAIL_BYTES = 4000;

export class JobStore {
  /** Live handles. Absent for a job whose daemon has since restarted — see `interruptOrphaned`. */
  private handles = new Map<string, BackgroundHandle>();

  /**
   * The running jobs that are services — a dev server, a tunnel — kept beside their handles.
   *
   * In memory, not a column: a job does not outlive the daemon that started it, so a mark that survived a restart
   * would describe a process that no longer exists. This was a module-level set once, written by `exec`'s reply
   * rather than by the start that knew, and never emptied.
   */
  private readonly services = new Set<string>();

  private readonly deadlines: JobDeadlines;

  /** Jobs the deadline stopped, with the limit that applied: recorded `killed` whatever code they die with. */
  private readonly expired = new Map<string, number>();

  /** The helpers `delegate` started in the background, and the asks moved there — a turn each, not a process (`helper-jobs.ts`). */
  private readonly helpers: HelperJobs;

  // Nothing made here: the directory a turn is given is an agent's own, and `logDirFor` creates it.
  constructor(private readonly options: JobStoreOptions) {
    this.deadlines = options.deadlines ?? new JobDeadlines();
    this.helpers = new HelperJobs({
      rows: {
        insert: (row) => this.insertHelper(row),
        settle: (id, status, report) =>
          void this.options.db.prepare("UPDATE jobs SET status = ?, exit_code = NULL, ended_at = ?, report = ? WHERE id = ?").run(status, this.now, JSON.stringify(report), id),
        keep: (id, report) => void this.options.db.prepare("UPDATE jobs SET report = ? WHERE id = ?").run(JSON.stringify(report), id),
      },
      logDirFor: (agentId) => this.logDirFor(agentId),
      get: (id) => this.get(id),
      running: (agentId) => this.backgroundTurns(agentId),
      tail: (id) => this.tail(id),
      closed: () => this.closed,
      now: () => this.now,
      deadlines: this.deadlines,
      ...(options.maxMs ? { maxMs: options.maxMs } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
      notify: () => this.onComplete ?? this.options.onComplete,
    });
  }

  /** Start a helper in the background, or say why not — see `HelperJobs.start`. */
  startHelper(params: StartHelper): HelperStart {
    return this.helpers.start(params);
  }

  /** Take an ask that outlasted its wait into the background, or say why not — see `HelperJobs.startAsk`. */
  startAsk(params: StartAsk): HelperStart {
    return this.helpers.startAsk(params);
  }

  /**
   * This agent's turns working in the background now — its helpers and its asks — oldest first: what its one limit
   * (`[delegate] max_background`) counts, what a refusal names, and what `/stop` stops.
   */
  backgroundTurns(agentId: string): JobRecord[] {
    return this.running(agentId).filter((job) => job.kind !== "command");
  }

  /** A turn job's row as it starts: no pid — it is a turn in this process — and what it was given and who it is for. */
  private insertHelper(row: HelperRow): void {
    this.options.db
      .prepare(
        `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, pid, log_path, started_at, kind, brief, turn_id, sender_id)
         VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.agentId, row.gatewayId, row.chatId, row.command, row.cwd, row.logPath, row.startedAt, row.kind, JSON.stringify(row.given), row.turnId ?? null, row.senderId);
  }

  /**
   * Where one agent's logs are, so its turns can read them — and nobody else's.
   *
   * Exposed because `exec` says `Live log: <path>` the moment a job starts, and a path the sandbox
   * refuses is worse than none. Per agent because a log is written by the child itself, unmasked: with
   * one shared directory, any agent could `read` another's job log and see the credentials that
   * agent's commands were given, which its own mask does not know to hide. Read-only: the job writes.
   */
  logDirFor(agentId: string): string {
    const dir = join(this.options.logDir, agentId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.{2,}/g, "_"));
    ensureDir(dir);
    return dir;
  }

  /**
   * Set the wake-up callback after construction.
   *
   * The two halves reference each other — the store wakes the pipeline, the pipeline starts jobs — so
   * one of them has to be wired second. Done here rather than by passing a closure into the pipeline,
   * because the store is what knows when a job actually ended.
   */
  setOnComplete(handler: (completion: JobCompletion) => void): void {
    this.onComplete = handler;
  }

  private onComplete?: (completion: JobCompletion) => void;

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Mark jobs from a previous run as interrupted.
   *
   * Called at boot. Their processes died with the daemon, so leaving them `running` would show a job
   * list that lies and an agent waiting on a wake-up that can never arrive.
   */
  interruptOrphaned(): JobRecord[] {
    // Read before the update, because after it there is nothing left to distinguish these rows from
    // any other interrupted job in the table.
    const orphaned = this.options.db
      .prepare<Row>(`SELECT * FROM jobs WHERE status = 'running'`)
      .all()
      .map(toRecord);

    const endedAt = this.now;
    const changed = this.options.db
      .prepare(
        `UPDATE jobs SET status = 'interrupted', ended_at = ? WHERE status = 'running'`,
      )
      .run(endedAt).changes;
    if (changed > 0) log.info("marked jobs interrupted by a restart", { count: changed });

    /**
     * Returned as they now *are*, not as they were read.
     *
     * The rows have to be read before the update; the records handed on do not have to carry that
     * moment with them, and carrying it silently disabled everything downstream. `reportInterrupted`
     * passes these straight to the wake-up, and a record still saying `running` means:
     *
     * - `jobWakeMessage` finds no matching outcome and falls through to its failure branch, so a job
     *   killed by a restart is announced as "failed with exit code unknown" — watched live on a clone
     *   that had run for 41 minutes;
     * - `endedAt` is null, so the same line says "after 0s";
     * - `jobFailureNotice` and `jobReportRequirement` both test for `failed` or `interrupted`, find
     *   neither, and return null — no notice posted, and nothing owed by the agent's reply.
     *
     * So the one case this whole path exists for — work lost to a restart, which nobody else will ever
     * mention — was the one case that reported nothing.
     */
    return orphaned.map((job) => ({ ...job, status: "interrupted" as const, endedAt }));
  }

  /**
   * Tell the agent about a job that died with the previous daemon.
   *
   * Returning the rows above fixed the job *list*. It did not fix the person: this method's absence is
   * why an operator who was told "gw kabarin begitu selesai" waited forever. Live, and twice in one
   * day — an agent started a 17-minute build on the box the daemon runs on, the box went down under
   * it, and after the restart nothing anywhere said the work had stopped. The comment at the call site
   * even claimed the point was to avoid "an agent waiting on a wake-up that can never arrive", which
   * was true of the row and false of the conversation.
   *
   * Bounded on two axes, because a crash-looping daemon must not turn one lost build into a flood:
   *
   * - **Age.** A job from yesterday is archaeology; the person has moved on, and a wake-up about it
   *   arrives with no context in a conversation that has since been reset.
   * - **Count.** Whatever the age window admits, only the most recent few are worth saying out loud.
   *   The rest stay in `nouride jobs`, which is where a full accounting belongs.
   */
  reportInterrupted(
    orphaned: JobRecord[],
    wake: (completion: JobCompletion) => void,
    now: number = this.now,
  ): number {
    const recent = orphaned
      .filter((job) => now - job.startedAt <= INTERRUPTED_REPORT_WINDOW_MS)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, INTERRUPTED_REPORT_MAX);

    for (const job of recent) {
      // The partial log, the same way a normal completion carries it: a build that died halfway is
      // exactly the case where the last lines say where it got to.
      void this.tail(job.id)
        .then((tail) => wake({ job, tail }))
        .catch((err: unknown) =>
          log.error("could not report an interrupted job", { job: job.id, error: String(err) }),
        );
    }

    if (recent.length > 0) {
      log.info("reporting jobs interrupted by a restart", {
        reported: recent.length,
        found: orphaned.length,
      });
    }
    return recent.length;
  }

  running(agentId: string): JobRecord[] {
    return this.options.db
      .prepare<Row>("SELECT * FROM jobs WHERE agent_id = ? AND status = 'running' ORDER BY started_at")
      .all(agentId)
      .map(toRecord);
  }

  /**
   * The newest first: twenty unless asked, a hundred at most — or, with `all`, every row the retention sweep has left
   * (0.8.12): Helpers & jobs stopped at a hundred where the box held 123, and `[retention] job_log_days` already bounds it.
   */
  list(options: { agentId?: string; limit?: number; all?: boolean } = {}): JobRecord[] {
    const limit = options.all ? -1 : Math.min(options.limit ?? 20, 100);
    return options.agentId
      ? this.options.db
          .prepare<Row>("SELECT * FROM jobs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?")
          .all(options.agentId, limit)
          .map(toRecord)
      : this.options.db
          .prepare<Row>("SELECT * FROM jobs ORDER BY started_at DESC LIMIT ?")
          .all(limit)
          .map(toRecord);
  }

  get(id: string): JobRecord | null {
    const row = this.options.db.prepare<Row>("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  listSnapshots(options: { agentId?: string; limit?: number; all?: boolean } = {}): JobSnapshot[] {
    return this.list(options).map((job) => this.snapshot(job));
  }

  getSnapshot(id: string): JobSnapshot | null {
    const job = this.get(id);
    return job ? this.snapshot(job) : null;
  }

  /**
   * Start a command and return immediately.
   *
   * Throws only when the cap is reached or the spawn fails — both are conditions the caller turns into
   * a tool result, because the model can act on either.
   */
  start(params: {
    agentId: string;
    gatewayId: string;
    chatId: string;
    argv: string[];
    /** `agent`: whose own user it runs as — absent for the daemon's own CLI, run for an agent by the `nouride` tool. */
    sandbox: Pick<SandboxOptions, "cwd" | "env" | "agent">;
    /** Opt-in: what to do when the job finishes. Appended verbatim to the wake message. */
    onComplete?: string;
    /** A server, meant to run until stopped: spared the CPU-seconds ceiling (`jobLimits`) and the deadline. */
    service?: boolean;
    /** Values its log is masked of besides the agent's: the credentials sent in its conversation (`tools/held-secrets.ts`). */
    mask?: Record<string, string>;
    /** What its log goes through before that masking: a command printing credentials, each value a handle (`tools/credential-output.ts`). */
    filter?: () => TextFilter;
    /**
     * The turn it was started in (0.7.17). An agent asked through `ask_agent` runs inside the asking agent's turn, so
     * this is how its job's end finds its way back to the agent that asked (`pipeline/job-wakes.ts`).
     */
    turnId?: string;
  }): JobRecord & { limitMs: number } {
    const command = params.argv.join(" ");
    const duplicate = this.options.db
      .prepare<DuplicateRow & { pid: number | null }>(
        `SELECT id, pid
           FROM jobs
          WHERE agent_id = ?
            AND status = 'running'
            AND command = ?
            AND cwd = ?
          ORDER BY started_at
          LIMIT 1`,
      )
      .get(params.agentId, command, params.sandbox.cwd);
    if (duplicate) {
      /**
       * Believed only if the process is actually there.
       *
       * `interruptOrphaned` clears these at boot, so a restart is covered — but within one daemon
       * lifetime a row can outlive its process: an exit event missed, a child SIGKILLed from outside,
       * a completion handler that threw. The row then says `running` forever, and this guard turns
       * that into a permanent refusal of one exact command with a message telling the operator to
       * wait for something that already finished. A stuck job list is annoying; a stuck job list that
       * blocks work is the failure worth spending a `kill(0)` on.
       *
       * Reconciled rather than merely ignored, so `nouride jobs` stops lying about it too — but
       * through `markStatus`, not `finish`: `finish` fires the completion wake-up, and waking an agent
       * to report a job it never saw running is noise about something nobody is waiting for.
       */
      const alive = duplicate.pid ? isProcessAlive(duplicate.pid) : false;
      if (alive) {
        throw new Error(
          `An identical background job is already running as ${duplicate.id}. ` +
            `Wait for it to finish, read its log, or stop it first.`,
        );
      }
      log.warn("a job was marked running but its process is gone: reconciling", {
        job: duplicate.id,
        pid: duplicate.pid,
      });
      this.markStatus(duplicate.id, "interrupted", null);
      this.forget(duplicate.id);
    }

    // Commands only: a helper counts against `[delegate] max_background`, not against this.
    const active = this.running(params.agentId).filter((job) => job.kind === "command").length;
    if (active >= this.options.maxConcurrentPerAgent) {
      throw new Error(
        `${active} background job(s) already running for this agent (limit ${this.options.maxConcurrentPerAgent}). ` +
          `Wait for one to finish, or stop it.`,
      );
    }

    const id = newId("job");
    const logPath = join(this.logDirFor(params.agentId), `${id}.log`);
    const startedAt = this.now;

    const secrets = params.mask ? { ...this.options.secrets?.(params.agentId), ...params.mask } : this.options.secrets?.(params.agentId);
    const handle = spawnJob(params, logPath, { secrets, policy: this.options.limits?.(), ...(params.filter ? { filter: params.filter } : {}) });
    // The log can contain anything the command printed, including tokens it was given. Same reasoning
    // as the database and inbound attachments: the daemon's, and its agent's where that agent is its own user.
    setFileMode(logPath, agentReadableMode());

    this.options.db
      .prepare(
        `INSERT INTO jobs
           (id, agent_id, gateway_id, chat_id, command, cwd, status, pid, log_path, started_at, on_complete, turn_id)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.gatewayId,
        params.chatId,
        command,
        params.sandbox.cwd,
        handle.pid,
        logPath,
        startedAt,
        params.onComplete ?? null,
        params.turnId ?? null,
      );

    this.handles.set(id, handle);
    if (params.service) this.services.add(id);
    // A service is exempt for the reason it has no CPU-seconds ceiling: running is its job. The agent says which a
    // job is, so this bounds a runaway, not an agent that means to run long — and the audit row says it chose to.
    const limitMs = params.service ? 0 : (this.options.maxMs?.() ?? 0);
    if (limitMs > 0) this.deadlines.arm(id, limitMs, () => this.expire(id, limitMs));
    this.options.audit?.record({
      action: "job_started",
      agentId: params.agentId,
      gatewayId: params.gatewayId,
      chatId: params.chatId,
      details: { job: id, command, pid: handle.pid, ...(params.service ? { service: true } : {}) },
    });
    log.info("background job started", { job: id, agent_id: params.agentId, command, pid: handle.pid });

    // Not awaited: that is the whole point. The completion path is what wakes the agent.
    // Nothing awaits this — that is the point — so **anything it throws is an unhandled rejection**.
    // The old shape made that worse: the `.catch` called `finish` again, so a failure inside `finish`
    // threw a second time with nobody left to catch it.
    //
    // Observed as "5 unhandled errors between tests" with every assertion passing: a job exiting after
    // the database had closed threw `RangeError: Cannot use a closed database`. In the daemon that is
    // shutdown ordering; in a test it is `afterEach`. Either way a completion that cannot be recorded is
    // something to log, not something to crash the process from a promise nobody is holding.
    void handle.exited
      .then(({ exitCode, signal, oomKills }) => this.settle(id, exitCode, signal, oomKills))
      .catch((err: unknown) => {
        log.error("background job failed to report", { job: id, error: String(err) });
        this.settle(id, null, null);
      });

    return { ...(this.get(id) as JobRecord), limitMs };
  }

  /** Whether a running job is a service — what the watchdog and an update leave alone. */
  isService(id: string): boolean {
    return this.services.has(id);
  }

  /** Stop a running job. Returns false when it is unknown or already finished. */
  kill(id: string, by: string): boolean {
    const handle = this.handles.get(id);
    const record = this.get(id);
    if (!record || record.status !== "running") return false;

    if (this.helpers.holds(id)) {
      // Its turn is aborted — a helper's, or an asked agent's — and its end is written by its own settle: `killed`, whatever it hands back.
      this.helpers.stop(id);
    } else if (handle) {
      this.stopping.add(id);
      this.halt(id, handle);
    } else {
      // No handle means the process belongs to a previous run of the daemon. The row is corrected so
      // the list stops lying; the process itself died with that daemon.
      this.markStatus(id, "interrupted", null);
      this.forget(id);
    }

    this.options.audit?.record({
      action: "job_killed",
      agentId: record.agentId,
      actor: by,
      details: { job: id, command: record.command },
    });
    return true;
  }

  /**
   * Stop everything. Called on shutdown — see the header on why children are not orphaned.
   *
   * Marks the store closed first: killing a child makes its `exited` promise resolve, and by the time it
   * does the database may already be gone.
   *
   * Awaited, and that is new. A job runs in a process group of its own, out of reach of the signal that
   * stops the daemon — a Ctrl-C at a terminal used to take its children with it — so one that ignores
   * SIGTERM is only stopped by the SIGKILL that follows, and that has to happen before we exit.
   */
  async killAll(): Promise<number> {
    this.closed = true;
    this.deadlines.clearAll();
    const handles = [...this.handles.values()];
    // Cleared here, because `finish` is the usual place handles are removed and `closed` now
    // short-circuits it — so without this they would be held for the lifetime of the process and a
    // second call would report the same jobs again. Caught by a test asserting the second call is 0.
    this.handles.clear();
    // A helper's or an ask's row is left `running` as a command's is: the store is closed, and the next boot closes them all.
    const [helpers] = await Promise.all([this.helpers.stopAll(), ...handles.map((handle) => handle.stop())]);
    return handles.length + helpers;
  }

  /** Last bytes of a job's log, for a wake-up message or `nouride jobs log`. */
  async tail(id: string, bytes = TAIL_BYTES): Promise<string> {
    const record = this.get(id);
    if (!record) return "";
    const stat = statFile(record.logPath);
    if (!stat || stat.size === 0) return "";

    try {
      const text = await readTextFile(record.logPath);
      return text.length > bytes ? `…\n${text.slice(-bytes)}` : text;
    } catch {
      return "";
    }
  }

  /**
   * Stop touching the database once it is gone.
   *
   * Shutdown kills the children, so their `exited` promises resolve *after* `db.close()` — and `finish`
   * then tried to write a row, throwing `RangeError: Cannot use a closed database` as an unhandled
   * rejection. Surfaced by `bun test` as "5 unhandled errors between tests" while every assertion passed,
   * which is also the most plausible source of the intermittent full-suite failures that had been filed
   * as timing.
   *
   * Set by `killAll`, and checked before every write on the completion path. The rows are corrected on
   * the next boot by `interruptOrphaned`, which is exactly what that exists for.
   */
  private closed = false;

  /** `finish`, with the guarantee that it cannot throw into a promise nobody is holding. */
  private settle(id: string, exitCode: number | null, signal: string | null, oomKills?: number): void {
    try {
      this.finish(id, exitCode, signal, oomKills);
    } catch (err) {
      // A closed database during shutdown is the expected case. The row is corrected on the next boot by
      // `interruptOrphaned`, which is what that exists for.
      log.warn("could not record job completion", { job: id, error: String(err) });
    }
  }

  /**
   * Jobs somebody asked to stop. Their end is recorded as `killed` whatever code the process chose to die
   * with: `ssh` answers SIGTERM with exit 255, which read as a failure — four times in one evening an
   * agent stopped its own job and was woken by a ⚠️ notice demanding to know why it had failed.
   */
  private readonly stopping = new Set<string>();

  private finish(id: string, exitCode: number | null, signal: string | null, oomKills?: number): void {
    if (this.closed) return;
    const record = this.get(id);
    // Already resolved — a kill that raced the natural exit. First writer wins, same as approvals.
    if (!record || record.status !== "running") return;

    const stopped = this.stopping.has(id);
    const limitMs = this.expired.get(id);
    // Before the row is written: once the process is gone, its deadline must never signal that pid again.
    this.forget(id);
    // A stop the deadline made is `killed` too — `ssh` answers its SIGTERM with 255, a server often with 0.
    const status: JobStatus = signal || stopped || limitMs !== undefined ? "killed" : exitCode === 0 ? "succeeded" : "failed";
    this.markStatus(id, status, exitCode);

    log.info("background job finished", { job: id, status, exit_code: exitCode });
    this.options.audit?.record({
      action: "job_finished",
      agentId: record.agentId,
      details: { job: id, status, exit_code: exitCode },
    });

    const finished = this.get(id);
    const notify = this.onComplete ?? this.options.onComplete;
    if (!finished || !notify) return;

    // The tail is read before the callback so the wake-up message carries it, and a slow read cannot
    // leave the agent woken with nothing to look at.
    const stop: JobStop | undefined = limitMs !== undefined ? { by: "deadline", limitMs } : undefined;
    void this.tail(id)
      .then((tail) => notify({ job: finished, tail, ...(stop ? { stop } : {}), ...(oomKills ? { oomKills } : {}) }))
      .catch((err: unknown) => log.error("job completion notify failed", { id, error: String(err) }));
  }

  /**
   * The deadline came: the job is stopped as a person's `kill` stops it, and its end is recorded by `finish` once the
   * process is gone. A stop already under way is left to end as it was asked — whoever asked, asked first.
   */
  private expire(id: string, limitMs: number): void {
    if (this.closed || this.stopping.has(id)) return;
    const handle = this.handles.get(id);
    const record = handle ? this.get(id) : null;
    if (!handle || record?.status !== "running") return;
    this.expired.set(id, limitMs);
    log.warn("a background job ran for job_max_ms, stopping it", { job: id, agent_id: record.agentId, max_ms: limitMs });
    this.options.audit?.record({
      action: "job_deadline",
      agentId: record.agentId,
      gatewayId: record.gatewayId,
      chatId: record.chatId,
      details: { job: id, command: record.command, max_ms: limitMs },
    });
    this.halt(id, handle);
  }

  /**
   * SIGTERM to everything the job started, SIGKILL after the grace (`BackgroundHandle.stop`) — then, if its row still
   * says `running` once the grace has passed again with its process gone, settled anyway.
   *
   * `exited` waits for the pipes as well as the process. A descendant that left the job's group — `setsid`, a script
   * that daemonizes, `ssh -f` — and kept the output open held the row `running` for as long as the daemon lived: a
   * job slot taken, and an agent never woken. The process the job *is* has been stopped, and that is the stop; a
   * late exit after this changes nothing, because `finish` is first-writer-wins.
   */
  private halt(id: string, handle: BackgroundHandle): void {
    const grace = this.options.stopGraceMs;
    void handle.stop(grace).then(() => {
      if (!this.handles.has(id)) return;
      const check = setTimeout(
        contained(log, "could not settle a stopped job", () => {
          if (this.handles.has(id) && !isProcessAlive(handle.pid)) {
            log.warn("a stopped job's output is still held open by something it started, settling it", { job: id, pid: handle.pid });
            this.settle(id, null, "SIGKILL");
          }
        }, { job: id }),
        grace ?? 5_000,
      );
      check.unref?.();
    });
  }

  /** What is held in memory about a running job — let go once its row is settled. */
  private forget(id: string): void {
    this.handles.delete(id);
    this.services.delete(id);
    this.deadlines.clear(id);
    this.expired.delete(id);
    this.stopping.delete(id);
  }

  private markStatus(id: string, status: JobStatus, exitCode: number | null): void {
    this.options.db
      .prepare("UPDATE jobs SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?")
      .run(status, exitCode, this.now, id);
  }

  /**
   * Delete log files older than `days`, and the job rows that pointed at them.
   *
   * These were never deleted. A live install was found holding logs a week old, which was harmless
   * only because those jobs had been small — the mechanism exists so that a job which dumps six
   * gigabytes through `tee` is not a permanent one.
   *
   * Deleted by file mtime, not by the job's `ended_at`: the file is the thing taking up space, and a
   * job whose log is still being appended to has a recent mtime whatever its row says. A **running**
   * job is skipped outright — its writer has the file open, and removing it under a live process is
   * how you get a job that reports success into a file nobody can read.
   *
   * `0` disables the sweep rather than deleting everything, the same off position the other retention
   * knobs use.
   */
  sweepLogs(days: number, now: number = Date.now()): number {
    if (days <= 0) return 0;
    const cutoff = now - days * 24 * 60 * 60_000;
    let removed = 0;

    for (const row of this.options.db
      .prepare<{ id: string; log_path: string; status: string }>(
        "SELECT id, log_path, status FROM jobs WHERE status != 'running'",
      )
      .all()) {
      const stat = statFile(row.log_path);
      // No file left means the row is the only thing still pointing at one, and it should go too.
      if (stat && stat.mtimeMs >= cutoff) continue;
      if (stat) removePath(row.log_path);
      this.options.db.prepare("DELETE FROM jobs WHERE id = ?").run(row.id);
      removed += 1;
    }

    return removed;
  }

  private snapshot(job: JobRecord): JobSnapshot {
    const stat = statFile(job.logPath);
    return {
      ...job,
      logBytes: stat?.size ?? 0,
      logUpdatedAt: stat?.mtimeMs ?? null,
      // A helper or an ask has no process: alive is whether this daemon is running its turn.
      processAlive: job.status !== "running" ? null : job.kind !== "command" ? this.helpers.holds(job.id) : job.pid ? isProcessAlive(job.pid) : null,
      service: this.services.has(job.id),
    };
  }
}

function toRecord(row: Row): JobRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    gatewayId: row.gateway_id,
    chatId: row.chat_id,
    command: row.command,
    cwd: row.cwd,
    status: row.status as JobStatus,
    pid: row.pid,
    exitCode: row.exit_code,
    logPath: row.log_path,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    onComplete: row.on_complete,
    kind: row.kind === "helper" || row.kind === "ask" ? row.kind : "command",
    // One column, read by the row's kind: a helper's brief, or an ask's agent and task (`AskedWork`).
    brief: row.kind === "helper" ? parsed<HelperBrief>(row.brief) : null,
    ask: row.kind === "ask" ? parsed<AskedWork>(row.brief) : null,
    report: parsed<SubAgentHandoff>(row.report),
    turnId: row.turn_id,
    senderId: row.sender_id,
  };
}

/** A JSON column, or null when it is empty or unreadable — a row is still listed, without the part that would not parse. */
function parsed<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Background commands, as the daemon depends on it.
 *
 * Business logic takes this, never `JobStore` — see `Port` in `@nouride/shared` for why it is derived
 * from the class rather than hand-written, and what that does and does not buy.
 */
export type JobsPort = Port<JobStore>;

/**
 * `exec`'s way to start a job: its call, as `start` takes it.
 *
 * One for every toolset, the registry's shared `exec` and an agent's own. There were two, and the shared one dropped
 * `on_complete` — so an agent with no blocked patterns and no ask floor, which is most of them, was told its
 * instruction would run when the job finished, and it never did.
 */
export function startJobFor(jobs: Pick<JobsPort, "start">) {
  return (params: {
    argv: string[];
    cwd: string;
    ctx: { agentId: string; gatewayId: string; chatId: string; turnId?: string };
    env: Record<string, string>;
    agent?: string;
    onComplete?: string;
    service?: boolean;
    mask?: Record<string, string>;
    filter?: () => TextFilter;
  }): { id: string; logPath: string; limitMs: number } => {
    const job = jobs.start({
      agentId: params.ctx.agentId,
      gatewayId: params.ctx.gatewayId,
      chatId: params.ctx.chatId,
      ...(params.ctx.turnId ? { turnId: params.ctx.turnId } : {}),
      argv: params.argv,
      sandbox: { cwd: params.cwd, env: params.env, ...(params.agent ? { agent: params.agent } : {}) },
      ...(params.onComplete ? { onComplete: params.onComplete } : {}),
      ...(params.service ? { service: true } : {}),
      ...(params.mask ? { mask: params.mask } : {}),
      ...(params.filter ? { filter: params.filter } : {}),
    });
    return { id: job.id, logPath: job.logPath, limitMs: job.limitMs };
  };
}
