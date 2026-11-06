/**
 * The orchestrator (0.7.18): one agent that answers a message addressed to nobody — `default_agent` before, under the
 * name of what it does. Setting it takes the old name out of the file; the old name is read as it until boot writes it.
 */

import { describe, expect, test } from "bun:test";
import { parseToml } from "@nouride/runtime";
import { parseConfig } from "@/modules/config/global/index.ts";
import { namingOrchestrator } from "@/modules/setup/agent-access.ts";

describe("naming the orchestrator in config.toml", () => {
  test("writes orchestrator beside what [daemon] already says", () => {
    const text = namingOrchestrator('[daemon]\ntimezone = "Asia/Jakarta"\n', "nox");
    expect(parseToml<{ daemon: Record<string, string> }>(text).daemon).toEqual({ timezone: "Asia/Jakarta", orchestrator: "nox" });
  });

  test("replaces one already there", () => {
    expect(namingOrchestrator('[daemon]\norchestrator = "nouva"\n', "nox")).toBe('[daemon]\norchestrator = "nox"\n');
  });
});

describe("a file from before 0.7.18", () => {
  test("default_agent is refused, naming orchestrator — 0.7.x rewrote it in every file", () => {
    expect(() => parseConfig({ daemon: { default_agent: "nouva" } })).toThrow('config.toml [daemon] default_agent is gone: write orchestrator = "<agent id>" in [daemon]');
  });
});
