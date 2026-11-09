/**
 * When the database is snapshotted, and where (2026-10-15).
 *
 * Every boot took a full `VACUUM INTO` and read it back to verify — 62 MB of I/O on the live box's
 * 31 MB database — so a crash loop wrote 155 MB to an SD card in two minutes for five identical
 * copies. And every snapshot went to the card, which is the thing they exist to outlive.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { GlobalConfig } from "@nouride/shared";
import { backupAgents } from "@nouride/persona";
import { startAgentBackups, startDatabaseBackups, startVaultBackups } from "@/boot/maintenance.ts";
import { backupVault } from "@/modules/memory/backup.ts";
import { sleep } from "../helpers.ts";
import { eventually } from "../wait.ts";
import { backupDirFor } from "@/commons/backup-dir.ts";
import { listBackups, newestBackupAt } from "@/db/backup.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let dir: string;
let db: SqliteDb;
const timers: ReturnType<typeof setInterval>[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-boot-snapshot-"));
  db = openDatabase(join(dir, "nouride.db"));
  db.exec("CREATE TABLE notes (body TEXT)");
  db.prepare("INSERT INTO notes VALUES (?)").run("a conversation worth keeping");
});

afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(backupDir = ""): GlobalConfig {
  const base = structuredClone(DEFAULT_CONFIG) as GlobalConfig;
  return { ...base, daemon: { ...base.daemon, dataDir: dir, backupDir } };
}

function boot(cfg: GlobalConfig): void {
  timers.push(startDatabaseBackups(cfg, db, () => NOW));
}

/** A snapshot as `stamp` names one, taken `ago` before `NOW`. */
function snapshotTaken(ago: number, root = join(dir, "backups", "db")): void {
  mkdirSync(root, { recursive: true });
  const stamp = new Date(NOW - ago).toISOString().slice(0, 19).replace(/[:T]/g, "-");
  writeFileSync(join(root, `nouride-${stamp}.db`), "");
}

describe("the boot snapshot", () => {
  test("is taken when there is none", () => {
    boot(config());
    expect(listBackups(dir)).toHaveLength(1);
  });

  test("is skipped while the newest is younger than a week: a crash loop writes the file once, a nightly restart none", () => {
    snapshotTaken(6 * DAY);
    boot(config());
    boot(config());
    expect(listBackups(dir)).toHaveLength(1);
  });

  test("is taken once the newest is a week old (0.8.17, PLAN §3.5)", () => {
    snapshotTaken(7 * DAY + HOUR);
    boot(config());
    expect(listBackups(dir)).toHaveLength(2);
    expect(newestBackupAt(dir)).toBe(NOW);
  });

  test("a snapshot taken before a migration counts — it is the same full copy, seconds old", () => {
    mkdirSync(join(dir, "backups", "db"), { recursive: true });
    const stamp = new Date(NOW - 60_000).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    writeFileSync(join(dir, "backups", "db", `nouride-${stamp}-before-049.db`), "");
    boot(config());
    expect(listBackups(dir)).toHaveLength(1);
  });
});

describe("[daemon] backup_dir", () => {
  test("snapshots go there, and not under the data directory", () => {
    const drive = join(dir, "usb", "nouride");
    mkdirSync(drive, { recursive: true });
    boot(config(drive));
    expect(readdirSync(join(drive, "db")).filter((name) => name.endsWith(".db"))).toHaveLength(1);
    expect(existsSync(join(dir, "backups", "db"))).toBe(false);
  });

  test("a directory that is not there is never created, and nothing is written in its place", () => {
    // The unplugged drive: its mount point is still there, empty, on the card. Writing into it — or
    // falling back to data/backups — is filling the card the setting moved the snapshots off.
    const drive = join(dir, "usb", "nouride");
    boot(config(drive));
    expect(existsSync(drive)).toBe(false);
    expect(existsSync(join(dir, "backups", "db"))).toBe(false);
    expect(backupDirFor({ dataDir: dir, backupDir: drive })).toEqual({ missing: drive });
  });

  test("unset means the data directory's own backups", () => {
    expect(backupDirFor({ dataDir: dir, backupDir: "" })).toEqual({ dir: join(dir, "backups") });
  });

  test("the list reads both places, newest first — a migration's snapshot stays under the data directory", () => {
    const drive = join(dir, "usb", "nouride");
    snapshotTaken(30 * HOUR);
    snapshotTaken(2 * HOUR, join(drive, "db"));
    const names = listBackups(dir, drive).map((backup) => backup.path);
    expect(names).toHaveLength(2);
    expect(names[0]).toContain(join(drive, "db"));
    expect(newestBackupAt(dir, drive)).toBe(NOW - 2 * HOUR);
  });
});

describe("a database nothing wrote to", () => {
  /**
   * A day of nobody using the box was a full copy written and read back from the SD card, and it pushed an older,
   * different copy out of the rotation. What the daemon writes about itself — its log lines — is not a write.
   */
  test("is not copied again; a write makes the next weekly one due, a week after the newest and not a day", () => {
    jest.useFakeTimers();
    try {
      const clock = { now: NOW };
      let written = 7;
      timers.push(startDatabaseBackups(config(), db, () => clock.now, () => written));
      expect(listBackups(dir)).toHaveLength(1);
      const days = (count: number): void => {
        for (let hour = 0; hour < 24 * count; hour += 1) {
          clock.now += HOUR;
          jest.advanceTimersByTime(HOUR);
        }
      };
      // Written to every day, and still one snapshot until the newest is a week old.
      written += 1;
      days(6);
      expect(listBackups(dir)).toHaveLength(1);
      days(1);
      expect(listBackups(dir)).toHaveLength(2);
      // Nothing written since: due again a week on, looked at, and not copied.
      days(8);
      expect(listBackups(dir)).toHaveLength(2);
      // Once due, it looks again daily: a write after a look that copied nothing is snapshotted the next day.
      written += 1;
      days(1);
      expect(listBackups(dir)).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * Four kept by default (0.8.17): a month back at one a week, one rule for the database, the vault
 * and the packs, and for `nouride db backup`, which reads the same key. An install on the default prunes its older
 * snapshots to four at its first weekly one.
 */
describe("how many are kept", () => {
  test("four by default: a new snapshot over six older ones leaves the newest four", () => {
    for (const weeks of [1, 2, 3, 4, 5, 6]) snapshotTaken(weeks * 7 * DAY + HOUR);
    expect(config().daemon.backupKeep).toBe(4);
    boot(config());
    const left = listBackups(dir);
    expect(left).toHaveLength(4);
    expect(newestBackupAt(dir)).toBe(NOW);
  });
});

describe("the vault and the packs follow the database's rule", () => {
  /**
   * They snapshotted on every boot, and each rotation keeps the newest `backup_keep` by name — so three restarts in a
   * crash loop left three copies of the current state and deleted every older one. Of the vault, only the snapshots
   * hold a second copy; of a pack, `MEMORY.md` is the file that cannot be rebuilt.
   */
  const KEEP = 3;
  function withKeep(): GlobalConfig {
    const base = config();
    return { ...base, daemon: { ...base.daemon, backupKeep: KEEP, agentsDir: join(dir, "agents") }, memory: { ...base.memory, dir: join(dir, "memory") } };
  }

  test("three boots within an hour leave the older vault snapshots in place", async () => {
    const cfg = withKeep();
    // A week apart and more, as weekly snapshots are (0.8.17): the newest older than a week, so the first boot takes one.
    for (const [i, ago] of [21, 14, 8].entries()) {
      mkdirSync(join(cfg.memory.dir, "people"), { recursive: true });
      writeFileSync(join(cfg.memory.dir, "people", "sam.md"), `- version ${i}\n`);
      await backupVault({ vaultDir: cfg.memory.dir, dataDir: dir, keep: KEEP, now: () => NOW - ago * 24 * HOUR });
    }
    const before = readdirSync(join(dir, "backups", "memory")).sort();
    // One after another, as restarts are: each boot's snapshot is on disk before the next one looks — and each boot
    // changed the vault, so it is the freshness rule, not "nothing changed", that holds the copies back.
    for (const minutes of [0, 1, 2]) {
      writeFileSync(join(cfg.memory.dir, "people", "sam.md"), `- changed at boot ${minutes}\n`);
      timers.push(startVaultBackups(cfg, () => NOW + minutes * 60_000));
      // The first boot's snapshot on disk before the next boot looks, however slow the runner: a fixed 30 ms let the
      // second boot start first on CI and take a snapshot of its own (2026-11-06). The later boots take none.
      if (minutes === 0) await eventually(() => readdirSync(join(dir, "backups", "memory")).sort().at(-1) !== before.at(-1), 4_000, "the first boot's snapshot");
      else await sleep(30);
    }
    const after = readdirSync(join(dir, "backups", "memory")).sort();
    expect(after).toHaveLength(KEEP);
    // One new snapshot rotated the oldest out; the two before it are still there.
    expect(after.slice(0, 2)).toEqual(before.slice(1));
  });

  test("three boots within an hour leave the older pack snapshots in place", async () => {
    const cfg = withKeep();
    const pack = join(cfg.daemon.agentsDir, "nouva");
    mkdirSync(pack, { recursive: true });
    // A week apart and more, as weekly snapshots are (0.8.17): the newest older than a week, so the first boot takes one.
    for (const ago of [21, 14, 8]) {
      writeFileSync(join(pack, "MEMORY.md"), `- remembered ${ago} days ago\n`);
      await backupAgents({ agentsDir: cfg.daemon.agentsDir, dataDir: dir, keep: KEEP, now: () => NOW - ago * 24 * HOUR });
    }
    const before = readdirSync(join(dir, "backups", "agents")).sort();
    // One after another, as restarts are, each with the pack changed — see the vault's test above.
    for (const minutes of [0, 1, 2]) {
      writeFileSync(join(pack, "MEMORY.md"), `- changed at boot ${minutes}\n`);
      timers.push(startAgentBackups(cfg, () => NOW + minutes * 60_000));
      // The first boot's snapshot on disk before the next boot looks, however slow the runner: a fixed 30 ms let the
      // second boot start first on CI and take a snapshot of its own (2026-11-06). The later boots take none.
      if (minutes === 0) await eventually(() => readdirSync(join(dir, "backups", "agents")).sort().at(-1) !== before.at(-1), 4_000, "the first boot's snapshot");
      else await sleep(30);
    }
    const after = readdirSync(join(dir, "backups", "agents")).sort();
    expect(after).toHaveLength(KEEP);
    expect(after.slice(0, 2)).toEqual(before.slice(1));
  });

  test("a vault nothing changed in is not copied again — a quiet week does not cost the week before it", async () => {
    const cfg = withKeep();
    mkdirSync(join(cfg.memory.dir, "people"), { recursive: true });
    writeFileSync(join(cfg.memory.dir, "people", "sam.md"), "- likes tea\n");
    // Last written an hour ago: a file changed in the last moments is copied whatever its stat says (`backup.ts`).
    const hourAgo = (Date.now() - 3_600_000) / 1000;
    utimesSync(join(cfg.memory.dir, "people", "sam.md"), hourAgo, hourAgo);
    await backupVault({ vaultDir: cfg.memory.dir, dataDir: dir, keep: KEEP, now: () => NOW - 2 * 24 * HOUR });
    timers.push(startVaultBackups(cfg, () => NOW));
    await sleep(50);
    expect(readdirSync(join(dir, "backups", "memory"))).toHaveLength(1);
  });
});
