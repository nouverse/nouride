/**
 * Turns working in the background, as jobs — the half of `JobStore` that runs a turn rather than a process: a helper
 * `delegate` started (0.7.15), and another agent's turn an `ask_agent` moved there once it outlasted its wait (0.7.19).
 *
 * A helper `delegate` starts with `background: true` is a row of `jobs` like a command is, and everything a command's
 * row already does applies to it: `nouride jobs` lists it, `nouride jobs kill` and `/stop` stop it, `[security]
 * job_max_ms` bounds it, a restart closes it as interrupted (`JobStore.interruptOrphaned`), and its end wakes the agent
 * in the chat that started it. What is different is what runs: a turn of the agent's, in this process, stopped by an
 * abort rather than a signal — and what it ends with, a handoff rather than an exit code.
 *
 * An ask is the same row with another agent's turn in it. The row is the asking agent's — its limit counts it, its
 * `/stop` stops it, its chat is woken with the answer — and the turn was already running when it got one: it is adopted,
 * with the moment it was asked as its start, so `job_max_ms` bounds the whole of it.
 *
 * The turns themselves are the pipeline's (`pipeline/background-helper.ts`, `pipeline/background-ask.ts`); this keeps
 * the row, the handle, the limit and the log. Its log is the turn's steps as they happen, written as they happen —
 * which is what is left of it when the daemon dies under it, and what the agent is woken with then.
 */

import { agentReadableMode, join, openAppendFile, type AppendFile } from "@nouride/runtime";
import { createLogger, newId } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import { maskSecrets } from "@nouride/secrets";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { goalLine, sameGoal, type HelperBrief } from "@/modules/tools/builtins/delegate-brief.ts";
import type { JobDeadlines } from "./deadline.ts";
import type { AskedWork, JobCompletion, JobRecord, JobStatus, JobStop } from "./jobs.store.ts";

const log = createLogger("jobs.helpers");

/** How a helper's run ended, as the turn that ran it says. */
export interface HelperOutcome {
  /** What it hands back — how it ended, its report, the files it changed. */
  report: SubAgentHandoff;
  /**
   * Stopped at a step for a shutdown. Its row is left `running`, for the next boot to close as interrupted and wake its
   * agent with what it had done — the road every job a restart cuts off takes (`JobStore.interruptOrphaned`).
   */
  paused?: boolean;
}

/** What a helper's turn is given by the job it runs as. */
export interface RunningHelper {
  id: string;
  /** Aborted by a stop — `/stop`, `nouride jobs kill`, the deadline — and by a shutdown. */
  signal: AbortSignal;
  /** A line in its log, masked of the agent's credentials. */
  log: (line: string) => void;
}

export interface StartHelper {
  agentId: string;
  gatewayId: string;
  chatId: string;
  /** The workspace it works in. */
  cwd: string;
  brief: HelperBrief;
  /** The turn that started it, and the person that turn was answering. */
  turnId?: string;
  senderId: string;
  /** How many this agent may have running, read as it starts (`[delegate] max_background`) — helpers and asks together. */
  limit: number;
  /** The helper's turn. Resolves when it ends; throwing is a helper that failed. */
  run: (job: RunningHelper) => Promise<HelperOutcome>;
  /**
   * When it began, for one adopted already running: a helper in the foreground that outlasted `delegate`'s wait. Its job
   * is counted from then, as an ask's is, so `job_max_ms` bounds the whole of it.
   */
  startedAt?: number;
}

/**
 * An ask that outlasted its wait, taken into the background (0.7.19): the asking agent's row, with the other agent's turn
 * in it. `run` adopts that turn — it is already running — and `startedAt` is when it was asked.
 */
export interface StartAsk extends Omit<StartHelper, "brief" | "startedAt"> {
  ask: AskedWork;
  startedAt: number;
}

/** Started — or not, and what is running instead. */
export type HelperStart =
  | { started: JobRecord }
  | { refused: "limit"; running: JobRecord[]; limit: number }
  | { refused: "duplicate"; running: JobRecord };

/** A turn job's row as it starts: what `JobStore.insertHelper` writes. */
export interface HelperRow {
  id: string;
  agentId: string;
  gatewayId: string;
  chatId: string;
  command: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  kind: "helper" | "ask";
  /** What it was given — a helper's brief, an ask's agent and task — as the `brief` column keeps it. */
  given: HelperBrief | AskedWork;
  turnId?: string;
  senderId: string;
}

/** What one start writes, by its kind: the row's kind, what it was given, its line in the job list, and its log's first line. */
interface Work {
  kind: HelperRow["kind"];
  given: HelperRow["given"];
  command: string;
  says: string;
}

/** What `JobStore` shares with this half: its rows, its clock and its ways out. The SQL stays the store's. */
export interface HelperJobsDeps {
  rows: {
    insert: (row: HelperRow) => void;
    /** Its end: how it ended, and what it handed back. */
    settle: (id: string, status: JobStatus, report: SubAgentHandoff) => void;
    /** What one stopped for a restart had done, kept with its row — which stays `running` for the next boot to close. */
    keep: (id: string, report: SubAgentHandoff) => void;
  };
  logDirFor: (agentId: string) => string;
  get: (id: string) => JobRecord | null;
  /** This agent's helpers running now, oldest first. */
  running: (agentId: string) => JobRecord[];
  tail: (id: string) => Promise<string>;
  /** Once the store is closed — a shutdown — nothing is written: the next boot settles what was left. */
  closed: () => boolean;
  now: () => number;
  deadlines: JobDeadlines;
  /** `[security] job_max_ms`, read as a helper starts. */
  maxMs?: () => number;
  /** The agent's credentials, masked out of its helper's log. */
  secrets?: (agentId: string) => Record<string, string>;
  audit?: AuditPort;
  notify: () => ((completion: JobCompletion) => void) | undefined;
}

interface Handle {
  controller: AbortController;
  /** Settles when the run has ended and its row is written. */
  done: Promise<void>;
  file: AppendFile | null;
}

/** How long a stop waits for a helper's turn to notice its abort before the shutdown moves on. */
const STOP_GRACE_MS = 5_000;

export class HelperJobs {
  private readonly handles = new Map<string, Handle>();
  /** Helpers somebody asked to stop: recorded `killed`, however their turn ended. */
  private readonly stopping = new Set<string>();
  /** Helpers the deadline stopped, with the limit that applied. */
  private readonly expired = new Map<string, number>();

  constructor(private readonly deps: HelperJobsDeps) {}

  /** Whether this process is running the helper — what a stop needs, and what "alive" means for one. */
  holds(id: string): boolean {
    return this.handles.has(id);
  }

  /**
   * Start one — or refuse, with what is running instead.
   *
   * Synchronous from the count to the insert, so two `delegate` calls in one batch cannot both see room for one more.
   * The same goal already running is refused rather than started twice: the harness says to look before starting, and
   * this is what holds when a model did not. Not one adopted (`startedAt`): its work is under way already, and refusing
   * the move would only keep the person waiting on it.
   */
  start(params: StartHelper): HelperStart {
    const running = this.deps.running(params.agentId);
    const twin = params.startedAt === undefined ? running.find((job) => job.brief && sameGoal(job.brief, params.brief)) : undefined;
    if (twin) return { refused: "duplicate", running: twin };
    return this.begin(params, running, params.agentId, {
      kind: "helper",
      given: params.brief,
      command: `helper: ${goalLine(params.brief, 200)}`,
      says: goalLine(params.brief, 300),
    });
  }

  /**
   * Take an ask that outlasted its wait into the background — or refuse, with what is running instead, and the ask stays
   * where it was: waited on. Counted with the helpers, against the one limit the asking agent has. No twin to refuse:
   * the same agent asked twice in one chat is refused before it starts, while the first is still at work there.
   */
  startAsk(params: StartAsk): HelperStart {
    return this.begin(params, this.deps.running(params.agentId), params.ask.agent, {
      kind: "ask",
      given: params.ask,
      command: `ask ${params.ask.agent}: ${goalLine({ goal: params.ask.task }, 200)}`,
      says: `${params.agentId} asked ${params.ask.agent}: ${goalLine({ goal: params.ask.task }, 300)}`,
    });
  }

  /** The row, its log, its deadline and its turn — for either kind, once the limit has room. `worker` is who runs the turn. */
  private begin(params: Omit<StartHelper, "brief"> & { startedAt?: number }, running: JobRecord[], worker: string, work: Work): HelperStart {
    if (running.length >= params.limit) return { refused: "limit", running, limit: params.limit };

    const id = newId("job");
    const logPath = join(this.deps.logDirFor(params.agentId), `${id}.log`);
    const now = this.deps.now();
    const startedAt = params.startedAt ?? now;
    const { command } = work;
    this.deps.rows.insert({
      id,
      agentId: params.agentId,
      gatewayId: params.gatewayId,
      chatId: params.chatId,
      command,
      cwd: params.cwd,
      logPath,
      startedAt,
      kind: work.kind,
      given: work.given,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      senderId: params.senderId,
    });

    const controller = new AbortController();
    const file = openLog(logPath);
    // The credentials of whoever's steps these are: the agent's own, and — for an ask — the asked agent's as well.
    const secrets = worker === params.agentId ? this.deps.secrets?.(params.agentId) : { ...this.deps.secrets?.(params.agentId), ...this.deps.secrets?.(worker) };
    const write = (line: string): void => {
      try {
        file?.write(`${clock(this.deps.now())} ${secrets ? maskSecrets(line, secrets) : line}\n`);
      } catch (err) {
        log.debug("a helper's log line was not written", { job: id, error: String(err) });
      }
    };
    write(`started: ${work.says}`);

    // On the whole of the work: an ask adopted after a wait has been running since it was asked.
    const limitMs = this.deps.maxMs?.() ?? 0;
    if (limitMs > 0) this.deps.deadlines.arm(id, Math.max(0, limitMs - (now - startedAt)), () => this.expire(id, limitMs));

    this.deps.audit?.record({
      action: "job_started",
      agentId: params.agentId,
      gatewayId: params.gatewayId,
      chatId: params.chatId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      details: { job: id, command, ...(work.kind === "ask" ? { asked: worker } : { helper: true }) },
    });
    const said = work.kind === "ask" ? "an ask moved to the background" : params.startedAt === undefined ? "background helper started" : "a helper moved to the background";
    log.info(said, { job: id, agent_id: params.agentId, goal: work.says });

    // Not awaited — that is the point, as for a command. Everything it can throw is caught here, because nothing holds
    // this promise: a turn that threw is a helper that failed, and a settle that throws is a line in the log. Started
    // now, not a tick later, and a run that throws before it returns a promise is the same failure as one that rejects.
    let turn: Promise<HelperOutcome>;
    try {
      turn = params.run({ id, signal: controller.signal, log: write });
    } catch (err) {
      turn = Promise.reject(err);
    }
    const done = turn
      .catch((err: unknown): HelperOutcome => ({ report: failed(worker, startedAt, this.deps.now(), err) }))
      .then((outcome) => this.settle(id, outcome, write))
      .catch((err: unknown) => log.warn("could not record a helper's end", { job: id, error: String(err) }))
      .finally(() => {
        file?.close();
        this.forget(id);
      });
    this.handles.set(id, { controller, done, file });
    return { started: this.deps.get(id)! };
  }

  /** Stop one this process runs. False when it is not running here. */
  stop(id: string): boolean {
    const handle = this.handles.get(id);
    if (!handle) return false;
    this.stopping.add(id);
    handle.controller.abort("stopped");
    return true;
  }

  /**
   * Stop every one, for a shutdown — after the store is closed, so none of them writes a row: the next boot closes
   * them as interrupted. Waits a moment for each to notice, and no longer.
   */
  async stopAll(): Promise<number> {
    const handles = [...this.handles.values()];
    for (const handle of handles) handle.controller.abort("shutdown");
    await Promise.race([Promise.all(handles.map((handle) => handle.done)), new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS).unref?.())]);
    return handles.length;
  }

  /** The deadline came: stopped as a person's kill stops it, and recorded `killed` with why. */
  private expire(id: string, limitMs: number): void {
    const handle = this.handles.get(id);
    if (!handle || this.stopping.has(id) || this.deps.closed()) return;
    this.expired.set(id, limitMs);
    const record = this.deps.get(id);
    log.warn(`${what(record)} ran for job_max_ms, stopping it`, { job: id, agent_id: record?.agentId, max_ms: limitMs });
    this.deps.audit?.record({
      action: "job_deadline",
      ...(record ? { agentId: record.agentId, gatewayId: record.gatewayId, chatId: record.chatId } : {}),
      details: { job: id, command: record?.command, max_ms: limitMs },
    });
    handle.controller.abort("deadline");
  }

  /** Its end, written once: the row, the log's last lines, and the wake-up. */
  private async settle(id: string, outcome: HelperOutcome, write: (line: string) => void): Promise<void> {
    if (this.deps.closed()) return;
    const record = this.deps.get(id);
    // Already settled elsewhere — a `kill` from a previous daemon's row, say. First writer wins, as for a command.
    if (!record || record.status !== "running") return;
    const { report } = outcome;
    write(`${outcome.paused ? "stopped for a restart" : "ended"}: ${report.status}${report.reason ? ` (${report.reason})` : ""} · ${report.metrics.toolCalls} tool calls · ${report.metrics.steps} steps`);
    if (report.summary) write(`report:\n${report.summary}`);

    if (outcome.paused) {
      // What it did is kept with the row; its status is the next boot's to write (`interruptOrphaned`).
      this.deps.rows.keep(id, report);
      log.info(`${what(record)} stopped for a restart; the next boot reports it`, { job: id });
      return;
    }

    const limitMs = this.expired.get(id);
    const status: JobStatus = this.stopping.has(id) || limitMs !== undefined ? "killed" : report.status === "success" ? "succeeded" : "failed";
    this.deps.deadlines.clear(id);
    this.deps.rows.settle(id, status, report);
    log.info(`${what(record)} finished`, { job: id, status, handoff: report.status });
    this.deps.audit?.record({
      action: "job_finished",
      agentId: record.agentId,
      details: { job: id, status, ...(record.ask ? { asked: record.ask.agent } : { helper: true }), handoff: report.status },
    });

    const finished = this.deps.get(id);
    const notify = this.deps.notify();
    if (!finished || !notify) return;
    const stop: JobStop | undefined = limitMs !== undefined ? { by: "deadline", limitMs } : undefined;
    notify({ job: finished, tail: await this.deps.tail(id), ...(stop ? { stop } : {}) });
  }

  private forget(id: string): void {
    this.handles.delete(id);
    this.stopping.delete(id);
    this.expired.delete(id);
    this.deps.deadlines.clear(id);
  }
}

/** What a turn job is, as its log lines name it. */
function what(record: Pick<JobRecord, "kind"> | null): string {
  return record?.kind === "ask" ? "an ask in the background" : "a background helper";
}

/** The log, created as it is opened and readable by the daemon and its agent alone (`agentReadableMode`) — what a helper reads can be anything. */
function openLog(path: string): AppendFile | null {
  try {
    return openAppendFile(path, agentReadableMode());
  } catch (err) {
    log.warn("a background helper's log could not be opened, so it runs without one", { path, error: String(err) });
    return null;
  }
}

/** `HH:MM:SS`, the moment a line was written. */
function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 19);
}

/** A run that threw: failed, with what it said, as a handoff — the shape every helper hands back. */
function failed(agentId: string, startedAt: number, now: number, err: unknown): SubAgentHandoff {
  return {
    agentId,
    status: "failed",
    summary: "",
    files: [],
    spills: [],
    metrics: { toolCalls: 0, steps: 0, ms: Math.max(0, now - startedAt) },
    reason: err instanceof Error ? err.message : String(err),
  };
}
