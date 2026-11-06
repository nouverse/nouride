/**
 * The store owns `nextRunAt`, and every one of these tests is about a way that ownership can go
 * wrong: a schedule that does not advance, one that advances twice, a job that fires after being
 * paused for a week, a one-shot that lingers, a failing job that never stops failing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { CronSection } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-cron-store-"));

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 60_000,
  maxJobs: 5,
  runRetentionDays: 14,
  catchupWindowMs: 3_600_000,
  failStreakLimit: 3,
  unattendedApproval: "auto",
  commandTimeoutMs: 600_000,
};

let db: SqliteDb;
let clock = Date.parse("2026-08-18T10:00:00+07:00");
let store: CronStore;

function makeStore(config: Partial<CronSection> = {}): CronStore {
  return new CronStore({
    db,
    config: { ...CONFIG, ...config },
    timezone: "Asia/Jakarta",
    now: () => clock,
  });
}

function input(overrides: Partial<JobInput> = {}): JobInput {
  return {
    agentId: "nouva",
    name: "test job",
    trigger: { kind: "every", everyMs: 300_000 },
    payload: { kind: "systemEvent", text: "ping" },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    createdBy: "tester",
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  db = openDatabase(join(DIR, "t.db"));
  migrate(db);
  clock = Date.parse("2026-08-18T10:00:00+07:00");
  store = makeStore();
});

afterEach(() => {
  db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("validation happens at create, not at fire time", () => {
  test("a job with half a target is refused — a gateway with no chat, or a chat with no gateway", () => {
    // Both blank was the only case here, and it passed with `||` turned into `&&`: half a target
    // went through and failed at fire time instead.
    expect(() => store.create(input({ target: { gatewayId: "telegram:main", chatId: "" } }))).toThrow(/target conversation/);
    expect(() => store.create(input({ target: { gatewayId: "", chatId: "12345" } }))).toThrow(/target conversation/);
  });

  test("a command job needs a non-empty argv of strings", () => {
    // Nothing tested this: every check on a command payload could be deleted with the suite green, and the
    // job then failed at fire time on a command that could never run.
    const command = (argv: unknown) => input({ payload: { kind: "command", argv } as never });
    expect(() => store.create(command([]))).toThrow(/argv array/);
    expect(() => store.create(command("ls -la"))).toThrow(/argv array/);
    expect(() => store.create(command(["ls", 3]))).toThrow(/must be a string/);
    expect(() => store.create(command(["ls", "-la"]))).not.toThrow();
  });

  /**
   * 2026-10-06: an agent's `nouride cron add` without `--agent` was stored with `agentId: ""`, and the
   * job failed at 21:15 with "agent  is not loaded" — hours after anyone could have fixed it.
   */
  test("a job with no agent is refused, and an update cannot blank one", () => {
    expect(() => store.create(input({ agentId: "" }))).toThrow(/needs an agent/);
    const job = store.create(input());
    expect(() => store.update(job.id, { agentId: " " }, "tester")).toThrow(/needs an agent/);
  });

  test("the agent can be changed, which is how a job created without one is repaired", () => {
    const job = store.create(input());
    expect(store.update(job.id, { agentId: "nero" }, "tester")!.agentId).toBe("nero");
    expect(store.get(job.id)!.agentId).toBe("nero");
  });

  test("a one-shot in the past is refused", () => {
    expect(() => store.create(input({ trigger: { kind: "at", at: clock - 1000 } }))).toThrow(
      /already passed/,
    );
  });

  test("an interval under the floor is refused", () => {
    expect(() => store.create(input({ trigger: { kind: "every", everyMs: 1000 } }))).toThrow(
      /shortest interval/,
    );
  });

  test("an unparseable cron expression is refused here, not at 3am", () => {
    expect(() => store.create(input({ trigger: { kind: "cron", expr: "0 9 * *" } }))).toThrow(
      /not a valid cron expression/,
    );
  });

  test("an expression that can never match is refused", () => {
    expect(() => store.create(input({ trigger: { kind: "cron", expr: "0 0 30 2 *" } }))).toThrow(
      /no occurrence/,
    );
  });

  test("an unknown timezone is refused", () => {
    expect(() =>
      store.create(input({ trigger: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Jakartaa" } })),
    ).toThrow(/IANA/);
  });

  test("a half-specified delivery override is refused", () => {
    expect(() =>
      store.create(input({ delivery: { mode: "announce", chatId: "999" } })),
    ).toThrow(/both a gateway id and a chat id/);
  });

  test("webhook delivery without a URL is refused", () => {
    expect(() => store.create(input({ delivery: { mode: "webhook" } }))).toThrow(/needs a URL/);
  });

  test("a mission job needs a goal, keeps a mission's limits, and reports to a chat (0.8.0)", () => {
    const mission = (payload: Record<string, unknown>, extra: Partial<JobInput> = {}) =>
      input({ payload: { kind: "mission", goal: "Sum up the week's mail.", ...payload } as JobInput["payload"], ...extra });
    expect(() => store.create(mission({ goal: "  " }))).toThrow(/needs a goal/);
    expect(() => store.create(mission({ goal: "x".repeat(2001) }))).toThrow(/under 2000 characters/);
    expect(() => store.create(mission({ checks: Array.from({ length: 11 }, () => "true") }))).toThrow(/at most 10 checks/);
    expect(() => store.create(mission({ review: "x".repeat(1001) }))).toThrow(/review criteria/);
    // With nowhere to say it is done or needs someone, nobody would ever hear of a run.
    expect(() => store.create(mission({}, { delivery: { mode: "none" } }))).toThrow(/reports to a chat/);
    expect(() => store.create(mission({ checks: ["test -s summary.md"], review: false }))).not.toThrow();
  });

  test("the job ceiling is enforced", () => {
    for (let i = 0; i < CONFIG.maxJobs; i++) store.create(input({ name: `job ${i}` }));
    expect(() => store.create(input())).toThrow(/ceiling/);
  });
});

describe("scheduling", () => {
  test("a cron job's first occurrence is read in the job's timezone", () => {
    const job = store.create(
      input({ trigger: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Jakarta" } }),
    );
    // 10:00 Jakarta now, so the next 09:00 there is tomorrow.
    expect(job.nextRunAt).toBe(Date.parse("2026-08-19T09:00:00+07:00"));
  });

  test("a cron job with no timezone uses the daemon's", () => {
    const utc = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => clock });
    const job = utc.create(input({ trigger: { kind: "cron", expr: "0 9 * * *" } }));
    // 03:00 UTC now, so the next 09:00 UTC is today.
    expect(job.nextRunAt).toBe(Date.parse("2026-08-18T09:00:00Z"));
  });

  test("an interval is measured from the end of the last run, not a fixed grid", () => {
    const job = store.create(input({ trigger: { kind: "every", everyMs: 300_000 } }));
    expect(job.nextRunAt).toBe(clock + 300_000);

    // The run itself takes four minutes. The next one is five minutes after it *finished*.
    clock += 240_000;
    store.settle(job, { status: "success" });
    expect(store.get(job.id)?.nextRunAt).toBe(clock + 300_000);
  });

  test("a paused job resumes from when it was re-enabled, not from its stale occurrence", () => {
    const job = store.create(input());
    store.setEnabled(job.id, false, "tester");
    expect(store.get(job.id)?.nextRunAt).toBeUndefined();

    clock += 7 * 86_400_000;
    const resumed = store.setEnabled(job.id, true, "tester");
    expect(resumed?.nextRunAt).toBe(clock + 300_000);
  });

  test("editing the schedule takes effect now, not after one more run", () => {
    const job = store.create(input({ trigger: { kind: "every", everyMs: 300_000 } }));
    const updated = store.update(job.id, { trigger: { kind: "every", everyMs: 3_600_000 } }, "tester");
    expect(updated?.nextRunAt).toBe(clock + 3_600_000);
  });
});

describe("claiming", () => {
  test("a job can only be claimed once", () => {
    store.create(input());
    const due = store.due(clock + 400_000);
    expect(due).toHaveLength(1);
    expect(store.claim(due[0]!)).toBe(true);
    // A second tick that overran the first sees the same job object and must not start it again.
    expect(store.claim(due[0]!)).toBe(false);
  });

  test("a claimed job is no longer due", () => {
    store.create(input());
    store.claim(store.due(clock + 400_000)[0]!);
    expect(store.due(clock + 400_000)).toHaveLength(0);
  });
});

describe("settling a run", () => {
  test("a successful one-shot removes itself", () => {
    const job = store.create(input({ trigger: { kind: "at", at: clock + 60_000 } }));
    store.settle(job, { status: "success" });
    expect(store.get(job.id)).toBeNull();
  });

  test("a one-shot with keepAfterRun survives, disabled, and says it fired", () => {
    /**
     * `--keep` is "do not delete a one-shot after it fires", and the row kept has to say that it did.
     *
     * It used to share the failure branch: off with the reason `missed`, a failure-shaped line in
     * `cron list`, and a warning that the job had not fired — for a job whose run row said success.
     * The assertions above the reason were all this test made, and every one of them held for the bug.
     */
    const job = store.create(input({ trigger: { kind: "at", at: clock + 60_000 }, keepAfterRun: true }));
    store.settle(job, { status: "success" });
    const after = store.get(job.id);
    expect(after).not.toBeNull();
    expect(after?.nextRunAt).toBeUndefined();
    expect(after?.enabled).toBe(false);
    expect(after?.disabledReason).toBe("fired");
    expect(after?.runCount).toBe(1);
    expect(after?.failCount).toBe(0);
  });

  test("a kept one-shot that was missed or failed still says so", () => {
    // The other two reasons are unchanged by `--keep`: keeping a job is not the same as it working.
    const missed = store.create(input({ name: "missed", trigger: { kind: "at", at: clock + 60_000 }, keepAfterRun: true }));
    store.settle(missed, { status: "skipped", result: "missed while the daemon was down" });
    expect(store.get(missed.id)?.disabledReason).toBe("missed");

    const failed = store.create(input({ name: "failed", trigger: { kind: "at", at: clock + 60_000 }, keepAfterRun: true }));
    store.settle(failed, { status: "error", result: "exit 1" });
    expect(store.get(failed.id)?.disabledReason).toBe("one-shot failed");
  });

  test("a failed one-shot is kept and disabled with a reason, not left looking scheduled", () => {
    const job = store.create(input({ trigger: { kind: "at", at: clock + 60_000 } }));
    store.settle(job, { status: "error", result: "gateway gone" });
    const after = store.get(job.id);
    expect(after?.enabled).toBe(false);
    expect(after?.disabledReason).toBe("one-shot failed");
    expect(after?.failCount).toBe(1);
  });

  test("a recurring job advances on failure too", () => {
    const job = store.create(input());
    store.settle(job, { status: "error", result: "boom" });
    const after = store.get(job.id);
    expect(after?.nextRunAt).toBe(clock + 300_000);
    expect(after?.enabled).toBe(true);
  });

  test("consecutive failures disable the job and say why", () => {
    let job = store.create(input());
    for (let i = 0; i < CONFIG.failStreakLimit; i++) {
      store.settle(store.get(job.id)!, { status: "error", result: "boom" });
    }
    const after = store.get(job.id)!;
    expect(after.enabled).toBe(false);
    expect(after.disabledReason).toBe("consecutive-failures");
    expect(after.nextRunAt).toBeUndefined();
  });

  test("one success resets the streak", () => {
    const job = store.create(input());
    store.settle(store.get(job.id)!, { status: "error", result: "boom" });
    store.settle(store.get(job.id)!, { status: "error", result: "boom" });
    store.settle(store.get(job.id)!, { status: "success" });
    expect(store.get(job.id)?.failStreak).toBe(0);

    // And the ceiling is measured from there, not from the lifetime count.
    store.settle(store.get(job.id)!, { status: "error", result: "boom" });
    expect(store.get(job.id)?.enabled).toBe(true);
    expect(store.get(job.id)?.failCount).toBe(3);
  });

  test("a skipped run is not a failure — downtime must not disable a nightly job", () => {
    const job = store.create(input());
    for (let i = 0; i < CONFIG.failStreakLimit + 2; i++) {
      store.settle(store.get(job.id)!, { status: "skipped", result: "daemon was down" });
    }
    expect(store.get(job.id)?.enabled).toBe(true);
    expect(store.get(job.id)?.failCount).toBe(0);
  });

  test("enabling a job the daemon disabled clears the streak, so it does not re-disable at once", () => {
    const job = store.create(input());
    for (let i = 0; i < CONFIG.failStreakLimit; i++) {
      store.settle(store.get(job.id)!, { status: "error", result: "boom" });
    }
    store.setEnabled(job.id, true, "tester");
    const after = store.get(job.id)!;
    expect(after.failStreak).toBe(0);
    expect(after.disabledReason).toBeUndefined();

    store.settle(after, { status: "error", result: "boom" });
    expect(store.get(job.id)?.enabled).toBe(true);
  });
});

describe("run history", () => {
  test("a run is recorded and can be read back", () => {
    const job = store.create(input());
    const run = store.startRun(job.id);
    clock += 1500;
    store.finishRun(run.id, { status: "success", result: "delivered" });

    const [recorded] = store.runs(job.id);
    expect(recorded?.status).toBe("success");
    expect(recorded?.finishedAt).toBe(clock);
    expect(recorded?.result).toBe("delivered");
  });

  test("runs left mid-flight by a restart are reconciled, not left saying `running`", () => {
    const job = store.create(input());
    store.startRun(job.id);
    expect(store.reconcileInterrupted()).toBe(1);
    // Interrupted, not failed: nothing about the job went wrong (P11).
    expect(store.runs(job.id)[0]?.status).toBe("interrupted");
    expect(store.runs(job.id)[0]?.result).toMatch(/restart/);
  });

  test("an interrupted run is not a failure: a one-shot says so, a recurring job keeps its streak and its next time", () => {
    const once = store.create(input({ name: "once", trigger: { kind: "at", at: clock + 60_000 } }));
    store.settle(once, { status: "interrupted", result: "interrupted by a daemon restart" });
    const settled = store.get(once.id)!;
    expect(settled.enabled).toBe(false);
    expect(settled.disabledReason).toBe("interrupted");
    expect(settled.failCount).toBe(0);

    const recurring = store.create(input({ name: "every" }));
    store.settle(recurring, { status: "error", result: "boom" });
    store.settle(store.get(recurring.id)!, { status: "interrupted", result: "interrupted by a daemon restart" });
    const after = store.get(recurring.id)!;
    expect(after.failStreak).toBe(1);
    expect(after.nextRunAt).toBeDefined();
  });

  test("history older than the retention window is swept", () => {
    const job = store.create(input());
    const old = store.startRun(job.id);
    store.finishRun(old.id, { status: "success" });

    clock += 15 * 86_400_000;
    const recent = store.startRun(job.id);
    store.finishRun(recent.id, { status: "success" });

    expect(store.sweepRuns()).toBe(1);
    expect(store.runs(job.id)).toHaveLength(1);
  });

  test("deleting a job on purpose takes its history with it", () => {
    /**
     * Deliberate, and no longer automatic. The `ON DELETE CASCADE` that used to do this also erased
     * every successfully fired one-shot — those are removed the instant they run — so the successes
     * disappeared and the failures were kept. Migration 024 dropped the cascade; `delete` now says
     * what it means, and the one-shot path leaves the history alone.
     */
    const job = store.create(input());
    store.finishRun(store.startRun(job.id).id, { status: "success" });
    store.delete(job.id, "tester");
    expect(store.runs(job.id)).toHaveLength(0);
  });
});

describe("listing", () => {
  test("disabled jobs are hidden by default and shown on request", () => {
    const a = store.create(input({ name: "live" }));
    const b = store.create(input({ name: "paused" }));
    store.setEnabled(b.id, false, "tester");

    expect(store.list().map((j) => j.name)).toEqual(["live"]);
    expect(store.list({ includeDisabled: true })).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
  });

  test("live jobs sort before ones with no next occurrence", () => {
    const soon = store.create(input({ name: "soon", trigger: { kind: "every", everyMs: 60_000 } }));
    const later = store.create(input({ name: "later", trigger: { kind: "every", everyMs: 600_000 } }));
    const paused = store.create(input({ name: "paused" }));
    store.setEnabled(paused.id, false, "tester");

    expect(store.list({ includeDisabled: true }).map((j) => j.name)).toEqual([
      "soon",
      "later",
      "paused",
    ]);
    expect(soon.id).not.toBe(later.id);
  });
});

/**
 * A webhook is a job whose trigger is a request. These are the properties that makes true: it never
 * comes due on its own, it is addressable by a token nobody chose, and rotating that token does not
 * cost the job its history.
 */
describe("webhook jobs", () => {
  const hook = (overrides: Partial<JobInput> = {}) =>
    store.create(
      input({ trigger: { kind: "webhook" }, payload: { kind: "agentTurn", message: "look" }, ...overrides }),
    );

  test("a webhook job gets a token and no next run", () => {
    const job = hook();

    expect(job.webhookToken).toMatch(/^[0-9a-f]{64}$/);
    // The property that keeps it out of the ticker entirely, rather than needing the ticker to know
    // what a webhook is.
    expect(job.nextRunAt).toBeUndefined();
  });

  test("it never comes due, however far the clock moves", () => {
    hook();
    clock += 365 * 24 * 3_600_000;

    expect(store.due(clock)).toEqual([]);
  });

  test("two webhooks never share a token", () => {
    const a = hook({ name: "a" });
    const b = hook({ name: "b" });

    expect(a.webhookToken).not.toBe(b.webhookToken);
  });

  test("a token finds its job, and an unknown one finds nothing", () => {
    const job = hook();

    expect(store.byWebhookToken(job.webhookToken!)?.id).toBe(job.id);
    expect(store.byWebhookToken("0".repeat(64))).toBeNull();
    // An empty token must not match the NULL on every clock-driven row.
    expect(store.byWebhookToken("")).toBeNull();
  });

  test("a clock-driven job has no token and cannot be reached by one", () => {
    const scheduled = store.create(input());

    expect(scheduled.webhookToken).toBeUndefined();
    expect(store.byWebhookToken("")).toBeNull();
  });

  test("rotating issues a new token and retires the old URL", () => {
    const job = hook();
    const before = job.webhookToken!;

    const rotated = store.rotateWebhookToken(job.id, "admin");

    expect(rotated?.webhookToken).not.toBe(before);
    // The reason rotation exists rather than delete-and-recreate: the run history survives it.
    expect(store.byWebhookToken(before)).toBeNull();
    expect(store.byWebhookToken(rotated!.webhookToken!)?.id).toBe(job.id);
  });

  test("rotating refuses a job that is not a webhook", () => {
    const scheduled = store.create(input());

    expect(store.rotateWebhookToken(scheduled.id, "admin")).toBeNull();
    expect(store.rotateWebhookToken("cron_nope", "admin")).toBeNull();
  });
});
