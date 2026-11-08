/**
 * `[missions]` as the dashboard saves it (0.8.0): into the file, in force at once, and refused outside the schema's
 * bounds — every value checked before anything is written, so a form with one bad field saves none of them. An empty
 * value takes its key out, back to the default; the slots on the box follow the agents that are on while unset.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { missionSettings, setMissionSettings, type AgentSlots, type MissionSetting } from "@/modules/config/settings/missions.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** `n` agents on, each following the daemon's `per_agent`. */
const following = (n: number): AgentSlots => Array.from({ length: n }, () => undefined);

function deps(): SettingsDeps {
  dir = mkdtempSync(join(tmpdir(), "mission-settings-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "t"\n');
  return { config: structuredClone(DEFAULT_CONFIG), configPath } as unknown as SettingsDeps;
}

describe("[missions] from the dashboard", () => {
  test("saved to the file and in force at once — the running config is what the missions read at every decision", async () => {
    const d = deps();
    const saved = await setMissionSettings(d, { patch: { perAgent: 2, maxRunning: 3, limitHours: 1.5, limitTurns: 80, limitTokens: 2_000_000 }, agents: following(2), actor: "t" });
    expect(saved).toEqual({ ok: true, restartRequired: false });
    const file = readFileSync(d.configPath, "utf8");
    for (const line of ["per_agent = 2", "max_running = 3", "limit_hours = 1.5", "limit_turns = 80", "limit_tokens = 2000000"]) expect(file).toContain(line);
    expect(d.config.missions).toEqual({ perAgent: 2, maxRunning: 3, limitHours: 1.5, limitTurns: 80, limitTokens: 2_000_000 });
  });

  test("one key alone leaves the others as they were", async () => {
    const d = deps();
    expect((await setMissionSettings(d, { patch: { limitTurns: 20 }, agents: following(6) })).ok).toBe(true);
    expect(d.config.missions).toEqual({ ...DEFAULT_CONFIG.missions, limitTurns: 20 });
    expect(readFileSync(d.configPath, "utf8")).not.toContain("per_agent");
  });

  test("refused outside the schema's bounds, with the key and the range — and a bad value saves none of the good ones", async () => {
    const d = deps();
    // Each with the setting it refused, which the page names (0.8.23): the one at fault, not the first sent.
    const cases: [Record<string, unknown>, string, MissionSetting][] = [
      [{ perAgent: 0 }, "[missions] per_agent must be a whole number from 1 to 4, got 0", "perAgent"],
      [{ perAgent: 5 }, "[missions] per_agent must be a whole number from 1 to 4, got 5", "perAgent"],
      [{ maxRunning: 7 }, "[missions] max_running must be a whole number from 1 to 6, got 7", "maxRunning"],
      [{ maxRunning: 0 }, "[missions] max_running must be a whole number from 1 to 6, got 0", "maxRunning"],
      [{ limitHours: 0.1 }, "[missions] limit_hours must be a number from 0.25 to 168, got 0.1", "limitHours"],
      [{ limitTurns: 2.5 }, "[missions] limit_turns must be a whole number from 1 to 1000, got 2.5", "limitTurns"],
      [{ limitTokens: 99_999 }, "[missions] limit_tokens must be a whole number from 100000 up, got 99999", "limitTokens"],
      [{ limitTurns: "50" }, '[missions] limit_turns must be a whole number from 1 to 1000, got "50"', "limitTurns"],
      [{ limitHours: 4, perAgent: 9 }, "[missions] per_agent must be a whole number from 1 to 4, got 9", "perAgent"],
    ];
    for (const [patch, error, field] of cases) expect(await setMissionSettings(d, { patch, agents: following(6) })).toEqual({ ok: false, field, error });
    // A key the page does not have is no field of it.
    expect(await setMissionSettings(d, { patch: { perHour: 2 }, agents: following(6) })).not.toHaveProperty("field");
    expect(d.config.missions).toEqual(DEFAULT_CONFIG.missions);
    expect(readFileSync(d.configPath, "utf8")).not.toContain("[missions]");
  });

  test("a key [missions] does not have, or nothing at all, is refused rather than written", async () => {
    const d = deps();
    expect(await setMissionSettings(d, { patch: { limitDollars: 5 }, agents: following(6) })).toMatchObject({ ok: false, error: expect.stringContaining("[missions] has no limitDollars") });
    expect(await setMissionSettings(d, { patch: {}, agents: following(6) })).toMatchObject({ ok: false, error: expect.stringContaining("nothing to change") });
    expect(readFileSync(d.configPath, "utf8")).not.toContain("[missions]");
  });

  test("read back with the bounds the form keeps to: hours may be a fraction, the rest are whole", () => {
    const view = missionSettings({ config: structuredClone(DEFAULT_CONFIG) }, following(6));
    expect(view).toMatchObject({ perAgent: 1, maxRunning: 3, limitHours: 8, limitTurns: 100, limitTokens: 100_000_000 });
    expect(view.bounds.limitHours).toEqual({ min: 0.25, max: 168, integer: false });
    expect(view.bounds.perAgent).toEqual({ min: 1, max: 4, integer: true });
    expect(view.bounds.limitTokens).toEqual({ min: 100_000, integer: true });
  });

  test("the slots on the box, unset, follow the agents that are on — and may be set as high as all of them", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    expect(missionSettings({ config }, following(6))).toMatchObject({ maxRunning: 3, auto: true, bounds: { maxRunning: { min: 1, max: 6, integer: true } } });
    expect(missionSettings({ config }, following(30))).toMatchObject({ maxRunning: 8, auto: true, bounds: { maxRunning: { max: 30 } } });
    expect(missionSettings({ config }, following(1))).toMatchObject({ maxRunning: 1, auto: true, bounds: { maxRunning: { max: 1 } } });
    // Each default as the page offers it, the slots as many as the agents give now.
    expect(missionSettings({ config }, following(6)).defaults).toEqual({ perAgent: 1, maxRunning: 3, limitHours: 8, limitTurns: 100, limitTokens: 100_000_000 });
    config.missions.maxRunning = 5;
    config.missions.perAgent = 2;
    expect(missionSettings({ config }, following(6))).toMatchObject({ maxRunning: 5, auto: false, defaults: { maxRunning: 3 }, bounds: { maxRunning: { max: 12 } } });
  });

  test("set as high as every agent at the per_agent the same save leaves — thirty agents take thirty", async () => {
    const d = deps();
    expect(await setMissionSettings(d, { patch: { maxRunning: 30 }, agents: following(30) })).toEqual({ ok: true, restartRequired: false });
    expect(d.config.missions.maxRunning).toBe(30);
    expect(await setMissionSettings(d, { patch: { maxRunning: 31 }, agents: following(30) })).toEqual({ ok: false, field: "maxRunning", error: "[missions] max_running must be a whole number from 1 to 30, got 31" });
    // One agent running two: two at once is every agent at its per_agent, said in the same save.
    expect(await setMissionSettings(d, { patch: { perAgent: 2, maxRunning: 2 }, agents: following(1) })).toEqual({ ok: true, restartRequired: false });
    expect(await setMissionSettings(d, { patch: { perAgent: null, maxRunning: 2 }, agents: following(1) })).toMatchObject({ ok: false, error: expect.stringContaining("from 1 to 1, got 2") });
  });

  test("an empty value takes its key out of the file — back to the default, and the box's slots back to following the agents", async () => {
    const d = deps();
    expect((await setMissionSettings(d, { patch: { maxRunning: 5, limitHours: 12, limitTurns: 80 }, agents: following(6) })).ok).toBe(true);
    expect(d.config.missions).toMatchObject({ maxRunning: 5, limitHours: 12, limitTurns: 80 });

    expect(await setMissionSettings(d, { patch: { maxRunning: null, limitHours: null }, agents: following(6) })).toEqual({ ok: true, restartRequired: false });
    const file = readFileSync(d.configPath, "utf8");
    expect(file).not.toContain("max_running");
    expect(file).not.toContain("limit_hours");
    expect(file).toContain("limit_turns = 80");
    expect(d.config.missions).toEqual({ ...DEFAULT_CONFIG.missions, limitTurns: 80 });
    expect(missionSettings(d, following(6))).toMatchObject({ maxRunning: 3, auto: true, limitHours: 8 });
  });
});
