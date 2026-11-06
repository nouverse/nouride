/**
 * The vault's format marker (`format.ts`): what a vault says it is, and what one from before the marker is read as;
 * memory booted over a new vault, a 0.7 one, and the two this build refuses — 0.6's, which the floor's release lays
 * out, and one a newer build wrote — each before the database is opened.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { bootMemory, checkMemoryVault } from "@/boot/memory.ts";
import { openAndMigrate } from "@/db/index.ts";
import { parseConfig } from "@/modules/config/global/index.ts";
import { readVaultFormat, VAULT_FORMAT, VaultFormatError } from "@/modules/memory/format.ts";
import { vaultAt, type Vault } from "@/modules/memory/vault.ts";
import { isolateInstallPaths, tempDir } from "../helpers.ts";

let dir: string;
let vault: Vault;
let db: SqliteDb | null = null;

beforeEach(() => {
  dir = tempDir("vault-format");
  // Where `isolateInstallPaths` puts it, so the daemon booted below reads this one.
  vault = vaultAt(join(dir, "data", "memory"));
});

afterEach(() => {
  db?.close();
  db = null;
  removePath(dir);
});

const EPISODE = "episodes/2026/09/2026-09-25-0900-nouva.md";
const MARKER = ".nouride-vault.json";

/** One conversation as 0.6 wrote it: its day linked flat. */
const EPISODE_06 = [
  "---",
  "id: 2026-09-25-0900-nouva",
  "type: episode",
  "status: summarized",
  "kind: dm",
  "chat: telegram:nouva:814",
  "started: 2026-09-25T09:00:00+07:00",
  "ended: 2026-09-25T09:05:00+07:00",
  'day: "[[days/2026-09-25]]"',
  'agents: ["[[agents/nouva]]"]',
  'people: ["[[people/gading]]"]',
  'summary: "Gading said hello."',
  "---",
  "",
  "09:00 · Gading",
  "Halo",
  "",
].join("\n");
const EPISODE_07 = EPISODE_06.replace("[[days/2026-09-25]]", "[[days/2026/09/2026-09-25]]");
const HUB = ["---", "type: day", "---", "", "# 2026-09-25", "", "- [[2026-09-25-0900-nouva]] · nouva · Gading said hello.", ""].join("\n");

/** A file in the vault, written as a build left it. */
function put(path: string, text: string): void {
  mkdirSync(dirname(join(vault.root, path)), { recursive: true });
  writeFileSync(join(vault.root, path), text);
}

function read(path: string): string | null {
  const file = join(vault.root, path);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** As 0.6 left it: the hub flat in `days/`, the episode linking it there, no marker. */
function vault06(): void {
  put(EPISODE, EPISODE_06);
  put("days/2026-09-25.md", HUB);
}

/** As 0.7 left it before the marker: the hub by month. */
function vault07(): void {
  put(EPISODE, EPISODE_07);
  put("days/2026/09/2026-09-25.md", HUB);
}

const snapshots = () => join(dir, "data", "backups", "memory");
const database = () => join(dir, "data", "nouride.db");

/** Memory booted the way the daemon boots it, over this vault: its format read first, then the database, then memory. */
async function boot() {
  const config = parseConfig({});
  isolateInstallPaths(config, join(dir, "data"));
  const vaultFormat = await checkMemoryVault(config);
  db = await openAndMigrate(database());
  return await bootMemory(config, db, {
    turns: { exchangesBetween: () => [], chatsActiveSince: () => [] },
    roomMessages: { between: () => [], isRoom: () => false, forChat: () => [] },
    providers: {
      get: () => {
        throw new Error("no model is asked anything here");
      },
    },
    vaultFormat,
  });
}

/** What `boot()` threw, or null when it booted. */
const refusal = () =>
  boot().then(
    () => null,
    (err: unknown) => err,
  );

describe("which format a vault is in", () => {
  test("what its marker says — and before the marker, where its day hubs are", async () => {
    expect(await readVaultFormat(vault)).toEqual({ format: 2, marked: false });
    vault06();
    expect(await readVaultFormat(vault)).toEqual({ format: 1, marked: false });
    // Once there is a marker, it is what decides: the same flat hub, read as the marker says.
    put(MARKER, '{"format": 2}\n');
    expect(await readVaultFormat(vault)).toEqual({ format: 2, marked: true });
    put(MARKER, '{"format": 7}\n');
    expect(await readVaultFormat(vault)).toEqual({ format: 7, marked: true });
  });

  test("a marker that cannot be read says why, and the files decide", async () => {
    vault06();
    put(MARKER, '{"format": "two"}\n');
    expect(await readVaultFormat(vault)).toEqual({ format: 1, marked: false, unreadable: 'it has no whole number as "format"' });
    put(MARKER, "{format: 2");
    expect(await readVaultFormat(vault)).toEqual({ format: 1, marked: false, unreadable: "it is not JSON" });
  });
});

describe("memory at boot", () => {
  test("a new vault is marked with this build's format", async () => {
    await boot();
    expect(read(MARKER)).toBe(`{"format": ${VAULT_FORMAT}}\n`);
  });

  test("a 0.6 vault with no marker is refused, naming the release that lays it out — and nothing is touched or opened", async () => {
    vault06();
    const refused = await refusal();
    expect(refused).toBeInstanceOf(VaultFormatError);
    const message = (refused as Error).message;
    // A 0.7.x lays it out, and 0.8.0 — the floor — reads it then: both steps, since 0.8.0 alone would refuse it too.
    expect(message).toStartWith(`refusing to start: the memory vault at ${vault.root} is format 1, 0.6's (its day hubs flat in days/), and this version reads format 2 only, which a 0.7.x lays it out in: install 0.7.29 first.`);
    expect(message).toContain("install 0.7.29 and start it once (it lays the vault out by month, after a snapshot), then 0.8.0 once, then this version again");
    expect(message).toContain("run ghcr.io/nouverse/nouride:0.7 once on the same volume, then ghcr.io/nouverse/nouride:0.8.0 once, then this image again");
    expect(read("days/2026-09-25.md")).toBe(HUB);
    expect(read(EPISODE)).toBe(EPISODE_06);
    expect(read(MARKER)).toBeNull();
    expect(existsSync(snapshots())).toBe(false);
    expect(existsSync(database())).toBe(false);
  });

  test("a vault marked 1, as 0.7's `nouride db restore` left one for 0.6, is refused the same way", async () => {
    vault07();
    put(MARKER, '{"format": 1}\n');
    expect(((await refusal()) as Error).message).toContain("is format 1, 0.6's");
    expect(read(MARKER)).toBe('{"format": 1}\n');
  });

  test("a 0.7 vault from before the marker is marked as it is: nothing moved, nothing snapshotted", async () => {
    vault07();
    await boot();
    expect(read(EPISODE)).toBe(EPISODE_07);
    expect(read(MARKER)).toBe('{"format": 2}\n');
    expect(existsSync(snapshots())).toBe(false);
  });

  test("the marker decides, not the files: a vault marked 2 is not refused for a flat file in days/", async () => {
    vault07();
    put(MARKER, '{"format": 2}\n');
    // A note somebody keeps in `days/`, named the way 0.6 named a hub.
    put("days/2026-09-26.md", "Notes for the 26th.\n");
    await boot();
    expect(read("days/2026-09-26.md")).toBe("Notes for the 26th.\n");
    expect(existsSync(snapshots())).toBe(false);
  });

  test("a marker that cannot be read is replaced by what the files say", async () => {
    vault07();
    put(MARKER, "not json");
    await boot();
    expect(read(EPISODE)).toBe(EPISODE_07);
    expect(read(MARKER)).toBe('{"format": 2}\n');
  });

  test("a vault a newer build wrote refuses the boot, naming the file and both formats — and nothing in it is touched", async () => {
    vault06();
    put(MARKER, '{"format": 3}\n');
    const refused = await refusal();
    expect(refused).toBeInstanceOf(VaultFormatError);
    const message = (refused as Error).message;
    expect(message).toStartWith("refusing to start: the memory vault is format 3, and this build reads format 2");
    expect(message).toContain(join(vault.root, MARKER));
    // The way back is named, with where the snapshots are.
    expect(message).toContain("start the newer build again");
    expect(message).toContain(snapshots());
    expect(read("days/2026-09-25.md")).toBe(HUB);
    expect(read(EPISODE)).toBe(EPISODE_06);
    expect(read(MARKER)).toBe('{"format": 3}\n');
    expect(existsSync(database())).toBe(false);
    expect(existsSync(snapshots())).toBe(false);
  });

  test("the daemon does not start over a 0.6 vault, says why as a refusal, and opens no database", async () => {
    vault06();
    // Recorded as the floor's, so the boot's first check (`boot/upgrade-floor.ts`) lets it by and the vault's is the one
    // that refuses — a vault copied in after the floor ran. No database yet: the vault is checked before one is opened,
    // so none is made.
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "data", "last-run-version"), "0.8.0\n");

    const config = join(dir, "config.toml");
    writeFileSync(
      config,
      [
        "[daemon]",
        `data_dir = "${join(dir, "data")}"`,
        `agents_dir = "${join(dir, "agents")}"`,
        `workspace_dir = "${join(dir, "workspace")}"`,
        "[memory]",
        `dir = "${vault.root}"`,
        "[dashboard]",
        "enabled = false",
        "[nougate]",
        "in_process = false",
        "",
      ].join("\n"),
    );
    // Nothing from this shell may point the daemon at a real install: no data directory, port or gateway of its own.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NOURIDE_|NOUGATE_|INITIAL_ADMIN_)/.test(name) && !["PORT", "HOST", "LOG_LEVEL"].includes(name)));
    const child = spawn("bun", [join(import.meta.dir, "../../src/index.ts")], { cwd: dir, env: { ...env, NOURIDE_CONFIG: config } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    // A daemon that started after all would never exit on its own.
    const started = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    clearTimeout(started);
    expect(code).toBe(1);
    expect(out).toContain('"message":"fatal: boot refused"');
    expect(out).toContain(`\nrefusing to start: the memory vault at ${vault.root} is format 1, 0.6's`);
    expect(out).not.toContain("fatal: boot failed");
    expect(out).not.toMatch(/^\s+at /m);
    expect(existsSync(database())).toBe(false);
    expect(read(EPISODE)).toBe(EPISODE_06);
  }, 30_000);
});
