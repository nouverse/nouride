/**
 * Which coding CLIs have an update out that matters here: installed, a newer version out or too old to be supported,
 * and an agent working in it. Home says it to an admin beside Nouride's own update, so a newer Claude Code is not
 * learned of from a model that is missing.
 */

import type { ScannedCli } from "@nouride/wire";

/**
 * The CLIs to update, by name, in the order the server lists them; none for a CLI no agent works in, and none at all
 * for someone who cannot have one updated (`mayUpdate`: an admin), whatever another page left in this browser.
 */
export function clisToUpdate(clis: readonly ScannedCli[], agents: readonly { external?: { cli: string } | undefined }[], mayUpdate: boolean): { id: string; name: string }[] {
  if (!mayUpdate) return [];
  const inUse = new Set(agents.flatMap((agent) => (agent.external ? [agent.external.cli] : [])));
  return clis.filter((cli) => cli.installed && inUse.has(cli.id) && (cli.standing?.standing === "update" || cli.standing?.standing === "older")).map((cli) => ({ id: cli.id, name: cli.name }));
}

/** The badge's words: the one CLI by name, or how many. */
export function cliUpdateWords(clis: readonly { name: string }[]): string | null {
  if (clis.length === 0) return null;
  return clis.length === 1 ? `${clis[0]!.name} update out` : `${clis.length} updates out`;
}
