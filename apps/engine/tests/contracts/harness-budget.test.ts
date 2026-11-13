/**
 * What the harness block and the list of built-in skills cost, held where they are.
 *
 * Both ride on every request of every agent, whatever the message is about. Measured on a live install, a first
 * message of 37 thousand tokens was about 11 thousand of harness and 3.6 thousand of skills listed, beside 12.8
 * thousand of tool schemas (`tool-schema-budget.test.ts` holds those). And a multi-step turn sends them again at every
 * step: one mockup was sixteen requests.
 *
 * This does not ask either to shrink. Nearly every line of the harness is there because of something that went wrong
 * live, and the lines that repeat a tool's own schema do so on purpose: `harness-tools.ts` has the measurements, a
 * median of 1.00 tool calls per round trip while the batch parameters were described in the schema alone, a helper
 * tool called zero times in 2,225 runs until a line was written for it. So a line taken out because "the schema says
 * it" is a change of behaviour, to be measured as one. What this asks is that growth be a decision: past a ceiling, it
 * fails here and has to be argued for, in the same change, with the reason in the commit.
 *
 * Measured, not estimated: characters of the text the model is sent, for an agent that holds every built-in tool, in
 * a one-to-one chat. The test's own folders are written as one letter and the two lines that differ by machine are
 * left out (the install ladder, which names this platform's package manager, and the machine's size), so the number
 * is the same on a laptop and on the runner.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, resolveBuiltinSkillsDir } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { createMissionTools } from "@/modules/tools/builtins/mission.ts";
import { createPersonaTool } from "@/modules/tools/builtins/persona.ts";
import { createScheduleTool } from "@/modules/tools/builtins/schedule.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

/** The harness of an agent with every built-in tool, one-to-one. 35,369 measured when this was written. */
const HARNESS = 35_700;
/** The seventeen built-in skills' descriptions together, which every agent's list carries. 7,500 measured. */
const SKILL_DESCRIPTIONS = 7_700;

/** Every optional dependency present, so every conditional tool is built. Their values are never called. */
const stub = new Proxy({}, { get: () => () => ({}) });

function everyTool() {
  const tools = createBuiltinTools({
    security: DEFAULT_CONFIG.security,
    startJob: (() => ({})) as never,
    memory: stub as never,
    sendFile: stub as never,
    attachmentRead: stub as never,
    nourideCli: { binary: "/bin/nouride", installDir: "/srv/nouride" } as never,
    update: stub as never,
    people: stub as never,
    sessionStatus: stub as never,
    runSubagent: stub as never,
    askAgent: stub as never,
    harness: stub as never,
    reflection: stub as never,
    mcpCatalog: { catalog: stub as never, linkFor: () => null },
    notes: stub as never,
  });
  tools.set("mission", createMissionTools(stub as never).chat);
  tools.set("work", createWorkTool(stub as never));
  tools.set("schedule", createScheduleTool({ store: stub as never, timezone: () => "UTC", agentExists: () => true, post: async () => true }));
  tools.set("persona", createPersonaTool({ files: stub as never }));
  return tools;
}

describe("what rides on every request", () => {
  test("the harness of an agent with every built-in tool stays under its ceiling", async () => {
    const bot = new FakeGateway("telegram:nouva", "telegram");
    const bench = await pipelineBench({ turns: [{ text: "ok" }], gateway: bot, agents: [{ id: "nouva" }, { id: "nix" }], agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["*"]\n' });
    try {
      bench.pipeline.setTools(everyTool());
      const built = await bench.pipeline.renderPrompt("nouva", envelope({ gatewayId: bot.id, chatId: "814", senderId: "814", chatType: "dm", text: "hey" }));
      if (typeof built === "string") throw new Error(built);
      const harness = built.text.match(/<<<NOURIDE:HARNESS>>>\n([\s\S]*?)\n<<<NOURIDE:\/HARNESS>>>/)?.[1] ?? "";
      const same = harness
        .replaceAll(bench.dataDir, "/D")
        .replaceAll(bench.agentsDir, "/A")
        .replaceAll(tmpdir(), "/T")
        .split("\n")
        .filter((line) => !line.startsWith("- `Executable not found in $PATH`") && !line.startsWith("- **This machine** has"))
        .join("\n");
      // It is the whole block that was measured: each of its sections is there.
      for (const section of ["CHECK BEFORE YOU ANSWER", "FILES", "TOOLS", "MEMORY", "YOUR CLI", "CONVERSATION"]) expect(same).toContain(`\n${section}\n`);
      expect({ characters: same.length, under: same.length <= HARNESS }).toEqual({ characters: same.length, under: true });
      // And a ceiling that has fallen far behind the text holds nothing: lower it in the change that shrinks the text.
      expect(same.length).toBeGreaterThan(HARNESS - 1_500);
    } finally {
      bench.dispose();
    }
  });

  test("the built-in skills' descriptions together stay under theirs: each new skill adds its own to every agent's list", () => {
    const dir = resolveBuiltinSkillsDir()!;
    const descriptions = readdirSync(dir)
      .filter((name) => statSync(join(dir, name)).isDirectory())
      .map((name) => (parseFrontmatter(readFileSync(join(dir, name, "SKILL.md"), "utf8")).fields.description ?? "").length);
    const total = descriptions.reduce((sum, length) => sum + length, 0);
    expect({ skills: descriptions.length, characters: total, under: total <= SKILL_DESCRIPTIONS }).toEqual({ skills: descriptions.length, characters: total, under: true });
  });
});
