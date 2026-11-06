/**
 * An external agent is never the orchestrator (0.8.1, EXTERNAL_AGENTS §5.2): Nouride's approval level, fixed list and tool
 * switches do not reach its coding CLI's own commands, and the orchestrator is the agent anyone in a room reaches. Refused
 * where it would be made one, saying why — not "cannot delegate or keep the household's memory", untrue since 0.8.1.
 */

import { expect, test } from "bun:test";
import { externalOrchestratorRefusal, setOrchestrator } from "@/modules/setup/agent-access.ts";

test("making an external agent the orchestrator is refused, and nothing is written", async () => {
  const result = await setOrchestrator(
    { registry: { get: () => ({ config: { id: "coder", external: { cli: "codex" } } }) }, config: {}, configPath: "/nowhere/config.toml" } as never,
    { agentId: "coder", actor: "t" },
  );
  expect(result).toEqual({ ok: false, error: externalOrchestratorRefusal("coder") });
  expect(externalOrchestratorRefusal("coder")).toBe("coder is an external agent: Nouride's approval level, fixed list and tool switches do not reach its coding CLI's own commands, and the orchestrator is the agent anyone in a room reaches. Make a Nouride agent the orchestrator, and hand work to coder with ask_agent.");
  expect(externalOrchestratorRefusal("coder")).not.toContain("delegate or keep the household's memory");
});
