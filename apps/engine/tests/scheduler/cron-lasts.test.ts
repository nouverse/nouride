/**
 * A job that lasts a set time (`JobDelivery.lasts`): on a clock, it turns itself off when that time is up and says so
 * where it reports, so a watch whose moment never comes does not check for good with nobody the wiser. Held here: when
 * its end is written and by whom, what moves it and what does not, the rules it is held to, and what the scheduler does
 * at that instant. The clock is the test's.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { CronSection, Job, JobTarget } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { ENDED, endedNotice } from "@/modules/cron/ending.ts";
import { Quiet } from "@/modules/cron/quiet.ts";
import { CronScheduler, TOLD, type CronExecutors } from "@/modules/cron/scheduler.ts";
import { CronValidationError } from "@/modules/cron/validate.ts";
import { WatchStore } from "@/modules/cron/watch.store.ts";
import { eventually } from "../wait.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-cron-lasts-"));

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 1000,
  maxJobs: 20,
  runRetentionDays: 14,
  catchupWindowMs: 60_000,
  failStreakLimit: 3,
  quietHours: "",
  unattendedApproval: "auto",
  commandTimeoutMs: 5000,
};

const NOON = Date.parse("2026-08-18T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let db: SqliteDb;
let store: CronStore;
let clock: number;
let hours: string;
let schedulers: CronScheduler[];

function hands(overrides: Partial<CronExecutors> = {}) {
  const delivered: { target: JobTarget; text: string }[] = [];
  const executors: CronExecutors = {
    runTurn: async () => ({ text: "turn output" }),
    dispatchTurn: () => true,
    deliver: async (target, text) => {
      delivered.push({ target, text });
      return { ok: true };
    },
    commandSandbox: () => ({ cwd: DIR, env: { PATH: process.env.PATH ?? "" } }),
    ...overrides,
  };
  const scheduler = new CronScheduler({ store, config: CONFIG, executors, watch: new WatchStore(db, () => clock), quiet: new Quiet({ hours: () => hours, timeZone: () => "UTC", now: () => clock }), now: () => clock, maxSleepMs: 5 });
  schedulers.push(scheduler);
  return { scheduler, delivered, said: () => delivered.map((one) => one.text) };
}

/** A check every ten minutes that reads a file: silent while the file is empty. */
function watching(overrides: Partial<JobInput> = {}): Job {
  return store.create({
    agentId: "nouva",
    name: "build watch",
    trigger: { kind: "every", everyMs: 10 * MINUTE },
    payload: { kind: "command", argv: ["sh", "-c", `cat ${join(DIR, "seen")} 2>/dev/null || true`], then: "deliver" },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    delivery: { mode: "announce", once: true, lasts: HOUR },
    createdBy: "tester",
    ...overrides,
  });
}

/**
 * A tick that has come and gone, seen by a job of its own that is due now and tells whatever the hour: what is said
 * after it is everything a tick says, so "nothing more" is read off the list and not off a wait.
 */
let ticks = 0;
async function ticked(h: ReturnType<typeof hands>): Promise<string> {
  const word = `tick ${++ticks}`;
  const marker = store.create({ agentId: "nouva", name: word, trigger: { kind: "every", everyMs: 10 * MINUTE }, payload: { kind: "systemEvent", text: word }, target: { gatewayId: "telegram:main", chatId: "marker" }, delivery: { mode: "announce", atOnce: true }, createdBy: "tester" });
  db.prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?").run(clock, marker.id);
  await eventually(() => h.said().includes(word), 4_000, "a tick");
  store.setEnabled(marker.id, false, "tester");
  return word;
}

const refusal = (make: () => unknown): string => {
  try {
    make();
  } catch (err) {
    if (err instanceof CronValidationError) return `${err.field}: ${err.message}`;
    throw err;
  }
  return "";
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  db = openDatabase(join(DIR, "t.db"));
  migrate(db);
  clock = NOON;
  hours = "";
  schedulers = [];
  store = new CronStore({ db, config: CONFIG, timezone: "UTC", now: () => clock });
});

afterEach(async () => {
  for (const scheduler of schedulers) await scheduler.stop(50);
  db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("when a lasting job ends is the store's to write", () => {
  test("made on, it ends its time from now, and comes due then where that is before its next run", () => {
    const made = watching({ delivery: { mode: "announce", lasts: 25 * MINUTE } });
    expect(made.delivery.endsAt).toBe(NOON + 25 * MINUTE);
    expect(made.nextRunAt).toBe(NOON + 10 * MINUTE);
    // Two runs in: the third would fall after its end, so it comes due at its end.
    clock = NOON + 20 * MINUTE;
    store.settle(store.get(made.id)!, { status: "success", result: "it printed nothing, so nothing was sent" });
    expect(store.get(made.id)!.nextRunAt).toBe(NOON + 25 * MINUTE);
  });

  test("an end a caller wrote is not kept", () => {
    const made = watching({ delivery: { mode: "announce", lasts: HOUR, endsAt: NOON + 9_999 * HOUR } });
    expect(made.delivery.endsAt).toBe(NOON + HOUR);
    const changed = store.update(made.id, { delivery: { mode: "announce", lasts: HOUR, endsAt: NOON + 9_999 * HOUR } }, "tester");
    expect(changed!.delivery.endsAt).toBe(NOON + HOUR);
    // An end with no length, on a job nobody said should end: dropped, or the job would be ended at an instant a caller chose.
    expect(watching({ name: "endless", delivery: { mode: "announce", endsAt: NOON + 1 } }).delivery).toEqual({ mode: "announce" });
  });

  test("a proposal has no end until it is turned on, and then its time counts from that moment", () => {
    const proposed = watching({ proposal: { by: "nouva", gatewayId: "telegram:main", chatId: "12345", for: "u1", at: NOON } });
    expect(proposed.enabled).toBe(false);
    expect(proposed.delivery).toEqual({ mode: "announce", once: true, lasts: HOUR });
    clock = NOON + 3 * HOUR;
    const on = store.setEnabled(proposed.id, true, "tester")!;
    expect(on.delivery.endsAt).toBe(NOON + 4 * HOUR);
  });

  test("turned off and on again, it has its whole time again", () => {
    const made = watching();
    clock = NOON + 50 * MINUTE;
    store.setEnabled(made.id, false, "tester");
    clock = NOON + 5 * HOUR;
    expect(store.setEnabled(made.id, true, "tester")!.delivery.endsAt).toBe(NOON + 6 * HOUR);
  });

  test("saving it with how long it lasts unchanged keeps its end, and a new length counts from the save", () => {
    const made = watching();
    clock = NOON + 30 * MINUTE;
    // Another mark changed: the watch does not get its hour again for it.
    expect(store.update(made.id, { delivery: { mode: "announce", once: true, lasts: HOUR, atOnce: true } }, "tester")!.delivery.endsAt).toBe(NOON + HOUR);
    expect(store.update(made.id, { delivery: { mode: "announce", once: true, lasts: 2 * HOUR } }, "tester")!.delivery.endsAt).toBe(NOON + 30 * MINUTE + 2 * HOUR);
    // Taken away, it has no end.
    const endless = store.update(made.id, { delivery: { mode: "announce", once: true } }, "tester")!;
    expect(endless.delivery).toEqual({ mode: "announce", once: true });
    expect(endless.nextRunAt).toBe(NOON + 30 * MINUTE + 10 * MINUTE);
  });

  test("a job with no length has no end, as before", () => {
    const made = watching({ delivery: { mode: "announce", once: true } });
    expect(made.delivery).toEqual({ mode: "announce", once: true });
    expect(store.setEnabled(made.id, true, "tester")!.delivery).toEqual({ mode: "announce", once: true });
  });
});

describe("what a length of time a job lasts must be", () => {
  test("only a job on a clock can last a set time", () => {
    for (const trigger of [{ kind: "webhook" }, { kind: "manual" }, { kind: "at", at: NOON + HOUR }] as const) {
      expect(refusal(() => watching({ trigger }))).toBe("schedule: only a job that runs again and again on a clock can last a set time: this one runs once, or when it is called or started.");
    }
    expect(refusal(() => watching({ trigger: { kind: "cron", expr: "0 9 * * 1-5" } }))).toBe("");
  });

  test("one that would end before its first run is refused, when it is made and when it is changed", () => {
    expect(refusal(() => watching({ delivery: { mode: "announce", lasts: 5 * MINUTE } }))).toBe("schedule: it would end before its first run: let it last longer than the time between two runs.");
    const made = watching();
    expect(refusal(() => store.update(made.id, { delivery: { mode: "announce", lasts: 5 * MINUTE } }, "tester"))).toContain("it would end before its first run");
    // A length that is exactly one interval has one run in it.
    expect(refusal(() => watching({ delivery: { mode: "announce", lasts: 10 * MINUTE } }))).toBe("");
  });

  test("a length that is not one is refused", () => {
    expect(refusal(() => watching({ delivery: { mode: "announce", lasts: 0 } }))).toContain("how long a job lasts is a length of time");
    expect(refusal(() => watching({ delivery: { mode: "announce", lasts: Number.NaN } }))).toContain("how long a job lasts is a length of time");
  });
});

describe("at its end a job is turned off and its chat is told", () => {
  test("a watch that saw nothing says so once, is off with why, and its history has the moment", async () => {
    const made = watching();
    const h = hands();
    clock = NOON + HOUR;
    // Its last check and its end fall on the same instant: it is ended, not run.
    db.prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?").run(clock, made.id);
    h.scheduler.start();

    await eventually(() => h.said().length > 0, 4_000, "the end to be said");
    expect(h.said()).toEqual(["⏹ **build watch** has run for 1 hour and turned itself off. What it watched for did not happen in that time. Turn it on again on the Automations page to keep it going."]);
    expect(h.delivered[0]!.target).toEqual({ gatewayId: "telegram:main", chatId: "12345" });
    const after = store.get(made.id)!;
    expect(after).toMatchObject({ enabled: false, disabledReason: ENDED });
    expect(after.nextRunAt).toBeUndefined();
    expect(store.runs(made.id)[0]).toMatchObject({ status: "skipped", result: "its time was up: it turned itself off" });
    // And it stays ended: a later tick says nothing more of it.
    clock += 30 * MINUTE;
    const tick = await ticked(h);
    expect(h.said().slice(1)).toEqual([tick]);
  });

  test("before its end it runs as any job does, and one that tells is off because it told, not because it ended", async () => {
    const made = watching();
    const h = hands();
    writeFileSync(join(DIR, "seen"), "the build is green");
    clock = NOON + 10 * MINUTE;
    h.scheduler.start();

    await eventually(() => !store.get(made.id)!.enabled, 4_000, "the watch to tell and turn off");
    expect(h.said()).toEqual(["the build is green"]);
    expect(store.get(made.id)!.disabledReason).toBe(TOLD);
    // Its end passes: nothing is said of a watch that already told.
    clock = NOON + 2 * HOUR;
    const tick = await ticked(h);
    expect(h.said()).toEqual(["the build is green", tick]);
  });

  test("a job that does not tell once ends without the line about what it watched for", () => {
    expect(endedNotice({ name: "hourly digest", delivery: { mode: "announce", lasts: 36 * HOUR } })).toBe("⏹ **hourly digest** has run for 36 hours and turned itself off. Turn it on again on the Automations page to keep it going.");
    expect(endedNotice({ name: "n", delivery: { mode: "announce", lasts: 2 * 24 * HOUR } })).toContain("has run for 2 days and");
    expect(endedNotice({ name: "n", delivery: { mode: "announce", lasts: 90 * MINUTE } })).toContain("has run for 90 minutes and");
  });

  test("one that tells nobody is turned off without a word", async () => {
    const made = watching({ delivery: { mode: "none", lasts: HOUR } });
    const h = hands();
    clock = NOON + HOUR;
    db.prepare("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?").run(clock, made.id);
    h.scheduler.start();

    await eventually(() => !store.get(made.id)!.enabled, 4_000, "the job to end");
    expect(store.get(made.id)!.disabledReason).toBe(ENDED);
    expect(h.said()).toEqual([]);
  });

  test("inside the quiet hours its end is kept with the rest, and said when they are over", async () => {
    hours = "22:00-07:00";
    const made = watching();
    const h = hands();
    clock = Date.parse("2026-08-19T03:00:00Z");
    db.prepare("UPDATE cron_jobs SET next_run_at = ?, delivery = ? WHERE id = ?").run(clock, JSON.stringify({ mode: "announce", once: true, lasts: HOUR, endsAt: clock }), made.id);
    h.scheduler.start();

    await eventually(() => !store.get(made.id)!.enabled, 4_000, "the job to end");
    // A tick later in the night: its end is still unsaid.
    const tick = await ticked(h);
    expect(h.said()).toEqual([tick]);
    clock = Date.parse("2026-08-19T07:00:30Z");
    await eventually(() => h.said().length > 1, 4_000, "the morning to say it");
    expect(h.said()[1]).toContain("has run for 1 hour and turned itself off");
  });

  test("a daemon that was down past a job's end ends it at the first look, and does not run it", async () => {
    const made = watching();
    let ran = 0;
    const h = hands({ commandSandbox: () => (ran++, { cwd: DIR, env: { PATH: process.env.PATH ?? "" } }) });
    // Three days later: far past the catch-up window and past its end.
    clock = NOON + 72 * HOUR;
    h.scheduler.start();

    await eventually(() => !store.get(made.id)!.enabled, 4_000, "the job to end");
    expect(store.get(made.id)!.disabledReason).toBe(ENDED);
    expect(ran).toBe(0);
    expect(h.said()).toHaveLength(1);
  });
});
