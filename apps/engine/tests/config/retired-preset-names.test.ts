/**
 * The presets' names before 0.7.23 — `normal`, `risky`, `none` — refused in 0.8.0 wherever a file names a level:
 * `[security] approvals` in `config.toml` and `[agent] approvals` in a pack. 0.7.23's boot
 * rewrote them; one back from git or by hand is refused naming the levels, never read as one of them. `risky` has its
 * own case beside each loader's tests; this holds all three, since `none` read as anything but a refusal would be the
 * one that loosens.
 */

import { describe, expect, test } from "bun:test";
import { parseAgentConfig } from "@nouride/persona";
import { parseConfig } from "@/modules/config/global/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

const OLD_NAMES = ["normal", "risky", "none"] as const;

describe("a preset's name from before 0.7.23", () => {
  test.each(OLD_NAMES)("%p in [security] approvals is refused at load, the levels named", (old) => {
    expect(() => parseConfig({ security: { approvals: old } })).toThrow(/\[security\] approvals/);
    expect(() => parseConfig({ security: { approvals: old } })).toThrow(/careful/);
  });

  test.each(OLD_NAMES)("%p in a pack's [agent] approvals is refused for that agent, the levels named", (old) => {
    expect(() => parseAgentConfig("nox", { agent: { approvals: old } }, { defaults: DEFAULT_CONFIG.llm.defaults })).toThrow(
      `agents/nox/config.toml [agent] approvals must be one of careful, balanced, trusted, per-person, got "${old}"`,
    );
  });
});
