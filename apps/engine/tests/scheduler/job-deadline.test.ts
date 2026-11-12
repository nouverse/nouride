/**
 * `[security] job_max_ms`: a background job still running after it is stopped, and its agent is told it did not
 * finish — not that it failed, and not that somebody chose to stop it.
 *
 * The processes here are portable on purpose: `bun run verify` runs on macOS, where a job has no process group of
 * its own and a stop reaches the direct child only. What only Linux can show — the stop reaching a grandchild — is
 * the one test under `skipIf`, and CI runs it on every release branch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isProcessAlive, removePath, type SqliteDb } from "@nouride/runtime";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { AuditLog } from "@/commons/audit.store.ts";
import { openAndMigrate } from "@/db/index.ts";
import { JobDeadlines } from "@/modules/jobs/deadline.ts";
import { JobStore, startJobFor, type JobCompletion, type JobRecord } from "@/modules/jobs/jobs.store.ts";
import { jobFailureNotice, jobReportRequirement, jobWakeMessage } from "@/modules/jobs/wake-text.ts";
import { jobStarted } from "@/modules/tools/builtins/exec-started.ts";
import { tempDir } from "../helpers.ts";
import { eventually, sleep } from "../wait.ts";

let dir: string;
let db: SqliteDb;
const strays: number[] = [];

beforeEach(async () => {
  dir = tempDir("job-deadline");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  db.close();
  removePath(dir);
});

const WHERE = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" };
/** A process that answers SIGTERM by exiting 255, as `ssh` does — the stop the deadline exists for. */
const LIKE_SSH = ["sh", "-c", "trap 'exit 255' TERM; while :; do sleep 0.1; done"];
/**
 * A single process that ignores SIGTERM, so only the SIGKILL after the grace ends it. Portable: no group needed. The
 * shell ignores the signal before it becomes `sleep`, which keeps it ignored. It was a script that set its own handler
 * once it ran: on a busy machine the deadline's SIGTERM came before it had, and ended it at once.
 */
const DEAF = ["sh", "-c", "trap '' TERM; exec sleep 30"];

/**
 * Deadlines reached when the test says, not after a time. For a job that must have done something before it is
 * stopped: one that boots a runtime first took longer than any short deadline on a busy machine, and was stopped
 * before it had.
 */
class HeldDeadlines extends JobDeadlines {
  private readonly held: (() => void)[] = [];
  override arm(_id: string, _ms: number, onExpire: () => void): void {
    this.held.push(onExpire);
  }
  reach(): void {
    for (const expire of this.held.splice(0)) expire();
  }
}

function store(maxMs: number, options: { audit?: AuditLog; deadlines?: JobDeadlines; graceMs?: number } = {}) {
  return new JobStore({
    db,
    logDir: join(dir, "logs"),
    maxConcurrentPerAgent: 4,
    maxMs: () => maxMs,
    stopGraceMs: options.graceMs ?? 300,
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.deadlines ? { deadlines: options.deadlines } : {}),
  });
}

function run(s: JobStore, argv: string[], extra: { service?: boolean; onComplete?: string } = {}) {
  return s.start({ ...WHERE, argv, sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } }, ...extra });
}

function completed(s: JobStore): Promise<JobCompletion> {
  return new Promise((resolve) => s.setOnComplete(resolve));
}


describe("the timers", () => {
  test("fire once, unless cleared; arming again replaces; clearing all leaves none", async () => {
    const deadlines = new JobDeadlines();
    const fired: string[] = [];
    deadlines.arm("a", 20, () => fired.push("a"));
    deadlines.arm("b", 20, () => fired.push("b"));
    deadlines.arm("b", 60, () => fired.push("b again"));
    deadlines.clear("a");
    expect(deadlines.pending()).toBe(1);
    await sleep(100);
    expect(fired).toEqual(["b again"]);
    expect(deadlines.pending()).toBe(0);

    deadlines.arm("c", 1_000, () => fired.push("c"));
    deadlines.clearAll();
    expect(deadlines.pending()).toBe(0);
  });

  test("one whose expiry throws is logged with its job, and the others still fire", async () => {
    // Out of a timer a throw is an uncaught exception, and the daemon shuts down on one (`boot/shutdown.ts`) — bun
    // fails this test on one. The row read as a deadline comes due is a database read like any other.
    const errors: LogEntry[] = [];
    addLogSink((entry) => void (entry.message === "a background job's deadline could not stop it" && errors.push(entry)));
    const deadlines = new JobDeadlines();
    const fired: string[] = [];
    deadlines.arm("job_a", 10, () => {
      throw new Error("Cannot use a closed database");
    });
    deadlines.arm("job_b", 30, () => fired.push("job_b"));
    await sleep(80);
    expect(fired).toEqual(["job_b"]);
    expect(deadlines.pending()).toBe(0);
    expect(errors.map((line) => [line.component, line.data?.job, line.data?.error])).toEqual([["jobs", "job_a", "Error: Cannot use a closed database"]]);
  });
});

describe("a job that runs past job_max_ms", () => {
  test("is stopped and recorded killed — though, like ssh, it answers SIGTERM with exit 255 — with the reason on its completion", async () => {
    const audit = new AuditLog(db);
    const s = store(300, { audit });
    const done = completed(s);
    const started = Date.now();
    const job = run(s, LIKE_SSH);
    expect(job.limitMs).toBe(300);

    const { job: finished, stop } = await done;
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(finished.status).toBe("killed");
    expect(stop).toEqual({ by: "deadline", limitMs: 300 });
    expect(audit.ofActions(["job_deadline"]).map((entry) => entry.details)).toEqual([{ job: job.id, command: LIKE_SSH.join(" "), max_ms: 300 }]);
  }, 10_000);

  test("is killed after the grace when it ignores SIGTERM", async () => {
    const s = store(200, { graceMs: 300 });
    const done = completed(s);
    const started = Date.now();
    run(s, DEAF);
    const { job, stop } = await done;
    expect(job.status).toBe("killed");
    expect(stop?.by).toBe("deadline");
    // The deadline, then the whole grace — the SIGTERM did nothing.
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  }, 10_000);

  test("is settled even when something it started left its group and holds the output open", async () => {
    // `exited` waits for the pipes; a detached grandchild keeps them, so the row used to say `running` for as long
    // as the daemon lived — a slot taken, and an agent never woken.
    const escapes = [
      process.execPath,
      "-e",
      "const c = require('child_process').spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); console.log('escaped ' + c.pid); setInterval(() => {}, 1000)",
    ];
    // The deadline is reached once the job has started what escapes, never before: with 300 ms from its start, a busy
    // machine stopped the job while its runtime was still loading, and nothing had escaped to hold the output.
    const deadlines = new HeldDeadlines();
    const s = store(300, { graceMs: 300, deadlines });
    const done = completed(s);
    const job = run(s, escapes);
    // What it printed, once it has: a fixed 150 ms read nothing on a busy machine, and the test failed on NaN.
    let log = "";
    await eventually(() => /escaped \d+/.test((log = existsSync(job.logPath) ? readFileSync(job.logPath, "utf8") : "")), 8_000, "the job to say what escaped");
    const escaped = Number(/escaped (\d+)/.exec(log)?.[1]);
    if (escaped) strays.push(escaped);
    expect(isProcessAlive(escaped)).toBe(true);
    deadlines.reach();

    const { job: finished, stop } = await done;
    expect(finished.status).toBe("killed");
    expect(stop?.by).toBe("deadline");
    expect(escaped).toBeGreaterThan(0);
  }, 15_000);

  test.skipIf(process.platform !== "linux")("reaches what the job started, not only the job (Linux: a process group of its own)", async () => {
    const s = store(300, { graceMs: 300 });
    const done = completed(s);
    const job = run(s, ["sh", "-c", "sleep 30 & echo $!; wait"]);
    let log = "";
    await eventually(() => /^\d+/.test((log = existsSync(job.logPath) ? readFileSync(job.logPath, "utf8") : "")), 4_000, "the job to print its child");
    const grandchild = Number(log.trim());
    strays.push(grandchild);
    expect(isProcessAlive(grandchild)).toBe(true);
    await done;
    await eventually(() => !isProcessAlive(grandchild), 4_000, "the grandchild to be stopped with its job");
  }, 10_000);
});

describe("what the deadline leaves alone", () => {
  test("a service: it is meant to run until stopped", async () => {
    const deadlines = new JobDeadlines();
    const s = store(200, { deadlines });
    const job = run(s, ["sleep", "5"], { service: true });
    expect(job.limitMs).toBe(0);
    expect(deadlines.pending()).toBe(0);
    await sleep(500);
    expect(s.get(job.id)?.status).toBe("running");
    expect(s.isService(job.id)).toBe(true);
    expect(s.getSnapshot(job.id)?.service).toBe(true);

    const done = completed(s);
    s.kill(job.id, "test");
    await done;
    expect(s.isService(job.id)).toBe(false);
  }, 10_000);

  test("every job, when it is 0", async () => {
    const deadlines = new JobDeadlines();
    const s = store(0, { deadlines });
    const job = run(s, ["sleep", "5"]);
    expect(job.limitMs).toBe(0);
    expect(deadlines.pending()).toBe(0);
    const done = completed(s);
    s.kill(job.id, "test");
    await done;
  });

  test("a job that ends in time — and its timer is gone with it", async () => {
    const deadlines = new JobDeadlines();
    const s = store(5_000, { deadlines });
    const done = completed(s);
    run(s, ["sleep", "0.1"]);
    expect(deadlines.pending()).toBe(1);
    const { job, stop } = await done;
    expect(job.status).toBe("succeeded");
    expect(stop).toBeUndefined();
    expect(deadlines.pending()).toBe(0);
  });

  test("a stop somebody asked for first: it ends as theirs, and the deadline in its grace does nothing", async () => {
    const audit = new AuditLog(db);
    const s = store(300, { audit, graceMs: 1_000 });
    const done = completed(s);
    const job = run(s, DEAF);
    await sleep(100);
    s.kill(job.id, "cli");
    const { job: finished, stop } = await done;
    expect(finished.status).toBe("killed");
    expect(stop).toBeUndefined();
    expect(audit.ofActions(["job_deadline"])).toEqual([]);
  }, 10_000);

  test("a shutdown: no deadline outlives killAll", async () => {
    const deadlines = new JobDeadlines();
    const s = store(60_000, { deadlines });
    run(s, ["sleep", "5"]);
    expect(deadlines.pending()).toBe(1);
    await s.killAll();
    expect(deadlines.pending()).toBe(0);
  });
});

describe("how it is said", () => {
  const job: JobRecord = {
    id: "job_9",
    agentId: "nouva",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    command: "ssh gpu ./train.sh",
    cwd: "/tmp",
    status: "killed",
    pid: 7,
    exitCode: 255,
    logPath: "/tmp/job_9.log",
    startedAt: 0,
    endedAt: 3_605_000,
    onComplete: null,
    kind: "command",
    brief: null,
    ask: null,
    report: null,
    turnId: null,
    senderId: null,
  };
  const deadline = { job, tail: "epoch 3/10\nepoch 4/10", stop: { by: "deadline" as const, limitMs: 3_600_000 } };

  test("the daemon's own line: the limit, that it had not finished, and where the output ends", () => {
    expect(jobFailureNotice(deadline)).toBe(
      "⏱️ Background job job_9 was stopped after 1h 0m, this install's limit for a background job (`[security] job_max_ms`). It had not finished.\n`ssh gpu ./train.sh`\n(output ends at) epoch 4/10",
    );
  });

  test("the wake-up: the limit and that it did not finish — not a failure, not a retry, and silence is not allowed", () => {
    const text = jobWakeMessage(deadline);
    expect(text).toContain("Background job job_9 was stopped by the daemon after 1h 0m, this install's limit for a background job (`[security] job_max_ms`), before it finished: `ssh gpu ./train.sh`");
    expect(text).toContain("Do not simply run it again: it would be stopped at the same limit.");
    expect(text).toContain("start it with `service: true`");
    expect(text).not.toMatch(/failed with|did NOT succeed|retry once|reply with only "\."|after 3605s/);
    expect(jobReportRequirement(deadline)).toContain("did NOT finish");
  });

  test("an on_complete instruction is not acted on — the work it was for did not get done", () => {
    const withInstruction = { ...deadline, job: { ...job, onComplete: "deploy it to prod" } };
    const text = jobWakeMessage(withInstruction);
    expect(text).toContain('Its instruction for when it finished ("deploy it to prod") does not apply: it did not finish.');
    expect(text).not.toContain("Instruction for this completion");
    // Owed though the job had an instruction — an ordinary `on_complete` job owes nothing.
    expect(jobReportRequirement(withInstruction)).not.toBeNull();
  });

  test("a stop somebody chose still reads as theirs", () => {
    const chosen = { job, tail: "" };
    expect(jobWakeMessage(chosen)).toContain("Background job job_9 was stopped after 3605s");
    expect(jobFailureNotice(chosen)).toBeNull();
    expect(jobReportRequirement(chosen)).toBeNull();
  });

  test("exec says the limit as the job starts — and says nothing of one that is not there", () => {
    const base = { argv: ["make"], cwd: "/tmp", keepWorking: false, requested: true };
    const limited = jobStarted({ ...base, job: { id: "job_1", logPath: "/tmp/1.log", limitMs: 7_200_000 }, service: false });
    expect(limited.content).toContain("If it is still running after 2h 0m, the daemon stops it (this install's `job_max_ms`) and you are told it did not finish.");
    const working = jobStarted({ ...base, keepWorking: true, job: { id: "job_1", logPath: "/tmp/1.log", limitMs: 7_200_000 }, service: false });
    expect(working.content).toContain("after 2h 0m, the daemon stops it");
    for (const unlimited of [
      jobStarted({ ...base, job: { id: "job_1", logPath: "/tmp/1.log", limitMs: 0 }, service: false }),
      jobStarted({ ...base, job: { id: "job_1", logPath: "/tmp/1.log", limitMs: 7_200_000 }, service: true }),
    ]) {
      expect(unlimited.content).not.toContain("job_max_ms");
    }
  });
});

describe("exec's way in", () => {
  test("one adapter for every toolset, and it carries on_complete — the shared exec's copy dropped it", () => {
    const asked: unknown[] = [];
    const start = startJobFor({
      start: (params) => (asked.push(params), { id: "job_1", logPath: "/tmp/1.log", limitMs: 60_000 } as JobRecord & { limitMs: number }),
    });
    const ctx = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" };
    expect(start({ argv: ["make"], cwd: "/w", ctx, env: { A: "1" }, onComplete: "deploy", service: true })).toEqual({ id: "job_1", logPath: "/tmp/1.log", limitMs: 60_000 });
    expect(asked).toEqual([{ ...ctx, argv: ["make"], sandbox: { cwd: "/w", env: { A: "1" } }, onComplete: "deploy", service: true }]);
  });
});
