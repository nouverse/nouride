/**
 * `[missions]` — the dashboard's way to how many missions run at once and the limits each stops at (0.8.0). Under
 * `/policy` with the other daemon-wide numbers, not `/missions/…`, where `/missions/:id` would claim it.
 *
 * An operator's, as starting and stopping a mission is: the limits are a person's word on work nobody watches. What a
 * value may be is the schema's (`settings/missions.ts`).
 */

import { join } from "@nouride/runtime";
import { atOnceBy, machineAtBoot } from "@/commons/machine.ts";
import { missionSettings, type MissionSetting } from "@/modules/config/settings/missions.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_A_NUMBER, NO_SETTINGS, notSaved } from "../plain.ts";

/** Each limit a save can be refused for, as the Missions page names it. */
const MISSION_FIELDS: Record<MissionSetting, string> = {
  perAgent: "the missions per agent",
  maxRunning: "the missions on this server",
  limitHours: "the hours limit",
  limitTurns: "the turns limit",
  // Its label is Tokens, a word the page keeps on its own line: said here by what it counts.
  limitTokens: "the limit on model use",
};

export function registerMissionSettingsRoutes(control: ControlApp, deps: ControlDeps): void {
  // The agents that are on, now, each by its own `per_agent`: the slots on the box follow them unset, and may be set as
  // high as all of them at once.
  const agents = () => deps.registry.enabled().map((agent) => agent.config.missionsPerAgent);
  // What the machine has room for: the slots on the box while nothing is set.
  const byMachine = () => atOnceBy(deps.ctx.machine ?? machineAtBoot());

  control.get("/policy/missions", (c) => {
    if (!deps.settings) return c.json({ ...missionSettings({ config: deps.ctx.config }, agents(), byMachine()), editable: false });
    return c.json({ ...deps.settings.missionSettings(agents(), byMachine()), editable: true });
  });

  control.post("/policy/missions", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const body = await jsonBody(c);
    if (!body) return c.json({ error: "send the settings to change, as an object" }, 400);
    const result = await deps.settings.setMissionSettings({ patch: body, agents: agents(), actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && MISSION_FIELDS[result.field]) }, 400);
    // Whole, as the GET answers: the page puts this in place of what it read, and without `editable` its form went
    // read-only after the first save.
    return c.json({ ok: true, ...deps.settings.missionSettings(agents(), byMachine()), editable: true });
  });

  // One agent's own `per_agent` (0.8.11), from its Settings page: `null` follows the daemon's. The same shape as
  // `/agents/:id/delegate` — an operator's, the pack written and reloaded.
  control.post("/agents/:id/missions", async (c) => {
    if (!deps.settings || !deps.files) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const raw = body.perAgent;
    if (raw !== null && typeof raw !== "number") return c.json({ error: "perAgent must be a whole number, or null to follow the daemon", plain: NOT_A_NUMBER }, 400);

    const result = await deps.settings.saveAgentMissionsPerAgent({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      value: raw,
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the number of missions at once") }, 400);
    return c.json({ ok: true });
  });
}
