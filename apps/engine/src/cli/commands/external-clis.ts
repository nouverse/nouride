/**
 * The coding CLIs behind external agents, from a terminal (0.8.1): `nouride agents scan` — which this box has — and
 * `nouride agents login <id>` — an agent's CLI signed in, the sign-in run on the box and answered here.
 */

import { openLinePrompt } from "@nouride/runtime";
import { BOLD, DIM, GREEN, RESET, YELLOW, fail, say } from "@nouride/cli-kit";
import type { ScannedCli } from "@nouride/wire";
import type { Client, AgentCliResponse, CliLoginResponse, ExternalClisResponse } from "@nouride/cli-kit";

/**
 * Looked at now, every time: who asks in a terminal has usually just installed one. From the last minute's answer — the
 * one the dashboard keeps — the orchestrator was told Codex was not installed right after it installed it, and set
 * about "fixing" that (0.8.1, the live box).
 */
export async function scanClis(client: Client): Promise<void> {
  const { room, clis } = await client.get<ExternalClisResponse>("/external-clis?fresh=1");
  if (!room.enough) return say(`${DIM}No room for a coding CLI here: the agents' commands may hold ${mib(room.bytes)}, and one CLI's session needs at least ${mib(room.needs)}.${RESET}`);
  for (const cli of clis) {
    if (cli.installed) say(`${GREEN}●${RESET} ${BOLD}${cli.id}${RESET} ${DIM}${cli.name} · ${cli.command}${cli.version ? ` ${cli.version}` : ""}${RESET}`);
    else say(`${DIM}○ ${cli.id} ${cli.name}, not installed: ${cli.install}${RESET}`);
    const standing = versionLine(cli);
    if (standing) say(`    ${warns(cli) ? YELLOW : DIM}${standing}${RESET}`);
    if (cli.installed && !cli.login && cli.loginNote) say(`    ${DIM}${cli.loginNote}${RESET}`);
  }
}

/** Whether its version is one to look at: older than this Nouride supports, or newer than it was tested with. */
const warns = (cli: ScannedCli): boolean => cli.standing?.standing === "older" || cli.standing?.standing === "newer";

/** `nouride doctor`'s line for each installed CLI with a tested range: a warning where its version is one to look at. */
export function cliVersionChecks(clis: readonly ScannedCli[]): { level: "ok" | "warn"; message: string }[] {
  return clis.flatMap((cli) => {
    const line = cli.installed ? versionLine(cli) : null;
    return line ? [{ level: warns(cli) ? ("warn" as const) : ("ok" as const), message: `coding CLI ${cli.id}: ${line}` }] : [];
  });
}

/**
 * Where an installed CLI's version stands, in a line (0.8.24): against the versions this Nouride was tested with, and the
 * newest its package has published where the registry was reached — `agents scan` and `doctor` say the same. Null for a
 * CLI with no tested range: a person's own, which names no package.
 */
function versionLine(cli: ScannedCli): string | null {
  const { standing, tested, version } = cli;
  if (!standing || !tested || !version) return null;
  const range = `${tested.lowest} to ${tested.highest}`;
  const out = standing.untested ? `; ${standing.untested} is out, not yet tested with this Nouride` : "";
  switch (standing.standing) {
    case "older":
      return `${version} is older than this Nouride supports (tested with ${range}): update it to ${standing.offer}${out}`;
    case "newer":
      return `${version} is newer than this Nouride was tested with (${range}): it runs, untested`;
    case "update":
      return `${standing.offer} is out, the newest this Nouride was tested with (${range}); this is ${version}${out}`;
    case "current":
      return `${version}, the newest this Nouride was tested with (${range})${out}`;
  }
}

/**
 * The sign-in, run on the box and shown here: what its terminal prints, as it prints it, and each line typed here as
 * its next input — a code it asks for, a choice. Ctrl-D stops it.
 */
export async function loginCli(client: Client, id: string): Promise<void> {
  let view = (await client.post<CliLoginResponse>(`/agents/${id}/cli/login`)).login;
  let printed = "";
  const show = () => {
    process.stdout.write(newOutput(printed, view.output));
    printed = view.output;
  };
  show();
  const rl = openLinePrompt();
  let typing = true;
  rl.onClose(() => {
    if (!typing) return;
    typing = false;
    void client.post(`/agents/${id}/cli/login/stop`).catch(() => {});
  });
  void (async () => {
    while (typing) {
      const line = await rl.ask("").catch(() => null);
      if (line === null || !typing) return;
      view = (await client.post<CliLoginResponse>(`/agents/${id}/cli/login/answer`, { text: line })).login;
    }
  })().catch((err: unknown) => say(`${YELLOW}that line did not reach the sign-in: ${err instanceof Error ? err.message : String(err)}${RESET}`));
  while (view.running) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    view = (await client.get<AgentCliResponse>(`/agents/${id}/cli`)).login ?? view;
    show();
  }
  typing = false;
  rl.close();
  if (view.signedIn) say(`\n${GREEN}✓${RESET} ${id}'s CLI is signed in: its next turn starts it with the sign-in`);
  else fail(`the sign-in ended without signing in (exit ${view.exitCode})`, `nouride agents login ${id} to try again`);
}

/**
 * What to print of a sign-in's screen, `printed` already shown: what was added where it only grew, and from the first
 * line that changed where it was drawn again in place — a terminal here cannot redraw what has scrolled by. Read as a
 * stream, a redrawn screen was printed twice over, and a line redrawn at the same length never (0.8.8).
 */
export function newOutput(printed: string, output: string): string {
  if (output.startsWith(printed)) return output.slice(printed.length);
  let same = 0;
  while (same < printed.length && printed[same] === output[same]) same += 1;
  const from = same === 0 ? 0 : output.lastIndexOf("\n", same - 1) + 1;
  return `${printed === "" || printed.endsWith("\n") ? "" : "\n"}${output.slice(from)}`;
}

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;
