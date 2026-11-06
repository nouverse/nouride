/**
 * This version starts only on data 0.8.0 has run on (`boot/upgrade-floor.ts`).
 *
 * 0.8.0's first start brought what it still read forward on disk and recorded the version; this one keeps none of those
 * steps. So data without that record is refused before anything is written — held here by the real boot too, on a
 * database it must leave as it found it. Data from before 0.8.0's own floor, the last 0.7.x, is told both steps at once.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_RUN_FILE, PENDING_FILE } from "@/boot/last-run.ts";
import { assertUpgradeFloor, UpgradeFloorError } from "@/boot/upgrade-floor.ts";
import { EARLIER_FLOOR, UPGRADE_FLOOR } from "@/commons/upgrade-floor.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-floor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const withData = (lastRun?: string) => {
  writeFileSync(join(dir, "nouride.db"), "");
  if (lastRun !== undefined) writeFileSync(join(dir, LAST_RUN_FILE), `${lastRun}\n`);
};

const refusal = async (): Promise<string> => {
  try {
    await assertUpgradeFloor(dir);
  } catch (err) {
    expect(err).toBeInstanceOf(UpgradeFloorError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("the upgrade floor", () => {
  test("is 0.8.0, and 0.8.0's own is the last 0.7.x", () => {
    expect(UPGRADE_FLOOR).toBe("0.8.0");
    expect(EARLIER_FLOOR).toEqual({ floor: "0.7.28", take: "0.7.29", image: "ghcr.io/nouverse/nouride:0.7" });
  });

  test("lets fresh data start: nothing on it to bring forward", async () => {
    await assertUpgradeFloor(dir);
  });

  test("lets data 0.8.0 — or anything after it — last ran on start", async () => {
    withData("0.8.0");
    await assertUpgradeFloor(dir);
    writeFileSync(join(dir, LAST_RUN_FILE), "0.8.1\n");
    await assertUpgradeFloor(dir);
  });

  test("refuses data the last 0.7.x ran on: 0.8.0 once, on systemd and on Docker by its own tag", async () => {
    for (const last of ["0.7.29", "0.7.28"]) {
      withData(last);
      const message = await refusal();
      expect(message).toStartWith(`refusing to start: this release upgrades only from 0.8.0, and the data in ${dir} last ran ${last}.`);
      expect(message).toContain("→ install 0.8.0 and start it once (it brings the database and every pack forward on disk, after a snapshot), then this version again");
      // Not `0.8`, which moves to every 0.8.x — this one too, which would refuse the data again.
      expect(message).toContain("→ on Docker: run ghcr.io/nouverse/nouride:0.8.0 once on the same volume, then this image again");
      expect(message).not.toContain("0.7.29 and start it once");
    }
  });

  test("refuses data an older 0.7.x last ran on with both steps: the last 0.7.x, then 0.8.0", async () => {
    withData("0.7.27");
    const message = await refusal();
    expect(message).toContain("upgrades only from 0.8.0");
    expect(message).toContain("last ran 0.7.27");
    expect(message).toContain("→ install 0.7.29 and start it once (it brings the database, the memory vault, config.toml and every pack forward on disk, after a snapshot), then 0.8.0 once, then this version again");
    expect(message).toContain("→ on Docker: run ghcr.io/nouverse/nouride:0.7 once on the same volume, then ghcr.io/nouverse/nouride:0.8.0 once, then this image again");
  });

  test("refuses data with no record: a release before 0.7.11 ran it, so both steps", async () => {
    withData();
    const message = await refusal();
    expect(message).toContain("a release before 0.7.11");
    expect(message).toContain("→ install 0.7.29 and start it once");
  });

  test("names what the last 0.7.x could not bring forward, since starting it again would not", async () => {
    withData("0.7.27");
    writeFileSync(join(dir, PENDING_FILE), "agents/nouva/config.toml: read-only\n");
    const message = await refusal();
    expect(message).toContain("could not bring these forward");
    expect(message).toContain("  - agents/nouva/config.toml: read-only");
  });

  test("is checked by the daemon's own boot before anything writes: the database is left as it was", async () => {
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "nouride.db"), "not migrated");
    writeFileSync(join(data, LAST_RUN_FILE), "0.7.27\n");
    const before = statSync(join(data, "nouride.db")).mtimeMs;
    const config = join(dir, "config.toml");
    writeFileSync(
      config,
      ["[daemon]", `data_dir = "${data}"`, `agents_dir = "${join(dir, "agents")}"`, `workspace_dir = "${join(dir, "workspace")}"`, "[dashboard]", "enabled = false", "[nougate]", "in_process = false", ""].join("\n"),
    );
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(NOURIDE_|NOUGATE_|INITIAL_ADMIN_)/.test(name) && !["PORT", "HOST", "LOG_LEVEL"].includes(name)));
    const child = spawn("bun", [join(import.meta.dir, "../../src/cli/main.ts"), "start"], { cwd: dir, env: { ...env, NOURIDE_CONFIG: config } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing to start: this release upgrades only from 0.8.0");
    expect(readFileSync(join(data, "nouride.db"), "utf8")).toBe("not migrated");
    expect(statSync(join(data, "nouride.db")).mtimeMs).toBe(before);
  }, 45_000);
});
