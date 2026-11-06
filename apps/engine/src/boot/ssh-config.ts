/**
 * The agents' ssh reads the agents' HOME (0.7.17).
 *
 * The unit sets `HOME` to `.nouride/home`, and everything an agent writes about ssh goes there — the `network-reach`
 * skill appends hosts to `~/.ssh/config`. But OpenSSH does not read `$HOME`: it reads `~/.ssh/config` from the home
 * `/etc/passwd` gives the account, `/home/<user>` on every install made before 0.7.17. Found on the live box: two
 * hosts an agent had added were in a file ssh never opened, and that home is read-only to the service
 * (`ProtectHome`), so no connection socket could be made there either.
 *
 * Moving the account's home needs root, which an update does not have. So at every start the daemon bridges it
 * itself, unprivileged, the same on every version an install comes from:
 *
 * - `ssh`, `scp` and `sftp` in `.nouride/bin` — first on the agents' PATH — run the real ones with
 *   `-F "$HOME/.ssh/config"` when that file exists. A `-F` the command gives itself comes later and wins. `git` and
 *   `rsync` call `ssh` from PATH, so they follow.
 * - That config ends with `Match all` and an `Include` of the passwd home's config and the system's, once: `-F` skips
 *   `/etc/ssh/ssh_config`, so it is named again, and whatever ssh read before still applies, after the agents' own
 *   entries. `Match all` first, because an `Include` under the last `Host` block would apply to that host only. Hosts
 *   an agent appends later land below it — fine unless the account's config has a `Host *` setting the same option.
 * - `~` in a config is still the passwd home, read-only, so new host keys go to `${HOME}/.ssh/known_hosts` — the old
 *   file is still read. Before this, every ssh job opened with "Failed to add the host to the list of known hosts".
 *
 * Nothing happens where the two homes are the same — a person's own machine, an install made by 0.7.17's
 * `install.sh` — or where there is no ssh.
 */

import { fileExistsSync, join, readTextFileSync, resolve, writeBytesSync, whichBinary, ensureDir } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { OWN_WRAPPER } from "@/modules/toolchain/bin-report.ts";

const log = createLogger("daemon");

const PROGRAMS = ["ssh", "scp", "sftp"] as const;

export function settleSsh(params: { home: string | undefined; passwdHome: string | null; bin: string; path: string }): void {
  const { home, passwdHome, bin } = params;
  if (!home || !passwdHome || resolve(home) === resolve(passwdHome)) return;
  // The real programs, from PATH without the directory the wrappers go in.
  const systemPath = params.path.split(":").filter((dir) => dir && resolve(dir) !== resolve(bin)).join(":");
  let wrapped = 0;
  for (const program of PROGRAMS) {
    const real = whichBinary(program, systemPath);
    if (!real) continue;
    writeIfChanged(join(bin, program), wrapper(real), 0o755);
    wrapped += 1;
  }
  if (wrapped === 0) return;

  const theirs = join(passwdHome, ".ssh", "config");
  const ours = join(home, ".ssh", "config");
  const text = fileExistsSync(ours) ? readTextFileSync(ours) : "";
  const include = `Include ${theirs}`;
  if (text.split("\n").some((line) => line.trim() === include)) return;
  ensureDir(join(home, ".ssh"), 0o700);
  const block = [
    "# Added by Nouride (0.7.17): what ssh read before (the account's config from its home in /etc/passwd, and the",
    "# system's, which -F skips). Entries above come first. `Match all` closes the last Host block: this is every host.",
    "Match all",
    "    UserKnownHostsFile ${HOME}/.ssh/known_hosts ~/.ssh/known_hosts",
    include,
    "Include /etc/ssh/ssh_config",
    "",
  ].join("\n");
  const gap = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  writeIfChanged(ours, `${text}${gap}${block}`, 0o600);
  log.info("the agents' ssh config now includes the account's own, and keeps new host keys in HOME", { included: theirs, config: ours });
}

/** A wrapper that names the agents' config, and nothing else. */
function wrapper(real: string): string {
  return [
    "#!/bin/sh",
    `${OWN_WRAPPER} (0.7.17): edits here do not last.`,
    "# OpenSSH reads ~/.ssh/config from /etc/passwd's home, not $HOME; this names the agents' HOME's config.",
    `if [ -f "$HOME/.ssh/config" ]; then exec ${real} -F "$HOME/.ssh/config" "$@"; fi`,
    `exec ${real} "$@"`,
    "",
  ].join("\n");
}

function writeIfChanged(path: string, content: string, mode: number): void {
  if (fileExistsSync(path) && readTextFileSync(path) === content) return;
  writeBytesSync(path, new TextEncoder().encode(content), mode);
}
