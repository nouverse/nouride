/**
 * Where a coding CLI's version stands, in words: `nouride agents scan` and `nouride doctor` say the same.
 */

import type { ScannedCli } from "@nouride/wire";

/** Whether its version is one to look at: older than this Nouride supports, or newer than it was tested with. */
export const cliVersionWarns = (cli: ScannedCli): boolean => cli.standing?.standing === "older" || cli.standing?.standing === "newer";

/** `nouride doctor`'s line for each installed CLI with a tested range: a warning where its version is one to look at. */
export function cliVersionChecks(clis: readonly ScannedCli[]): { level: "ok" | "warn"; message: string }[] {
  return clis.flatMap((cli) => {
    const line = cli.installed ? cliVersionLine(cli) : null;
    return line ? [{ level: cliVersionWarns(cli) ? ("warn" as const) : ("ok" as const), message: `coding CLI ${cli.id}: ${line}` }] : [];
  });
}

/**
 * Where an installed CLI's version stands, in a line (0.8.24): against the versions this Nouride was tested with, and the
 * newest its package has published where the registry was reached — `agents scan` and `doctor` say the same. Null for a
 * CLI with no tested range: a person's own, which names no package.
 */
export function cliVersionLine(cli: ScannedCli): string | null {
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
