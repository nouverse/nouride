/**
 * `[external]` in a pack (0.8.1): a coding CLI answers the agent. Read at load, and a mistake refused there with the
 * file and the field rather than on the agent's first message.
 */

import { describe, expect, test } from "bun:test";
import type { LLMDefaultsSection } from "@nouride/shared";
import { parseAgentConfig } from "../src/config.ts";
import { unknownPackKeys } from "../src/pack-keys.ts";

const DEFAULTS: LLMDefaultsSection = { provider: "anthropic", model: "m", maxTokens: 4096, temperature: 0.7 } as LLMDefaultsSection;
const CLIS = ["claude-code", "codex", "antigravity", "omp"];
const parse = (external: unknown) => parseAgentConfig("coder", { external } as never, { defaults: DEFAULTS, knownClis: CLIS });

describe("[external]", () => {
  test("names the CLI, and carries what the pack set — absent stays absent", () => {
    expect(parse({ cli: "claude-code" }).external).toEqual({ cli: "claude-code" });
    expect(parse({ cli: "codex", profile: "work", model: "gpt-5.5-codex", permissions: "risky" }).external).toEqual({
      cli: "codex",
      profile: "work",
      model: "gpt-5.5-codex",
      permissions: "risky",
    });
    expect(parseAgentConfig("plain", null, { defaults: DEFAULTS, knownClis: CLIS }).external).toBeUndefined();
  });

  test("keeps the agent's model settings: Nouride's own work around the CLI runs on them", () => {
    expect(parseAgentConfig("coder", { external: { cli: "omp" }, llm: { model: "small-one" } } as never, { defaults: DEFAULTS, knownClis: CLIS }).llm.model).toBe("small-one");
  });

  test("refuses a CLI this install does not know, naming the known and where to add one", () => {
    expect(() => parse({ cli: "cursor" })).toThrow('agents/coder/config.toml [external] cli "cursor" is not a CLI this install knows (known: claude-code, codex, antigravity, omp); add another as [[external_clis]]');
  });

  test("refuses a missing CLI, a profile no folder could carry, a preset that is not one", () => {
    expect(() => parse({ model: "x" })).toThrow("[external] cli is required");
    expect(() => parse({ cli: "omp", profile: "Work Laptop" })).toThrow('[external] profile "Work Laptop" must be lowercase');
    expect(() => parse({ cli: "omp", permissions: "yolo" })).toThrow('[external] permissions must be one of folder, risky, all, got "yolo"');
    expect(() => parse("claude-code")).toThrow("[external] must be a table");
  });

  test("a key it does not read is warned about by name — `instruction` too, since the persona pack reaches the CLI (0.8.1)", () => {
    expect(unknownPackKeys({ external: { cli: "omp", modle: "x" } })).toEqual(["[external] modle"]);
    expect(unknownPackKeys({ external: { cli: "omp", profile: "a", model: "b", permissions: "all" } })).toEqual([]);
    expect(unknownPackKeys({ external: { cli: "omp", instruction: "c" } })).toEqual(["[external] instruction"]);
  });
});
