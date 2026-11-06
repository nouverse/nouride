/**
 * An agent's effort written from its CLI tab or `agent_configure` (0.8.7, `setup/agent-effort.ts`): `[llm] effort` in its
 * own pack, reloaded, audited; "default" takes it away; a level it does not know, or an agent that is not there,
 * changes nothing.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRegistry } from "@nouride/persona";
import { setEffort, withEffort } from "@/modules/setup/agent-effort.ts";
import { tempDir } from "../helpers.ts";

function pack(text: string) {
  const dir = join(tempDir("agent-effort"), "nix");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), text);
  const reloaded: string[] = [];
  const audited: { action: string; details?: unknown }[] = [];
  const registry = { get: (id: string) => (id === "nix" ? { dir, config: { id: "nix" } } : undefined), reload: async (id: string) => void reloaded.push(id) } as unknown as AgentRegistry;
  return { path: join(dir, "config.toml"), deps: { registry, audit: { record: (entry: { action: string; details?: unknown }) => void audited.push(entry) } as never }, reloaded, audited };
}

describe("an agent's effort", () => {
  test("set in its [llm], beside what is there, reloaded and audited", async () => {
    const { path, deps, reloaded, audited } = pack('[agent]\nname = "Nix"\n\n[llm]\nprovider = "local"\n');
    expect(await setEffort(deps, { agentId: "nix", effort: "xhigh", actor: "admin" })).toEqual({ ok: true });
    expect(readFileSync(path, "utf8")).toContain('effort = "xhigh"');
    expect(readFileSync(path, "utf8")).toContain('provider = "local"');
    expect(reloaded).toEqual(["nix"]);
    expect(audited).toEqual([{ action: "agent_effort_changed", agentId: "nix", actor: "admin", details: { effort: "xhigh" } } as never]);
  });

  test("default takes its own away; a pack with no [llm] gets one", () => {
    expect(withEffort('[llm]\nmodel = "m"\neffort = "max"\n', "default")).toBe('[llm]\nmodel = "m"\n');
    expect(withEffort('[agent]\nname = "Nix"\n', "low")).toContain('[llm]\neffort = "low"');
  });

  test("a level it does not know, or no such agent: refused, nothing written", async () => {
    const { path, deps, reloaded } = pack('[llm]\nprovider = "local"\n');
    expect(await setEffort(deps, { agentId: "nix", effort: "huge", actor: "admin" })).toMatchObject({ ok: false, error: expect.stringContaining("low, medium, high, xhigh, max, default") });
    expect(await setEffort(deps, { agentId: "ghost", effort: "low", actor: "admin" })).toEqual({ ok: false, error: 'no agent "ghost"' });
    expect(readFileSync(path, "utf8")).toBe('[llm]\nprovider = "local"\n');
    expect(reloaded).toEqual([]);
  });
});
