/**
 * The install's quiet hours, as the dashboard saves them and as a config file is read: into `[cron]`, live without a
 * restart, taken out again for none, and refused when they are not two different times of the day.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { validate } from "@/modules/config/global/validate.ts";
import { setQuietHours } from "@/modules/config/settings/quiet-hours.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function deps(): SettingsDeps {
  dir = mkdtempSync(join(tmpdir(), "quiet-hours-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "t"\n');
  return { config: structuredClone(DEFAULT_CONFIG), configPath } as unknown as SettingsDeps;
}

describe("saved from the dashboard", () => {
  test("none as shipped; saved to [cron] as it is written, and live at once", async () => {
    const d = deps();
    expect(d.config.cron.quietHours).toBe("");
    expect(await setQuietHours(d, { hours: " 22:00-07:00 " })).toMatchObject({ ok: true, restartRequired: false });
    expect(readFileSync(d.configPath, "utf8")).toContain('[cron]\nquiet_hours = "22:00-07:00"');
    expect(d.config.cron.quietHours).toBe("22:00-07:00");
  });

  test("empty takes the key out, and that is none", async () => {
    const d = deps();
    await setQuietHours(d, { hours: "22:00-07:00" });
    expect((await setQuietHours(d, { hours: "" })).ok).toBe(true);
    expect(readFileSync(d.configPath, "utf8")).not.toContain("quiet_hours");
    expect(d.config.cron.quietHours).toBe("");
  });

  test("anything that is not two different times is refused, and nothing is written", async () => {
    const d = deps();
    await setQuietHours(d, { hours: "22:00-07:00" });
    const before = readFileSync(d.configPath, "utf8");
    for (const hours of ["22-07", "25:00-07:00", "22:00-22:00", "night"]) {
      const saved = await setQuietHours(d, { hours });
      expect({ hours, saved }).toEqual({ hours, saved: { ok: false, error: expect.stringContaining('[cron] quiet_hours must be two different times of the day, as "22:00-07:00"') } });
    }
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
    expect(d.config.cron.quietHours).toBe("22:00-07:00");
  });
});

describe("read from a config file", () => {
  test("a value that is not a span is refused at load, by its key", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.cron.quietHours = "22:00-07:00";
    expect(() => validate(config)).not.toThrow();
    config.cron.quietHours = "";
    expect(() => validate(config)).not.toThrow();
    config.cron.quietHours = "10pm to 7am";
    expect(() => validate(config)).toThrow('[cron] quiet_hours must be two times of the day, as "22:00-07:00", or empty for none; got "10pm to 7am"');
  });
});
