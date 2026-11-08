/**
 * How an external agent's coding CLI is started (0.8.1): the command, its environment, and its profile folder.
 *
 * It runs as the agent's own user, from the agent's own folder, with the agent's HOME — the CLI is that agent's whole
 * shell, so it gets the wall its commands get. A profile is a folder in that HOME the CLI is pointed at (its sign-in,
 * settings, history): a short shell step, run as the agent too, makes it and the files a new one starts with before the
 * CLI starts, so every file in it is the agent's and none is the daemon's.
 */

import { agentCommandsHaveOwnUsers, ensureDir, fileExists, join, runCommand } from "@nouride/runtime";
import { NourideError } from "@nouride/shared";
import type { CliRow } from "@nouride/acp";
import { buildEnv, ownHomeEnv } from "@/modules/tools/builtins/exec.ts";

export interface Launch {
  cmd: string[];
  env: Record<string, string>;
  cwd: string;
  /** Where its sign-in and settings live; absent for a CLI whose profile is its HOME. */
  profileDir?: string;
}

/** A profile's folder: in the agent's own, per CLI, by name. */
export function profileDirOf(privateDir: string, cli: string, profile: string): string {
  return join(privateDir, ".cli", cli, profile);
}

/** A string as one single-quoted shell word. */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The shell step before the CLI: the profile folder made, each starting file written where none is yet, then the CLI
 * in its place (`exec`), so the process the daemon holds is the CLI's. A file already there is the person's and kept.
 */
export function prepareScript(files: Readonly<Record<string, string>> = {}): string {
  const lines = ["set -e", 'mkdir -p "$1"'];
  for (const [name, content] of Object.entries(files)) {
    lines.push(`[ -e "$1/${name}" ] || printf '%s' ${quoted(content)} > "$1/${name}"`);
  }
  lines.push("shift", 'exec "$@"');
  return lines.join("\n");
}

/**
 * The agent's own folder, where its CLI starts, made where agents are not their own users — where they are, the helper
 * makes it, as theirs. A turn makes it too (`workspaceFor`), but the Brain tab's sign-in check can come first: started in
 * a folder that was not there, a new agent's CLI read as not installed (the e2e VM, 0.8.24). One that cannot be made is
 * left to the start, which says why.
 */
export function ownFolder(dir: string): string {
  if (!agentCommandsHaveOwnUsers()) {
    try {
      ensureDir(dir);
    } catch {
      // Said by the start that needs it, in the CLI's words.
    }
  }
  return dir;
}

export function launchFor(input: {
  row: CliRow;
  profile: string;
  /** The agent's own folder — its HOME where agents have their own users, and where the CLI starts. */
  privateDir: string;
  /** The secrets bound to the CLI's command (`[security.exec_secrets]`), as variables. */
  secrets: Record<string, string>;
  /** What follows the command — its sign-in's words. Absent: its ACP mode. */
  args?: readonly string[];
}): Launch {
  const { row } = input;
  const argv = [row.command, ...(input.args ?? row.args)];
  const profileDir = row.profileEnv ? profileDirOf(input.privateDir, row.id, input.profile) : undefined;
  const env = {
    ...buildEnv({
      // Nobody at a keyboard, and no browser on a box: a CLI that would open one prints its link instead.
      DEBIAN_FRONTEND: "noninteractive",
      GIT_TERMINAL_PROMPT: "0",
      NO_BROWSER: "1",
      ...input.secrets,
      ...row.env,
      ...(row.profileEnv && profileDir ? { [row.profileEnv]: profileDir } : {}),
    }),
    // Its own HOME over the daemon's, after the allowlist, which would put the daemon's back (`commandEnv`).
    ...ownHomeEnv(input.privateDir),
  };
  return {
    cmd: profileDir ? ["sh", "-c", prepareScript(row.profileFiles), "nouride-cli", profileDir, ...argv] : argv,
    env,
    cwd: input.privateDir,
    ...(profileDir ? { profileDir } : {}),
  };
}

/**
 * A shared account's sign-in (`sharedLogin`): the CLI's words in a terminal as the daemon's user — no agent's yet — in a
 * folder of its own, dropped once it ends: the token it prints is all that is kept. Wide, so the token is on one line.
 */
export function accountLaunch(row: CliRow, home: string): Launch {
  const argv = [row.command, ...(row.sharedLogin?.args ?? [])];
  const env = {
    ...buildEnv({ DEBIAN_FRONTEND: "noninteractive", GIT_TERMINAL_PROMPT: "0", NO_BROWSER: "1", ...row.env, ...(row.profileEnv ? { [row.profileEnv]: join(home, "profile") } : {}) }),
    HOME: home,
  };
  const script = 'mkdir -p "$1" && cd "$1" && { stty cols 500 rows 50 2>/dev/null || true; } && shift && exec "$@"';
  return { cmd: ["sh", "-c", script, "nouride-sign-in", home, ...argv], env, cwd: "/" };
}

/** A folder a session starts in, made as the agent where it is not there yet — a mission's, at its first turn. */
export async function folderReady(agentId: string, folder: string, run: typeof runCommand = runCommand): Promise<void> {
  if (await fileExists(folder)) return;
  const out = await run(["mkdir", "-p", folder], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 15_000, maxOutputBytes: 4096, agent: agentId });
  if (out.exitCode !== 0) {
    const why = out.stderr.trim() || `exit ${out.exitCode}`;
    throw new NourideError("external_agent", `${folder} could not be made as ${agentId}: ${why}`, `The mission's folder could not be made: ${why}`);
  }
}
