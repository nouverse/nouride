/**
 * The model tiers (0.8.0) — the dashboard's way to `[llm.defaults] small_model`/`high_model`, each helper key's tier,
 * and one agent's own pair. The shape of the budgets beside them: admin for the install's, operator for an agent's,
 * `null` on an agent meaning "inherit the install's". What each answers is `settings/tiers.ts`.
 */

import type { ModelTiersView } from "@nouride/wire";
import { join } from "@nouride/runtime";
import { atLeast } from "@/modules/users/auth.ts";
import type { TierField } from "@/modules/config/settings/tiers.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { INCOMPLETE, NO_SETTINGS, notSaved } from "../plain.ts";

/** Each model a tiers' save can be refused for, as the Models page and an agent's Model tab name it. */
const TIER_FIELDS: Record<TierField, string> = {
  smallModel: "the small model",
  highModel: "the high model",
  summaryModel: "the model for compacting a long conversation",
  passModel: "the model for the nightly memory pass",
  steerReplyModel: "the model for the reply under a steered message",
  imageModel: "the model for reading an image",
  learningModel: "the model for skill learning",
};

export function registerTierRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/llm/tiers", (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    return c.json({ ...deps.settings.modelTiers(), editable: true } satisfies ModelTiersView);
  });

  /** Admin: which model the install's work runs on is what it spends. */
  control.post("/llm/tiers", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = await jsonBody(c);
    if (!body) return c.json({ error: "send the settings to change, as an object" }, 400);
    const result = await deps.settings.setModelTiers({ patch: body as Record<string, string>, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && TIER_FIELDS[result.field]) }, 400);
    return c.json({ ok: true, ...deps.settings.modelTiers() } satisfies { ok: true } & Omit<ModelTiersView, "editable">);
  });

  control.post("/agents/:id/tiers", async (c) => {
    if (!deps.settings || !deps.files) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "operator")) return c.json({ error: "operator only" }, 403);

    const id = c.req.param("id");
    const agent = deps.registry.get(id);
    if (!agent) return c.json({ error: `no agent "${id}"` }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const tiers: { small?: string | null; high?: string | null } = {};
    for (const tier of ["small", "high"] as const) {
      const raw = body[tier];
      if (raw === undefined) continue;
      if (raw !== null && typeof raw !== "string") return c.json({ error: `${tier} must be a model id, or null to inherit the install's`, plain: INCOMPLETE }, 400);
      tiers[tier] = raw;
    }

    const result = await deps.settings.saveAgentTiers({
      agentConfigPath: join(agent.dir, "config.toml"),
      reload: () => deps.registry.reload(id),
      tiers,
      actor: principal.actor,
      agentId: id,
    });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && TIER_FIELDS[result.field]) }, 400);
    return c.json({ ok: true } satisfies { ok: true });
  });
}
