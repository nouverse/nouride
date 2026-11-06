/**
 * Snapshots of the vault.
 *
 * The vault is memory's truth and the database only its index, so the vault is what must survive a
 * lost disk. Each snapshot is a full tree (recovery is `cp -r`); unchanged files share one copy.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTextFileIfExists } from "@nouride/runtime";
import { backupVault } from "@/modules/memory/backup.ts";

let root: string;
let vaultDir: string;
let dataDir: string;

/** Each write an hour ago and a second after the last — a vault edited by people, not in the last few milliseconds. */
let written = 0;
const write = (path: string, text: string) => {
  mkdirSync(join(vaultDir, path, ".."), { recursive: true });
  writeFileSync(join(vaultDir, path), text);
  const at = (Date.now() - 3_600_000 + (written += 1) * 1000) / 1000;
  utimesSync(join(vaultDir, path), at, at);
};

beforeEach(() => {
  root = join(tmpdir(), `nouride-vault-backup-${Math.floor(performance.now() * 1000)}`);
  vaultDir = join(root, "memory");
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  write("people/sam.md", "## Life\n- Likes tea.\n");
  write("episodes/2026/09/2026-09-25-0459-nouva.md", "---\nid: x\n---\nuser: hi\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;

describe("backupVault", () => {
  test("a snapshot is the whole tree, readable without Nouride", async () => {
    const result = await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    expect(result.files).toBe(2);
    expect(await readTextFileIfExists(join(result.path!, "people/sam.md"))).toContain("Likes tea.");
    expect(await readTextFileIfExists(join(result.path!, "episodes/2026/09/2026-09-25-0459-nouva.md"))).toContain("user: hi");
  });

  test("an unchanged file shares the previous snapshot's copy; a changed one does not", async () => {
    const first = await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    // Same length on purpose: the size check alone must not be what tells them apart.
    write("people/sam.md", "## Life\n- Likes tee.\n");
    const second = await backupVault({ vaultDir, dataDir, keep: 7, now: () => 2 * DAY });

    expect(second.linked).toBe(1);
    const episode = "episodes/2026/09/2026-09-25-0459-nouva.md";
    expect(statSync(join(second.path!, episode)).ino).toBe(statSync(join(first.path!, episode)).ino);
    expect(statSync(join(second.path!, "people/sam.md")).ino).not.toBe(statSync(join(first.path!, "people/sam.md")).ino);
    // The older snapshot still says what the vault said then.
    expect(await readTextFileIfExists(join(first.path!, "people/sam.md"))).toContain("Likes tea.");
    expect(await readTextFileIfExists(join(second.path!, "people/sam.md"))).toContain("Likes tee.");
  });

  test("a file changed a moment ago is copied, even when its size and time say it is the one already copied", async () => {
    // What a coarse timestamp tick does: rewritten to the same length straight after the copy, the time does not move.
    const sam = join(vaultDir, "people/sam.md");
    const recent = (Date.now() - 500) / 1000;
    utimesSync(sam, recent, recent);
    const first = await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    writeFileSync(sam, "## Life\n- Likes tee.\n");
    utimesSync(sam, recent, recent);
    const second = await backupVault({ vaultDir, dataDir, keep: 7, now: () => 2 * DAY });

    expect(statSync(join(second.path!, "people/sam.md")).ino).not.toBe(statSync(join(first.path!, "people/sam.md")).ino);
    expect(await readTextFileIfExists(join(second.path!, "people/sam.md"))).toContain("Likes tee.");
  });

  test("the oldest snapshots go, and a shared file survives its older name going", async () => {
    await backupVault({ vaultDir, dataDir, keep: 2, now: () => DAY });
    await backupVault({ vaultDir, dataDir, keep: 2, now: () => 2 * DAY });
    const third = await backupVault({ vaultDir, dataDir, keep: 2, now: () => 3 * DAY });
    expect(third.removed).toBe(1);
    expect(await readTextFileIfExists(join(third.path!, "people/sam.md"))).toContain("Likes tea.");
  });

  test("a snapshot taken before a rewrite stays out of the rotation, and only the newest of its kind is kept", async () => {
    for (let day = 1; day <= 3; day += 1) await backupVault({ vaultDir, dataDir, keep: 3, now: () => day * DAY });
    const first = await backupVault({ vaultDir, dataDir, keep: 3, now: () => 3 * DAY + 60_000, before: "tidy" });
    const second = await backupVault({ vaultDir, dataDir, keep: 3, now: () => 3 * DAY + 120_000, before: "tidy" });
    expect(second.path).toEndWith("-before-tidy");
    expect(second.removed).toBe(1);
    const left = readdirSync(join(dataDir, "backups", "memory")).sort();
    expect(left.filter((name) => !name.includes("-before-"))).toHaveLength(3);
    expect(left.filter((name) => name.includes("-before-"))).toEqual([second.path!.split("/").at(-1)!]);
    expect(first.path).not.toBe(second.path);
  });

  test("a write in flight is not backed up", async () => {
    write("people/sam.md.123.tmp", "half");
    const result = await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    expect(await readTextFileIfExists(join(result.path!, "people/sam.md.123.tmp"))).toBeNull();
  });

  test("a vault that holds the backup directory is refused rather than copied into itself", async () => {
    const result = await backupVault({ vaultDir: root, dataDir, keep: 7, now: () => DAY });
    expect(result.path).toBeNull();
  });

  test("an empty vault writes nothing", async () => {
    rmSync(vaultDir, { recursive: true, force: true });
    const result = await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    expect(result.path).toBeNull();
  });
});

describe("deciding a link from size and time (E10)", () => {
  /**
   * Linking used to read every vault file and its previous copy on every snapshot, from an SD card. Now a copy keeps
   * its source's time, and the next snapshot compares two stats. The test is the trade it makes: a file whose bytes
   * changed while its size and time did not is linked — `rsync`'s quick check, never met by an atomic rename.
   */
  const SAM = "people/sam.md";

  test("a copy keeps its source's modification time", async () => {
    const first = await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    expect(Math.abs(statSync(join(first.path!, SAM)).mtimeMs - statSync(join(vaultDir, SAM)).mtimeMs)).toBeLessThan(1);
  });

  test("same size and time is linked without reading; a new time is copied", async () => {
    const first = await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    const was = statSync(join(vaultDir, SAM));
    write(SAM, "## Life\n- Likes tee.\n");
    utimesSync(join(vaultDir, SAM), was.atime, was.mtime);
    const second = await backupVault({ vaultDir, dataDir, keep: 7, now: () => 2 * DAY });
    expect(statSync(join(second.path!, SAM)).ino).toBe(statSync(join(first.path!, SAM)).ino);

    utimesSync(join(vaultDir, SAM), was.atime, new Date(was.mtimeMs + 5_000));
    const third = await backupVault({ vaultDir, dataDir, keep: 7, now: () => 3 * DAY });
    expect(statSync(join(third.path!, SAM)).ino).not.toBe(statSync(join(second.path!, SAM)).ino);
    expect(await readTextFileIfExists(join(third.path!, SAM))).toContain("Likes tee.");
  });

  test("with `skipUnchanged`, a vault as the previous snapshot has it writes nothing — unless a file came or went", async () => {
    await backupVault({ vaultDir, dataDir, keep: 7, now: () => DAY });
    expect(await backupVault({ vaultDir, dataDir, keep: 7, now: () => 2 * DAY, skipUnchanged: true })).toMatchObject({ path: null, unchanged: true });
    write("people/mira.md", "- new\n");
    expect((await backupVault({ vaultDir, dataDir, keep: 7, now: () => 3 * DAY, skipUnchanged: true })).path).not.toBeNull();
    // Taken before a rewrite, it is that rewrite's way back: always written.
    expect((await backupVault({ vaultDir, dataDir, keep: 7, now: () => 4 * DAY, skipUnchanged: true, before: "tidy" })).path).not.toBeNull();
  });
});
