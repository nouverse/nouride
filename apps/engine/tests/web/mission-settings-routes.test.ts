/**
 * `/policy/missions` over HTTP — what the Missions page reads and sends (0.8.0). Anyone signed in reads the limits; an
 * operator or an admin changes them, a viewer does not. The settings service is a recorder here — what it does with a
 * value is `config/mission-settings.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { registerMissionSettingsRoutes } from "@/modules/web/control/routes/mission-settings.ts";

const VIEW = { ...DEFAULT_CONFIG.missions, bounds: { perAgent: { min: 1, max: 4, integer: true } } };

function app(role: "admin" | "operator" | "viewer", options: { refuse?: string; settings?: false } = {}) {
  const calls: Record<string, unknown>[] = [];
  const asked: number[] = [];
  const machines: number[] = [];
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { username: role } });
    await next();
  });
  // Six agents loaded, one of them turned off: five are on — nix with its own three missions at once (0.8.11).
  const agents = ["nouva", "nero", "nestor", "nexa", "nix"].map((id) => ({ config: { id, enabled: true, ...(id === "nix" ? { missionsPerAgent: 3 } : {}) } }));
  registerMissionSettingsRoutes(control as never, {
    // A machine with room for two: four cores, 4 GiB.
    ctx: { config: structuredClone(DEFAULT_CONFIG), machine: { cores: 4, memoryBytes: 4 * 1024 ** 3 } },
    registry: { enabled: () => agents },
    settings:
      options.settings === false
        ? undefined
        : {
            missionSettings: (on: readonly (number | undefined)[], byMachine: number) => (asked.push(on.length), machines.push(byMachine), VIEW),
            setMissionSettings: async (args: Record<string, unknown>) => {
              calls.push(args);
              return options.refuse ? { ok: false, error: options.refuse } : { ok: true, restartRequired: false };
            },
          },
  } as never);
  const post = (body: unknown) => control.request("/policy/missions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { control, calls, asked, machines, post };
}

describe("the mission settings", () => {
  test("read by anyone signed in, with their bounds and whether this daemon can change them — for the agents that are on", async () => {
    const viewer = app("viewer");
    const response = await viewer.control.request("/policy/missions");
    expect(await response.json()).toEqual({ ...VIEW, editable: true });
    expect(viewer.asked).toEqual([5]);
    // And for the machine it runs on: what it has room for is what the slots follow while unset.
    expect(viewer.machines).toEqual([2]);
  });

  test("a daemon that cannot change them still shows them whole: the slots its machine gives it, the defaults and the bounds", async () => {
    const response = await app("viewer", { settings: false }).control.request("/policy/missions");
    // As high as every agent at its own per_agent at once: four at the daemon's one, nix at its three.
    expect(await response.json()).toMatchObject({ maxRunning: 2, auto: true, defaults: { maxRunning: 2 }, bounds: { maxRunning: { min: 1, max: 7 } }, editable: false });
  });

  test("changed by an operator or an admin, as the person who saves them, and answered with what is now in force", async () => {
    for (const role of ["operator", "admin"] as const) {
      const signed = app(role);
      const response = await signed.post({ limitTurns: 20 });
      expect(response.status).toBe(200);
      // As the GET answers it, `editable` included: the page puts this in place of what it read.
      expect(await response.json()).toEqual({ ok: true, ...VIEW, editable: true });
      expect(signed.calls).toEqual([{ patch: { limitTurns: 20 }, agents: [undefined, undefined, undefined, undefined, 3], actor: role }]);
      expect(signed.asked).toEqual([5]);
    }
  });

  test("a viewer is refused before the service sees anything", async () => {
    const viewer = app("viewer");
    expect((await viewer.post({ limitTurns: 20 })).status).toBe(403);
    expect(viewer.calls).toEqual([]);
  });

  test("a body that is no object is a 400; a value the service refuses is a 400 with its sentence", async () => {
    const operator = app("operator");
    expect((await operator.post([1])).status).toBe(400);
    expect((await operator.post(null)).status).toBe(400);
    expect(operator.calls).toEqual([]);
    const refused = await app("operator", { refuse: "[missions] per_agent must be a whole number from 1 to 4, got 9" }).post({ perAgent: 9 });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "[missions] per_agent must be a whole number from 1 to 4, got 9", plain: "Nothing was saved. Check what you entered, and try again." });
  });
});

describe("one agent's missions at once (0.8.11)", () => {
  function agentApp(role: "operator" | "viewer") {
    const calls: Record<string, unknown>[] = [];
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: role, role, user: { username: role } });
      await next();
    });
    registerMissionSettingsRoutes(control as never, {
      ctx: { config: structuredClone(DEFAULT_CONFIG) },
      files: {},
      registry: { enabled: () => [], get: (id: string) => (id === "nix" ? { dir: "/packs/nix", config: {} } : undefined), reload: async () => {} },
      settings: {
        saveAgentMissionsPerAgent: async (args: Record<string, unknown>) => {
          calls.push(args);
          return args.value === 9 ? { ok: false, error: "[missions] per_agent must be a whole number from 1 to 4, got 9" } : { ok: true, restartRequired: false };
        },
      },
    } as never);
    const post = (id: string, body: unknown) => control.request(`/agents/${id}/missions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { calls, post };
  }

  test("a number, or null to follow the daemon, goes to that agent's own file, as the operator who saves it", async () => {
    const operator = agentApp("operator");
    expect((await operator.post("nix", { perAgent: 3 })).status).toBe(200);
    expect((await operator.post("nix", { perAgent: null })).status).toBe(200);
    expect(operator.calls.map((one) => one.value)).toEqual([3, null]);
    expect(operator.calls[0]).toMatchObject({ agentConfigPath: "/packs/nix/config.toml", actor: "operator", agentId: "nix" });
  });

  test("a viewer is refused; a value the service refuses is a 400 with why; no number never reaches it; no such agent is a 404", async () => {
    expect((await agentApp("viewer").post("nix", { perAgent: 3 })).status).toBe(403);
    const operator = agentApp("operator");
    const refused = await operator.post("nix", { perAgent: 9 });
    expect(refused.status).toBe(400);
    // Its one field, named as the agent's Settings page names it (0.8.23).
    expect(await refused.json()).toEqual({ error: "[missions] per_agent must be a whole number from 1 to 4, got 9", plain: "Nothing was saved. Check the number of missions at once, and try again." });
    expect((await operator.post("nix", { perAgent: "3" })).status).toBe(400);
    expect((await operator.post("ghost", { perAgent: 3 })).status).toBe(404);
    expect(operator.calls).toHaveLength(1);
  });
});
