/**
 * `POST /agents/:id/look` (0.8.1): the Look tab's parts reach the pack's writer as text, each part by its name, and a
 * value that is not text is refused before it does.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AgentRegistry } from "@nouride/persona";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import type { DaemonContext } from "@/commons/context.ts";

const TOKEN = "control-token-for-tests-0000000000";

describe("an agent's look, from the dashboard", () => {
  test("its parts reach the writer as text; one that is not text is refused", async () => {
    const seen: unknown[] = [];
    const app = new Hono();
    mountControlRoutes(app, {
      ctx: { config: {}, gateways: new Map(), startedAt: Date.now(), status: "ready", providerErrors: new Map() } as unknown as DaemonContext,
      token: TOKEN,
      registry: { get: () => undefined } as unknown as AgentRegistry,
      setup: { setLook: async (input: unknown) => (seen.push(input), { ok: true as const }) },
    } as unknown as ControlDeps);
    const post = (body: unknown) => app.request("/api/control/agents/nouva/look", { method: "POST", headers: { "x-nouride-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }, { clientAddress: "203.0.113.10" });
    expect((await post({ fur: "ginger", hat: "", unknown: "x" })).status).toBe(200);
    expect((await post({ eyes: 2 })).status).toBe(400);
    expect(seen).toEqual([{ agentId: "nouva", look: { fur: "ginger", hat: "" }, actor: "cli" }]);
  });
});
