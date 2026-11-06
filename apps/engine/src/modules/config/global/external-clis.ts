/**
 * `[[external_clis]]` (0.8.1): a coding CLI the person adds for external agents, beside the two built in — Claude Code
 * and Codex.
 *
 * Read field by field, as the other open sections are: a row starts a program as the agent's user, so a misspelled key
 * is warned about and a wrong type refused at load, naming the entry — not found at the agent's first turn as a CLI
 * that "is not installed". An id a built-in row has is refused: the built-in one was tried, and a row of the same name
 * that is not would read as if it were. No `env`: a secret the CLI needs is bound to its command in
 * `[security.exec_secrets]`, which never puts a value in this file.
 */

import { BUILT_IN_CLIS } from "@nouride/acp";
import { ConfigError, createLogger, EXTERNAL_PERMISSIONS, type ExternalCliConfig, type ExternalPermissions } from "@nouride/shared";
import { isPlainObject, requireString } from "./merge.ts";

const log = createLogger("config.external-clis");

const KEYS = new Set(["id", "name", "command", "args", "install", "version_args", "profile_env", "modes", "instruction_file", "login", "login_note", "status", "signed_out"]);
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
/** A file in the folder the CLI works in: a name, never a path out of it. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseExternalClis(raw: unknown): ExternalCliConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError("[[external_clis]] must be a list of tables, each written [[external_clis]]");
  const rows = raw.map((entry, index) => parseRow(entry, `[[external_clis]] #${index + 1}`));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new ConfigError(`[[external_clis]] id "${row.id}" is written twice`);
    seen.add(row.id);
  }
  return rows;
}

function parseRow(entry: unknown, at: string): ExternalCliConfig {
  if (!isPlainObject(entry)) throw new ConfigError(`${at} must be a table`);
  const id = requireString(entry.id, `${at} id`)?.trim();
  if (!id || !ID.test(id)) throw new ConfigError(`${at} id must be lowercase letters, digits and "-", up to 32: it is what a pack's [external] cli names`);
  const where = `[[external_clis]] "${id}"`;
  if (BUILT_IN_CLIS.some((row) => row.id === id)) throw new ConfigError(`${where} is a built-in CLI's id: remove the entry, or give yours another id`);
  for (const key of Object.keys(entry)) if (!KEYS.has(key)) log.warn("unknown config key ignored", { key: `${where} ${key}` });

  const command = requireString(entry.command, `${where} command`)?.trim();
  if (!command) throw new ConfigError(`${where} command is required: the program that speaks ACP, by name on the daemon's PATH or by path`);
  const profileEnv = requireString(entry.profile_env, `${where} profile_env`);
  if (profileEnv !== undefined && !VARIABLE.test(profileEnv)) throw new ConfigError(`${where} profile_env must be a variable name, like MY_CLI_HOME`);
  const instructionFile = requireString(entry.instruction_file, `${where} instruction_file`) ?? "AGENTS.md";
  if (!FILE_NAME.test(instructionFile)) throw new ConfigError(`${where} instruction_file must be a file name in the folder the CLI works in, like AGENTS.md`);
  const login = strings(entry.login, `${where} login`);
  const loginNote = requireString(entry.login_note, `${where} login_note`);
  const status = strings(entry.status, `${where} status`);
  const signedOut = strings(entry.signed_out, `${where} signed_out`);
  const modes = modesOf(entry.modes, where);

  return {
    id,
    name: requireString(entry.name, `${where} name`)?.trim() || id,
    command,
    args: strings(entry.args, `${where} args`) ?? [],
    install: requireString(entry.install, `${where} install`)?.trim() || `install ${command} where the daemon's user finds it on its PATH`,
    versionArgs: strings(entry.version_args, `${where} version_args`) ?? ["--version"],
    instructionFile,
    ...(profileEnv ? { profileEnv } : {}),
    ...(modes ? { modes } : {}),
    ...(login?.length ? { login } : {}),
    ...(loginNote ? { loginNote } : {}),
    ...(status?.length ? { status } : {}),
    ...(signedOut?.length ? { signedOut } : {}),
  };
}

function strings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ConfigError(`${where} must be a list of strings`);
  return value as string[];
}

function modesOf(value: unknown, where: string): Partial<Record<ExternalPermissions, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new ConfigError(`${where} modes must be a table: folder, risky and all, each the CLI's own mode id`);
  const modes: Partial<Record<ExternalPermissions, string>> = {};
  for (const [preset, mode] of Object.entries(value)) {
    if (!(EXTERNAL_PERMISSIONS as readonly string[]).includes(preset)) throw new ConfigError(`${where} modes.${preset} is not a preset (${EXTERNAL_PERMISSIONS.join(", ")})`);
    if (typeof mode !== "string" || !mode.trim()) throw new ConfigError(`${where} modes.${preset} must be the CLI's mode id`);
    modes[preset as ExternalPermissions] = mode.trim();
  }
  return modes;
}
