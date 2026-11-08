/**
 * The database check at boot, skipped after a clean stop — `boot/integrity.ts`.
 *
 * `quick_check` reads every page, and boot ran it every time: after a clean stop as after a power cut. Each case
 * here is a way a skip must not happen — a run that died, a check that failed, a week gone by — and the one way it
 * should.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { CHECK_AT_LEAST_EVERY_MS, checkAtBoot, markCleanShutdown } from "@/boot/integrity.ts";
import { tempDir } from "../helpers.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function dataDir(): string {
  const dir = tempDir("integrity");
  cleanup.push(() => removePath(dir));
  return dir;
}

/** A database whose check is counted, and answers what it is told to. */
function counted(result = { ok: true, detail: "ok" }) {
  const db = { checks: 0, integrityCheck: () => (db.checks++, result) };
  return db;
}

const DAY = 24 * 60 * 60 * 1000;

describe("the boot check", () => {
  test("runs when the last run left no marker — a crash, a kill -9, a power cut, or a first boot", () => {
    const dir = dataDir();
    const db = counted();

    const result = checkAtBoot(db as never, dir, 1_000);

    expect(db.checks).toBe(1);
    expect(result).toEqual({ ok: true, detail: "ok", checkedAt: 1_000, skipped: false });
  });

  test("is skipped after a clean stop, and the check it relies on is carried forward", () => {
    const dir = dataDir();
    markCleanShutdown(dir, { ok: true, checkedAt: 5 * DAY }, 6 * DAY);
    const db = counted();

    const result = checkAtBoot(db as never, dir, 6 * DAY + 60_000);

    expect(db.checks).toBe(0);
    expect(result).toEqual({ ok: true, detail: "ok", checkedAt: 5 * DAY, skipped: true });
  });

  test("the marker is taken at boot: a run that dies after it leaves the next one checking", () => {
    const dir = dataDir();
    markCleanShutdown(dir, { ok: true, checkedAt: 0 }, 1);
    checkAtBoot(counted() as never, dir, 2);
    // …and this run never reached its own clean stop.
    const db = counted();

    checkAtBoot(db as never, dir, 3);

    expect(db.checks).toBe(1);
  });

  test("runs anyway once the last check is a week old: a clean stop says nothing about the disk", () => {
    const dir = dataDir();
    markCleanShutdown(dir, { ok: true, checkedAt: 0 }, CHECK_AT_LEAST_EVERY_MS);
    const db = counted();

    const result = checkAtBoot(db as never, dir, CHECK_AT_LEAST_EVERY_MS + 1);

    expect(db.checks).toBe(1);
    expect(result.checkedAt).toBe(CHECK_AT_LEAST_EVERY_MS + 1);
  });

  test("a failed check is not carried forward as one that passed", () => {
    const dir = dataDir();
    const failed = checkAtBoot(counted({ ok: false, detail: "*** in database main ***" }) as never, dir, 10);
    markCleanShutdown(dir, failed, 20);
    const db = counted();

    checkAtBoot(db as never, dir, 30);

    expect(existsSync(join(dir, "clean-shutdown.json"))).toBe(false);
    expect(db.checks).toBe(1);
  });

  test("a marker that is not one this wrote reads as no marker", () => {
    const dir = dataDir();
    writeFileSync(join(dir, "clean-shutdown.json"), "{ not json");
    const db = counted();

    checkAtBoot(db as never, dir, 5);

    expect(db.checks).toBe(1);
  });

  test("what a clean stop leaves says when it stopped and when the database was last checked", () => {
    const dir = dataDir();
    markCleanShutdown(dir, { ok: true, checkedAt: 7 }, 9);

    expect(JSON.parse(readFileSync(join(dir, "clean-shutdown.json"), "utf8"))).toEqual({ stoppedAt: 9, checkedAt: 7 });
  });
});
