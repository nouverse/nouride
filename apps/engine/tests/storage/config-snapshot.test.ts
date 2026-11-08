/**
 * What the snapshots did not hold before 0.8.18: the daemon's config and its people, the install's MCP
 * library, the skill pool, a pack's `skills.toml` and `mcp.toml`; and a skill improvement kept nothing of the version it
 * replaced. Each now has its snapshot, on the schedule the database, the vault and the packs keep.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupAgents, listSkills, updateExistingSkill } from "@nouride/persona";
import { backupConfig, backupSkillPool } from "@/modules/config/snapshot.ts";
import { newestSnapshotAt, snapshotFiles } from "@/commons/snapshot-files.ts";
import { eventually } from "../helpers.ts";
import { startConfigBackups } from "@/boot/maintenance.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** An install: config.toml, two people with a backup and history beside them, the MCP library, a skill. */
function install() {
  dir = mkdtempSync(join(tmpdir(), "config-snapshot-"));
  const home = join(dir, ".nouride");
  const agentsDir = join(home, "agents");
  const dataDir = join(home, "data");
  for (const folder of [join(home, "people", "history", "ani.toml"), join(agentsDir, "skills", "deploy"), join(agentsDir, "nouva"), dataDir]) mkdirSync(folder, { recursive: true });
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "home"\n');
  writeFileSync(join(home, "people", "ani.toml"), '[person]\nname = "Ani"\n');
  writeFileSync(join(home, "people", "budi.toml"), '[person]\nname = "Budi"\n');
  writeFileSync(join(home, "people", "ani.toml.bak.1"), '[person]\nname = "Old"\n');
  writeFileSync(join(home, "people", "history", "ani.toml", "2026-11-01T00-00-00-000Z"), "old");
  writeFileSync(join(agentsDir, "mcp.toml"), '[[servers]]\nname = "echo"\n');
  writeFileSync(join(agentsDir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\nSteps.\n");
  writeFileSync(join(agentsDir, "skills", "deploy", "notes.md"), "Details.\n");
  writeFileSync(join(agentsDir, "nouva", "SOUL.md"), "Kind.\n");
  writeFileSync(join(agentsDir, "nouva", "skills.toml"), "deploy = true\n");
  writeFileSync(join(agentsDir, "nouva", "mcp.toml"), "[servers.echo]\non = true\n");
  return { home, configPath, agentsDir, dataDir };
}

const files = (root: string, prefix = ""): string[] =>
  readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(root, path) : [path];
  });

describe("the config snapshot", () => {
  test("holds config.toml, each person's file and the MCP library, not their backups or history, and copies back as it was", () => {
    const at = install();
    const taken = backupConfig({ configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4 });
    expect(taken.path).not.toBeNull();
    expect(files(taken.path!).sort()).toEqual(["config.toml", "mcp.toml", "people/ani.toml", "people/budi.toml"]);
    expect(readFileSync(join(taken.path!, "people", "ani.toml"), "utf8")).toBe('[person]\nname = "Ani"\n');
    expect(taken.path!.startsWith(join(at.dataDir, "backups", "config"))).toBe(true);
  });

  test("nothing changed is nothing written; a changed person is a new snapshot", () => {
    const at = install();
    const opts = { configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4, skipUnchanged: true };
    // Written an hour ago: a file changed in the last two seconds is never believed the same by its size and time.
    const hourAgo = new Date(Date.now() - 3_600_000);
    for (const file of [at.configPath, join(at.home, "people", "ani.toml"), join(at.home, "people", "budi.toml"), join(at.agentsDir, "mcp.toml")]) utimesSync(file, hourAgo, hourAgo);
    backupConfig({ ...opts, now: () => Date.UTC(2026, 10, 1) });
    expect(backupConfig({ ...opts, now: () => Date.UTC(2026, 10, 8) }).unchanged).toBe(true);
    writeFileSync(join(at.home, "people", "budi.toml"), '[person]\nname = "Budi"\nnotes = "Chess."\n');
    const again = backupConfig({ ...opts, now: () => Date.UTC(2026, 10, 15) });
    expect(again.unchanged).toBeUndefined();
    expect(readFileSync(join(again.path!, "people", "budi.toml"), "utf8")).toContain("Chess.");
  });
});

describe("the skill pool snapshot", () => {
  test("holds every skill's files", () => {
    const at = install();
    const taken = backupSkillPool({ agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4 });
    expect(files(taken.path!).sort()).toEqual(["deploy/SKILL.md", "deploy/notes.md"]);
    expect(taken.path!.startsWith(join(at.dataDir, "backups", "skills"))).toBe(true);
  });
});

describe("what a snapshot cannot or need not copy", () => {
  test("a link, a socket and what a skill's tools installed are left out, and the pool's snapshot is whole", async () => {
    const at = install();
    const tools = join(at.agentsDir, "skills", "deploy", "tools");
    mkdirSync(join(tools, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(tools, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(tools, "__pycache__"), { recursive: true });
    writeFileSync(join(tools, "__pycache__", "run.cpython-313.pyc"), "x");
    // As the live pool had it (2026-11-05): a package linked to a global install, a folder the copy cannot read as a file.
    symlinkSync(tmpdir(), join(tools, "playwright"));
    const socket = join(tools, "s.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const taken = backupSkillPool({ agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4 });
      expect(files(taken.path!).sort()).toEqual(["deploy/SKILL.md", "deploy/notes.md"]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("a copy that stops half-way leaves no snapshot behind, nor its unfinished folder", () => {
    const at = install();
    const root = join(at.dataDir, "backups", "config");
    expect(() =>
      snapshotFiles({ root, files: [{ rel: "config.toml", abs: at.configPath }, { rel: "gone.toml", abs: join(at.home, "gone.toml") }], keep: 4, now: Date.UTC(2026, 10, 5) }),
    ).toThrow();
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([]);
  });
});

describe("a snapshot whose process is killed half-way", () => {
  // Linux's copy of a pipe waits for a writer, a copy that never ends; macOS refuses it at once, and nothing is killed.
  test.skipIf(process.platform !== "linux")("is not taken for one, and the next snapshot sweeps what it left", async () => {
    const at = install();
    const root = join(at.dataDir, "backups", "config");
    // A copy that never ends: a pipe nobody writes to, handed in as a file, then the process killed.
    const pipe = join(at.home, "pipe");
    spawnSync("mkfifo", [pipe]);
    // An hour old, so a copy of it is believed the same by its size and time: what a next snapshot would link to.
    const hourAgo = new Date(Date.now() - 3_600_000);
    for (const file of [at.configPath, join(at.home, "people", "ani.toml"), join(at.home, "people", "budi.toml"), join(at.agentsDir, "mcp.toml")]) utimesSync(file, hourAgo, hourAgo);
    const script = `import { snapshotFiles } from "@/commons/snapshot-files.ts";
      snapshotFiles({ root: ${JSON.stringify(root)}, files: [{ rel: "config.toml", abs: ${JSON.stringify(at.configPath)} }, { rel: "pipe", abs: ${JSON.stringify(pipe)} }], keep: 4, now: Date.UTC(2026, 10, 5) });`;
    const child = spawn(process.execPath, ["-e", script], { cwd: join(import.meta.dir, "..", "..") });
    await eventually(() => existsSync(root) && readdirSync(root).length > 0, 8_000, "the snapshot begun");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(newestSnapshotAt([root])).toBeNull();
    expect(readdirSync(root).every((name) => name.startsWith("."))).toBe(true);
    const taken = backupConfig({ configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4 });
    expect(taken.path).not.toBeNull();
    // Copied whole, not linked to the copy the killed process had made: that one was never a snapshot.
    expect(taken.linked).toBe(0);
    expect(readdirSync(root).filter((name) => name.startsWith("."))).toEqual([]);
  });
});

describe("on the snapshot schedule", () => {
  test("the first start takes both", () => {
    const at = install();
    const config = structuredClone(DEFAULT_CONFIG);
    config.daemon.dataDir = at.dataDir;
    config.daemon.agentsDir = at.agentsDir;
    const timers = startConfigBackups(config, at.configPath, () => null);
    try {
      expect(readdirSync(join(at.dataDir, "backups", "config"))).toHaveLength(1);
      expect(readdirSync(join(at.dataDir, "backups", "skills"))).toHaveLength(1);
    } finally {
      for (const timer of timers) clearInterval(timer);
    }
  });
});

describe("a pack's snapshot", () => {
  test("holds its skills.toml and its mcp.toml beside its persona files", async () => {
    const at = install();
    const taken = await backupAgents({ agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4 });
    expect(files(taken.path!).filter((file) => file.startsWith("nouva/")).sort()).toEqual(["nouva/SOUL.md", "nouva/mcp.toml", "nouva/skills.toml"]);
  });
});

describe("a skill's improvement", () => {
  test("keeps the version it replaces in skills/.history/, which the pool does not read as a skill", async () => {
    const at = install();
    const updated = await updateExistingSkill(at.agentsDir, { name: "deploy", description: "Ship it.", body: "Better steps.\n" });
    expect(updated.ok).toBe(true);
    const history = join(at.agentsDir, "skills", ".history", "deploy");
    const kept = readdirSync(history);
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(history, kept[0]!), "utf8")).toContain("Steps.");
    expect(readFileSync(join(at.agentsDir, "skills", "deploy", "SKILL.md"), "utf8")).toContain("Better steps.");
    expect((await listSkills(join(at.agentsDir, "skills"), "shared", {})).map((skill) => skill.name)).toEqual(["deploy"]);
    expect(existsSync(join(at.agentsDir, "skills", ".history", "deploy", "SKILL.md"))).toBe(false);
  });
});
