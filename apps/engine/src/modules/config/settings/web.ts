/**
 * `[security.web]` as the dashboard's Web Search page edits it: which search service `web_search`
 * uses, where it is, and which credential it authenticates with.
 *
 * Five choices, not the file's keys, because the keys combine in ways nobody should have to
 * reason about — a Brave `search_kind` with a custom `search_endpoint` is "a proxy", the same kind
 * with an unresolved key and no endpoint is "the free sources". The page asks which one you want and
 * this writes the keys that mean it:
 *
 * | mode | search_kind | search_endpoint | search_api_key |
 * |---|---|---|---|
 * | `free` | brave | "" | "" |
 * | `brave` | brave | "" | a secret name, which must resolve |
 * | `searxng` | searxng | the instance | "" |
 * | `exa` | exa | "" | a secret name, which must resolve |
 * | `custom` | brave | the proxy | a secret name, or "" when the proxy authenticates |
 *
 * As everywhere in settings: a key's *value* goes to the secret store and only its name to the file.
 * The tool is built once at boot, so every save reports a restart.
 */

import { assertSecretName } from "@nouride/secrets";
import type { WebPolicySection } from "@nouride/shared";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { isSearchKind, resolveSearch, SEARCH_BACKENDS } from "@/modules/tools/builtins/search-backends.ts";
import { editConfigFile } from "./file.ts";
import { setSecret } from "./secrets.ts";
import type { FieldRefusal, SaveResult, SettingsDeps } from "./types.ts";

export type WebSearchMode = "free" | "brave" | "searxng" | "exa" | "custom";
const WEB_SEARCH_MODES: WebSearchMode[] = ["free", "brave", "searxng", "exa", "custom"];

/** The services a key is required for, by the name the page's refusal gives them. */
const NEEDS_KEY: Partial<Record<WebSearchMode, string>> = { brave: "Brave", exa: "Exa" };

/**
 * The name a new key is stored under when the page is not told another.
 *
 * Each service's own (`keyName`), so a key pasted for one never replaces the other's, switching back finds the first
 * where it was, and a service in the fallback chain finds its key where the page put it. Brave's is the name the stock
 * config has always held; a custom endpoint speaks Brave's API, so it takes Brave's.
 */
export function defaultSearchSecret(mode: WebSearchMode): string {
  return SEARCH_BACKENDS[mode === "exa" ? "exa" : "brave"].keyName!;
}

export interface WebSearchSettings {
  mode: WebSearchMode;
  endpoint: string;
  /** The secret *name*. Kept when the mode does not use it, so switching back finds it again. */
  apiKeySecret: string;
  /** Whether that name resolves, and from where. Never the value. */
  apiKeyOrigin: "env" | "store" | "missing";
  fallbackEnabled: boolean;
  allowPrivateUrls: boolean;
  /** What `web_search` would use with these settings: a backend, the free sources, or nothing. */
  effective: "brave" | "searxng" | "exa" | "free" | "unavailable";
  /** Why `effective` is `unavailable`, in the operator's words. */
  problem?: string;
  /** What is missing then (0.8.23): the page asks for it in its own words, `problem` naming the file's keys. */
  needs?: "address" | "key";
}

/** What the page shows. Read from the live config, so it reflects a save before the restart. */
export function webSearchSettings(deps: SettingsDeps): WebSearchSettings {
  const web = deps.config.security.web;
  const key = web.searchApiKey.trim();
  const origin = key ? deps.secrets.origin(key) : undefined;
  const resolved = key ? deps.secrets.resolve(key) : undefined;
  const outcome = describe(web, resolved);
  const mode = modeOf(web, Boolean(resolved));
  return {
    mode,
    endpoint: web.searchEndpoint,
    apiKeySecret: key || defaultSearchSecret(mode),
    apiKeyOrigin: origin ?? "missing",
    fallbackEnabled: web.fallbackEnabled,
    allowPrivateUrls: web.allowPrivateUrls,
    ...outcome,
  };
}

/**
 * Which of the five the file currently says.
 *
 * A Brave kind whose key does not resolve and has no endpoint *is* the free sources — that is what
 * `resolveSearch` does with it — so it reads as `free`, not as a Brave setup with a problem. The
 * stock config is exactly this: the name `brave_search_api_key`, set by nobody. Exa without its key
 * is not: only the default kind falls back, so it reads as Exa, and as not working.
 */
function modeOf(web: WebPolicySection, keyResolves: boolean): WebSearchMode {
  if (web.searchKind === "searxng" || web.searchKind === "exa") return web.searchKind;
  if (web.searchEndpoint.trim()) return "custom";
  return keyResolves ? "brave" : "free";
}

function describe(web: WebPolicySection, apiKey: string | undefined): Pick<WebSearchSettings, "effective" | "problem" | "needs"> {
  const kind = isSearchKind(web.searchKind) ? web.searchKind : "brave";
  const resolved = resolveSearch({ kind, endpoint: web.searchEndpoint, apiKey });
  if ("keyless" in resolved) return { effective: "free" };
  if ("unavailable" in resolved) return { effective: "unavailable", problem: resolved.unavailable, needs: resolved.needs };
  return { effective: resolved.kind };
}

export interface WebSearchPatch {
  mode: WebSearchMode;
  endpoint?: string;
  /** The secret name to use. For `brave` and `exa`, and optionally `custom`. */
  apiKeySecret?: string;
  /** A key typed into the page: stored under `apiKeySecret` before anything is written. */
  apiKeyValue?: string;
  fallbackEnabled?: boolean;
  allowPrivateUrls?: boolean;
}

/** A field of the Web Search page a refusal names (0.8.23): the service picked, its address, the key or its secret's name. */
export type WebSearchField = "mode" | "endpoint" | "secret" | "key";

/** Check a patch as the boot would, and say what is wrong in a sentence, and in which field. `null` when it is fine. */
function checkWebSearchPatch(deps: SettingsDeps, patch: WebSearchPatch): FieldRefusal<WebSearchField> | null {
  if (!WEB_SEARCH_MODES.includes(patch.mode)) return { field: "mode", error: `mode must be one of ${WEB_SEARCH_MODES.join(", ")}` };
  const endpoint = patch.endpoint?.trim() ?? "";
  if (patch.mode === "searxng" || patch.mode === "custom") {
    if (!endpoint) return { field: "endpoint", error: patch.mode === "searxng" ? "SearXNG needs the address of your instance" : "a custom endpoint needs its URL" };
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return { field: "endpoint", error: `"${endpoint}" is not a URL` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return { field: "endpoint", error: "the endpoint must be an http:// or https:// URL" };
  }

  const name = patch.apiKeySecret?.trim() ?? "";
  if (name || patch.apiKeyValue) {
    try {
      assertSecretName(name || defaultSearchSecret(patch.mode), "secret name");
    } catch (err) {
      return { field: "secret", error: err instanceof Error ? err.message : String(err) };
    }
  }
  const service = NEEDS_KEY[patch.mode];
  if (service && !patch.apiKeyValue && !(name && deps.secrets.resolve(name))) {
    return name
      ? { field: "secret", error: `the secret "${name}" is not set: paste the key, or pick a secret that holds it` }
      : { field: "key", error: `${service} needs an API key: paste it, or pick the secret that holds it` };
  }
  return null;
}

/** Save the page: the key to the store if one was typed, then `[security.web]`, then the live config. */
export async function setWebSearchSettings(
  deps: SettingsDeps,
  params: { patch: WebSearchPatch; actor?: string },
): Promise<SaveResult<WebSearchField>> {
  const { patch } = params;
  const problem = checkWebSearchPatch(deps, patch);
  if (problem) return { ok: false, ...problem };

  const usesKey = Boolean(NEEDS_KEY[patch.mode]) || patch.mode === "custom";
  let secretName = usesKey ? (patch.apiKeySecret?.trim() ?? "") : "";
  if (usesKey && patch.apiKeyValue) secretName ||= defaultSearchSecret(patch.mode);

  const web = deps.config.security.web;
  const next = {
    search_kind: patch.mode === "searxng" || patch.mode === "exa" ? patch.mode : "brave",
    search_endpoint: patch.mode === "searxng" || patch.mode === "custom" ? (patch.endpoint?.trim() ?? "") : "",
    search_api_key: secretName,
    fallback_enabled: patch.fallbackEnabled ?? web.fallbackEnabled,
    // Turning the fallback on with an empty chain would be a switch that does nothing.
    fallback_backends: web.fallbackBackends.length ? web.fallbackBackends : ["duckduckgo"],
    allow_private_urls: patch.allowPrivateUrls ?? web.allowPrivateUrls,
  };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "security.web", next));
  if (!saved.ok) return saved;
  // Once the save is through, so a refused one leaves the key that works in place.
  if (usesKey && patch.apiKeyValue) {
    const stored = await setSecret(deps, { name: secretName, value: patch.apiKeyValue, actor: params.actor });
    if (!stored.ok) return { ok: false, field: "key", error: stored.error };
  }

  deps.audit?.record({
    action: "web_search_configured",
    actor: params.actor,
    details: { mode: patch.mode, endpoint: next.search_endpoint, secret: secretName, keyStored: Boolean(patch.apiKeyValue) },
  });
  // Built once at boot, like every tool.
  return { ok: true, restartRequired: true };
}
