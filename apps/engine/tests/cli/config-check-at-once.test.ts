/**
 * `nouride config check` says how many helpers and missions would run at once, and for each whether the file set the
 * number or the machine decides it. Spawned, as an operator runs it, so the machine is the one the test runs on: what
 * is asserted of it is that its number is said as the machine's and is one the rule can give, never which.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli-harness.ts";

let root: string;
let configPath: string;

const base = () => `[daemon]\ndata_dir = "${join(root, "data")}"\nagents_dir = "${join(root, "agents")}"\n\n[dashboard]\nport = 9\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-check-at-once-"));
  configPath = join(root, "config.toml");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const check = (...flags: string[]) => runCli(["config", "check", ...flags], { cwd: root, config: configPath, env: { LOG_LEVEL: "warn" } });

interface AtOnce {
  machine: string;
  helpers: { limit: number; auto: boolean };
  missions: { limit: number; auto: boolean };
}

describe("nouride config check, on how much work runs at once", () => {
  test("numbers set in the file are the ones said, as set, and the file is left as it was", async () => {
    writeFileSync(configPath, `${base()}\n[delegate]\nmax_background = 2\n\n[missions]\nmax_running = 3\n`);
    const before = readFileSync(configPath, "utf8");
    const run = await check();
    expect(run.code).toBe(0);
    expect(run.out).toContain("at once   2 helpers in the background for each agent (set in the config), 3 missions at once (set in the config); this machine: ");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("0 set for helpers is off, said as set", async () => {
    writeFileSync(configPath, `${base()}\n[delegate]\nmax_background = 0\n`);
    expect((await check()).out).toContain("at once   no helpers in the background (set in the config), ");
  });

  test("nothing set: each number is the machine's and said so, and nothing is written to the file for it", async () => {
    writeFileSync(configPath, base());
    const before = readFileSync(configPath, "utf8");
    const run = await check();
    expect(run.out).toMatch(/at once {3}[1-4] helpers? in the background for each agent \(from this machine\), 1 mission at once \(from this machine\); this machine: \d+ cores?/);
    const json = JSON.parse((await check("--json")).out) as { data: { atOnce: AtOnce } };
    expect(json.data.atOnce.helpers.auto).toBe(true);
    expect(json.data.atOnce.missions).toEqual({ limit: 1, auto: true });
    expect([1, 2, 3, 4]).toContain(json.data.atOnce.helpers.limit);
    expect(json.data.atOnce.machine).toMatch(/^\d+ cores?, [\d.]+(MB|GB) of memory/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
