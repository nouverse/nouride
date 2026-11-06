/**
 * `[delegate] max_background`, for one agent — the dashboard's way to how many helpers it may have working in the
 * background at once (0.7.15). The daemon's number is read here and set in `config.toml`; an agent's is set from its
 * Settings page, operator and up, and `null` means "follow the daemon" — the same shape as the quiet-job wait beside it.
 */

import { join } from "@nouride/runtime";
import { MAX_BACKGROUND_HELPERS } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_A_NUMBER, NOT_SAVED, NO_SETTINGS } from "../plain.ts";

export function registerDelegateRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/policy/delegate", (c) =>
    c.json({
      maxBackground: deps.ctx.config.delegate.maxBackground,
      max: MAX_BACKGROUND_HELPERS,
      editable: Boolean(deps.settings),
    }),
  );

  control.post("/agents/:id/delegate", async (c) => {
    if (!deps.settings || !deps.files) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const raw = body.maxBackground;
    if (raw !== null && typeof raw !== "number") {
      return c.json({ error: "maxBackground must be a whole number, or null to follow the daemon", plain: NOT_A_NUMBER }, 400);
    }

    const result = await deps.settings.saveAgentMaxBackground({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      value: raw,
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: NOT_SAVED }, 400);
    return c.json({ ok: true });
  });
}
