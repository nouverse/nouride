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
  const profile = text(table.profile, "profile");
  if (profile !== undefined && !PROFILE_NAME.test(profile)) {
    throw new ConfigError(`${where} [external] profile "${profile}" must be lowercase letters, digits and dashes, at most 24`);
  }
  const permissions = table.permissions;
  if (permissions !== undefined && !EXTERNAL_PERMISSIONS.includes(permissions as ExternalPermissions)) {
    throw new ConfigError(`${where} [external] permissions must be one of ${EXTERNAL_PERMISSIONS.join(", ")}, got ${JSON.stringify(permissions)}`);
  }
  const model = text(table.model, "model");
  return {
    external: {
      cli,
      ...(profile ? { profile } : {}),
      ...(model ? { model } : {}),
      ...(permissions !== undefined ? { permissions: permissions as ExternalPermissions } : {}),
    },
  };
}
