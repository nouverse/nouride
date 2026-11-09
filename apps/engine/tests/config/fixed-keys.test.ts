/**
 * The keys 0.8.0 made fixed values: `[health]`, `[cron] tick_interval_ms`, `[queue] dedup_window_ms` and a
 * gateway's `resilience` table. A file that still writes one loads — dropping the value keeps what the daemon does — and
 * each is named in a warning, which `config check` lists among its notes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLogSink, type LogEntry } from "@nouride/shared";
import { ensureDir, removePath, writeTextFile } from "@nouride/runtime";
import { loadGlobalConfig, parseConfig } from "@/modules/config/global/index.ts";
import { describeConfig } from "@/modules/config/schema.ts";

const said: LogEntry[] = [];
addLogSink((entry) => void said.push(entry));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-fixed-"));
  said.length = 0;
});
afterEach(() => removePath(dir));

const FIXED_FILE = {
  health: { heartbeat_interval_ms: 5_000, disk_warn_threshold_mb: 10, wal_warn_threshold_mb: 1 },
  cron: { tick_interval_ms: 1_000, max_jobs: 7 },
  queue: { dedup_window_ms: 50, max_queue_depth: 9 },
  gateways: { telegram: { bot: { enabled: true, token: "telegram_bot", resilience: { max_reconnect_attempts: 2 } } } },
};

/** What was said about each key, by the key. */
function warnedKeys(message: RegExp): unknown[] {
  return said.filter((entry) => entry.level === "warn" && message.test(entry.message)).map((entry) => entry.data?.key);
}

describe("a key 0.8.0 made a fixed value", () => {
  test("is named in a warning and ignored — never refused, never called a typo", () => {
    const config = parseConfig(structuredClone(FIXED_FILE));
    expect(warnedKeys(/fixed value since 0\.8\.0 and ignored/).sort()).toEqual(
      [
        "[cron] tick_interval_ms",
        "[gateways.telegram.bot] resilience",
        "[health] disk_warn_threshold_mb",
        "[health] heartbeat_interval_ms",
        "[health] wal_warn_threshold_mb",
        "[queue] dedup_window_ms",
      ].sort(),
    );
    // Said once, as fixed: the merge's own "unknown key" line would send the operator looking for a typo.
    expect(warnedKeys(/unknown config key/)).toEqual([]);
    // The rest of each section still reads.
    expect(config.cron.maxJobs).toBe(7);
    expect(config.queue.maxQueueDepth).toBe(9);
    expect(config.gateways.map((gateway) => gateway.id)).toEqual(["telegram:bot"]);
    expect("health" in config).toBe(false);
    expect("tickIntervalMs" in config.cron).toBe(false);
    expect("dedupWindowMs" in config.queue).toBe(false);
  });

  test("leaves the parsed file as it was — the loader reads it, it does not change it", () => {
    const raw = structuredClone(FIXED_FILE);
    parseConfig(raw);
    expect(raw).toEqual(FIXED_FILE);
  });

  test("an empty [health] table is named too", () => {
    parseConfig({ health: {} });
    expect(warnedKeys(/fixed value since 0\.8\.0/)).toEqual(["[health]"]);
  });

  test("is among what `config check` lists, with the line to remove", async () => {
    ensureDir(join(dir, ".nouride"));
    await writeTextFile(join(dir, "config.toml"), "[cron]\ntick_interval_ms = 1000\n");
    const loaded = await loadGlobalConfig(dir, { quiet: true, execRoot: dir });
    expect(loaded.notes).toContainEqual({
      message: "config key is a fixed value since 0.8.0 and ignored",
      detail: "key: [cron] tick_interval_ms",
      hint: "remove the line: the value is fixed in the code",
    });
  });

  test("is gone from the schema, so neither `config schema` nor the dashboard offers it", () => {
    const paths = describeConfig().map((field) => field.path);
    expect(paths.filter((path) => path.startsWith("health.") || path === "cron.tick_interval_ms" || path === "queue.dedup_window_ms")).toEqual([]);
  });
});
