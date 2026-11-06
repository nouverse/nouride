/**
 * `[delegate] max_background` (0.7.15): how many helpers an agent may have working in the background at once — the
 * daemon's, refused at load outside 0 to 4, and an agent's own, written to its pack from the dashboard and read back by
 * the loader. `null` takes the agent's key away, so it follows the daemon again.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_BACKGROUND_HELPERS, resolveMaxBackground } from "@nouride/shared";
import { parseAgentConfig } from "@nouride/persona";
import { ensureDir, parseToml, writeTextFile } from "@nouride/runtime";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { loadGlobalConfig } from "@/modules/config/global/index.ts";
import { saveAgentMaxBackground } from "@/modules/config/settings/jobs.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const defaults = DEFAULT_CONFIG.llm.defaults;

describe("the daemon's", () => {
  /** A config loaded the way the daemon loads one, from an install. */
  async function load(toml: string) {
    dir = mkdtempSync(join(tmpdir(), "delegate-config-"));
    ensureDir(join(dir, ".nouride"));
    await writeTextFile(join(dir, "config.toml"), toml);
    return (await loadGlobalConfig(dir)).config;
  }

  test("is 2 unless said, and 0 to 4 whole — refused at load otherwise", async () => {
    expect(DEFAULT_CONFIG.delegate.maxBackground).toBe(2);
    expect((await load("")).delegate.maxBackground).toBe(2);
    expect((await load("[delegate]\nmax_background = 0\n")).delegate.maxBackground).toBe(0);
    expect((await load("[delegate]\nmax_background = 4\n")).delegate.maxBackground).toBe(4);
    for (const bad of ["5", "-1", "1.5"]) {
      await expect(load(`[delegate]\nmax_background = ${bad}\n`)).rejects.toThrow("max_background");
    }
  });
});

describe("one agent's", () => {
  test("read from its pack, refused there outside 0 to 4", () => {
    const pack = (toml: string) => parseAgentConfig("nouva", parseToml(toml) as never, { defaults });
    expect(pack("[delegate]\nmax_background = 1\n").maxBackgroundHelpers).toBe(1);
    expect(pack("[agent]\nname = \"n\"\n").maxBackgroundHelpers).toBeUndefined();
    expect(() => pack("[delegate]\nmax_background = 7\n")).toThrow("agents/nouva/config.toml [delegate] max_background must be a whole number from 0 (off) to 4");
  });

  test("its own number wins, absent follows the daemon, and anything odd is off — never over the ceiling", () => {
    expect(resolveMaxBackground(1, 2)).toBe(1);
    expect(resolveMaxBackground(undefined, 2)).toBe(2);
    expect(resolveMaxBackground(0, 2)).toBe(0);
    expect(resolveMaxBackground(-3, 2)).toBe(0);
    expect(resolveMaxBackground(99, 2)).toBe(MAX_BACKGROUND_HELPERS);
  });

  test("written to its own [delegate] from the dashboard, and null takes the key away again", async () => {
    dir = mkdtempSync(join(tmpdir(), "delegate-settings-"));
    const agentConfigPath = join(dir, "agent.toml");
    writeFileSync(agentConfigPath, "[agent]\nname = \"Nouva\"\n");
    let reloads = 0;
    const base = { agentConfigPath, reload: async () => void (reloads += 1), actor: "t", agentId: "nouva" };
    const deps = {} as SettingsDeps;

    expect(await saveAgentMaxBackground(deps, { ...base, value: 1 })).toEqual({ ok: true, restartRequired: false });
    expect(readFileSync(agentConfigPath, "utf8")).toContain("[delegate]\nmax_background = 1");
    // Reloaded by the write: the pack the next helper is counted against is the one just saved.
    expect(reloads).toBe(1);
    expect((await saveAgentMaxBackground(deps, { ...base, value: null })).ok).toBe(true);
    expect(readFileSync(agentConfigPath, "utf8")).not.toContain("max_background");
    const refused = await saveAgentMaxBackground(deps, { ...base, value: 5 });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("from 0 (off) to 4") });
  });
});
