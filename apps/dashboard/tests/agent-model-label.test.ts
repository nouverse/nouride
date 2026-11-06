/**
 * The model each agent is listed with (0.8.1). An external agent's is its CLI's — the pack's, or the CLI's own default
 * as a session named it. The agent picker listed Nix, a Claude Code agent on its default, as `claude-sonnet-5-5` and
 * Kuro, on Codex, as `codex:gpt-5.6-luna`: their `[llm]`, which answers none of their turns (the owner).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentModel } from "@/commons/lib/agents";

describe("the model an agent is listed with", () => {
  test("an external agent's is its CLI's: the one its pack sets, else the CLI's default by name, else said to be its default", () => {
    expect(agentModel({ model: "codex:gpt-5.6-luna", external: { cli: "codex", name: "Codex", profile: "default", model: "gpt-5.6-luna", cliDefault: "gpt-6-luna" } })).toBe("Codex · gpt-5.6-luna");
    expect(agentModel({ model: "claude-sonnet-5-5", external: { cli: "claude-code", name: "Claude Code", profile: "default", model: null, cliDefault: "Opus 5.5" } })).toBe("Claude Code · Opus 5.5 (default)");
    // Before its CLI's first session, or from a daemon that does not say: no model of Nouride's stands in.
    expect(agentModel({ model: "claude-sonnet-5-5", external: { cli: "claude-code", profile: "default" } })).toBe("claude-code · its default model");
  });

  test("any other agent's is its own", () => {
    expect(agentModel({ model: "gemini-3.8-flash" })).toBe("gemini-3.8-flash");
  });

  // Home lists no agents since 0.8.15: the Office teaser took its place.
  test("every list of agents shows it so: the picker, the chat's badge, the Agents page and an agent's header", () => {
    const source = (path: string) => readFileSync(join(import.meta.dir, "../src/modules", path), "utf8");
    const header = source("chat/components/ChatHeader.tsx");
    expect(header).toContain("{agentModel(agent)}</p>");
    expect(header).toContain('{currentAgent ? agentModel(currentAgent) : "active"}');
    expect(header).not.toContain("{agent.model}");
    expect(source("agents/index.page.tsx")).toContain("`${agentModel(agent)} · account ${agent.external.profile}`");
    expect(source("agents/layout.page.tsx")).toContain("<Terminal size={11} /> {agentModel(agent)}");
  });
});
