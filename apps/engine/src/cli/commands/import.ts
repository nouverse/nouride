/**
 * `nouride import <file>`: an export put in place of everything this install holds (`modules/transfer/import.ts`).
 *
 * It replaces the files a running daemon holds open, so it is refused while one runs: stop Nouride, import, start it.
 * The file is opened and checked first, and what it holds is said beside what it replaces; then the word that confirms
 * it is typed. The passphrase is asked for without echo. A script gives both on stdin (`--stdin`): the passphrase on
 * the first line, the word on the second.
 */

import { dirname, join, openLinePrompt, readStdin, removePath, resolve, statFile } from "@nouride/runtime";
import { BOLD, DIM, GREEN, RESET, YELLOW, bareArgs, emit, fail, hasFlag, say, usageError } from "@nouride/cli-kit";
import { plural } from "@nouride/shared";
import type { ImportReport } from "@nouride/wire";
import { commandKeyLayout, commandStoreEnv } from "@/boot/secret-store.ts";
import { keptName, stagingOf } from "@/boot/staged-import.ts";
import { refuseWhileRunning } from "@/cli/commands/db.ts";
import { agentsIn, holds } from "@/cli/commands/export.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { VERSION } from "@/commons/version.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import { applyImport, openImport } from "@/modules/transfer/import.ts";
import { CONFIRM_WORD } from "@/modules/transfer/service.ts";
import { startHint } from "@/service/hints.ts";

/** What an import says it brought and left, and what to do next. */
function sayReport(report: ImportReport): void {
  say(`${GREEN}✓${RESET} imported, from Nouride ${report.from.version}: ${report.agents.length} ${plural(report.agents.length, "agent")}${report.agents.length > 0 ? ` (${report.agents.join(", ")})` : ""}`);
  for (const line of holds(report.parts, 0).slice(1)) say(`  - ${line}`);
  say(report.secrets === null ? `${YELLOW}!${RESET} The file held no secrets: set each again on Secrets, or the connections and models that need one will not work.` : `  - ${report.secrets} ${plural(report.secrets, "secret")}, now under this machine's own key`);
  say(`${DIM}Did not come: a coding CLI's sign-ins (sign each in again), the snapshots, logs, installed tools, a chat app's own session${report.folders ? "" : ", the agents' own folders"}.${RESET}`);
  if (report.passed.links + report.passed.credentials > 0) say(`${DIM}Passed over when the file was made: ${report.passed.links} ${plural(report.passed.links, "link")}, ${report.passed.credentials} ${plural(report.passed.credentials, "file")} that hold a sign-in or a key.${RESET}`);
  for (const one of report.missing) say(`${YELLOW}!${RESET} ${one.setting} names ${one.path}, which is not on this machine.`);
  say(`${DIM}Everyone signs in again (${report.ended.sessions} ${plural(report.ended.sessions, "session")} and ${report.ended.devices} ${plural(report.ended.devices, "device")} ended), with the accounts of the install that was exported.${RESET}`);
  say(`${BOLD}Not live yet.${RESET} ${report.held.connections.length} ${plural(report.held.connections.length, "connection")} and ${report.held.automations} ${plural(report.held.automations, "automation")} wait, and ${report.held.missions} ${plural(report.held.missions, "mission")} ${report.held.missions === 1 ? "was" : "were"} paused.`);
  say(`  Switch the old machine off, then press ${BOLD}Go live${RESET} on the dashboard's Settings, Export and import.`);
  say(`${DIM}  What this install held before is kept in ${report.kept}: remove it once you are satisfied.${RESET}`);
}

export async function importInstall(args: string[]): Promise<void> {
  const [named] = bareArgs(args);
  if (!named) usageError("Which file?", "nouride import <file> [--stdin]");
  const file = resolve(named);
  if (!statFile(file)) fail(`${file} is not there, or cannot be read from here.`, "On a server, Nouride's commands run as its own account, whoever types them: put the file where that account can read it, such as /var/tmp.");
  const { config, source } = await loadConfig();
  const configPath = source ?? defaultConfigPath();
  const data = config.daemon.dataDir;
  refuseWhileRunning(data);

  const piped = hasFlag(args, "--stdin") ? (await readStdin()).split("\n").map((line) => line.trim()) : null;
  const staging = stagingOf(data);
  const prompt = piped ? null : openLinePrompt();
  try {
    let opened = await openImport({ file, staging, version: VERSION, ...(piped ? { passphrase: piped[0] } : {}) });
    if (!opened.ok && opened.why === "passphrase" && prompt && process.stdin.isTTY) {
      opened = await openImport({ file, staging, version: VERSION, passphrase: await prompt.askHidden("The passphrase typed when this file was made: ") });
    }
    // The page's words say "password"; a terminal asked for a passphrase, and says so.
    if (!opened.ok) fail(opened.why === "passphrase" ? "That passphrase does not open this file's secrets. It is the one typed when the file was made." : opened.plain, "Nothing was changed.");
    const { manifest } = opened;

    say(`${BOLD}This file${RESET}, made by Nouride ${manifest.version} on ${new Date(manifest.madeAt).toISOString().slice(0, 10)}, holds`);
    for (const line of holds(manifest.parts, manifest.database.bytes)) say(`  - ${line}`);
    say(manifest.secrets === null ? "  - no secrets" : `  - ${manifest.secrets} ${plural(manifest.secrets, "secret")}`);
    const here = agentsIn(config.daemon.agentsDir);
    say(`${BOLD}It replaces everything this install holds${RESET}: ${here.length} ${plural(here.length, "agent")}${here.length > 0 ? ` (${here.join(", ")})` : ""}, every chat, memory, account and secret. Nothing is merged. What is here now is kept in a folder beside it.`);
    const typed = piped ? (piped[1] ?? "") : ((await prompt?.ask(`Type ${CONFIRM_WORD} to go on: `).catch(() => "")) ?? "").trim();
    if (typed !== CONFIRM_WORD) {
      removePath(staging);
      fail(typed ? `Nothing was changed: "${typed}" is not ${CONFIRM_WORD}.` : `Nothing was changed: ${CONFIRM_WORD} was not typed.`);
    }

    const kept = join(dirname(data), keptName(Date.now()));
    const done = await applyImport({ opened, config, configPath, kept, store: { env: commandStoreEnv(), layout: commandKeyLayout({ dataDir: data, configPath }) } });
    if (!done.ok) fail(done.restored ? "The import failed, and this install was put back as it was." : `The import failed, and not everything could be put back: what this install held is in ${kept}.`, done.error);
    emit(done.report);
    sayReport(done.report);
    say(`${DIM}  ${startHint()}${RESET}`);
  } finally {
    prompt?.close();
  }
}
