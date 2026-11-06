/**
 * Snapshots of the persona packs.
 *
 * `docs/DEPLOY.md` puts one thing first under what to keep: `MEMORY.md`. Months of accumulated
 * identity, not in git, and the only file in an installation whose loss is permanent. The `.bak`
 * rotation `memory_write` does covers the agent corrupting its own memory; it does not cover the
 * directory being deleted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTextFileIfExists, writeTextFileAtomic } from "@nouride/runtime";
import { backupAgents, prepareBackupDir } from "@nouride/persona";

let root: string;
let agentsDir: string;
let dataDir: string;

beforeEach(async () => {
  root = join(tmpdir(), `nouride-backup-${Math.floor(performance.now() * 1000)}`);
  agentsDir = join(root, "agents");
  dataDir = join(root, "data");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  await writeTextFileAtomic(join(agentsDir, "nouva", "IDENTITY.md"), "# IDENTITY\nNouva\n");
  await writeTextFileAtomic(join(agentsDir, "nouva", "MEMORY.md"), "## Preferences\n- Prefers Bun\n");
  await writeTextFileAtomic(join(agentsDir, "nouva", "config.toml"), "[agent]\nenabled = true\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const backupsRoot = () => join(dataDir, "backups", "agents");

describe("backupAgents", () => {
  test("copies the files that cannot be rebuilt", async () => {
    const result = await backupAgents({ agentsDir, dataDir, keep: 7, now: () => 1_000_000 });

    expect(result.agents).toBe(1);
    expect(result.files).toBe(3);
    expect(
      await readTextFileIfExists(join(result.path as string, "nouva", "MEMORY.md")),
    ).toContain("Prefers Bun");
  });

  test("a file a pack does not have is not invented", async () => {
    // Writing an empty `SOUL.md` would make a restore create files the original never had, and an
    // empty soul is not the same as no soul.
    const result = await backupAgents({ agentsDir, dataDir, keep: 7, now: () => 1_000_000 });
    expect(await readTextFileIfExists(join(result.path as string, "nouva", "SOUL.md"))).toBeNull();
  });

  test("the workspace is not backed up", async () => {
    // It is output, and it can be large. The pack is the irreplaceable half.
    await writeTextFileAtomic(join(agentsDir, "nouva", "scratch.bin"), "x".repeat(100));
    const result = await backupAgents({ agentsDir, dataDir, keep: 7, now: () => 1_000_000 });
    expect(await readTextFileIfExists(join(result.path as string, "nouva", "scratch.bin"))).toBeNull();
  });

  test("keeps the newest and drops the oldest", async () => {
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 5; i += 1) {
      await backupAgents({ agentsDir, dataDir, keep: 3, now: () => 1_000_000_000 + i * day });
    }

    const { listDir } = await import("@nouride/runtime");
    const kept = listDir(backupsRoot())
      .filter((e) => e.isDirectory)
      .map((e) => e.name)
      .sort();

    expect(kept).toHaveLength(3);
    // Sorted by name, which sorts chronologically because the stamp was built to — not by mtime,
    // which changes when a filesystem is restored from a backup and would either wipe a restored
    // archive or never fire.
    expect(kept[2]).toContain("1970");
  });

  test("keep of zero disables the sweep rather than deleting everything", async () => {
    // The same rule `retention_days = 0` follows. A knob whose off position means "delete all" is a
    // knob nobody can safely try.
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      await backupAgents({ agentsDir, dataDir, keep: 0, now: () => 1_000_000_000 + i * day });
    }
    const { listDir } = await import("@nouride/runtime");
    expect(listDir(backupsRoot()).filter((e) => e.isDirectory)).toHaveLength(3);
  });

  test("no agents means nothing written, not an empty snapshot", async () => {
    rmSync(agentsDir, { recursive: true, force: true });
    mkdirSync(agentsDir, { recursive: true });

    const result = await backupAgents({ agentsDir, dataDir, keep: 7 });
    expect(result).toMatchObject({ path: null, agents: 0, files: 0 });
  });

  test("a failure is logged and swallowed", async () => {
    // The daemon being useful is more common than the disaster this protects against. An operator who
    // finds no snapshots has lost less than one who finds no daemon.
    const result = await backupAgents({
      agentsDir: join(root, "does-not-exist"),
      dataDir,
      keep: 7,
    });
    expect(result.path).toBeNull();
  });

  test("preparing the directory twice is not an error", () => {
    prepareBackupDir(dataDir);
    expect(() => prepareBackupDir(dataDir)).not.toThrow();
  });
});
