/**
 * What a coding CLI runs on, read from the files installed beside its connector: the connector's own
 * `package.json` (its version, the Node it asks for, its dependencies), each dependency's as installed, and of those the
 * one the row names as the CLI itself (`CliRow.carries`). Nothing is written by hand but that one name, and no CLI is
 * started: Claude Code's binary is 300 MB, and its version is a line of JSON beside it.
 *
 * Only for a row that names its package: a person's own CLI is a command and nothing more is known of it. A file that
 * is not there or does not parse leaves its version out, which is shown as unknown.
 */

import { cliPart, underMinimum, type CliPart, type CliRow } from "@nouride/acp";
import { dirname, fileExistsSync, join, readTextFileSync, realPath, whichBinary, type runCommand } from "@nouride/runtime";

interface PackageJson {
  name?: unknown;
  version?: unknown;
  engines?: unknown;
  dependencies?: unknown;
  [field: string]: unknown;
}

/** How far up a folder tree a `package.json` or a `node_modules` is looked for: an install is never this deep. */
const UP = 12;

function readPackage(file: string): PackageJson | null {
  if (!fileExistsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readTextFileSync(file));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** The folder of the package named `name` that holds `file`: its own, not one further up that happens to be a package. */
function packageRoot(file: string, name: string): { dir: string; json: PackageJson } | null {
  let dir = dirname(file);
  for (let i = 0; i < UP; i += 1) {
    const json = readPackage(join(dir, "package.json"));
    if (json && json.name === name) return { dir, json };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** A dependency's `package.json` as Node finds it from `from`: its own `node_modules`, then each folder's above. */
function dependency(from: string, name: string): PackageJson | null {
  let dir = from;
  for (let i = 0; i < UP; i += 1) {
    const json = readPackage(join(dir, "node_modules", name, "package.json"));
    if (json) return json;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * The parts of `row`'s CLI as this box has them, the CLI itself first; empty where the row names no package or its
 * connector's files are not found. `env` is what the CLI is started with: its PATH finds the command, and the Node that
 * would run it.
 */
export async function readParts(row: CliRow, env: Record<string, string>, run: typeof runCommand): Promise<CliPart[]> {
  if (!row.package) return [];
  const command = row.command.includes("/") ? row.command : whichBinary(row.command, env.PATH ?? "");
  const root = command ? packageRoot(realPath(command), row.package) : null;
  if (!root) return [];
  const parts: CliPart[] = [];
  const version = (json: PackageJson | null, field = "version") => {
    const read = text(json?.[field]);
    return read ? { version: read } : {};
  };

  if (row.carries) parts.push({ kind: "cli", name: row.carries.name, package: row.carries.package, ...version(dependency(root.dir, row.carries.package), row.carries.field) });
  parts.push({ kind: "connector", name: row.package, package: row.package, ...version(root.json) });

  const engines = root.json.engines;
  const needs = engines && typeof engines === "object" ? text((engines as { node?: unknown }).node) : undefined;
  if (needs) {
    const has = await nodeVersion(env, run);
    const tooOld = has ? underMinimum(has, needs) : null;
    parts.push({ kind: "runtime", name: "Node.js", ...(has ? { version: has } : {}), needs, ...(tooOld === null ? {} : { tooOld }) });
  }

  const dependencies = root.json.dependencies;
  const names = dependencies && typeof dependencies === "object" ? Object.keys(dependencies).sort() : [];
  for (const name of names) {
    if (name === row.carries?.package) continue;
    parts.push({ kind: "dependency", name, package: name, ...version(dependency(root.dir, name)) });
  }
  return parts;
}

/** The Node on the CLI's PATH, as it says: what starts a connector that asks for one. Null where none answers. */
async function nodeVersion(env: Record<string, string>, run: typeof runCommand): Promise<string | null> {
  try {
    const out = await run(["node", "--version"], { cwd: "/", env, timeoutMs: 20_000, maxOutputBytes: 1024 });
    if (out.exitCode !== 0) return null;
    return /^v?(\d+\.\d+\.\d+)/.exec(out.stdout.trim())?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * What each CLI runs on, as it was last read, by CLI id: `/status` names the CLI's own version from it without a scan
 * of its own. Filled by a scan, and when a CLI starts with nothing read of it yet; emptied after an update, whose new
 * version the next start reads.
 */
export class KeptParts {
  private readonly kept = new Map<string, CliPart[]>();

  /** A scan's answer: each CLI's parts as it read them, and none for one it read nothing of. */
  note(clis: readonly { id: string; parts?: CliPart[] }[]): void {
    for (const cli of clis) cli.parts ? this.kept.set(cli.id, cli.parts) : this.kept.delete(cli.id);
  }

  /** A CLI started: its parts read, where nothing was read of it yet. Never waited for, and a failed read says nothing. */
  started(row: CliRow, env: Record<string, string>, run: typeof runCommand): void {
    if (this.kept.has(row.id)) return;
    void readParts(row, env, run).then(
      (parts) => void (parts.length > 0 && this.kept.set(row.id, parts)),
      () => undefined,
    );
  }

  clear(): void {
    this.kept.clear();
  }

  /** The CLI's own version, where a part that is the CLI was read with one. */
  ownVersion(cliId: string): string | undefined {
    return cliPart(this.kept.get(cliId))?.version;
  }
}
