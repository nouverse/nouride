/**
 * One Python env every agent shares: `.nouride/opt/python`, a venv layered over the system's packages.
 *
 * Debian marks its Python externally managed (PEP 668), so `pip install` is refused, `pip install
 * --user` is refused, and `/usr` is read-only to this daemon anyway. That leaves an agent asked for
 * pandas with three ways to improvise and no right one — and the one it reached for on the live box was
 * a venv in its scratchpad, which the sweep deleted three days later along with everything in it.
 *
 * The sanctioned answer to PEP 668 is a venv, so there is one, kept where installs are kept and second
 * on every command's PATH (`env.ts`): `python3`, `pip`, a `#!/usr/bin/env python3` script and whatever
 * pip installs all resolve to it, and `pip install x` simply works.
 *
 * `--system-site-packages`, so nothing that imports today stops importing: the distribution's packages
 * and anything a person installed system-wide stay visible, and `pip install` of one of them answers
 * "already satisfied" instead of a second copy. `VIRTUAL_ENV` is deliberately never set — tools that
 * read it (poetry, uv, pdm) would put a project's dependencies here instead of in the project's own env.
 *
 * Built at boot without holding it up, and rebuilt when it no longer matches the system's Python — a
 * Debian release upgrade, or a container image with a newer one — because a venv points at the
 * interpreter it was made from and dies with it. What it held is listed beside the old copy, so the
 * reinstall is one command.
 */

import { createLogger } from "@nouride/shared";
import {
  dirname,
  ensureDir,
  fileExistsSync,
  join,
  listDir,
  readTextFileSync,
  removePath,
  renamePath,
  runCommand,
  writeTextFile,
} from "@nouride/runtime";

const log = createLogger("toolchain");

export type PythonEnvState =
  | { state: "ready"; version: string }
  | { state: "creating" }
  | { state: "unavailable"; why: string }
  | { state: "failed"; why: string };

let current: PythonEnvState | null = null;

/** What the env was when boot last looked, or null where this daemon keeps none (a person's own checkout). */
export function pythonEnvState(): PythonEnvState | null {
  return current;
}

/** The `major.minor` a venv was made with, from its own `pyvenv.cfg`, or null. */
export function venvVersion(dir: string): string | null {
  try {
    return /^version(?:_info)?\s*=\s*(\d+\.\d+)/m.exec(readTextFileSync(join(dir, "pyvenv.cfg")))?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function ensurePythonEnv(
  dir: string,
  input: { python: string | null; env: Record<string, string>; run?: typeof runCommand },
): Promise<PythonEnvState> {
  if (!input.python) return (current = { state: "unavailable", why: "python3 is not installed" });
  const run = input.run ?? runCommand;
  ensureDir(dirname(dir));
  const sandbox = (timeoutMs: number) => ({ cwd: dirname(dir), timeoutMs, maxOutputBytes: 64 * 1024, env: input.env });

  const probe = await run([input.python, "-c", "import sys, venv; print('%d.%d' % sys.version_info[:2])"], sandbox(15_000));
  const version = probe.stdout.trim();
  if (probe.exitCode !== 0 || !/^\d+\.\d+$/.test(version)) {
    return (current = { state: "unavailable", why: lastLine(probe.stderr) || "python3 has no venv module" });
  }

  if (fileExistsSync(join(dir, "pyvenv.cfg"))) {
    if (venvVersion(dir) === version && fileExistsSync(join(dir, "bin", "python3")) && fileExistsSync(join(dir, "bin", "pip"))) {
      return (current = { state: "ready", version });
    }
    await setAside(dir);
  }

  current = { state: "creating" };
  const made = await run([input.python, "-m", "venv", "--system-site-packages", dir], sandbox(120_000));
  if (made.exitCode !== 0) {
    const why = lastLine(made.stderr || made.stdout) || `exit ${made.exitCode ?? "killed"}`;
    // What venv made before it stopped — an env with no pip — goes, or the next boot sets it aside as a stale one and
    // tries again: a box without python3-venv gathered one more copy every start.
    removePath(dir);
    log.warn("could not create the shared Python env", { dir, why });
    // Debian ships the venv module and keeps pip's wheels in a separate package.
    return (current = { state: "failed", why: /ensurepip|python3[\d.]*-venv/.test(made.stderr + made.stdout) ? "the python3-venv package is not installed" : why });
  }
  log.info("the shared Python env is ready", { dir, version });
  return (current = { state: "ready", version });
}

/**
 * Move a stale env out of the way, keeping a list of what it held.
 *
 * Read from the `.dist-info` directories rather than `pip freeze`, because the interpreter that would
 * run `pip` is usually the thing that went away.
 */
async function setAside(dir: string): Promise<void> {
  const aside = `${dir}.broken-${Date.now()}`;
  renamePath(dir, aside);
  const lib = join(aside, "lib");
  const sites = listDir(lib).filter((entry) => entry.name.startsWith("python")).map((entry) => join(lib, entry.name, "site-packages"));
  const held = sites.flatMap((site) => listDir(site).map((entry) => entry.name))
    .filter((name) => name.endsWith(".dist-info"))
    .map((name) => name.slice(0, -".dist-info".length).replace(/-([^-]+)$/, "==$1"))
    .filter((spec) => !/^(pip|setuptools|wheel)==/.test(spec));
  if (held.length > 0) await writeTextFile(join(aside, "requirements.txt"), `${held.sort().join("\n")}\n`);
  log.warn("the shared Python env no longer matched this system's Python and was rebuilt", {
    old: aside,
    ...(held.length > 0 ? { reinstall: `pip install -r ${join(aside, "requirements.txt")}` } : {}),
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).at(-1)?.trim() ?? "";
}
