/**
 * `[jobs] quiet_after_minutes`, for the daemon and for one agent — the dashboard's way to the job
 * watchdog's wait. The same shape as the turn budget beside it: admin for the daemon's number,
 * operator for an agent's, and `null` on an agent meaning "follow the daemon".
 */

import { join } from "@nouride/runtime";
import { JOB_QUIET_MINUTES_MAX } from "@/modules/config/settings/jobs.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_A_NUMBER, NOT_SAVED, NO_SETTINGS } from "../plain.ts";

export function registerJobQuietRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/policy/job-quiet", (c) =>
    c.json({
      minutes: deps.ctx.config.jobs.quietAfterMinutes,
      max: JOB_QUIET_MINUTES_MAX,
      editable: Boolean(deps.settings),
    }),
  );

  control.post("/policy/job-quiet", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.minutes !== "number") return c.json({ error: "minutes must be a whole number" }, 400);

    const result = await deps.settings.setJobQuietMinutes({ minutes: body.minutes, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true, minutes: deps.ctx.config.jobs.quietAfterMinutes });
  });

  control.post("/agents/:id/job-quiet", async (c) => {
    if (!deps.settings || !deps.files) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const raw = body.minutes;
    if (raw !== null && typeof raw !== "number") {
      return c.json({ error: "minutes must be a whole number, or null to follow the daemon", plain: NOT_A_NUMBER }, 400);
    }

    const result = await deps.settings.saveAgentJobQuietMinutes({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      minutes: raw,
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true });
  });
}
