/**
 * Background jobs — work that outlives a turn.
 *
 * The gap this closes is the one foundational difference from Claude Code, and it was a *shape* rather
 * than a missing tool: every `exec` blocked its turn, capped at 300s, which is the same value as
 * `max_turn_duration_ms` — so a five-minute command could never use its own budget before the turn
 * killed it. Two limits that had never been compared against each other.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, utimesSync } from "node:fs";
import { ensureDir, removePath, statFile, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { jobLimits } from "@/modules/jobs/job-spawn.ts";
import { JobStore, type JobCompletion } from "@/modules/jobs/jobs.store.ts";
import { jobWakeMessage } from "@/modules/jobs/wake-text.ts";
import { tempDir } from "../helpers.ts";
import { eventually, sleep } from "../wait.ts";

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
  dir = tempDir("jobs");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  removePath(dir);
});

function store(options: { maxConcurrentPerAgent?: number; secrets?: Record<string, string>; maxMemoryMb?: number } = {}) {
  return new JobStore({
    db,
    logDir: join(dir, "logs"),
    maxConcurrentPerAgent: options.maxConcurrentPerAgent ?? 4,
    ...(options.secrets ? { secrets: () => options.secrets! } : {}),
    ...(options.maxMemoryMb ? { limits: () => ({ maxMemoryMb: options.maxMemoryMb }) } : {}),
  });
}

const WHERE = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" };

function run(s: JobStore, argv: string[]) {
  return s.start({ ...WHERE, argv, sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } } });
}

/** Wait for the wake-up rather than for a duration — a sleep here is a flaky test on a slow machine. */
function waitForCompletion(s: JobStore): Promise<JobCompletion> {
  return new Promise((resolve) => s.setOnComplete(resolve));
}

describe("starting a job", () => {
  test("returns immediately, before the command finishes", async () => {
    const s = store();
    const started = Date.now();
    const job = run(s, ["sleep", "1"]);

    // The whole point: the call returns in milliseconds while the work takes a second.
    expect(Date.now() - started).toBeLessThan(500);
    expect(job.status).toBe("running");
    expect(job.pid).toBeGreaterThan(0);

    s.kill(job.id, "test");
  });

  test("keeps the turn it was started in, so an asked agent's job finds the agent that asked (nouride-releases#10)", async () => {
    const s = store();
    const done = waitForCompletion(s);
    const job = s.start({ ...WHERE, agentId: "nox", turnId: "turn_nouva", argv: ["true"], sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } } });
    expect((await done).job.turnId).toBe("turn_nouva");
    expect(s.get(job.id)?.turnId).toBe("turn_nouva");
  });

  test("records it as running, visible to the concurrency check", () => {
    const s = store();
    const job = run(s, ["sleep", "2"]);
    expect(s.running("nouva").map((j) => j.id)).toContain(job.id);
    s.kill(job.id, "test");
  });

  test("a cap is refused, not queued", () => {
    // Silently queueing would make `background: true` behave like a foreground call at the worst
    // possible moment — the agent would appear to have started something that had not started.
    const s = store({ maxConcurrentPerAgent: 1 });
    const first = run(s, ["sleep", "2"]);
    expect(() => run(s, ["sleep", "3"])).toThrow(/limit 1/);
    s.kill(first.id, "test");
  });

  test("refuses an identical running job instead of starting a second copy", () => {
    const s = store();
    const first = run(s, ["sleep", "2"]);

    expect(() => run(s, ["sleep", "2"])).toThrow(new RegExp(first.id));
    expect(s.running("nouva").map((job) => job.id)).toEqual([first.id]);

    s.kill(first.id, "test");
  });

  test("a row that says running with no process behind it does not block the command forever", () => {
    // `interruptOrphaned` covers a restart, but within one daemon lifetime a row can outlive its
    // process — a missed exit event, a child SIGKILLed from outside, a completion handler that threw.
    // The duplicate guard then refuses that one exact command for the rest of the process, telling the
    // operator to wait for something that finished long ago.
    const s = store();
    const stale = run(s, ["sleep", "2"]);

    // The row still claims a live process; the pid points at nothing. `kill(0)` is what settles it.
    db.prepare("UPDATE jobs SET pid = ? WHERE id = ?").run(2_147_483_600, stale.id);

    const replacement = run(s, ["sleep", "2"]);
    expect(replacement.id).not.toBe(stale.id);

    // And the list stops lying: the phantom is reconciled rather than left as a second "running" row.
    expect(s.running("nouva").map((job) => job.id)).toEqual([replacement.id]);
    expect(s.get(stale.id)?.status).toBe("interrupted");

    s.kill(replacement.id, "test");
  });

  test("the cap is per agent, not global", () => {
    const s = store({ maxConcurrentPerAgent: 1 });
    const mine = run(s, ["sleep", "2"]);
    const theirs = s.start({
      ...WHERE,
      agentId: "nox",
      argv: ["sleep", "2"],
      sandbox: { cwd: dir, env: {} },
    });
    expect(theirs.status).toBe("running");
    s.kill(mine.id, "test");
    s.kill(theirs.id, "test");
  });

  test("allows the same command in a different directory", () => {
    const s = store();
    const first = run(s, ["sleep", "2"]);
    const otherDir = join(dir, "other");
    ensureDir(otherDir);
    const second = s.start({
      ...WHERE,
      argv: ["sleep", "2"],
      sandbox: { cwd: otherDir, env: { PATH: process.env.PATH ?? "" } },
    });

    expect(second.status).toBe("running");

    s.kill(first.id, "test");
    s.kill(second.id, "test");
  });

  test("a snapshot reports log growth and whether the process is still alive", async () => {
    const s = store();
    const job = run(s, ["sh", "-c", "echo started; sleep 1"]);
    /**
     * Polled, not slept. This was `setTimeout(25)` and it failed twice on a loaded machine — a child
     * process getting its first line to disk is not something 25 milliseconds can be promised, and a
     * flake here reads as a broken snapshot rather than a busy laptop.
     *
     * The deadline is generous because it only bounds the failure case: a healthy run leaves this
     * loop on the first or second pass.
     */
    const deadline = Date.now() + 5_000;
    let snapshot = s.getSnapshot(job.id);
    while ((snapshot?.logBytes ?? 0) === 0 && Date.now() < deadline) {
      await sleep(10);
      snapshot = s.getSnapshot(job.id);
    }

    expect(snapshot?.processAlive).toBe(true);
    expect(snapshot?.logBytes).toBeGreaterThan(0);
    expect(snapshot?.logUpdatedAt).not.toBeNull();

    s.kill(job.id, "test");
    await waitForCompletion(s);
    expect(s.getSnapshot(job.id)?.processAlive).toBeNull();
  });
});

describe("finishing", () => {
  test("a successful job reports succeeded and wakes the caller", async () => {
    const s = store();
    const woken = waitForCompletion(s);
    run(s, ["sh", "-c", "echo done"]);

    const completion = await woken;
    expect(completion.job.status).toBe("succeeded");
    expect(completion.job.exitCode).toBe(0);
    expect(completion.tail).toContain("done");
  });

  test("a failing job carries its exit code", async () => {
    const s = store();
    const woken = waitForCompletion(s);
    run(s, ["sh", "-c", "echo bad >&2; exit 3"]);

    const completion = await woken;
    expect(completion.job.status).toBe("failed");
    expect(completion.job.exitCode).toBe(3);
    // stderr is interleaved into the same log: the ordering a person expects from a terminal is the
    // ordering that makes a failure readable.
    expect(completion.tail).toContain("bad");
  });

  test("output goes to a file, not memory", async () => {
    // A build log is megabytes. Holding it until someone asks would let one runaway command exhaust
    // the daemon, and a file is something the agent can `read` with an offset like any other.
    const s = store();
    const woken = waitForCompletion(s);
    const job = run(s, ["sh", "-c", "echo persisted"]);
    await woken;

    expect(await s.tail(job.id)).toContain("persisted");
    expect(s.get(job.id)?.logPath).toContain(job.id);
  });

  test("a credential the command prints never reaches the file — not even split across two writes (S5)", async () => {
    // The agent can `read` the log whole; masking it only when a wake-up quoted the tail left the value on disk.
    const s = store({ secrets: { API_TOKEN: "sk-live-0123456789abcdef" } });
    const woken = waitForCompletion(s);
    const job = run(s, ["sh", "-c", "printf 'key: sk-live-01234'; sleep 0.3; printf '56789abcdef in use\\n'; echo sk-live-0123456789abcdef >&2"]);
    await woken;

    const written = readFileSync(s.get(job.id)!.logPath, "utf8");
    expect(written).not.toContain("sk-live");
    expect(written).toContain("key: [REDACTED:API_TOKEN] in use");
  });

  test.skipIf(process.platform !== "linux")("and it runs under the ceilings a foreground command gets (S5)", async () => {
    // `dd` mallocs its 128 MB block up front, so a 64 MB address-space ceiling stops it at once.
    const s = store({ maxMemoryMb: 64 });
    const woken = waitForCompletion(s);
    run(s, ["dd", "if=/dev/zero", "of=/dev/null", "bs=128M", "count=1"]);
    expect((await woken).job.status).toBe("failed");
  });

  test("each agent's logs are in a directory of its own", async () => {
    // A log is written by the child itself, unmasked, and the log directory is a read-only root for the
    // agent's turns. Shared, any agent could read the credentials another agent's commands were given.
    const s = store();
    const woken = waitForCompletion(s);
    const job = run(s, ["sh", "-c", "echo mine"]);
    await woken;

    const nouva = s.logDirFor("nouva");
    const nix = s.logDirFor("nix");
    expect(s.get(job.id)?.logPath.startsWith(`${nouva}/`)).toBe(true);
    expect(nouva.startsWith(nix) || nix.startsWith(nouva)).toBe(false);
    expect(s.logDirFor("../nouva")).not.toContain("..");
  });

  test("a killed job is killed, not failed", async () => {
    // Different causes need different words: the operator stopped this one, nothing went wrong.
    const s = store();
    const woken = waitForCompletion(s);
    const job = run(s, ["sleep", "30"]);

    expect(s.kill(job.id, "test")).toBe(true);
    expect((await woken).job.status).toBe("killed");
  });

  test("killing an already-finished job changes nothing", async () => {
    const s = store();
    const woken = waitForCompletion(s);
    const job = run(s, ["sh", "-c", "true"]);
    await woken;

    expect(s.kill(job.id, "test")).toBe(false);
    expect(s.get(job.id)?.status).toBe("succeeded");
  });
});

describe("listing", () => {
  test("a hundred at most when counted; every row retention left when asked for all (0.8.12)", () => {
    // Helpers & jobs stopped at a hundred where the box held 123; `[retention] job_log_days` bounds the rest.
    const s = store();
    const insert = db.prepare(
      `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, exit_code, log_path, started_at, ended_at)
       VALUES (?, 'nouva', 'telegram:main', 'chat-1', 'true', ?, 'succeeded', 0, ?, ?, ?)`,
    );
    for (let i = 0; i < 123; i++) insert.run(`job_many_${i}`, dir, join(dir, "logs", `many-${i}.log`), 1_000 + i, 2_000 + i);
    expect(s.list({ limit: 500 })).toHaveLength(100);
    expect(s.list({ all: true }).filter((job) => job.id.startsWith("job_many_"))).toHaveLength(123);
    db.prepare("DELETE FROM jobs WHERE id LIKE 'job_many_%'").run();
  });
});

describe("a job's ceilings (S5)", () => {
  test("the operator's, as a foreground command has them — and no CPU seconds for a server, whose CPU adds up by running", () => {
    expect(jobLimits({ maxMemoryMb: 512, maxCpuSeconds: 600 }, false)).toEqual({ memoryMb: 512, cpuSeconds: 600 });
    expect(jobLimits({ maxMemoryMb: 512, maxCpuSeconds: 600 }, true)).toEqual({ memoryMb: 512, cpuSeconds: 0 });
    expect(jobLimits(undefined, false)).toEqual({ memoryMb: 0, cpuSeconds: 0 });
  });
});

describe("stopping a job", () => {
  test("is recorded as killed, whatever code the process chose to die with", async () => {
    // `ssh` answers SIGTERM with exit 255. Recorded as a failure, it posted a ⚠️ notice and woke the
    // agent to explain why a job it had just stopped itself had failed — four times in one evening.
    const s = store();
    const woken = waitForCompletion(s);
    const job = run(s, ["sh", "-c", "trap 'exit 255' TERM; while :; do sleep 0.1; done"]);
    await sleep(200);
    s.kill(job.id, "cli");

    const completion = await woken;
    expect(completion.job.status).toBe("killed");
    expect(jobWakeMessage(completion)).toContain("was stopped");
  });
});

describe("a restart", () => {
  test("marks previously running jobs interrupted", () => {
    // Their processes died with the daemon. Leaving them `running` shows a job list that lies and an
    // agent waiting on a wake-up that can never arrive.
    db.prepare(
      `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at)
       VALUES ('job_old', 'nouva', 'telegram:main', 'chat-1', 'sleep 999', '/tmp', 'running', '/tmp/x.log', 1)`,
    ).run();

    // Returns the rows it touched, not a count: fixing the row is not the same as telling the person,
    // and the caller needs the records to wake anybody. See `reportInterrupted`.
    const orphaned = store().interruptOrphaned();
    expect(orphaned.map((job) => job.id)).toEqual(["job_old"]);
    expect(store().get("job_old")?.status).toBe("interrupted");

    /**
     * And the returned record says so too — which for a long time it did not.
     *
     * The rows are read before the update, necessarily. They were also *returned* that way, still
     * saying `running`, and `reportInterrupted` hands them straight to the wake-up. Everything
     * downstream tests for `failed` or `interrupted`, so a 41-minute clone killed by a restart was
     * announced as "failed with exit code unknown after 0s", posted no notice, and left the agent
     * owing nothing. This assertion is the difference, and the old test asserted the row instead —
     * which was true the whole time.
     */
    expect(orphaned[0]?.status).toBe("interrupted");
    expect(orphaned[0]?.endedAt).toBeGreaterThan(0);
  });

  test("leaves finished jobs alone", () => {
    db.prepare(
      `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, exit_code, log_path, started_at, ended_at)
       VALUES ('job_done', 'nouva', 'telegram:main', 'chat-1', 'true', '/tmp', 'succeeded', 0, '/tmp/x.log', 1, 2)`,
    ).run();

    expect(store().interruptOrphaned()).toEqual([]);
    expect(store().get("job_done")?.status).toBe("succeeded");
  });

  test("killing a job with no live handle corrects the row instead of lying", () => {
    // The pid belonged to a previous daemon — or worse, to something unrelated that has since reused
    // the number, which is why `kill` never signals a pid it does not hold a handle for.
    db.prepare(
      `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, pid, log_path, started_at)
       VALUES ('job_ghost', 'nouva', 'telegram:main', 'chat-1', 'sleep 999', '/tmp', 'running', 999999, '/tmp/x.log', 1)`,
    ).run();

    const s = store();
    expect(s.kill("job_ghost", "test")).toBe(true);
    expect(s.get("job_ghost")?.status).toBe("interrupted");
  });
});

describe("jobWakeMessage", () => {
  const base = {
    id: "job_1",
    agentId: "nouva",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    command: "bun test",
    cwd: "/srv/app",
    pid: 1,
    logPath: "/data/jobs/job_1.log",
    startedAt: 1000,
    endedAt: 9000,
    onComplete: null,
    kind: "command" as const,
    brief: null,
    ask: null,
    report: null,
    turnId: null,
    senderId: null,
  };

  test("says what happened, how long it took, and where the log is", () => {
    const text = jobWakeMessage({
      job: { ...base, status: "succeeded", exitCode: 0 },
      tail: "42 pass",
    });
    expect(text).toContain("finished successfully");
    expect(text).toContain("8s");
    expect(text).toContain("bun test");
    expect(text).toContain("/data/jobs/job_1.log");
    expect(text).toContain("42 pass");
  });

  test("a failure names the exit code", () => {
    const text = jobWakeMessage({ job: { ...base, status: "failed", exitCode: 1 }, tail: "" });
    expect(text).toContain("exit code 1");
    expect(text).toContain("(no output)");
  });

  test("tells the agent not to re-run it unasked", () => {
    // Otherwise a failing build becomes a loop: woken, sees a failure, runs it again, woken again.
    const text = jobWakeMessage({ job: { ...base, status: "failed", exitCode: 1 }, tail: "" });
    expect(text).toMatch(/[Dd]o not re-run/);
  });

  test("reads as an event, not as a person speaking", () => {
    // It enters the conversation as a message, so it has to be unmistakably the runtime talking.
    //
    // The opening line is now explicit about it. "[Background job …]" was not enough on its own: the
    // model still answered conversationally — "Aman Gading, … ada hal lain yang bisa dibantu?" — a
    // reply to a message nobody had sent. Saying *nobody is waiting on a reply* is what changed it.
    const text = jobWakeMessage({ job: { ...base, status: "succeeded", exitCode: 0 }, tail: "" });
    expect(text.startsWith("[System event")).toBe(true);
    expect(text).toContain("Nobody is waiting on a reply");
    expect(text).toContain("Background job");
  });

  test("permits silence when output adds nothing new", () => {
    // Seen live: the agent killed a dev server, reported it, and then the job's own completion made it
    // report the same thing again as though asked. The fix: if you already reported this, say nothing.
    const text = jobWakeMessage({ job: { ...base, status: "killed", exitCode: null }, tail: "" });
    expect(text).toContain('reply with only "." (it is not sent)');
    expect(text).toContain("No greeting");
  });

  test("on_complete instruction replaces the default feedback prompt", () => {
    // When the agent explicitly said what to do next, the wake message should carry that instruction
    // directly rather than asking the model to infer from context.
    const text = jobWakeMessage({
      job: { ...base, status: "succeeded", exitCode: 0, onComplete: "run bun install in the cloned directory" },
      tail: "Cloning into 'core'...\ndone.",
    });
    expect(text).toContain("run bun install in the cloned directory");
    expect(text).toContain("Instruction for this completion");
    // The default contextual feedback prompt must not appear — on_complete replaces it.
    expect(text).not.toContain("brief summary");
  });

  test("no on_complete falls back to reporting this job, in order", () => {
    /**
     * The wording changed because the old wording was the bug. "Post a brief summary of what happened"
     * was satisfied nine times in a row by describing the job the agent had just *started* — see
     * `job-wake-report.test.ts` for the install this came from.
     */
    const text = jobWakeMessage({ job: { ...base, status: "succeeded", exitCode: 0 }, tail: "done" });
    expect(text).toContain("Report THIS job, before anything else");
    expect(text).not.toContain("Instruction for this completion");
  });

  test("includes @agentId so routing can find the agent in any chat type", () => {
    // Without this, a wake envelope in a multi-bot group has no mention, and routing falls through
    // to gatewayOwner — which is gated by `answerUnaddressed`, which is false in a shared room.
    const text = jobWakeMessage({ job: { ...base, status: "succeeded", exitCode: 0 }, tail: "" });
    expect(text).toContain("@nouva");
  });
});

describe("a completion that lands after shutdown", () => {
  /**
   * Nothing awaits the completion path — that is the point of a background job — so anything it throws is
   * an unhandled rejection. Surfaced by `bun test` as "5 unhandled errors between tests" while every
   * assertion passed: a job exiting after the database had closed threw `RangeError: Cannot use a closed
   * database`. In the daemon that is shutdown ordering; in a test it is `afterEach`.
   *
   * It was also the most plausible cause of the intermittent full-suite failures that had been filed as
   * timing flakiness.
   */
  test("does not throw when the database is already closed", async () => {
    const s = store();
    const job = run(s, ["sleep", "30"]);

    // The shutdown sequence, with the close landing before the child's exit: `killAll` marks the store
    // closed and signals synchronously, and only its waiting is skipped here — which is the order this
    // test exists to force.
    void s.killAll();
    db.close();

    // The child's exit lands here, after the close. Nothing should escape.
    await sleep(150);
    expect(job.id).toBeTruthy();

    // Reopened for `afterEach`, which closes it again.
    db = await openAndMigrate(join(dir, "test.db"));
  });

  test("killAll marks the store closed, so late completions are no-ops", async () => {
    const s = store();
    run(s, ["sleep", "30"]);
    expect(await s.killAll()).toBe(1);
    // A second call finds nothing left to kill rather than reporting the same job again.
    expect(await s.killAll()).toBe(0);
  });
});

/**
 * Deleting job logs, which nothing did.
 *
 * A live install was found holding logs a week old. Harmless only because those jobs had been small —
 * the point of the sweep is that a job which pipes six gigabytes through `tee` is not permanent.
 */
describe("sweeping old logs", () => {
  const age = (path: string, days: number) => {
    const when = new Date(Date.now() - days * 24 * 60 * 60_000);
    utimesSync(path, when, when);
  };

  /** A job that has actually exited, so the sweep is allowed to consider it. */
  async function finished(s: JobStore) {
    const done = waitForCompletion(s);
    const started = run(s, ["echo", "hi"]);
    await done;
    return started;
  }

  test("an old finished job loses its log and its row", async () => {
    const s = store();
    const job = await finished(s);
    age(job.logPath, 30);

    expect(s.sweepLogs(14)).toBe(1);
    expect(statFile(job.logPath)).toBeNull();
    // The row goes with the file: a row pointing at a log that no longer exists is a job the
    // dashboard lists and nobody can read.
    expect(s.get(job.id)).toBeNull();
  });

  test("a recent job is left alone", async () => {
    const s = store();
    const job = await finished(s);

    expect(s.sweepLogs(14)).toBe(0);
    expect(statFile(job.logPath)).not.toBeNull();
    expect(s.get(job.id)).not.toBeNull();
  });

  test("a running job is never swept, however old its log looks", async () => {
    // Its writer has the file open. Removing it under a live process is how a job reports success
    // into a file nobody can read.
    const s = store();
    const job = run(s, ["sleep", "5"]);
    age(job.logPath, 90);

    expect(s.sweepLogs(1)).toBe(0);
    expect(statFile(job.logPath)).not.toBeNull();
    s.kill(job.id, "test");
  });

  test("zero disables the sweep rather than deleting everything", async () => {
    // The same off position the other retention knobs use, for the same reason.
    const s = store();
    const job = await finished(s);
    age(job.logPath, 500);

    expect(s.sweepLogs(0)).toBe(0);
    expect(statFile(job.logPath)).not.toBeNull();
  });

  test("a row whose log is already gone is cleaned up too", async () => {
    // Somebody deleted the file by hand, or a disk filled. The row is the only thing left pointing
    // at a log that does not exist.
    const s = store();
    const job = await finished(s);
    removePath(job.logPath);

    expect(s.sweepLogs(14)).toBe(1);
    expect(s.get(job.id)).toBeNull();
  });
});

/**
 * A job that died with the daemon has to reach the person, not just the job list.
 *
 * The failure, live and twice in one day: an agent said "gw kabarin begitu selesai", started a
 * 17-minute build on the box the daemon runs on, the box went down under it — and after the restart
 * nothing anywhere said the work had stopped. `interruptOrphaned` corrected the row and told nobody.
 */
describe("reporting jobs interrupted by a restart", () => {
  const insertRunning = (id: string, startedAt: number) =>
    db
      .prepare(
        `INSERT INTO jobs (id, agent_id, gateway_id, chat_id, command, cwd, status, log_path, started_at)
         VALUES (?, 'nouva', 'telegram:main', 'chat-1', 'bun run build', '/tmp', 'running', '/tmp/x.log', ?)`,
      )
      .run(id, startedAt);

  test("a recent one is reported, with its partial log", async () => {
    const now = 10_000_000;
    insertRunning("job_recent", now - 60_000);

    const s = store();
    const woken: string[] = [];
    const reported = s.reportInterrupted(s.interruptOrphaned(), (c) => woken.push(c.job.id), now);

    expect(reported).toBe(1);
    // The tail is read asynchronously before the wake fires: waited for, not slept on — 5 ms lost to a busy machine.
    await eventually(() => woken.length > 0, 4_000, "the wake");
    expect(woken).toEqual(["job_recent"]);
  });

  test("yesterday's is not", () => {
    // Archaeology. The conversation has been reset since, and the wake-up would arrive with no context
    // — reading as the agent raising something nobody remembers asking for.
    const now = 10_000_000;
    insertRunning("job_ancient", now - 48 * 60 * 60 * 1000);

    const s = store();
    expect(s.reportInterrupted(s.interruptOrphaned(), () => {}, now)).toBe(0);
  });

  test("a crash-looping daemon reports the newest few, not everything", () => {
    // Four jobs lost at once must not become four wake-ups on every boot. The rest stay in
    // `nouride jobs`, which is where a full accounting belongs.
    const now = 10_000_000;
    for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) {
      insertRunning(`job_${id}`, now - (i + 1) * 1000);
    }

    const s = store();
    const woken: string[] = [];
    expect(s.reportInterrupted(s.interruptOrphaned(), (c) => woken.push(c.job.id), now)).toBe(3);
  });

  test("nothing running, nothing said", () => {
    const s = store();
    expect(s.reportInterrupted(s.interruptOrphaned(), () => {}, 10_000_000)).toBe(0);
  });
});

/**
 * The unattended chain counter.
 *
 * A job finishing wakes its agent, that turn starts the next step, and its completion wakes it again.
 * Nine of those in a row was a legitimate install — so the ceiling is high and what matters is that it
 * counts correctly and that a person resets it. Bounded like every other map in `admission.ts`,
 * because "one entry per chat that ever ran a job" is small until the daemon has been up for months.
 */
describe("counting job wake-ups per conversation", () => {
  const admissionFor = async (limit: number) => {
    const { Admission } = await import("@/modules/pipeline/admission.ts");
    const { DEFAULT_CONFIG } = await import("@/modules/config/defaults.ts");
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.jobWakeMaxChain = limit;
    return new Admission({ config } as never);
  };

  test("counts from one, per conversation", async () => {
    const admission = await admissionFor(100);

    expect(admission.noteJobWake("telegram:bot", "chat-a")).toEqual({ position: 1, limit: 100 });
    expect(admission.noteJobWake("telegram:bot", "chat-a")).toEqual({ position: 2, limit: 100 });
    // A different chat is a different chain: one conversation's long install must not spend another's
    // budget.
    expect(admission.noteJobWake("telegram:bot", "chat-b")).toEqual({ position: 1, limit: 100 });
    expect(admission.noteJobWake("discord:nox", "chat-a")).toEqual({ position: 1, limit: 100 });
  });

  test("a person speaking starts it over", async () => {
    const admission = await admissionFor(100);

    admission.noteJobWake("telegram:bot", "chat-a");
    admission.noteJobWake("telegram:bot", "chat-a");
    admission.resetJobWakeChain("telegram:bot", "chat-a");

    expect(admission.noteJobWake("telegram:bot", "chat-a").position).toBe(1);
  });

  test("the table has a ceiling", async () => {
    // The question this file's own header says you should be able to answer by reading it.
    const admission = await admissionFor(100);
    for (let n = 0; n < 1_200; n += 1) admission.noteJobWake("telegram:bot", `chat-${n}`);

    expect(admission.wakeChainEntries()).toBeLessThan(1_200);
  });

  test("the configured limit is what it reports", async () => {
    expect((await admissionFor(3)).noteJobWake("telegram:bot", "c").limit).toBe(3);
    // 0 lifts the ceiling — the wake message reads that as "no limit".
    expect((await admissionFor(0)).noteJobWake("telegram:bot", "c").limit).toBe(0);
  });
});
