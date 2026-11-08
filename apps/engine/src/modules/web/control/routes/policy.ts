/**
 * The daemon-wide policies read and changed from the dashboard: what a day may spend, and how long a turn and its
 * tool rounds may run. Whether a command asks is each agent's approval level (`/agents/:id/approvals`) since 0.8.0;
 * the exec knob that lived here, `sensitive_paths`, went into the levels.
 */

import { TOOL_ITERATIONS_MAX, TOOL_ITERATIONS_MIN, TURN_SECONDS_MAX, TURN_SECONDS_MIN } from "@nouride/shared";
import { startOfLocalDay } from "@/commons/clock.ts";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NO_SETTINGS, notSaved } from "../plain.ts";

export function registerPolicyRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The daily spend ceiling, and what today has actually cost so far.
   *
   * Both together, because neither answers the question on its own. A cap with no spend beside it is
   * a number an operator has no way to calibrate — "is 20 dollars generous or about to refuse the
   * next turn?" — and the spend is already recorded, so withholding it would mean reading the cap
   * here and the usage on another page to make one decision.
   *
   * `spend` is null rather than 0 when nothing records usage: a daemon with no usage store cannot
   * enforce a cap at all, and reporting "0 spent" would read as a quiet day rather than as a
   * measurement that is not happening.
   */
  control.get("/policy/spend", (c) => {
    const limits = deps.ctx.config.llm.limits;
    const from = startOfLocalDay(Date.now(), deps.ctx.config.daemon.timezone);
    const today = deps.usage?.since(from);
    return c.json({
      maxDailyCostUsd: limits.maxDailyCostUsd,
      alertThresholdPct: limits.costAlertThresholdPct,
      spentTodayUsd: today?.usd ?? null,
      // A figure that omits calls on unpriced models is one people make decisions on and should not.
      unpricedRequests: today?.unpricedRequests ?? 0,
      editable: Boolean(deps.settings),
    });
  });

  /**
   * Set it. Admin only, and live on the next turn rather than the next boot.
   *
   * Admin because it is the ceiling on what every agent here may spend, and because raising it is
   * the one change whose consequence is a bill somebody else pays.
   */
  control.post("/policy/spend", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    // Not coerced, for the reason given below on `level`: `Number(undefined)` is `NaN`, and the
    // service would then complain about the shape of a number nobody sent.
    if (typeof body.maxDailyCostUsd !== "number") {
      return c.json({ error: "maxDailyCostUsd must be a number of dollars, or 0 for no cap" }, 400);
    }

    const result = await deps.settings.setDailyCostCap({
      usd: body.maxDailyCostUsd,
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the daily spend cap") }, 400);
    return c.json({ ok: true, maxDailyCostUsd: deps.ctx.config.llm.limits.maxDailyCostUsd });
  });

  /**
   * The daemon-wide tool budget, with the bounds and the guidance the form needs.
   *
   * The bounds travel with the value rather than being repeated in the dashboard, so a change to
   * the rule reaches the form without a second edit — and the form cannot offer a number the daemon
   * will refuse.
   */
  control.get("/policy/tool-iterations", (c) =>
    c.json({
      maxToolIterations: deps.ctx.config.llm.limits.maxToolIterations,
      min: TOOL_ITERATIONS_MIN,
      max: TOOL_ITERATIONS_MAX,
      editable: Boolean(deps.settings),
    }),
  );

  control.post("/policy/tool-iterations", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    // Admin, for the reason the spend cap is: this is the ceiling on what one message may cost,
    // for every agent on the daemon.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.maxToolIterations !== "number") {
      return c.json({ error: "maxToolIterations must be a whole number" }, 400);
    }

    const result = await deps.settings.setToolIterations({
      iterations: body.maxToolIterations,
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the tool budget") }, 400);
    return c.json({ ok: true, maxToolIterations: deps.ctx.config.llm.limits.maxToolIterations });
  });

  /**
   * The clock's half of `/policy/tool-iterations`, and the same shape.
   *
   * Seconds on the wire. The config key is milliseconds and the dashboard should not be the third
   * place that conversion is written — the daemon does it once, in `setTurnSeconds`.
   */
  control.get("/policy/turn-seconds", (c) =>
    c.json({
      turnSeconds: Math.round(deps.ctx.config.llm.limits.maxTurnDurationMs / 1000),
      // The ceiling the queue imposes, which is lower than `max` on a daemon with a short queue
      // timeout. Sent so the form can say why a number it would otherwise allow is refused.
      queueSeconds: Math.round(deps.ctx.config.queue.queueTimeoutMs / 1000),
      min: TURN_SECONDS_MIN,
      max: TURN_SECONDS_MAX,
      editable: Boolean(deps.settings),
    }),
  );

  control.post("/policy/turn-seconds", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    // Admin, like the tool budget: this is the other half of what one message may cost.
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (typeof body.turnSeconds !== "number") {
      return c.json({ error: "turnSeconds must be a whole number of seconds" }, 400);
    }

    const result = await deps.settings.setTurnSeconds({
      seconds: body.turnSeconds,
      actor: principal.actor,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved("the turn budget") }, 400);
    return c.json({
      ok: true,
      turnSeconds: Math.round(deps.ctx.config.llm.limits.maxTurnDurationMs / 1000),
    });
  });
}
