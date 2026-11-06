/**
 * The quiet-job wait, as the dashboard saves it: into the file, live without a restart, and refused
 * outside 0–1440 whole minutes. An agent's own wait removes its key on `null`, so the agent follows the
 * daemon again instead of being pinned to a copy of today's default.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { saveAgentJobQuietMinutes, setJobQuietMinutes } from "@/modules/config/settings/jobs.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function deps(): SettingsDeps {
  dir = mkdtempSync(join(tmpdir(), "job-quiet-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(configPath, "[daemon]\nname = \"t\"\n");
  return { config: structuredClone(DEFAULT_CONFIG), configPath } as unknown as SettingsDeps;
}

describe("the daemon's wait", () => {
  test("saved to [jobs], and live at once", async () => {
    const d = deps();
    expect(await setJobQuietMinutes(d, { minutes: 15 })).toMatchObject({ ok: true, restartRequired: false });
    expect(readFileSync(d.configPath, "utf8")).toContain("[jobs]\nquiet_after_minutes = 15");
    expect(d.config.jobs.quietAfterMinutes).toBe(15);
  });

  test("0 turns it off; a fraction, a negative or more than a day is refused and nothing is written", async () => {
    const d = deps();
    expect((await setJobQuietMinutes(d, { minutes: 0 })).ok).toBe(true);
    expect(d.config.jobs.quietAfterMinutes).toBe(0);
    for (const minutes of [-1, 2.5, 1441]) {
      expect((await setJobQuietMinutes(d, { minutes })).ok).toBe(false);
    }
    expect(d.config.jobs.quietAfterMinutes).toBe(0);
  });
});

describe("one agent's wait", () => {
  test("written to its own [jobs], and null takes the key away again", async () => {
    const d = deps();
    const agentConfigPath = join(dir, "agent.toml");
    writeFileSync(agentConfigPath, "[agent]\nname = \"Nouva\"\n");
    const base = { agentConfigPath, reload: async () => {}, actor: "t", agentId: "nouva" };

    expect((await saveAgentJobQuietMinutes(d, { ...base, minutes: 30 })).ok).toBe(true);
    expect(readFileSync(agentConfigPath, "utf8")).toContain("quiet_after_minutes = 30");
    expect((await saveAgentJobQuietMinutes(d, { ...base, minutes: null })).ok).toBe(true);
    expect(readFileSync(agentConfigPath, "utf8")).not.toContain("quiet_after_minutes");
    expect((await saveAgentJobQuietMinutes(d, { ...base, minutes: -5 })).ok).toBe(false);
  });
});
