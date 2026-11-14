/**
 * `[external]` in a pack (0.8.1): the coding CLI that answers this agent's turns, and how.
 *
 * Read at load and refused there with the file and the field (invariant 6): an unknown CLI, a profile name no folder
 * or group could carry, a preset that is not one of the three. Which CLIs exist is the caller's to say (`knownClis`):
 * the built-in rows and the person's own `[[external_clis]]` — this package holds no list of its own.
 */

import { ConfigError, EXTERNAL_PERMISSIONS, type ExternalAgentConfig, type ExternalPermissions } from "@nouride/shared";

/** A profile names a folder and, shared, a group: lowercase, digits and dashes, short enough for a group name. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export interface RawExternal {
  cli?: unknown;
  profile?: unknown;
  model?: unknown;
  permissions?: unknown;
}

/**
 * `profile` as written: one account's name, or several in the order the agent moves through them when one reaches a
 * limit. One field for both, so there is no second setting to keep in step with the first. Each a name a folder could
 * carry, and none twice: an account listed twice would be moved to from itself.
 */
function accountsOf(raw: unknown, where: string, text: (value: unknown, key: string) => string | undefined): string[] {
  const listed = Array.isArray(raw);
  if (listed && raw.length === 0) throw new ConfigError(`${where} [external] profile is an empty list: name an account, or several in the order to move through them, like ["rina", "work"]`);
  const names = (listed ? raw : [raw]).map((entry) => text(entry, "profile")).filter((name): name is string => name !== undefined);
  for (const name of names) {
    if (!PROFILE_NAME.test(name)) throw new ConfigError(`${where} [external] profile "${name}" must be lowercase letters, digits and dashes, at most 24`);
  }
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new ConfigError(`${where} [external] profile lists "${twice}" twice: each account once, in the order to move through them`);
  return names;
}

export function externalOf(raw: unknown, where: string, knownClis: readonly string[] | undefined): { external?: ExternalAgentConfig } {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(`${where} [external] must be a table`);
  const table = raw as RawExternal;
  const text = (value: unknown, key: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${where} [external] ${key} must be a non-empty string`);
    return value.trim();
  };
  const cli = text(table.cli, "cli");
  if (!cli) throw new ConfigError(`${where} [external] cli is required: which coding CLI answers this agent`);
  if (knownClis && !knownClis.includes(cli)) {
    throw new ConfigError(`${where} [external] cli "${cli}" is not a CLI this install knows (known: ${knownClis.join(", ")}); add another as [[external_clis]] in config.toml`);
  }
  const accounts = accountsOf(table.profile, where, text);
  const profile = accounts[0];
  const permissions = table.permissions;
  if (permissions !== undefined && !EXTERNAL_PERMISSIONS.includes(permissions as ExternalPermissions)) {
    throw new ConfigError(`${where} [external] permissions must be one of ${EXTERNAL_PERMISSIONS.join(", ")}, got ${JSON.stringify(permissions)}`);
  }
  const model = text(table.model, "model");
  return {
    external: {
      cli,
      ...(profile ? { profile } : {}),
      ...(accounts.length > 1 ? { accounts } : {}),
      ...(model ? { model } : {}),
      ...(permissions !== undefined ? { permissions: permissions as ExternalPermissions } : {}),
    },
  };
}
