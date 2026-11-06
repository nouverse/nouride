/**
 * The programs every agent runs, and who may change them (0.8.0).
 *
 * Where each agent's commands run as its own user, what one agent installs lands in its own HOME (`ownUserEnv`): a
 * shared directory an agent could write is one where it puts a program another agent — or the daemon — then runs. The
 * programs installed for every agent before stay shared and runnable: `.nouride/bin`, `lib`, `opt`, and the tools the
 * daemon's HOME holds (`claude` in `~/.local`, Rust in `~/.cargo` and `~/.rustup`). Changing them is the orchestrator's
 * (`[daemon] orchestrator`), through `nouride tools run`, as the daemon's user — unless its pack says
 * `[security] shared_tools = false`. Everywhere the agents share the daemon's user, nothing here applies.
 */

import { join, readTextFileSync, runCommand } from "@nouride/runtime";
import type { GlobalConfig, LoadedAgent } from "@nouride/shared";

/** The tool folders in the daemon's HOME that every agent runs from, and the orchestrator changes. */
export const SHARED_HOME_TOOLS = [".local", ".cargo", ".rustup"] as const;

/** The group every agent's own user is in: what is shared is its to read and run. */
const AGENTS_GROUP = "nr-agents";

/** Whether `agent` installs and updates the programs every agent runs: the orchestrator's, unless its pack says no. */
export function changesSharedTools(config: Pick<GlobalConfig, "daemon">, agent: Pick<LoadedAgent, "config"> | undefined): boolean {
  return agent !== undefined && config.daemon.orchestrator === agent.config.id && agent.config.sharedTools !== false;
}

/** Every shared program folder: the install's own, then the daemon's HOME's. */
export function sharedToolDirs(nouride: string, home: string): string[] {
  return [join(nouride, "bin"), join(nouride, "lib"), join(nouride, "opt"), ...SHARED_HOME_TOOLS.map((dir) => join(home, dir))];
}

/**
 * The commands that make what was installed every agent's to run: the group `nr-agents`, and read and search for it,
 * on each entry that lacks them — and only those. The install's own folders are setgid (install.sh), and a `chmod`
 * that touched one would set that bit again, which the daemon's unit refuses (`RestrictSUIDSGID`): every
 * `nouride tools run` reported a failure for a program every agent could run. What the daemon adds under `UMask=0027`
 * already has the group's bits; what it adds in the HOME's tool folders, which are not setgid, takes the group here.
 */
export function shareCommands(dirs: readonly string[]): string[][] {
  return [
    ["find", ...dirs, "!", "-group", AGENTS_GROUP, "-exec", "chgrp", "-h", AGENTS_GROUP, "{}", "+"],
    // The whole choice in parentheses: `-o` binds looser than the `-exec` after it.
    ["find", ...dirs, "(", "(", "-type", "d", "!", "-perm", "-g=rx", ")", "-o", "(", "-type", "f", "!", "-perm", "-g=r", ")", ")", "-exec", "chmod", "g+rX", "{}", "+"],
  ];
}

/**
 * Whether this machine has the agents' group, which the installer makes with each agent's own user. Where it has none
 * — a container, macOS, a Linux install without the helper — every agent is the daemon's user, and what was installed
 * is theirs already: a `find -group` naming a group that does not exist fails, and `nouride tools run` said "not every
 * agent can run it yet" after an install that had worked (0.8.1, on Docker and macOS).
 */
export function hasAgentsGroup(groupFile = "/etc/group"): boolean {
  try {
    return readTextFileSync(groupFile).split("\n").some((line) => line.startsWith(`${AGENTS_GROUP}:`));
  } catch {
    return false;
  }
}

/** Every agent given what was installed: after each `nouride tools run`, and at boot for the shared HOME's tools. */
export async function shareTools(dirs: readonly string[], groupFile = "/etc/group"): Promise<{ ok: boolean; problem?: string }> {
  if (!hasAgentsGroup(groupFile)) return { ok: true };
  const sandbox = { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 120_000, maxOutputBytes: 8192 };
  for (const command of shareCommands(dirs)) {
    const done = await runCommand(command, sandbox);
    // A folder that is not there yet is nothing to share; any other refusal is said.
    const problem = done.stderr.split("\n").filter((line) => line && !/No such file or directory/.test(line)).join("; ");
    if (done.exitCode !== 0 && problem) return { ok: false, problem };
  }
  return { ok: true };
}
