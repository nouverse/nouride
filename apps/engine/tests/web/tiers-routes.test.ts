/**
 * `/llm/tiers` and `/agents/:id/tiers` over HTTP — what the Models page and an agent's Model tab send (0.8.0). The
 * install's tiers are an admin's, as the spend cap is; an agent's own pair an operator's, as its budgets are. The
 * settings service is a recorder here — what it does with a value is `config/settings-tiers.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerTierRoutes } from "@/modules/web/control/routes/tiers.ts";

const VIEW = { defaults: { provider: "main", model: "m", smallModel: "", highModel: "" }, helpers: { summaryModel: "", passModel: "", steerReplyModel: "", imageModel: "", learningModel: "" }, passProvider: "" };

function app(role: "admin" | "operator" | "viewer") {
  const calls: { what: string; args: Record<string, unknown> }[] = [];
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { username: role } });
    await next();
  });
  registerTierRoutes(control as never, {
    files: {},
    registry: { get: (id: string) => (id === "nox" ? { dir: "/packs/nox", config: {} } : undefined), reload: async () => {} },
    settings: {
      modelTiers: () => VIEW,
      setModelTiers: async (args: Record<string, unknown>) => (calls.push({ what: "install", args }), { ok: true, restartRequired: false }),
      saveAgentTiers: async (args: Record<string, unknown>) => (calls.push({ what: "agent", args }), { ok: true, restartRequired: false }),
    },
  } as never);
  const post = (path: string, body: unknown) => control.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { control, calls, post };
}

describe("the install's tiers", () => {
  test("read by anyone signed in, with whether this daemon can change them", async () => {
    const response = await app("viewer").control.request("/llm/tiers");
    expect(await response.json()).toEqual({ ...VIEW, editable: true });
  });

  test("changed by an admin only — which model the install's work runs on is what it spends", async () => {
    const admin = app("admin");
    expect((await admin.post("/llm/tiers", { smallModel: "m-small", summaryModel: "small" })).status).toBe(200);
    expect(admin.calls).toEqual([{ what: "install", args: { patch: { smallModel: "m-small", summaryModel: "small" }, actor: "admin" } }]);
    for (const role of ["operator", "viewer"] as const) {
      const other = app(role);
      expect((await other.post("/llm/tiers", { smallModel: "m-small" })).status, role).toBe(403);
      expect(other.calls, role).toEqual([]);
    }
  });

  test("a body that is not an object is refused before the service sees it", async () => {
    const admin = app("admin");
    expect((await admin.post("/llm/tiers", ["small"])).status).toBe(400);
    expect((await admin.post("/llm/tiers", null)).status).toBe(400);
    expect(admin.calls).toEqual([]);
  });
});

describe("one agent's own pair", () => {
  test("an operator's: a model id, or null to inherit, into that agent's own file", async () => {
    const operator = app("operator");
    expect((await operator.post("/agents/nox/tiers", { small: "nox-small", high: null })).status).toBe(200);
    expect(operator.calls).toEqual([{ what: "agent", args: expect.objectContaining({ agentConfigPath: "/packs/nox/config.toml", tiers: { small: "nox-small", high: null }, agentId: "nox" }) }]);
    expect((await app("viewer").post("/agents/nox/tiers", { small: "x" })).status).toBe(403);
  });

  test("anything but text or null, or an agent that is not there, is refused and nothing is written", async () => {
    const operator = app("operator");
    expect((await operator.post("/agents/nox/tiers", { small: 5 })).status).toBe(400);
    expect((await operator.post("/agents/ghost/tiers", { small: "x" })).status).toBe(404);
    expect(operator.calls).toEqual([]);
  });
});
