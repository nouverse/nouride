/**
 * The shell a command line is handed to, and the PATH it runs with.
 *
 * Two jobs, and they belong together because both are about the directories agents can write.
 *
 * **The PATH, restored after the login profile.** Boot puts the agents' own directories first on the
 * daemon's PATH, and a plain command inherits it. A shell script did not: `exec` runs one as `bash -lc`,
 * a login shell reads `/etc/profile`, and Debian's resets PATH outright — found on a Pi, where
 * `command -v cloudflared` failed for a binary the agent had installed there itself. So a script whose
 * environment names `NOURIDE_PATH` (the whole composed PATH: the bin directory, the shared Python env,
 * the system's own, the tool directories in HOME) is started with it put back first, after the profile
 * has run. `NOURIDE_BIN` alone is the older spelling of the same thing. Applied at spawn, so the audit
 * log, grants and `nouride jobs` still show the script as it was written.
 *
 * **The shell itself, never from those directories.** `exec` hands a command line to a bare `bash`, and
 * a bare name is looked up on that same PATH — whose first entry is a directory every agent can write
 * and is told to install into. A `bash` dropped there would have run nearly every command after it. So
 * the shell is resolved with the agents' own directories taken off the PATH: the same shell as before
 * wherever nobody shadowed it (Homebrew's bash on a Mac stays Homebrew's), and the system's when
 * somebody did. A shell named by its full path is the caller's own choice and is left alone.
 */

import { dirname } from "node:path";

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** Looked up once per (name, PATH): the PATH a command gets changes only when the daemon restarts. */
const resolved = new Map<string, string>();

/**
 * Where `name` is found with every directory under `.nouride/` taken off the PATH, or the bare name when
 * nothing else provides it — which is what ran before, so a host without one is no worse.
 *
 * Exported for the daemon's own children too: `tar` extracting an update and `ps` checking a lock's
 * pid are looked up on the same PATH, and a `tar` the agents installed should never be the one that
 * unpacks the next binary.
 */
export function systemProgram(name: string, env: Record<string, string | undefined> = process.env): string {
  const path = env.PATH ?? "";
  const own = env.NOURIDE_BIN ? dirname(env.NOURIDE_BIN) : "";
  const key = `${name}\u0000${own}\u0000${path}`;
  let found = resolved.get(key);
  if (found === undefined) {
    const outside = own ? path.split(":").filter((dir) => dir !== own && !dir.startsWith(`${own}/`)).join(":") : path;
    found = Bun.which(name, { PATH: outside }) ?? name;
    if (resolved.size > 64) resolved.clear();
    resolved.set(key, found);
  }
  return found;
}

export function withBinFirst(cmd: string[], env: Record<string, string> | undefined): string[] {
  const head = cmd[0] ?? "";
  if (!SHELLS.has(head.split("/").pop() ?? "")) return cmd;
  const shell = head.includes("/") ? head : systemProgram(head, env ?? process.env);
  const script = cmd[2];
  const restore = env?.NOURIDE_PATH ? "$NOURIDE_PATH" : env?.NOURIDE_BIN ? "$NOURIDE_BIN" : null;
  if (!restore || !["-c", "-lc"].includes(cmd[1] ?? "") || script === undefined) return [shell, ...cmd.slice(1)];
  return [shell, cmd[1]!, `export PATH="${restore}:$PATH"; ${script}`, ...cmd.slice(3)];
}
