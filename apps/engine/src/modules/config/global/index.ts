/**
 * Daemon config loading — §7 ARCHITECTURE, §20 SPEC.
 *
 * Two parsing strategies, because there are two kinds of section:
 *
 * - **Fixed shape** (`daemon`, `security`, `llm`, …) — keys are camelized and deep merged onto
 *   `DEFAULT_CONFIG`, which doubles as the schema, so a typo gets a warning instead of being
 *   silently swallowed. See `merge.ts`.
 * - **Open shape** (`[providers.*]`, `[gateways.<platform>.<name>]`) — the names are the operator's,
 *   so a generic merge cannot tell a new profile from a misspelled key. Validated field by field in
 *   `open-sections.ts`, with errors that name the table they came from.
 *
 * This file is the order those run in, which is the part worth reading in one place: the retired-key check, the
 * fixed keys dropped, merge, then the open sections, then structure, then env overrides, then paths, then the full
 * validation pass.
 */

import { hostTimeZone, loadTomlIfExists, parseToml, resolve, statFile } from "@nouride/runtime";
import { ConfigError, holding, quietly, type GlobalConfig, type LogEntry } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { absolutePath, absolutizePaths, defaultConfigPath, executableRoot, INSTALL_ROOT, installRootFor } from "./paths.ts";
import { parseExternalClis } from "./external-clis.ts";
import { parseGateways, parseProviders } from "./open-sections.ts";
import { isPlainObject, mergeConfig } from "./merge.ts";
import { refuseLooserExec, withoutGoneKeys } from "./gone-keys.ts";
import { applyEnvOverrides } from "./env.ts";
import { assertTypes, validate, validateStructure } from "./validate.ts";
import { readPeople } from "@/modules/people/entry.ts";
import { loadPeopleDir, peopleDirOf } from "@/modules/people/files.ts";

export { INSTALL_ROOT, defaultConfigPath } from "./paths.ts";
export { mergeConfig } from "./merge.ts";
export { assertGatewayExecPosture, reportConfigAdvisories } from "./validate.ts";


export interface LoadedConfig {
  config: GlobalConfig;
  /** Absolute path the config came from, or null when running on defaults. */
  source: string | null;
  /**
   * What the loader had to say about the file — an unknown key, a setting worth a second look —
   * held back by a `quiet` load, and empty for one that said them. Boot says them as it loads. `nouride doctor` and
   * `config check` list them among their own lines, and every other command keeps them off a terminal that asked it
   * something else: `nouride status` printed each one on stderr, on every run.
   */
  notes: ConfigNote[];
}

/** One thing the loader said about a config file, as a line to read: what, its particulars, and what to do about it. */
export interface ConfigNote {
  message: string;
  detail?: string;
  hint?: string;
}

/**
 * A held line as a note: its data is the particulars, and a `hint` in it is the advice. Also `config check`'s, for
 * what loading the packs logs while it holds (`holdLines`).
 */
export function noteOf(entry: LogEntry): ConfigNote {
  const { hint, ...rest } = entry.data ?? {};
  const detail = Object.entries(rest)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
  return { message: entry.message, ...(detail ? { detail } : {}), ...(typeof hint === "string" ? { hint } : {}) };
}


/**
 * Find the config and load it. Resolution order, first hit wins:
 *
 * 1. `$NOURIDE_CONFIG` — an explicit file, for anyone who wants no searching at all.
 * 2. `$NOURIDE_HOME` — an explicit install root, both shapes.
 * 3. `<cwd>/.nouride/config.toml`, then `<cwd>/config.toml` only when the cwd also holds a `.nouride/` — a
 *    source checkout, or an operator standing in the install.
 * 4. The binary's own directory, both shapes, when it is not the cwd — so an installed `nouride` works
 *    from anywhere.
 * 5. Built-in defaults. A missing file is not an error: a fresh checkout should boot.
 *
 * A bare `config.toml` is a candidate because it is what an operator writes by hand next to the binary,
 * and because the example file ships beside it. The install root is what `nouride setup` creates and what
 * everything defaults into.
 *
 * `client`: the CLI talking to a daemon — see `applyEnvOverrides`. `quiet`: every command but `start` — what the loader
 * says is held back and handed over as `notes`. A config that does not load still throws, quiet or not.
 */
export async function loadGlobalConfig(
  cwd: string = process.cwd(),
  options: { client?: boolean; quiet?: boolean; /** Where the running binary lives; a test's stand-in for it. */ execRoot?: string } = {},
): Promise<LoadedConfig> {
  const { source, raw, root } = await locate(cwd, options.execRoot ?? executableRoot());
  if (!options.quiet) return { config: configFrom(raw, source, root, options), source, notes: [] };
  const { value, held } = holding(() => configFrom(raw, source, root, options));
  return { config: value, source, notes: held.map(noteOf) };
}

/**
 * The data directory the config names, read without loading the rest of it: the file `loadGlobalConfig` finds, the
 * same precedence (`NOURIDE_DATA_DIR`, `[daemon] data_dir`, the default) and the same root. For the upgrade floor,
 * which answers when a config.toml from before 0.7.28 will not load (`boot/upgrade-floor.ts`).
 */
export async function configuredDataDir(cwd: string = process.cwd(), execRoot: string = executableRoot()): Promise<string> {
  const { source, raw, root } = await locate(cwd, execRoot);
  const written = isPlainObject(raw.daemon) && typeof raw.daemon.data_dir === "string" ? raw.daemon.data_dir : DEFAULT_CONFIG.daemon.dataDir;
  return absolutePath(process.env.NOURIDE_DATA_DIR || written, installRootFor(source, root));
}

/** The config file, in the order `loadGlobalConfig` says, parsed — and the install it belongs to. */
async function locate(cwd: string, execRoot: string): Promise<{ source: string | null; raw: Record<string, unknown>; root: string }> {
  const home = process.env.NOURIDE_HOME;

  const candidates = [
    process.env.NOURIDE_CONFIG,
    ...(home ? [defaultConfigPath(home), resolve(home, "config.toml")] : []),
    defaultConfigPath(cwd),
    // A bare `config.toml` in the cwd only beside an install: any project's own config.toml (a Hugo site's) was
    // read as this one's — unknown-key warnings, a data directory under that project, "No control token found".
    ...(statFile(resolve(cwd, INSTALL_ROOT))?.isDirectory ? [resolve(cwd, "config.toml")] : []),
    // Last, and only when it names a different place than the cwd already covered. Behind the cwd
    // deliberately: a developer running against a checkout must never be silently served the
    // installed daemon's config.
    ...(execRoot && execRoot !== resolve(cwd)
      ? [defaultConfigPath(execRoot), resolve(execRoot, "config.toml")]
      : []),
  ].filter((p): p is string => Boolean(p));

  const source = candidates.find((path) => statFile(path)?.isDirectory === false) ?? null;
  const raw = source ? ((await loadTomlIfExists<Record<string, unknown>>(source)) ?? {}) : {};

  // With no file yet, `$NOURIDE_HOME` is still the install: a fresh container's CLI, run from an agent's workspace,
  // otherwise looked for the control token under that workspace and reported no daemon.
  const root = home ? resolve(home) : source ? cwd : installWithoutConfig(cwd, execRoot);
  return { source, raw, root };
}

/**
 * The install a command belongs to when no config file names one: the cwd when it holds an install — standing in one, or
 * in a checkout — else the binary's own, which the installer creates (`<install>/.nouride`) before setup writes any
 * config, else the cwd.
 *
 * The binary's was not asked. A fresh install's CLI run as root from its home, before the wizard, looked for the
 * daemon's control token under `/root/.nouride` and said a daemon running in `/srv/nouride` was another install's — and
 * `nouride users reset`, the recovery for a lost first password, would have reset an empty database there instead.
 */
function installWithoutConfig(cwd: string, execRoot: string): string {
  if (statFile(resolve(cwd, INSTALL_ROOT))?.isDirectory) return cwd;
  if (execRoot && statFile(resolve(execRoot, INSTALL_ROOT))?.isDirectory) return execRoot;
  return cwd;
}

/**
 * The loader's steps on a parsed file, in its order: parse onto the defaults, the environment's overrides, the full
 * validation, then every relative path made absolute against the install the file belongs to (`installRootFor`), not
 * the cwd. One sequence for boot (`loadGlobalConfig`) and for a save (`readConfigText`), so what a save puts in the
 * running daemon is what the next boot would load.
 */
function configFrom(raw: Record<string, unknown>, source: string | null, cwd: string, options: { client?: boolean } = {}): GlobalConfig {
  // People from their own files once the folder is there (0.8.18, `people/files.ts`): the `[[people]]` block the move
  // kept for the way back is then neither read nor checked, and a save of any other setting cannot bring it back.
  const filed = source ? loadPeopleDir(peopleDirOf(source)) : null;
  const config = parseConfig(filed ? withoutPeople(raw) : raw);
  if (filed) config.people = filed;
  applyEnvOverrides(config, options);
  validate(config);
  absolutizePaths(config, installRootFor(source, cwd));
  return config;
}

/**
 * What the loader makes of `text` as the daemon's config file at `path` — what a save is checked by before it lands,
 * and what the running daemon's copy then follows (`config/follow.ts`). Throws what the loader throws. Quietly: its
 * warnings were said when the daemon loaded the file, and a save is not the moment to repeat them.
 */
export function readConfigText(text: string, path: string): GlobalConfig {
  return quietly(() => configFrom(parseToml<Record<string, unknown>>(text), path, process.cwd()));
}

/**
 * Why `text` would not load as this daemon's config, or null — the loader's own steps on it, in its order, without
 * its warnings. For a file about to be written somewhere a running daemon is not: `nouride gateway rename` checks the
 * config it plans with it. A save to the running daemon's file is checked by `readConfigText`, whose answer it keeps.
 */
export function configProblem(text: string): string | null {
  try {
    quietly(() => configFrom(parseToml<Record<string, unknown>>(text), null, process.cwd()));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Tables and keys 0.7.x still read under an old name and rewrote on disk (`config/upgrade.ts`, until 0.7.28), refused
 * in 0.8.0 with what replaced each. Refused rather than ignored: dropped, each would change what the daemon does
 * without a word — who may talk to it, when a conversation resets, which agent answers first, how skills are learned.
 * A preset's old name (`normal`, `risky`, `none`) is refused by the enum check like any other unknown level.
 */
const RETIRED: readonly { present: (raw: Record<string, unknown>) => boolean; refusal: string }[] = [
  {
    present: (raw) => isPlainObject(raw.security) && "sender_allowlist" in raw.security,
    refusal: "config.toml [security] sender_allowlist is gone: list those ids in [security.access] allowlist",
  },
  {
    present: (raw) => "session_memory" in raw,
    refusal: "config.toml [session_memory] is gone: its reset is [rollover], and conversations are episodes under [memory]. Remove the section",
  },
  {
    present: (raw) => isPlainObject(raw.daemon) && "default_agent" in raw.daemon,
    refusal: 'config.toml [daemon] default_agent is gone: write orchestrator = "<agent id>" in [daemon]',
  },
  {
    present: (raw) => Array.isArray(raw.people) && raw.people.some((entry) => isPlainObject(entry) && "id" in entry),
    refusal: 'config.toml [[people]] id is gone: write ids = ["platform:account", …] in that entry instead',
  },
  {
    present: (raw) => "rsi" in raw,
    refusal:
      'config.toml [rsi] is gone: write [skills.learning], with mode = "off", "ask" or "auto" (require_approval is ask, ' +
      "always_allow is auto), and model and notify_chat as they were",
  },
];

function refuseRetiredForms(raw: Record<string, unknown>): void {
  const found = RETIRED.filter((form) => form.present(raw));
  if (found.length > 0) throw new ConfigError(found.map((form) => form.refusal).join("\n"));
}

export function parseConfig(raw: Record<string, unknown>): GlobalConfig {
  // Open-shaped sections are pulled out first so the generic merge never sees them and
  // never reports their user-chosen names as unknown keys.
  const { providers, gateways, external_clis: externalClis, ...written } = raw;

  refuseRetiredForms(written);
  refuseLooserExec(written);
  // A key 0.8.0 took out is named and dropped before the merge, which would otherwise call it a typo.
  const merged = mergeConfig(structuredClone(DEFAULT_CONFIG), withoutGoneKeys(written));
  // Before anything reads a value: a string where a boolean belongs was true, a scalar where a list belongs was split
  // into characters, and a number where text belongs took the load down on its first `.trim()`.
  assertTypes(merged);
  // Left out, this machine's zone, by name — so every config a parse hands back can format a date. The empty default
  // only says "not set"; handed to `Intl` it is refused, and whatever skipped `applyEnvOverrides` ran without memory.
  if (typeof merged.daemon.timezone === "string" && !merged.daemon.timezone.trim()) merged.daemon.timezone = hostTimeZone();
  // Today's shape whatever the file's: a key for everyone, every account in `ids` — see `readPeople`.
  merged.people = readPeople(merged.people as unknown[]);
  merged.providers = parseProviders(providers);
  merged.gateways = parseGateways(gateways);
  merged.externalClis = parseExternalClis(externalClis);

  // Structural checks belong here rather than in the caller: a parse that can hand back a
  // config referencing a profile that does not exist is a trap for every other entry point.
  validateStructure(merged);

  return merged;
}

/** The file as parsed, without its `[[people]]`: what the loader reads when the people are in their own files. */
function withoutPeople(raw: Record<string, unknown>): Record<string, unknown> {
  const { people: _kept, ...rest } = raw;
  return rest;
}

