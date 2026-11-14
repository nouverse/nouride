/**
 * What a coding CLI runs on, as data: the CLI itself, the connector that carries it and speaks ACP, the
 * runtime that starts the connector, and the connector's other dependencies. The engine reads them from the files
 * installed (`external-agents/parts.ts`); the scan, `nouride doctor` and the dashboard show them.
 *
 * Before this the one version read was the connector's, shown as the CLI's: claude-agent-acp 0.100.0 "up to date" while
 * the Claude Code inside it was 2.1.316 (seen on a live box).
 */

/** The CLI itself, what carries it, what runs that, and what else the connector needs. */
export type CliPartKind = "cli" | "connector" | "runtime" | "dependency";

export interface CliPart {
  kind: CliPartKind;
  /** As a person reads it: "Claude Code", "Node.js"; a package's own name otherwise. */
  name: string;
  /** The npm package it is; absent for the runtime. */
  package?: string;
  /** As installed; absent where it could not be read, which is shown as unknown and never guessed. */
  version?: string;
  /** The runtime alone: the versions the connector asks for, as its `engines` writes them (">=22"). */
  needs?: string;
  /** The runtime alone: under what `needs` asks. Absent where either cannot be read as a version and a lower bound. */
  tooOld?: boolean;
}

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/;
/** A lower bound and nothing else: ">=22", ">= 18.17.0". */
const AT_LEAST = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/;

/**
 * Whether `version` is under the lowest a range allows. Only a plain lower bound is read: a range of any other shape
 * ("^20 || >=22") is no verdict, null, rather than a guess at what it means.
 */
export function underMinimum(version: string, range: string): boolean | null {
  const has = VERSION.exec(version.trim());
  const wants = AT_LEAST.exec(range);
  if (!has || !wants) return null;
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(has[i] ?? 0);
    const b = Number(wants[i] ?? 0);
    if (a !== b) return a < b;
  }
  return false;
}

/** The part that is the CLI itself, where the connector's row names one and it was read. */
export function cliPart(parts: readonly CliPart[] | undefined): CliPart | undefined {
  return parts?.find((part) => part.kind === "cli");
}
