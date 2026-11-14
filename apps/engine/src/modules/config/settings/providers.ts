/**
 * Provider profiles: the endpoints agents run against.
 */

import { SESSION_PLACEHOLDER } from "@nouride/llm";
import { createLogger } from "@nouride/shared";
import type { ProviderKind } from "@nouride/shared";
import { removeTomlKey, upsertTomlTable, removeTomlTable } from "@/modules/config/edit.ts";
import { endpointKeys } from "@/modules/config/known-endpoints.ts";
import { editConfigFile } from "./file.ts";
import {
  NAME_PATTERN,
  PROVIDER_KINDS,
  type ProviderView,
  type SaveResult,
  type SettingsDeps,
} from "./types.ts";

const log = createLogger("settings");

/** A field of the provider form a refusal names (0.8.23). */
export type ProviderField = "name" | "kind" | "baseUrl" | "apiKey" | "headers";

/** A header's name as HTTP takes one, in the letters services use for theirs. */
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * Headers a request says for itself. A key typed as a header would sit in `config.toml` as text, where the key's own
 * field keeps it as a secret the file only names.
 */
const OWN_HEADERS = new Set(["authorization", "x-api-key", "content-type"]);
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE = 1024;

/**
 * A provider's extra headers as its form sent them, which is the whole set: a header the form no longer names is
 * removed. A name with no value keeps the value saved under it, because a saved value is never sent back to the form
 * to be sent here again.
 */
function headersFrom(asked: Record<string, string | null>, saved: Record<string, string> | undefined): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const savedBy = new Map(Object.entries(saved ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [typed, given] of Object.entries(asked)) {
    const name = typed.trim();
    const lower = name.toLowerCase();
    if (!HEADER_NAME.test(name)) return { ok: false, error: `"${typed}" is not a header's name` };
    if (OWN_HEADERS.has(lower)) return { ok: false, error: `${name} is a header the request sends itself: the key goes in the API key field` };
    // HTTP reads a header's name in any case: two spellings of one would be sent as one header with both values.
    if (seen.has(lower)) return { ok: false, error: `header ${name} is there twice` };
    seen.add(lower);
    const value = given?.trim() ? given.trim() : savedBy.get(lower);
    if (value === undefined) return { ok: false, error: `header ${name} needs a value` };
    if (/[\r\n]/.test(value) || value.length > MAX_HEADER_VALUE) return { ok: false, error: `header ${name} has a value a header cannot carry` };
    headers[name] = value;
  }
  if (seen.size > MAX_HEADERS) return { ok: false, error: `a provider takes at most ${MAX_HEADERS} extra headers` };
  return { ok: true, headers };
}

// ── Provider profiles ──────────────────────────────────────────────────────

export function providerProfiles(deps: SettingsDeps): ProviderView[] {
  const names = new Set(deps.secrets.inventory().map((entry) => entry.name));
  return Object.entries(deps.config.providers).map(([name, profile]) => ({
    name,
    kind: profile.kind,
    baseUrl: profile.baseUrl,
    apiKeySecret: profile.apiKeySecret,
    hasCredential: names.has(profile.apiKeySecret),
    builtIn: false,
    headers: Object.fromEntries(Object.entries(profile.headers ?? {}).map(([header, value]) => [header, value === SESSION_PLACEHOLDER ? value : null])),
  }));
}

/**
 * Create or update a provider profile.
 *
 * Unlike the setup wizard this does not probe the endpoint. The wizard probes because it is filling a
 * model picker and because a first-run failure is better caught immediately; here the operator may be
 * pointing at something that is not up yet, and refusing to save a profile because its server is down
 * is a worse default than saving one that has not answered.
 */
export async function saveProvider(deps: Pick<SettingsDeps, "config" | "configPath" | "secrets" | "providers" | "audit">, input: {
  name: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  /** Its extra headers, all of them (`headersFrom`). Absent: the ones it has are left as they are. */
  headers?: Record<string, string | null>;
  actor: string;
}): Promise<SaveResult<ProviderField>> {
  const name = input.name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, field: "name", error: "name may contain only letters, digits, - and _" };
  }
  const kind = input.kind as ProviderKind;
  if (!PROVIDER_KINDS.includes(kind)) {
    return { ok: false, field: "kind", error: `unknown provider kind "${input.kind}"` };
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, field: "baseUrl", error: "a base URL is required" };

  const existing = deps.config.providers[name];
  const apiKeySecret = existing?.apiKeySecret ?? `${name}_api_key`;
  const apiKey = input.apiKey?.trim();
  if (!apiKey && !existing) return { ok: false, field: "apiKey", error: "an API key is required" };
  const read = input.headers === undefined ? undefined : headersFrom(input.headers, existing?.headers);
  if (read && !read.ok) return { ok: false, field: "headers", error: read.error };
  const headers = read?.headers;

  const saved = await editConfigFile(deps, (source) => {
    // What its endpoint needs beyond the wire format, from the one table (`known-endpoints.ts`): OpenAI's own API
    // takes the output ceiling only as `max_completion_tokens` for its newer models. Read under the file lock, so a
    // key the operator wrote by hand is seen and kept.
    const keys = endpointKeys(source, name, { kind, baseUrl });
    const cleared = keys.remove.reduce((text, key) => removeTomlKey(text, `providers.${name}`, key), source);
    // The set as the form sent it replaces what is there, in whichever of TOML's forms it was written: a
    // `[providers.<name>.headers]` table of an operator's own, left in place, would meet a second `headers`.
    const bare = headers === undefined ? cleared : removeTomlTable(cleared, `providers.${name}.headers`);
    return upsertTomlTable(bare, `providers.${name}`, {
      kind,
      base_url: baseUrl,
      // The NAME again. Same rule, same reason.
      api_key: apiKeySecret,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...keys.set,
    });
  });
  if (!saved.ok) return saved;
  // Once the save is through, so a refused one leaves the key that works in place.
  if (apiKey) await deps.secrets.set(apiKeySecret, apiKey);

  // The profile in the running config is the file's now, headers and all (`config/follow.ts`). Providers, unlike
  // gateways, are resolved per call rather than held open, so this one takes effect immediately and says so — once
  // the client built from the old endpoint and key is gone.
  deps.providers.forget(name);

  log.info("provider profile saved", { name, kind, actor: input.actor });
  deps.audit?.record({
    action: "provider_configured",
    actor: input.actor,
    details: { profile: name, kind, base_url: baseUrl },
  });
  return { ok: true, restartRequired: false };
}

/**
 * Remove a provider profile.
 *
 * Refused while an agent still names it. The agent would keep loading and fail on its first message
 * with a profile-not-found error, hours later, to whoever happened to message it.
 */
export async function removeProvider(
  deps: SettingsDeps,
  name: string,
  actor: string,
  usedBy: () => string[],
): Promise<SaveResult> {
  if (!deps.config.providers[name]) return { ok: false, error: `no profile "${name}"` };

  const users = usedBy();
  if (users.length > 0) {
    return { ok: false, error: `still used by ${users.join(", ")}` };
  }

  const saved = await editConfigFile(deps, (source) => removeTomlTable(source, `providers.${name}`));
  if (!saved.ok) return saved;
  // Gone from the running config with the file; the client built for it goes too, or a name nobody defines would
  // still answer from the cache.
  deps.providers.forget(name);

  log.info("provider profile removed", { name, actor });
  deps.audit?.record({ action: "provider_removed", actor, details: { profile: name } });
  return { ok: true, restartRequired: false };
}
