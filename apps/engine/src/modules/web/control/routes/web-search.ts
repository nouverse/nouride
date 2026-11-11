/**
 * The Web Search page: which service `web_search` uses, and a way to try one before saving it.
 *
 * The test runs a real search through the same tool the agents get, built from what the form holds
 * rather than what is saved — the question the page is asked is "will this work", and only a search
 * answers it. A typed key is used for that one call and not stored.
 */

import type { WebSearchSettings, WebSearchTest } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import { createWebSearchTool } from "@/modules/tools/builtins/web/index.ts";
import { defaultSearchSecret, type WebSearchField, type WebSearchPatch, type WebSearchSettings as StoredWebSearch } from "@/modules/config/settings/web.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { NO_SETTINGS, notSaved } from "../plain.ts";

/** Each field a save can be refused for, as the Web Search page names it. */
const WEB_SEARCH_FIELDS: Record<WebSearchField, string> = {
  mode: "the search service",
  endpoint: "the address",
  secret: "the secret's name",
  key: "the key",
};

/** What a search that is not working is missing, as the Web Search page asks for it. */
const NEEDS: Record<NonNullable<StoredWebSearch["needs"]>, string> = {
  address: "It needs the address of your search service.",
  key: "It needs the key for your search service.",
};

const TEST_QUERY = "open source software";

export function registerWebSearchRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * The tool was built from the config as it was at boot. Kept so the page can say "saved, not live
   * until a restart" rather than leaving somebody to wonder why the agents still search the old way.
   */
  //
  // What it *resolved to*, too: storing the key the stock config already names changes no line of the
  // file and still changes which backend a rebuilt tool would use.
  const live = () =>
    JSON.stringify({ web: deps.ctx.config.security.web, effective: deps.settings!.webSearchSettings().effective });
  // Other route tests mount every route with a daemon cut down to what they exercise — no config, or
  // a settings stub without this method — so the snapshot is taken only when there is one to take.
  const atBoot =
    deps.ctx?.config?.security?.web && typeof deps.settings?.webSearchSettings === "function" ? live() : undefined;

  /** The settings as the page reads them: what searching needs in its words, and whether a restart is waited on. */
  const asRead = (view: StoredWebSearch) => ({
    ...view,
    // Why searching is not working is said in the settings file's words (0.8.23): the page says what it needs.
    plain: view.needs ? NEEDS[view.needs] : null,
    restartPending: atBoot !== undefined && live() !== atBoot,
    editable: true,
  });

  control.get("/web-search", (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    return c.json(asRead(deps.settings.webSearchSettings()) satisfies WebSearchSettings);
  });

  control.post("/web-search", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    const principal = c.get("principal");
    if (!atLeast(principal, "admin")) return c.json({ error: "admin only" }, 403);

    const patch = parsePatch(await jsonBody(c));
    if (typeof patch === "string") return c.json({ error: patch }, 400);
    const result = await deps.settings.setWebSearchSettings({ patch, actor: principal.actor });
    if (!result.ok) return c.json({ error: result.error, plain: notSaved(result.field && WEB_SEARCH_FIELDS[result.field]) }, 400);
    return c.json({ ok: true, restartRequired: result.restartRequired, settings: asRead(deps.settings.webSearchSettings()) } satisfies { ok: true; restartRequired: boolean; settings: WebSearchSettings });
  });

  control.post("/web-search/test", async (c) => {
    if (!deps.settings) return c.json({ error: "config editing is not available", plain: NO_SETTINGS }, 501);
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);

    const patch = parsePatch(await jsonBody(c));
    if (typeof patch === "string") return c.json({ error: patch }, 400);
    // Not the save's checks whole: an unsaved key is the point of testing, so "not set" is not
    // a reason to refuse here.
    const usesEndpoint = patch.mode === "searxng" || patch.mode === "custom";
    if (usesEndpoint && !patch.endpoint?.trim()) return c.json({ ok: false, error: "enter the endpoint first" });

    const needsKey = patch.mode === "brave" || patch.mode === "exa";
    const usesKey = needsKey || patch.mode === "custom";
    const apiKey = usesKey
      ? patch.apiKeyValue || deps.secrets.resolve(patch.apiKeySecret?.trim() || defaultSearchSecret(patch.mode))
      : undefined;
    if (needsKey && !apiKey) return c.json({ ok: false, error: "no API key to test with: paste one or pick a secret that is set" });

    const tool = createWebSearchTool({
      searchKind: patch.mode === "searxng" || patch.mode === "exa" ? patch.mode : "brave",
      ...(usesEndpoint ? { searchEndpoint: patch.endpoint!.trim() } : {}),
      ...(apiKey ? { searchApiKey: apiKey } : {}),
      // The question is whether *this* backend answers. A fallback would answer for it.
      fallbackEnabled: false,
    });
    if (!tool) return c.json({ ok: false, error: "this combination does not give web_search a backend", plain: "These choices leave the agents no search service to use." });

    const started = performance.now();
    const result = await tool.execute({ query: TEST_QUERY }, {} as never);
    const ms = Math.round(performance.now() - started);
    if (result.isError) return c.json({ ok: false, error: result.content, plain: "The search service did not answer the test. Check its address and its key, and try again.", ms });

    const results = [...result.content.matchAll(/^\d+\. (.+)\n {3}(https?:\/\/\S+)/gm)]
      .slice(0, 3)
      .map((m) => ({ title: m[1]!, url: m[2]! }));
    return c.json({
      ok: results.length > 0,
      ms,
      query: TEST_QUERY,
      source: typeof result.metadata?.source === "string" ? result.metadata.source : undefined,
      results,
      ...(results.length === 0 ? { error: "it answered, but with no results" } : {}),
    } satisfies WebSearchTest);
  });
}

/** The body as a patch, or why it is not one. Types only — what the values mean is `settings/web.ts`. */
function parsePatch(body: unknown): WebSearchPatch | string {
  if (!body || typeof body !== "object") return "expected a JSON object";
  const b = body as Record<string, unknown>;
  for (const key of ["endpoint", "apiKeySecret", "apiKeyValue"] as const) {
    if (b[key] !== undefined && typeof b[key] !== "string") return `${key} must be a string`;
  }
  for (const key of ["fallbackEnabled", "allowPrivateUrls"] as const) {
    if (b[key] !== undefined && typeof b[key] !== "boolean") return `${key} must be a boolean`;
  }
  if (typeof b.mode !== "string") return "mode is required";
  return {
    mode: b.mode as WebSearchPatch["mode"],
    ...(typeof b.endpoint === "string" ? { endpoint: b.endpoint } : {}),
    ...(typeof b.apiKeySecret === "string" ? { apiKeySecret: b.apiKeySecret } : {}),
    ...(typeof b.apiKeyValue === "string" && b.apiKeyValue ? { apiKeyValue: b.apiKeyValue } : {}),
    ...(typeof b.fallbackEnabled === "boolean" ? { fallbackEnabled: b.fallbackEnabled } : {}),
    ...(typeof b.allowPrivateUrls === "boolean" ? { allowPrivateUrls: b.allowPrivateUrls } : {}),
  };
}
