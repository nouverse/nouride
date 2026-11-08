/**
 * Agent mention settings: whether agents can @mention each other, and how many hops a chain may
 * take before the daemon stops forwarding.
 *
 * Its own route rather than a field on an existing endpoint, because it is a daemon-wide setting
 * and reading it from a per-agent endpoint is how a global control ends up looking scoped.
 */

import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_SAVED, NO_SETTINGS, notSaved } from "../plain.ts";

export function registerMentionRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * Current mention settings, and whether this daemon can change them.
   *
   * `editable` is false when there is no `SettingsService` — a daemon running on built-in defaults
   * has no file to write, and a control that silently fails is worse than one visibly disabled.
   */
  control.get("/mentions", (c) => {
    return c.json({
      mentionsEnabled: deps.ctx.config.agents.mentionsEnabled,
      mentionMaxHops: deps.ctx.config.agents.mentionMaxHops,
      editable: Boolean(deps.settings),
    });
  });

  /**
   * Update mention settings. Admin only, and live on the next message rather than the next boot.
   *
   * Accepts partial updates: either or both of `mentionsEnabled` and `mentionMaxHops`.
   */
  control.post("/mentions", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;

    if ("mentionsEnabled" in body) {
      if (typeof body.mentionsEnabled !== "boolean") {
        return c.json({ error: "mentionsEnabled must be a boolean" }, 400);
      }
      const result = await deps.settings.setMentionsEnabled({
        enabled: body.mentionsEnabled,
        actor: principal.actor,
      });
      if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    }

    if ("mentionMaxHops" in body) {
      if (typeof body.mentionMaxHops !== "number") {
        return c.json({ error: "mentionMaxHops must be a number" }, 400);
      }
      const result = await deps.settings.setMentionMaxHops({
        maxHops: body.mentionMaxHops,
        actor: principal.actor,
      });
      if (!result.ok) return c.json({ error: result.error, plain: notSaved("the hop limit") }, 400);
    }

    return c.json({
      ok: true,
      mentionsEnabled: deps.ctx.config.agents.mentionsEnabled,
      mentionMaxHops: deps.ctx.config.agents.mentionMaxHops,
    });
  });
}
