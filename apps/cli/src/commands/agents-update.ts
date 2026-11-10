/**
 * `nouride agents update <cli> [<version>]` (0.8.24): a coding CLI to the newest version this Nouride was tested with, or
 * to `<version>` — the way back after a failed check. In order: held at the daemon until no turn runs in it (one still
 * running after ten minutes: nothing is installed, and it says so); installed through the shared tools folder as `nouride
 * tools run` installs, as this user; checked at the daemon, the CLI started again for its first agent and its new
 * version's handshake read (`external-agents/cli-update.ts`). A failed check leaves only that CLI's agents unavailable,
 * and names the version to go back to. The Update button asks the orchestrator to run this; it is not typed by people.
 */

import { BOLD, DIM, GREEN, RESET, emit, fail, say, usageError } from "@nouride/cli-kit";
import type { Client, ExternalClisResponse } from "@nouride/cli-kit";
import type { UpdateChecked } from "@nouride/cli-kit";

const USAGE = "Usage: nouride agents update <cli> [<version>] (`nouride agents scan` lists them)";
/** How long a turn in the CLI is waited for: a long one ends in minutes, and one that does not is not cut off. */
const WAIT_MS = 10 * 60_000;
const POLL_MS = 2_000;

/** Installs a program for every agent, as `nouride tools run` does: the install's own, handed in by the binary's entry. */
export type InstallShared = (command: readonly string[]) => Promise<{ exitCode: number | null; shared: { ok: boolean; problem?: string } | null }>;

export interface UpdateSteps {
  install: InstallShared;
  pause: (ms: number) => Promise<void>;
  now: () => number;
}

/** The steps of a real update, around the install's installer. */
export function updateSteps(install: InstallShared): UpdateSteps {
  return { install, pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: Date.now };
}

export async function updateCli(client: Client, args: readonly string[], steps: UpdateSteps): Promise<void> {
  const [id, version] = args;
  if (!id) usageError("Which coding CLI?", USAGE);
  const { clis } = await client.get<ExternalClisResponse>("/external-clis?fresh=1");
  const cli = clis.find((entry) => entry.id === id);
  if (!cli) usageError(`No coding CLI "${id}" here.`, USAGE);
  if (!cli.package) fail(`${cli.name} names no package, so Nouride does not update it`, "Update it the way it was installed.");
  if (!cli.installed) fail(`${cli.name} is not installed here`, `nouride tools run -- npm i -g ${cli.package}`);
  const to = version ?? cli.standing?.offer ?? cli.tested?.highest;
  if (!to) fail(`no version of ${cli.name} to update to`, "Name one: nouride agents update <cli> <version>.");
  if (cli.version === to) {
    // Let go of a hold a run cut off before its check left (its agents said "being updated" until a restart): the new
    // version is checked when it first starts all the same (`checkVersion`).
    await client.post(`/external-clis/${id}/release`);
    emit({ cli: id, version: to, changed: false });
    return say(`${GREEN}✓${RESET} ${cli.name} is at ${to} already`);
  }

  say(`${DIM}waiting until no turn runs in ${cli.name}; no new one starts in it meanwhile${RESET}`);
  const deadline = steps.now() + WAIT_MS;
  for (;;) {
    const { busy } = await client.post<{ busy: number }>(`/external-clis/${id}/hold`);
    if (busy === 0) break;
    if (steps.now() >= deadline) {
      await client.post(`/external-clis/${id}/release`);
      fail(`a turn kept running in ${cli.name} for ten minutes: nothing was installed`, `Try again when it ends: nouride agents update ${id}${version ? ` ${version}` : ""}`);
    }
    await steps.pause(POLL_MS);
  }

  say(`${DIM}installing ${cli.package}@${to}${RESET}`);
  const installed = await steps.install(["npm", "install", "-g", `${cli.package}@${to}`]);
  if (!installed.shared || !installed.shared.ok) {
    await client.post(`/external-clis/${id}/release`);
    fail(
      installed.shared ? `${cli.package}@${to} is installed, but not every agent can run it yet: ${installed.shared.problem}` : `installing ${cli.package}@${to} did not finish (exit ${installed.exitCode ?? "killed"})`,
      `${cli.name}'s agents answer with what was there before.`,
    );
  }

  const checked = await client.post<UpdateChecked>(`/external-clis/${id}/check`);
  emit({ ...checked, from: cli.version ?? null, to });
  if (!checked.passed) fail(checked.problem ?? `${cli.name} ${to} did not pass Nouride's check`, checked.before ? `Go back: nouride agents update ${id} ${checked.before}` : undefined);
  say(`${GREEN}✓${RESET} ${BOLD}${cli.name}${RESET} is at ${to}, from ${cli.version ?? "its version before"}: its handshake has what Nouride uses`);
}
