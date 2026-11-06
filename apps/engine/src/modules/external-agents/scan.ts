/**
 * Which coding CLIs this box has (EXTERNAL_AGENTS §5.3, `nouride agents scan` and New Agent's Answered by): each
 * row's version command run once, read as installed and a version, or as missing with how to install it. Nouride
 * ships no CLI; this only says what is there.
 */

import type { CliRow } from "@nouride/acp";
import { runCommand } from "@nouride/runtime";
import { buildEnv } from "@/modules/tools/builtins/exec.ts";

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
}

const VERSION = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/;
const MISSING = /not found|No such file|ENOENT|executable file not found/i;

export async function scanCli(row: CliRow, run: typeof runCommand = runCommand): Promise<ScannedCli> {
  const base = { id: row.id, name: row.name, ...(row.maker ? { maker: row.maker } : {}), command: row.command, install: row.install, login: (row.login?.length ?? 0) > 0, ...(row.loginNote ? { loginNote: row.loginNote } : {}) };
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
