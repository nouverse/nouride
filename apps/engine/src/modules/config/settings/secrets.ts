/**
 * The secret store, as the control plane may touch it.
 *
 * **Nothing here returns a value, and nothing ever should.** The store exists so a config file can
 * name a credential instead of holding one; a function here that handed one back would make every
 * caller of the control API — the dashboard, the CLI, and through the CLI an *agent* — able to read
 * every token on the box. `hasSecret` answers the only question anybody actually has about a value:
 * whether it resolves.
 */

import { createLogger } from "@nouride/shared";
import { envNamesFor, type FieldChange, SecretError, type StoreLock } from "@nouride/secrets";
import { unnamePackSecret } from "./agents.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

/** Whether a named secret resolves to anything. Never the value — see the MCP list endpoint. */
export function hasSecret(deps: SettingsDeps, name: string): boolean {
  return Boolean(deps.secrets.resolve(name));
}

export function groupContextDefault(deps: SettingsDeps): number {
  return deps.config.agents.groupContextMessages;
}

/** One credential, as a management screen needs to see it. Never a value. */
export interface SecretEntry {
  name: string;
  /** `env`, `store`, or `missing` — referenced by something and set by nobody. */
  origin: "env" | "store" | "missing";
  /**
   * What breaks if this is wrong, in the operator's words.
   *
   * The reason this endpoint is worth having at all. A list of names answers "what is stored"; the
   * question anybody actually arrives with is "which of these is the Discord token for Nox, and is
   * it set" — and a name alone cannot answer it, because the name is whatever somebody typed into
   * `config.toml` a year ago.
   */
  usedBy: string[];
  /**
   * Set in the store *and* shadowed by an environment variable of the same name.
   *
   * The store write succeeded and changes nothing, because `resolve` reads the environment first.
   * Invisible without this, and indistinguishable from the new value simply not working.
   */
  shadowed: boolean;
  /** What is said about it (0.8.19): free fields, a name and a text each. Never secret, so shown to whoever lists. */
  fields: Record<string, string>;
  addedBy?: string;
  addedAt?: string;
  changedAt?: string;
}

/**
 * Every credential this daemon knows the name of, and what each one is for.
 *
 * Three sources, merged. What the store holds; what the environment provides for a name something
 * references; and what is referenced by the configuration and set by nobody — the last being the one
 * an operator most needs, because a missing credential shows up as a gateway that will not connect
 * rather than as anything saying which secret is absent.
 *
 * Still not values. `SecretStore` has no route to read one back and this does not add one.
 */
export function secretInventory(deps: SettingsDeps): SecretEntry[] {
  const usage = new Map<string, string[]>();
  const note = (name: string | undefined, what: string): void => {
    const key = name?.trim();
    if (!key) return;
    usage.set(key, [...(usage.get(key) ?? []), what]);
  };

  // `providers` is keyed by profile name, so the key is the name and the value carries the rest.
  for (const [name, profile] of Object.entries(deps.config.providers)) {
    note(profile.apiKeySecret, `provider ${name}`);
  }
  for (const gateway of deps.config.gateways) {
    note(gateway.tokenSecret, `gateway ${gateway.id}`);
    note(gateway.encryptionKeySecret, `gateway ${gateway.id} (session encryption)`);
  }
  note(deps.config.dashboard.oauth?.secretName, "dashboard sign-in");
  for (const pack of deps.packs?.() ?? []) {
    for (const name of pack.secrets) note(name, `agent ${pack.agentId}'s commands`);
  }
  // Only when something would use it: the stock config names `brave_search_api_key` whether or not
  // anybody has one, and a "missing" row for a key nobody needs is a false alarm.
  const web = deps.config.security.web;
  if (web.searchApiKey && (deps.secrets.origin(web.searchApiKey) || web.searchEndpoint || web.searchKind !== "brave")) {
    note(web.searchApiKey, "web search");
  }

  const stored = new Set(deps.secrets.inventory().map((entry) => entry.name));
  const names = [...new Set([...stored, ...usage.keys()])].sort();

  return names.map((name) => {
    const origin = deps.secrets.origin(name);
    const said = stored.has(name) ? deps.secrets.describe(name) : null;
    return {
      name,
      origin: origin ?? "missing",
      usedBy: usage.get(name) ?? [],
      shadowed: origin === "env" && stored.has(name),
      fields: said?.fields ?? {},
      ...(said?.addedBy ? { addedBy: said.addedBy } : {}),
      ...(said?.addedAt ? { addedAt: said.addedAt } : {}),
      ...(said?.changedAt ? { changedAt: said.changedAt } : {}),
    };
  });
}

/** Whether the store is encrypted yet, and where its key is (0.8.19): said on the Secrets page and by `doctor`. */
export function secretLock(deps: Pick<SettingsDeps, "secrets">): StoreLock {
  return deps.secrets.lock();
}

/**
 * What is said about a stored secret, changed: its fields, a name and a text each. Its value is untouched, so it asks
 * nothing of anyone and is audited by the names it changed.
 */
export async function changeSecretFields(deps: Pick<SettingsDeps, "secrets" | "audit">, params: {
  name: string;
  change: FieldChange;
  actor?: string;
}): Promise<SaveResult & { fields?: Record<string, string> }> {
  try {
    const fields = await deps.secrets.changeFields(params.name.trim(), params.change);
    const changed = [...Object.keys(params.change.set ?? {}), ...(params.change.remove ?? [])];
    deps.audit?.record({ action: "secret_fields_changed", actor: params.actor, details: { name: params.name, fields: changed } });
    return { ok: true, restartRequired: false, fields };
  } catch (err) {
    if (err instanceof SecretError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Whether an environment variable of the same name takes priority over the store.
 *
 * `resolve` checks the environment first, so writing a secret that is shadowed succeeds and changes
 * nothing — a silent no-op indistinguishable from success. Callers say this back rather than letting
 * somebody debug it later.
 */
export function secretShadowedByEnv(_deps: SettingsDeps, name: string): boolean {
  return envNamesFor(name).some((envName) => Boolean(process.env[envName]));
}

/**
 * Store a credential under a name.
 *
 * Overwriting is allowed, deliberately: an agent handed a rotated key should be able to store it,
 * and refusing would mean every rotation needs a human at a terminal. It is a change worth an audit
 * row, and it gets one — with the length, never the value.
 */
export async function setSecret(deps: Pick<SettingsDeps, "secrets" | "audit">, params: {
  name: string;
  value: string;
  actor?: string;
  /** What is said about it, given with the value (0.8.19). */
  fields?: FieldChange;
}): Promise<SaveResult> {
  const name = params.name.trim();
  if (!name) return { ok: false, error: "secret name is required" };
  if (!params.value) return { ok: false, error: "a secret with no value is not a secret" };

  const replaced = deps.secrets.has(name);
  try {
    await deps.secrets.set(name, params.value, { ...(params.fields ? { fields: params.fields } : {}), ...(params.actor ? { actor: params.actor } : {}) });
  } catch (err) {
    // A field refused (a key's shape in it, a name too long), said back; the value is not stored without what was said.
    if (err instanceof SecretError) return { ok: false, error: err.message };
    throw err;
  }

  // Length and not a prefix: even four characters of a token is four characters of a token, and this
  // row is kept for thirty days.
  log.info("secret stored", { name, replaced, chars: params.value.length, actor: params.actor });
  deps.audit?.record({
    action: "secret_stored",
    actor: params.actor,
    details: { name, replaced, chars: params.value.length },
  });
  return { ok: true, restartRequired: false };
}

/**
 * Remove one.
 *
 * No restart is reported even though a live gateway may be authenticating with it: the gateway holds
 * the value it resolved at boot, so nothing breaks until something reloads. Saying "restart
 * required" would invite exactly the restart that turns a recoverable mistake into an outage.
 *
 * Deleted means deleted (0.7.17): gone for good — not still set in the environment — it goes from every agent's
 * `exec_secrets` too, so no command goes on asking for a value that is not there. The dialog says so first. What the
 * daemon's own config names it with — a provider's key, a connection's token — stays, and finds no value.
 */
export async function deleteSecret(deps: SettingsDeps, params: {
  name: string;
  actor?: string;
}): Promise<boolean> {
  const name = params.name.trim();
  if (!name) return false;
  const deleted = await deps.secrets.delete(name);
  const packs = deps.secrets.resolve(name) === undefined ? (deps.packs?.() ?? []).filter((pack) => pack.secrets.includes(name)) : [];
  const unnamed: string[] = [];
  for (const pack of packs) {
    if (await unnamePackSecret({ agentConfigPath: pack.configPath, reload: pack.reload, name })) unnamed.push(pack.agentId);
  }
  if (deleted || unnamed.length > 0) {
    log.warn("secret removed", { name, actor: params.actor, ...(unnamed.length > 0 ? { agents: unnamed } : {}) });
    deps.audit?.record({ action: "secret_removed", actor: params.actor, details: { name, ...(unnamed.length > 0 ? { agents: unnamed } : {}) } });
  }
  return deleted || unnamed.length > 0;
}
