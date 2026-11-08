/**
 * Provider profiles: the endpoints agents run against, and what they offer.
 */

import type { ProviderKind } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import type { ProviderField } from "@/modules/config/settings/providers.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NOT_CHANGED, NO_SETTINGS, notSaved, probed } from "../plain.ts";

/** Each field a provider's save can be refused for, as the Models page's form names it. */
const PROVIDER_FIELDS: Record<ProviderField, string> = {
  name: "the provider's name",
  kind: "the kind",
  baseUrl: "the base URL",
  apiKey: "the API key",
};

export function registerProviderRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/providers", (c) => {
    if (!deps.settings) return c.json({ providers: [], editable: false });
    return c.json({ providers: deps.settings.providerProfiles(), editable: true });
  });

  control.post("/providers", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.settings.saveProvider({
      name: String(body.name ?? ""),
      kind: String(body.kind ?? ""),
      baseUrl: String(body.baseUrl ?? ""),
      actor: principal.actor,
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
    });
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: notSaved(result.field && PROVIDER_FIELDS[result.field]) }, 400);
  });

  control.delete("/providers/:name", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const name = c.req.param("name");
    const result = await deps.settings.removeProvider(name, principal.actor, () =>
      deps.registry
        .all()
        .filter((agent) => agent.config.llm.provider === name)
        .map((agent) => agent.config.id),
    );
    return result.ok ? c.json(result) : c.json({ error: result.error, plain: NOT_CHANGED }, 400);
  });

  /**
   * Probe an endpoint without saving, so the model picker has something to offer.
   *
   * Shares the setup wizard's prober rather than growing a second one: two implementations of "does
   * this endpoint answer" drift, and the one that drifts is the one nobody is looking at.
   */
  control.post("/providers/probe", async (c) => {
    if (!deps.setup) return c.json({ error: "probing is not available" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const result = await deps.setup.probe({
      kind: String(body.kind ?? "openai") as ProviderKind,
      baseUrl: String(body.baseUrl ?? ""),
      apiKey: String(body.apiKey ?? ""),
    });
    return c.json(probed(result));
  });

  /**
   * List models for a saved provider profile, resolving its credential server-side.
   *
   * Asked the way every request through the profile is, its own `headers` included: a gateway that wants one beside
   * the key refused the listing without it, while every turn through the same profile worked.
   */
  control.get("/providers/:name/models", async (c) => {
    if (!deps.setup) return c.json({ error: "probing is not available" }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const name = c.req.param("name");
    let endpoint: ReturnType<ControlDeps["providers"]["endpointFor"]>;
    try {
      endpoint = deps.providers.endpointFor(name);
    } catch {
      return c.json({ ok: false, error: `Unknown or uncredentialed provider profile "${name}"` }, 404);
    }

    return c.json(probed(await deps.setup.probe(endpoint)));
  });
}
