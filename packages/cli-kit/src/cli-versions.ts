/**
 * Where a coding CLI's version stands, in words: `nouride agents scan` and `nouride doctor` say the same.
 */

import { partsNamed } from "@nouride/acp";
import type { CliPart, ScannedCli } from "@nouride/wire";

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
 * Where an installed CLI's version stands, in a line (0.8.24): against the versions this Nouride was tested with, and
 * what is out where the registry was reached — `agents scan` and `doctor` say the same. The newest out is what an update
 * installs, tested with this Nouride or not, and the line says which. Null for a CLI with no tested range: a person's
 * own, which names no package.
 */
export function cliVersionLine(cli: ScannedCli): string | null {
  const { standing, tested, version } = cli;
  if (!standing || !tested || !version) return null;
  const range = `${tested.lowest} to ${tested.highest}`;
  const own = cli.parts?.find((part) => part.kind === "cli")?.name ?? cli.name;
  const brings = standing.brings ? `, with ${own} ${standing.brings}` : "";
  const untested = standing.offerUntested ? `. It is past the versions this Nouride was tested with (${range}), and offered all the same` : "";
  const ahead = standing.ahead ? `; ${own} ${standing.ahead} is out, and nothing that carries it yet` : "";
  switch (standing.standing) {
    case "older":
      return `${version} is older than this Nouride supports (tested with ${range}): update it to ${standing.offer ?? tested.highest}${brings}${untested}`;
    case "newer":
      return `${version} is newer than this Nouride was tested with (${range}): it runs, untested${ahead}`;
    case "update":
      return `${standing.offer} is out${brings}; this is ${version}${untested}`;
    case "current":
      // "The newest out" only where the registry said what is out: otherwise it is the newest tested, and that is said.
      return `${version}, ${cli.newest ? "the newest out" : `the newest this Nouride was tested with (${range}); what is out was not read`}${ahead}`;
  }
}

/** A package's name without its scope, as a person says it: "claude-agent-acp". */
const unscoped = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

/** A part's name and version; where the files installed did not say its version, that is said instead of a guess. */
const partWords = (part: CliPart, name = part.name): string => `${name} ${part.version ?? "(version not read)"}`;

/** The CLI itself and what carries it, as one phrase (`partsNamed`); null where nothing of it was read: a person's own CLI. */
export function cliNamed(cli: Pick<ScannedCli, "parts">): string | null {
  return partsNamed(cli.parts);
}

/**
 * What else an installed CLI runs on, a line each, for `nouride agents scan` and `nouride doctor`: the runtime against
 * what the connector asks for, a warning where it is under it, and the connector's other dependencies as installed.
 */
export function cliPartsLines(cli: Pick<ScannedCli, "parts">): { level: "ok" | "warn"; message: string }[] {
  const parts = cli.parts ?? [];
  const connector = parts.find((part) => part.kind === "connector");
  const by = connector ? unscoped(connector.name) : "its connector";
  const lines: { level: "ok" | "warn"; message: string }[] = [];
  for (const part of parts.filter((entry) => entry.kind === "runtime")) {
    if (part.tooOld) lines.push({ level: "warn", message: `${partWords(part)} is older than ${by} asks for (${part.needs}): update ${part.name}` });
    else lines.push({ level: "ok", message: `${partWords(part)}${part.needs ? ` (${by} asks for ${part.needs})` : ""}` });
  }
  const rest = parts.filter((entry) => entry.kind === "dependency");
  if (rest.length > 0) lines.push({ level: "ok", message: `with ${rest.map((part) => partWords(part)).join(", ")}` });
  return lines;
}

/** `nouride doctor`'s lines for what each installed CLI runs on: the CLI in its connector, then `cliPartsLines`. */
export function cliPartsChecks(clis: readonly ScannedCli[]): { level: "ok" | "warn"; message: string }[] {
  return clis.flatMap((cli) => {
    const named = cli.installed ? cliNamed(cli) : null;
    if (!named) return [];
    return [{ level: "ok" as const, message: `coding CLI ${cli.id}: ${named}` }, ...cliPartsLines(cli).map((line) => ({ level: line.level, message: `coding CLI ${cli.id}: ${line.message}` }))];
  });
}
