/**
 * Provider profiles: the endpoints agents run against.
 */

import { createLogger } from "@nouride/shared";
import type { ProviderKind } from "@nouride/shared";
import { upsertTomlTable, removeTomlTable } from "@/modules/config/edit.ts";
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
export type ProviderField = "name" | "kind" | "baseUrl" | "apiKey";

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

  const saved = await editConfigFile(deps, (source) =>
    upsertTomlTable(source, `providers.${name}`, {
      kind,
      base_url: baseUrl,
      // The NAME again. Same rule, same reason.
      api_key: apiKeySecret,
    }),
  );
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
