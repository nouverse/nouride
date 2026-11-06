/**
 * How many missions one agent may have working at once (0.8.11): `[missions] per_agent` in its own pack, read by the
 * loader, written from its Settings page, and in force at the dispatcher's next decision; absent, the daemon's. The
 * owner asked for three or four, set per agent — the setting was the box's alone. The box's own `max_running` may be
 * set as high as every agent at its own number at once.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentConfig } from "@nouride/persona";
import { parseToml } from "@nouride/runtime";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { missionSettings, saveAgentMissionsPerAgent, setMissionSettings } from "@/modules/config/settings/missions.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const pack = (toml: string) => parseAgentConfig("nix", parseToml(toml) as never, { defaults: DEFAULT_CONFIG.llm.defaults });

describe("one agent's missions at once", () => {
  test("read from its pack's [missions], 1 to 4 whole — refused there by its file and field otherwise", () => {
    expect(pack("[missions]\nper_agent = 3\n").missionsPerAgent).toBe(3);
    expect(pack("[missions]\nper_agent = 4\n").missionsPerAgent).toBe(4);
    expect(pack('[agent]\nname = "n"\n').missionsPerAgent).toBeUndefined();
    for (const bad of ["0", "5", "1.5"]) {
      expect(() => pack(`[missions]\nper_agent = ${bad}\n`)).toThrow("agents/nix/config.toml [missions] per_agent must be a whole number from 1 to 4");
    }
  });

  test("written to its own [missions] from the dashboard, reloaded, audited — and null takes the key away again", async () => {
    dir = mkdtempSync(join(tmpdir(), "agent-mission-slots-"));
    const agentConfigPath = join(dir, "config.toml");
    writeFileSync(agentConfigPath, '[agent]\nname = "Nix"\n');
    let reloads = 0;
    const audited: { action: string; actor?: string; details?: unknown }[] = [];
    const deps = { audit: { record: (entry: { action: string; actor?: string; details?: unknown }) => void audited.push(entry) } } as unknown as SettingsDeps;
    const base = { agentConfigPath, reload: async () => void (reloads += 1), actor: "gading", agentId: "nix" };

    expect(await saveAgentMissionsPerAgent(deps, { ...base, value: 3 })).toEqual({ ok: true, restartRequired: false });
    expect(readFileSync(agentConfigPath, "utf8")).toContain("[missions]\nper_agent = 3");
    // Reloaded by the write: the pack the dispatcher reads at its next decision is the one just saved.
    expect(reloads).toBe(1);
    expect(audited).toEqual([{ action: "agent_missions_per_agent_changed", actor: "gading", details: { agent: "nix", per_agent: 3 } }]);
    expect((await saveAgentMissionsPerAgent(deps, { ...base, value: null })).ok).toBe(true);
    expect(readFileSync(agentConfigPath, "utf8")).not.toContain("per_agent");
    expect(await saveAgentMissionsPerAgent(deps, { ...base, value: 5 })).toEqual({ ok: false, error: "[missions] per_agent must be a whole number from 1 to 4, got 5" });
    expect(readFileSync(agentConfigPath, "utf8")).not.toContain("per_agent");
  });
});

describe("the box's max_running, with agents at their own numbers", () => {
  test("may be set as high as every agent at its own per_agent at once — nix at four, two at the daemon's one: six", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const agents = [4, undefined, undefined];
    expect(missionSettings({ config }, agents).bounds.maxRunning).toMatchObject({ min: 1, max: 6 });
    dir = mkdtempSync(join(tmpdir(), "agent-mission-slots-"));
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, '[daemon]\nname = "t"\n');
    const deps = { config, configPath } as unknown as SettingsDeps;
    expect(await setMissionSettings(deps, { patch: { maxRunning: 7 }, agents })).toEqual({ ok: false, error: "[missions] max_running must be a whole number from 1 to 6, got 7" });
    expect(await setMissionSettings(deps, { patch: { maxRunning: 6 }, agents })).toEqual({ ok: true, restartRequired: false });
  });
});
