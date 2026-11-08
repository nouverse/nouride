/**
 * A pack's `config.toml` warns about a key it does not read, as the daemon's config always has: a typo,
 * or a key a release deleted, used to load in silence and do nothing. The agent still loads.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLogSink, type LLMDefaultsSection, type LogEntry } from "@nouride/shared";
import { removePath, writeTextFile } from "@nouride/runtime";
import { loadAgent } from "../src/loader.ts";
import { unknownPackKeys } from "../src/pack-keys.ts";

const DEFAULTS: LLMDefaultsSection = { provider: "main", model: "m-1", maxTokens: 0, temperature: 0.7 };

const said: LogEntry[] = [];
addLogSink((entry) => void said.push(entry));

let agentsDir: string;
beforeAll(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "nouride-pack-keys-"));
});
afterAll(() => removePath(agentsDir));

describe("a pack key nothing reads", () => {
  test("is named by table and key — a misspelling, a key no release reads, a whole table", () => {
    expect(
      unknownPackKeys({
        agent: { display_name: "Nox", name: "nox" },
        llm: { provider: "main", modle: "m-2" },
        rsi: { mode: "ask" },
      }),
    ).toEqual(["[agent] name", "[llm] modle", "[rsi]"]);
  });

  test("an open table's keys are the operator's: a connection in [channels], a secret in [security.exec_secrets]", () => {
    expect(
      unknownPackKeys({
        channels: { "telegram:nouva": ["-100"] },
        security: { exec_secrets: { pypi_token: ["twine upload"] }, sender_allowlist: [] },
        tools: { enabled: ["read"], approval_required: [], blocked: [] },
        workspace: { roots: [], skill_roots: [] },
        jobs: { quiet_after_minutes: 5 },
        delegate: { max_background: 1 },
      }),
    ).toEqual([]);
  });

  test("is warned about when the agent loads, with its file, and the agent loads", async () => {
    await writeTextFile(join(agentsDir, "nox", "IDENTITY.md"), "# Nox\n");
    await writeTextFile(join(agentsDir, "nox", "config.toml"), '[llm]\nmodle = "m-2"\ntemperature = 0.2\n');
    said.length = 0;
    const agent = await loadAgent("nox", { agentsDir, llmDefaults: DEFAULTS });
    expect(agent.config.llm.temperature).toBe(0.2);
    expect(agent.config.llm.model).toBe("m-1");
    expect(said.filter((entry) => entry.message === "unknown pack config key ignored").map((entry) => entry.data)).toEqual([
      { key: "agents/nox/config.toml [llm] modle" },
    ]);
  });
});
