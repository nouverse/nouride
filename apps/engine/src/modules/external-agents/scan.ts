/**
 * Which coding CLIs this box has (`nouride agents scan` and New Agent's Answered by): each
 * row's version command run once, read as installed and a version, or as missing with how to install it. Nouride
 * ships no CLI; this only says what is there.
 */

import { cliStanding, type CliRow, type CliVersionView } from "@nouride/acp";
import { runCommand } from "@nouride/runtime";
import { buildEnv } from "@/modules/tools/builtins/exec.ts";
import type { NewestVersions } from "./newest.ts";

export interface ScannedCli {
  id: string;
  name: string;
  /** Who makes it: "Anthropic". */
  maker?: string;
  command: string;
  installed: boolean;
  /** As the CLI printed it; absent where it printed none Nouride could read. */
  version?: string;
  /** Said where it is not installed. */
  install: string;
  /** Whether a sign-in can be run for it from here. */
  login: boolean;
  loginNote?: string;
  /** The npm package that carries it (0.8.24); absent for a person's own CLI. */
  package?: string;
  /** The versions of its package this Nouride was tested with. */
  tested?: { lowest: string; highest: string };
  /** The newest the npm registry said, where it was reached (`newest.ts`). */
  newest?: string;
  /** Where its version stands against `tested` and `newest`, where both its version and `tested` are known. */
  standing?: CliVersionView;
}

/**
 * The scanned CLIs with the newest each package has published, where the registry said, and where each version stands
 * (0.8.24). The registry is asked about the installed ones only; `check` asks it now rather than once a day.
 */
export async function withStanding(clis: readonly ScannedCli[], newest: Pick<NewestVersions, "of"> | undefined, check: boolean): Promise<ScannedCli[]> {
  const packages = clis.flatMap((cli) => (cli.installed && cli.package ? [cli.package] : []));
  const said = newest ? await newest.of(packages, check) : {};
  return clis.map((cli) => {
    const out = cli.package ? said[cli.package] : undefined;
    const standing = cli.installed && cli.version && cli.tested ? cliStanding(cli.version, cli.tested, out) : null;
    return { ...cli, ...(out ? { newest: out } : {}), ...(standing ? { standing } : {}) };
  });
}

const VERSION = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/;
const MISSING = /not found|No such file|ENOENT|executable file not found/i;

export async function scanCli(row: CliRow, run: typeof runCommand = runCommand): Promise<ScannedCli> {
  const base = {
    id: row.id,
    name: row.name,
    ...(row.maker ? { maker: row.maker } : {}),
    command: row.command,
    install: row.install,
    login: (row.login?.length ?? 0) > 0,
    ...(row.loginNote ? { loginNote: row.loginNote } : {}),
    ...(row.package ? { package: row.package } : {}),
    ...(row.tested ? { tested: row.tested } : {}),
  };
  try {
    const out = await run([row.command, ...row.versionArgs], { cwd: "/", env: buildEnv({}), timeoutMs: 20_000, maxOutputBytes: 8192 });
    // 126 and 127 are the shell's "cannot run" and "not found"; a CLI that ran and failed its version flag is there.
    if (out.exitCode === 127 || out.exitCode === 126 || MISSING.test(out.stderr) && out.exitCode !== 0) return { ...base, installed: false };
    const version = `${out.stdout}\n${out.stderr}`.match(VERSION)?.[0];
    return { ...base, installed: true, ...(version ? { version } : {}) };
  } catch (err) {
    if (MISSING.test(String(err))) return { ...base, installed: false };
    throw err;
  }
}
