/**
 * `nouride agents install <cli>`: a coding CLI its maker installs with a script of its own (`CliRow.script`),
 * installed for every agent. An npm one is set up by the orchestrator with `nouride tools run`; these three (Antigravity,
 * Cursor, Grok Build) were said as a terminal's work for whoever runs the server, and their cards had no Set it up.
 * Run as `tools run` runs an install: this user, the shared HOME, then shared with every agent. The installer leaves the
 * CLI in that HOME; it is copied into the install's `opt/<id>` and linked into its `bin` under the name it is started by.
 */

import { BUILT_IN_CLIS, type CliRow } from "@nouride/acp";
import { DIM, GREEN, RESET, emit, fail, say, usageError } from "@nouride/cli-kit";
import type { Client, ExternalClisResponse } from "@nouride/cli-kit";
import type { InstallShared } from "./agents-update.ts";

const USAGE = "Usage: nouride agents install <cli> (`nouride agents scan` lists them)";

/**
 * The install, its words handed in as arguments and never written into it: the script's address, where it leaves the
 * CLI under HOME, the CLI's id, `folder` or `file`, and the name it is started by. A copy, not a link into HOME: Grok's
 * installer leaves it in `~/.grok`, which is not a folder shared with every agent.
 */
const SCRIPT_INSTALL = `set -eu
curl -fsSL "$1" | bash
real=$(readlink -f "$HOME/$2" || true)
[ -f "$real" ] || { echo "the installer left nothing at ~/$2" >&2; exit 1; }
to="$(cd "$NOURIDE_BIN/.." && pwd)/opt/$3"
rm -rf "$to" && mkdir -p "$to"
if [ "$4" = folder ]; then cp -R "$(dirname "$real")/." "$to/"; else cp "$real" "$to/"; fi
ln -sfn "$to/$(basename "$real")" "$NOURIDE_BIN/$5"`;

/** The command that installs a script-installed CLI, as `tools run` runs a command. */
export function scriptInstall(row: CliRow & { script: NonNullable<CliRow["script"]> }): string[] {
  const { url, binary, folder } = row.script;
  return ["bash", "-c", SCRIPT_INSTALL, "install", url, binary, row.id, folder ? "folder" : "file", row.command];
}

export async function installCli(client: Client, args: readonly string[], install: InstallShared): Promise<void> {
  const [id] = args;
  if (!id) usageError("Which coding CLI?", USAGE);
  const row = BUILT_IN_CLIS.find((entry) => entry.id === id);
  if (!row) usageError(`No coding CLI "${id}" is built in.`, USAGE);
  if (!row.script) fail(`${row.name} is not installed with its maker's own script`, row.package ? `nouride tools run -- npm i -g ${row.package}` : row.install);
  const before = (await client.get<ExternalClisResponse>("/external-clis?fresh=1")).clis.find((entry) => entry.id === id);
  if (before?.installed) {
    emit({ cli: id, installed: true, changed: false, version: before.version ?? null });
    return say(`${GREEN}✓${RESET} ${row.name} is installed already${before.version ? `, at ${before.version}` : ""}`);
  }

  say(`${DIM}installing ${row.name} with ${row.maker ?? "its maker"}'s own installer${RESET}`);
  const ran = await install(scriptInstall({ ...row, script: row.script }));
  if (!ran.shared) fail(`${row.name}'s installer did not finish (exit ${ran.exitCode ?? "killed"})`, "Nothing was set up for the agents.");
  if (!ran.shared.ok) fail(`${row.name} is installed, but not every agent can run it yet: ${ran.shared.problem}`);
  const after = (await client.get<ExternalClisResponse>("/external-clis?fresh=1")).clis.find((entry) => entry.id === id);
  if (!after?.installed) fail(`${row.name}'s installer finished, but \`${row.command}\` does not run where the agents run it`);
  emit({ cli: id, installed: true, changed: true, version: after.version ?? null });
  say(`${GREEN}✓${RESET} ${row.name}${after.version ? ` ${after.version}` : ""} is installed for every agent. Sign in to it on the Models page.`);
}
