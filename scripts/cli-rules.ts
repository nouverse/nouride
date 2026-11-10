/**
 * The line around the CLI, which `check-arch.ts` holds.
 *
 * A command that asks a running daemon reaches it over HTTP and imports no daemon code: a change inside a domain
 * cannot break it, and nothing it does can reach past the control API. The commands that work on the install itself
 * read its files with the daemon down, so they are the engine's and stay in it. Each rule keeps one half of that true:
 *
 * - `cli-imports-engine`: nothing under `apps/cli/src` or `packages/cli-kit/src` names the engine — not its package,
 *   not a path into it, not its `@/` alias. What a client command needs of the install is handed in
 *   (`apps/cli/src/install.ts`); what both sides speak is `@nouride/cli-kit`.
 * - `engine-imports-cli`: in the engine, only the binary's entry imports the CLI. It is where the two meet.
 */

import { dirname, join, normalize } from "node:path";
import { MODULE_SPECIFIER } from "./lint-sources.ts";

/** The binary's entry: the one file of the engine that takes the CLI in. */
export const CLI_ENTRY = "apps/engine/src/cli/main.ts";
/** Where no file may name the engine. */
const CLI_SIDE = ["apps/cli/src/", "packages/cli-kit/src/"];

export interface CliFinding {
  line: number;
  rule: "cli-imports-engine" | "engine-imports-cli";
  detail: string;
}

/** Whether `specifier`, imported by `rel`, is `pkg` or a file under `dir`. */
function names(rel: string, specifier: string, pkg: string, dir: string): boolean {
  if (specifier === pkg || specifier.startsWith(`${pkg}/`)) return true;
  return specifier.startsWith(".") && normalize(join(dirname(rel), specifier)).startsWith(dir);
}

/** What `rel` imports across the line, in `source` — its text with comments taken out, or whole. */
export function cliFindings(rel: string, source: string): CliFinding[] {
  const clientSide = CLI_SIDE.some((dir) => rel.startsWith(dir));
  const engineSide = rel.startsWith("apps/engine/src/") && rel !== CLI_ENTRY;
  if (!clientSide && !engineSide) return [];
  const findings: CliFinding[] = [];
  for (const match of source.matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1]!;
    const line = source.slice(0, match.index).split("\n").length;
    if (clientSide && (specifier.startsWith("@/") || names(rel, specifier, "@nouride/engine", "apps/engine/"))) {
      findings.push({
        line,
        rule: "cli-imports-engine",
        detail: `"${specifier}" — a command that asks the daemon imports nothing of the engine: what it needs of the install is handed in (apps/cli/src/install.ts), and what both sides speak is @nouride/cli-kit`,
      });
    }
    if (engineSide && names(rel, specifier, "@nouride/cli", "apps/cli/")) {
      findings.push({ line, rule: "engine-imports-cli", detail: `"${specifier}" — only the binary's entry (${CLI_ENTRY}) takes the CLI in` });
    }
  }
  return findings;
}
