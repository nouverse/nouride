/**
 * Finding the install, from wherever the command was typed.
 *
 * Two bugs meet in this file, and the second is the dangerous one.
 *
 * The visible one: the CLI is on `PATH` as a symlink, and it resolved the install against the
 * **current working directory**. `nouride status` from `/root` reported no daemon while one ran
 * perfectly, so every command in a live session had to be written `cd /srv/nouride && ./nouride …`.
 *
 * The quiet one: relative paths in `config.toml` are relative to the *install*, not the cwd.
 * Resolving `data_dir = "./.nouride/data"` against the wrong base does not fail — it creates an
 * empty database beside the real one and reports a healthy boot with no agents and no history.
 * A handoff note recorded that as an hour lost, and widening the search is exactly what would have
 * spread it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { configuredDataDir, loadGlobalConfig } from "@/modules/config/global/index.ts";

const DIR = resolve(mkdtempSync(join(tmpdir(), "nouride-tmp-config-resolution-")));
const INSTALL = join(DIR, "install");
const ELSEWHERE = join(DIR, "elsewhere");

function writeInstall(root: string, body: string): void {
  mkdirSync(join(root, ".nouride"), { recursive: true });
  writeFileSync(join(root, ".nouride", "config.toml"), body);
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(ELSEWHERE, { recursive: true });
  writeInstall(INSTALL, '[daemon]\norchestrator = "from-install"\n');
});

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  delete process.env.NOURIDE_HOME;
  delete process.env.NOURIDE_CONFIG;
});

describe("where the config comes from", () => {
  test("the cwd's install wins, as it always did", async () => {
    const { config, source } = await loadGlobalConfig(INSTALL);
    expect(config.daemon.orchestrator).toBe("from-install");
    expect(source).toBe(join(INSTALL, ".nouride", "config.toml"));
  });

  test("a project's own config.toml is not this one's — a bare one is read only beside an install", async () => {
    // A Hugo site, say: its config.toml was read as Nouride's, with a data directory under the project.
    writeFileSync(join(ELSEWHERE, "config.toml"), 'baseURL = "https://example.org/"\ntitle = "a site"\n');
    expect((await loadGlobalConfig(ELSEWHERE)).source).toBeNull();
    // Beside an install it is the hand-written file it always was.
    mkdirSync(join(ELSEWHERE, ".nouride"), { recursive: true });
    writeFileSync(join(ELSEWHERE, "config.toml"), '[daemon]\norchestrator = "by-hand"\n');
    const beside = await loadGlobalConfig(ELSEWHERE);
    expect(beside.source).toBe(join(ELSEWHERE, "config.toml"));
    expect(beside.config.daemon.orchestrator).toBe("by-hand");
  });

  test("standing somewhere else finds nothing, and boots on defaults", async () => {
    // The binary here is `bun`, whose directory holds no install — so the executable candidate
    // never matches, which is the property that makes it safe to add without a mode flag.
    const { source } = await loadGlobalConfig(ELSEWHERE);
    expect(source).toBeNull();
  });

  test("$NOURIDE_HOME names an install from anywhere", async () => {
    process.env.NOURIDE_HOME = INSTALL;
    const { config, source } = await loadGlobalConfig(ELSEWHERE);
    expect(config.daemon.orchestrator).toBe("from-install");
    expect(source).toBe(join(INSTALL, ".nouride", "config.toml"));
  });

  test("$NOURIDE_HOME is the install even before it has a config", async () => {
    // A fresh container: no config.toml yet, the CLI run from somewhere else. The data directory is
    // still the install's, or `nouride status` looks for a control token that is not there.
    const empty = join(DIR, "empty-install");
    mkdirSync(empty, { recursive: true });
    process.env.NOURIDE_HOME = empty;
    const { config, source } = await loadGlobalConfig(ELSEWHERE);
    expect(source).toBeNull();
    expect(config.daemon.dataDir.startsWith(empty)).toBe(true);
  });

  test("$NOURIDE_CONFIG beats $NOURIDE_HOME — the more specific answer wins", async () => {
    const other = join(DIR, "explicit.toml");
    writeFileSync(other, '[daemon]\norchestrator = "from-explicit"\n');
    process.env.NOURIDE_HOME = INSTALL;
    process.env.NOURIDE_CONFIG = other;

    const { config } = await loadGlobalConfig(ELSEWHERE);
    expect(config.daemon.orchestrator).toBe("from-explicit");
  });

  test("a checkout's own config is never overridden by an install elsewhere", async () => {
    // The ordering that matters for anyone developing against a source tree while a daemon runs.
    process.env.NOURIDE_HOME = INSTALL;
    writeInstall(ELSEWHERE, '[daemon]\norchestrator = "from-checkout"\n');

    // NOURIDE_HOME is explicit, so it still wins — but the cwd beats the *executable* directory,
    // which is the implicit one.
    const { config } = await loadGlobalConfig(ELSEWHERE);
    expect(config.daemon.orchestrator).toBe("from-install");

    delete process.env.NOURIDE_HOME;
    const fallback = await loadGlobalConfig(ELSEWHERE);
    expect(fallback.config.daemon.orchestrator).toBe("from-checkout");
  });
});

describe("relative paths resolve against the install, not the cwd", () => {
  test("a config found through $NOURIDE_HOME still points at its own directories", async () => {
    writeInstall(
      INSTALL,
      '[daemon]\ndata_dir = "./.nouride/data"\nagents_dir = "./.nouride/agents"\n',
    );
    process.env.NOURIDE_HOME = INSTALL;

    // Called from somewhere else entirely — the cwd must contribute nothing to these.
    const { config } = await loadGlobalConfig(ELSEWHERE);

    expect(config.daemon.dataDir).toBe(join(INSTALL, ".nouride", "data"));
    expect(config.daemon.agentsDir).toBe(join(INSTALL, ".nouride", "agents"));
    // The failure this guards: an empty database created beside the real one, reported as a
    // healthy boot with no agents and no history.
    expect(config.daemon.dataDir.startsWith(ELSEWHERE)).toBe(false);
  });

  test("a hand-written config beside the binary resolves against that directory", async () => {
    // The other shape: `<root>/config.toml` rather than `<root>/.nouride/config.toml`, so the
    // install root is one level up, not two.
    const flat = join(DIR, "flat");
    mkdirSync(flat, { recursive: true });
    writeFileSync(join(flat, "config.toml"), '[daemon]\ndata_dir = "./data"\n');
    process.env.NOURIDE_HOME = flat;

    const { config } = await loadGlobalConfig(ELSEWHERE);
    expect(config.daemon.dataDir).toBe(join(flat, "data"));
  });

  test("backup_dir resolves like the other directories, and unset stays unset", async () => {
    // Empty means "the data directory's own backups" — resolved against the install it would become
    // the install directory itself, and every snapshot would land beside the binary.
    writeInstall(INSTALL, '[daemon]\nbackup_dir = "./usb/nouride"\n');
    process.env.NOURIDE_HOME = INSTALL;
    expect((await loadGlobalConfig(ELSEWHERE)).config.daemon.backupDir).toBe(join(INSTALL, "usb", "nouride"));

    writeInstall(INSTALL, "[daemon]\n");
    expect((await loadGlobalConfig(ELSEWHERE)).config.daemon.backupDir).toBe("");
  });

  test("with no config at all, relative defaults still resolve against the cwd", async () => {
    // Unchanged behaviour for a fresh checkout, which has no config and must still boot.
    const { config, source } = await loadGlobalConfig(ELSEWHERE);
    expect(source).toBeNull();
    expect(config.daemon.dataDir.startsWith(ELSEWHERE)).toBe(true);
  });
});

describe("a fresh install, before setup has written a config", () => {
  /** What the installer leaves: the binary's directory with an empty `.nouride/`, and no config in it yet. */
  const FRESH = join(DIR, "srv-nouride");
  beforeEach(() => mkdirSync(join(FRESH, ".nouride", "data"), { recursive: true }));

  test("is the binary's own install from anywhere else — root's home, say — not one under the cwd", async () => {
    const { config, source } = await loadGlobalConfig(ELSEWHERE, { execRoot: FRESH });
    expect(source).toBeNull();
    expect(config.daemon.dataDir).toBe(join(FRESH, ".nouride", "data"));
  });

  test("gives way to an install the cwd holds — standing in one, or in a checkout", async () => {
    mkdirSync(join(ELSEWHERE, ".nouride"), { recursive: true });
    const { config } = await loadGlobalConfig(ELSEWHERE, { execRoot: FRESH });
    expect(config.daemon.dataDir).toBe(join(ELSEWHERE, ".nouride", "data"));
  });

  test("is the cwd when the binary's directory holds no install either — `bun` in a checkout", async () => {
    const { config } = await loadGlobalConfig(ELSEWHERE, { execRoot: join(DIR, "no-install-here") });
    expect(config.daemon.dataDir.startsWith(ELSEWHERE)).toBe(true);
  });
});

describe("the data directory, read without loading the rest", () => {
  afterEach(() => delete process.env.NOURIDE_DATA_DIR);

  test("is the one the loader makes of the same file: relative to the install, then the environment's", async () => {
    writeInstall(INSTALL, '[daemon]\ndata_dir = "./.nouride/somewhere"\n');
    expect(await configuredDataDir(INSTALL, "")).toBe((await loadGlobalConfig(INSTALL, { execRoot: "" })).config.daemon.dataDir);
    expect(await configuredDataDir(INSTALL, "")).toBe(join(INSTALL, ".nouride", "somewhere"));
    process.env.NOURIDE_DATA_DIR = join(DIR, "from-env");
    expect(await configuredDataDir(INSTALL, "")).toBe((await loadGlobalConfig(INSTALL, { execRoot: "" })).config.daemon.dataDir);
  });

  test("and the default where the file names none — from a file the loader refuses", async () => {
    writeInstall(INSTALL, '[daemon]\ndefault_agent = "nouva"\n');
    await expect(loadGlobalConfig(INSTALL, { execRoot: "" })).rejects.toThrow("default_agent is gone");
    expect(await configuredDataDir(INSTALL, "")).toBe(join(INSTALL, ".nouride", "data"));
  });
});
