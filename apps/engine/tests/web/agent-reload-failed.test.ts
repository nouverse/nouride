/**
 * A pack that failed to load, reloaded by its id once it is fixed.
 *
 * Found in the 0.7.7 → 0.7.10 upgrade run: after fixing the pack, `nouride agent reload e2e` answered `no agent
 * "e2e"`, and only a restart brought it back — the route looked the id up among the agents that had loaded, while
 * `AgentRegistry.reload` itself would load it. A real registry over packs on disk, and the real route.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { registerAgentRoutes } from "@/modules/web/control/routes/agents.ts";
import { packFailureCheck } from "@/cli/commands/doctor-checks.ts";

const BROKEN = '[agent]\napprovals = "sometimes"\n';
const FIXED = '[agent]\napprovals = "careful"\n';

let agentsDir: string;
let registry: AgentRegistry;
let app: Hono;

function pack(id: string, config: string): void {
  mkdirSync(join(agentsDir, id), { recursive: true });
  writeFileSync(join(agentsDir, id, "IDENTITY.md"), `${id}\n`);
  writeFileSync(join(agentsDir, id, "config.toml"), config);
}

beforeEach(async () => {
  agentsDir = mkdtempSync(join(tmpdir(), "nouride-reload-failed-"));
  pack("e2e", BROKEN);
  registry = await AgentRegistry.create({ agentsDir, llmDefaults: { ...DEFAULT_CONFIG.llm.defaults, provider: "p", model: "m" } });
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, { kind: "token", actor: "cli", role: "admin" } as never);
    await next();
  });
  registerAgentRoutes(app as never, { registry } as never);
});

afterEach(() => rmSync(agentsDir, { recursive: true, force: true }));

const reload = (id: string) => app.request(`/agents/${id}/reload`, { method: "POST" });

describe("POST /agents/:id/reload", () => {
  test("loads a pack that failed to load, once it is fixed — no restart", async () => {
    expect(registry.get("e2e")).toBeUndefined();
    expect(registry.loadFailures().map((failure) => failure.id)).toEqual(["e2e"]);

    pack("e2e", FIXED);
    const res = await reload("e2e");
    expect(res.status).toBe(200);
    expect(registry.get("e2e")?.config.id).toBe("e2e");
    expect(registry.loadFailures()).toEqual([]);
  });

  test("still broken, it says why it does not load — not that there is no such agent", async () => {
    const res = await reload("e2e");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('got "sometimes"');
  });

  test("an id that is neither loaded nor failed is still no agent — and a failed pack is one only reload reaches", async () => {
    expect((await reload("nobody")).status).toBe(404);
    // Pausing what never loaded would answer `{ ok: false }` as if it meant something.
    expect((await app.request("/agents/e2e/pause", { method: "POST" })).status).toBe(404);
  });
});

describe("nouride doctor, on a pack that failed to load", () => {
  test("says why, and that fixing it and reloading it by id brings it back — no restart", () => {
    const check = packFailureCheck({ id: "e2e", error: 'agents/e2e/config.toml [agent] approvals must be one of careful, balanced, trusted, per-person, got "sometimes"' });
    expect(check).toEqual({
      level: "bad",
      message: 'agent pack "e2e" failed to load',
      hint: 'agents/e2e/config.toml [agent] approvals must be one of careful, balanced, trusted, per-person, got "sometimes" (fix it, then `nouride agent reload e2e`)',
    });
  });
});
