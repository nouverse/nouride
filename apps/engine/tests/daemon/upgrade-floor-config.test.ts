/**
 * The floor answers before the config (`boot/upgrade-floor.ts`, `loadConfigPastTheFloor`).
 *
 * Found in the 0.8.0 upgrade run: a 0.7.7 volume under the 0.8.0 image was refused for its config.toml —
 * `[daemon] default_agent is gone: write orchestrator = …` — and never reached the floor's refusal, which says which
 * release to start once. Fixed by hand, the next old form would have been refused, then the database. And `nouride config check`,
 * where the release notes send Docker users first, said "✓ this configuration would start" on 0.7.27 data the daemon
 * refuses. The same run found a fresh install that could never start once its first boot was refused late.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@nouride/shared";
import { LAST_RUN_FILE, openRecorded } from "@/boot/last-run.ts";
import { assertUpgradeFloor, loadConfigPastTheFloor, UpgradeFloorError } from "@/boot/upgrade-floor.ts";
import { runCli } from "../cli-harness.ts";

let root = "";
let data = "";
let configPath = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-floor-config-"));
  data = join(root, "data");
  configPath = join(root, "config.toml");
  mkdirSync(data);
  writeFileSync(join(data, "nouride.db"), "not migrated");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.NOURIDE_CONFIG;
});

/** A config naming this data directory, with `extra` — an old form, or nothing. */
function config(extra = ""): void {
  writeFileSync(
    configPath,
    `[daemon]\ndata_dir = "${data}"\nagents_dir = "${join(root, "agents")}"\nworkspace_dir = "${join(root, "workspace")}"\n${extra}\n` +
      "[dashboard]\nenabled = false\n[nougate]\nin_process = false\n",
  );
}
const lastRan = (version: string) => writeFileSync(join(data, LAST_RUN_FILE), `${version}\n`);
const OLD_FORM = 'default_agent = "nouva"';

async function refusal(): Promise<Error> {
  process.env.NOURIDE_CONFIG = configPath;
  try {
    await loadConfigPastTheFloor({ quiet: true });
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a refusal");
}

describe("a config.toml this version refuses", () => {
  test("on data below the floor, is answered with the floor: start 0.8.0 once", async () => {
    config(OLD_FORM);
    lastRan("0.7.7");
    const err = await refusal();
    expect(err).toBeInstanceOf(UpgradeFloorError);
    expect(err.message).toContain("upgrades only from 0.8.0, and the data in");
    expect(err.message).toContain("last ran 0.7.7");
  });

  test("on data past the floor, is refused for itself", async () => {
    config(OLD_FORM);
    lastRan("0.8.0");
    const err = await refusal();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain("[daemon] default_agent is gone");
  });

  test("the daemon's boot says the floor, and leaves the database as it was", async () => {
    config(OLD_FORM);
    lastRan("0.7.7");
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NOURIDE_|NOUGATE_|INITIAL_ADMIN_)/.test(name) && !["PORT", "HOST", "LOG_LEVEL"].includes(name)));
    const child = spawn("bun", [join(import.meta.dir, "../../src/cli/main.ts"), "start"], { cwd: root, env: { ...env, NOURIDE_CONFIG: configPath } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing to start: this release upgrades only from 0.8.0");
    expect(stderr).not.toContain("default_agent is gone");
    expect(readFileSync(join(data, "nouride.db"), "utf8")).toBe("not migrated");
  }, 45_000);
});

describe("nouride config check, on data below the floor", () => {
  const check = () => runCli(["config", "check"], { cwd: root, config: configPath, env: { LOG_LEVEL: "warn" } });

  test("a config that loads would still not start: it says so, and why", async () => {
    config();
    // The last 0.7.x, which 0.8.0 starts on and this version does not.
    lastRan("0.7.29");
    const run = await check();
    expect(run.code).toBe(1);
    expect(run.out + run.err).toContain("this configuration would NOT start");
    expect(run.out + run.err).toContain("upgrades only from 0.8.0");
    expect(run.out + run.err).toContain("install 0.8.0 and start it once");
  });

  test("one in an old form is answered with the floor, as the daemon answers it", async () => {
    config(OLD_FORM);
    lastRan("0.7.7");
    const run = await check();
    expect(run.code).toBe(1);
    expect(run.out + run.err).toContain("upgrades only from 0.8.0");
    expect(run.out + run.err).not.toContain("default_agent is gone");
  });
});

describe("the record of the version that last ran here", () => {
  test("is written with the migration: a first boot stopped after it leaves data the next boot starts on", async () => {
    // As a first boot refused after the database is made — OAuth set on a build without it, in the 0.8.0 upgrade run:
    // with the record written at ready, every boot after was refused as data a release before 0.7.11 had run.
    const fresh = join(root, "fresh");
    (await openRecorded(fresh, "0.8.0")).close();
    expect(readFileSync(join(fresh, LAST_RUN_FILE), "utf8")).toBe("0.8.0\n");
    await assertUpgradeFloor(fresh);
  });
});
