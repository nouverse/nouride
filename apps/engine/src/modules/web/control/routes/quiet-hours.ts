/**
 * `[cron] quiet_hours`, from the dashboard: the hours in which what automations would say is kept for later. Read by
 * anyone signed in, since it says why a run's words have not arrived; set by an admin, for the whole install.
 */

import type { QuietHoursPolicy } from "@nouride/wire";
import { parseQuietHours } from "@nouride/shared";
import { atLeast, type Principal } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NO_SETTINGS, notSaved } from "../plain.ts";
import { thingOfJob, thingsFor } from "../whose.ts";

export function registerQuietHoursRoutes(control: ControlApp, deps: ControlDeps): void {
  const policy = (principal: Principal): QuietHoursPolicy => {
    const span = parseQuietHours(deps.ctx.config.cron.quietHours);
    return {
      ...(span ? { from: clock(span.from), to: clock(span.to) } : {}),
      timeZone: deps.ctx.config.daemon.timezone,
      editable: Boolean(deps.settings),
      ...keptFor(deps, principal),
    };
  };

  control.get("/policy/quiet-hours", (c) => c.json(policy(c.get("principal")) satisfies QuietHoursPolicy));

  control.post("/policy/quiet-hours", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    // Both times, or neither: neither is none.
    const none = body.from === null && body.to === null;
    if (!none && (typeof body.from !== "string" || typeof body.to !== "string")) {
      return c.json({ error: 'send { from: "22:00", to: "07:00" }, or both null for none', plain: notSaved("the two times") }, 400);
    }
    const result = await deps.settings.setQuietHours({ hours: none ? "" : `${body.from as string}-${body.to as string}`, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the two times: they must be different") }, 400);
    return c.json({ ok: true, ...policy(principal) } satisfies { ok: true } & QuietHoursPolicy);
  });
}

/**
 * What is kept now, counted over the automations whoever asks may see: another person's are not theirs to learn
 * of, by a number either.
 */
function keptFor(deps: ControlDeps, principal: Principal): Pick<QuietHoursPolicy, "kept"> {
  const kept = deps.cron?.scheduler.kept();
  if (!kept || !deps.cron) return {};
  const things = thingsFor(deps, principal);
  const seen = new Map<string, boolean>();
  const count = kept.jobIds.filter((jobId) => {
    if (!seen.has(jobId)) {
      const job = deps.cron!.store.get(jobId);
      seen.set(jobId, job !== null && job !== undefined && things.sees(thingOfJob(job)));
    }
    return seen.get(jobId);
  }).length;
  return count > 0 ? { kept: { count, until: kept.until } } : {};
}

const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
