/**
 * An http MCP server's headers, every way its block names one: literal values (`headers`), credentials by a secret's
 * name (`header_secrets`), and who each call is made for (`identity`) — and the rule that one header has one of them.
 */

import { assertSecretName, looksLikeCredential } from "@nouride/secrets";
import { ConfigError, type McpIdentityHeader, type McpServerConfig } from "@nouride/shared";

/** A string where one is written, else a refusal naming where. */
function text(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ConfigError(`${where} must be a string`);
  return value;
}

/** A secret's name, refused when it is a value (invariant 3): the message names the field, never the value. */
function secretName(name: string, where: string): string {
  try {
    assertSecretName(name, where);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return name;
}

/**
 * `headers = { "X-Client" = "nouride" }` — a flat table of strings, and nothing that looks like a
 * credential.
 *
 * The refusal is the point. `headers` is the obvious place to paste a bearer token, and doing so
 * produces a daemon that works — while the token sits in a `config.toml` that gets committed,
 * copied into a backup, and pasted into an issue. `auth_secret` exists so there is somewhere right
 * to put it, so this says that rather than just saying no.
 */
export function headerTable(value: unknown, at: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${at} headers must be a table of header name → string`);
  }

  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "string") {
      throw new ConfigError(`${at} headers "${name}" must be a string`);
    }
    if (looksLikeCredential(raw)) {
      throw new ConfigError(
        `${at} headers "${name}" looks like a credential: put it in the secret store and name it ` +
          `with auth_secret instead, so it is not sitting in a file that gets committed`,
      );
    }
    headers[name] = raw;
  }
  return headers;
}

/** A header's name as HTTP takes one. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * `header_secrets = { "x-api-key" = "secret_name" }` — an HTTP server's headers that hold a credential, each the
 * **name** of a secret (`McpServerConfig.headerSecrets`). Refused for a stdio server, which has no headers to send.
 */
export function headerSecretTable(value: unknown, transport: string, at: string): Record<string, string> {
  if (transport === "stdio") throw new ConfigError(`${at} header_secrets is for an http server's headers; a stdio server's credential is env_secrets`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${at} header_secrets must be a table of "header-name" = "secret_name"`);
  }
  const table: Record<string, string> = {};
  for (const [header, name] of Object.entries(value)) {
    if (!HEADER_NAME.test(header)) throw new ConfigError(`${at} header_secrets: "${header}" is not a header's name`);
    table[header] = secretName(text(name, `${at} header_secrets.${header}`)!, `${at} header_secrets.${header}`);
  }
  return table;
}

/** The placeholders an identity header's `format` may hold (`McpServerConfig.identity`). */
const IDENTITY_FIELDS = ["{account}", "{accounts}", "{person_key}"];

/**
 * `[identity]` — who a call is made for, in one header the daemon fills (`McpServerConfig.identity`). Refused for a
 * stdio server, and for a format that names nothing the daemon knows: a constant would be sent as everyone's identity.
 */
export function identityHeader(value: unknown, transport: string, at: string): McpIdentityHeader {
  if (transport === "stdio") throw new ConfigError(`${at} identity is for an http server's headers: a stdio server is one process for every sender`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${at} identity must be a table: header = "x-…", format = "{person_key}", on_unknown = "omit" or "fail"`);
  }
  const table = value as Record<string, unknown>;
  for (const field of Object.keys(table)) {
    if (!["header", "format", "on_unknown"].includes(field)) throw new ConfigError(`${at} identity.${field} is not a key of identity: header, format, on_unknown`);
  }
  const header = text(table.header, `${at} identity.header`);
  if (!header || !HEADER_NAME.test(header)) throw new ConfigError(`${at} identity.header must be a header's name, like "x-app-sender"`);
  const format = text(table.format, `${at} identity.format`) ?? "{account}";
  const placeholders = format.match(/\{[^}]*\}/g) ?? [];
  const unknown = placeholders.filter((field) => !IDENTITY_FIELDS.includes(field));
  if (unknown.length > 0) throw new ConfigError(`${at} identity.format: ${unknown.join(", ")} is not something the daemon fills; it fills ${IDENTITY_FIELDS.join(", ")}`);
  if (placeholders.length === 0) throw new ConfigError(`${at} identity.format names no sender: with none of ${IDENTITY_FIELDS.join(", ")} every call would carry the same value`);
  const onUnknown = table.on_unknown ?? "omit";
  if (onUnknown !== "omit" && onUnknown !== "fail") throw new ConfigError(`${at} identity.on_unknown must be "omit" (no header) or "fail" (the call refused)`);
  return { header, format, onUnknown };
}

/**
 * The headers of an http server, by every way it names one: literal, a secret, its bearer token, and its identity.
 * Refused where two would set one header: which of them reached the server would be whichever was written last.
 */
export function oneHeaderEach(server: McpServerConfig, at: string): void {
  const owners = new Map<string, string>();
  const take = (header: string, by: string) => {
    const lower = header.toLowerCase();
    const before = owners.get(lower);
    if (before) throw new ConfigError(`${at} ${header} is set by both ${before} and ${by}: name it once`);
    owners.set(lower, by);
  };
  for (const header of Object.keys(server.headers ?? {})) take(header, "headers");
  for (const header of Object.keys(server.headerSecrets ?? {})) take(header, "header_secrets");
  if (server.authSecret) take(server.authHeader ?? "Authorization", server.authHeader ? "auth_secret (under auth_header)" : "auth_secret (as a bearer token)");
  if (server.auth === "oauth") take("Authorization", "its login (auth = \"oauth\")");
  if (server.identity) take(server.identity.header, "identity");
}
