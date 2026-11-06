/**
 * What is in the agents' bin directory, and what about it needs a person's attention.
 *
 * Shared by `nouride doctor`, which lists it, and boot, which says one line when something is wrong.
 * Three things go wrong there, all seen on the live box or one step from it:
 *
 * - **A link into a cache.** `ffprobe` pointed into `~/.bun/install/cache`, and clearing that cache —
 *   which anybody short of disk would do — would have broken it with nothing saying why.
 * - **A dangling link**, which is the same failure after it happened.
 * - **A name the system also has.** The bin directory comes first on every command's PATH, so a
 *   `git`, `tar` or `python3` there is what every agent runs. Sometimes that is the point (a newer CLI);
 *   for the few names below it is almost never, and a shell there is what `withBinFirst` refuses to run.
 */

import { dirname, fileExistsSync, join, linkTarget, listDir, readTextFileSync, resolve, statFile } from "@nouride/runtime";

/** Names whose system copy the daemon, its scripts or every agent depend on. */
const CRITICAL = new Set(["sh", "bash", "dash", "zsh", "env", "git", "ssh", "curl", "tar", "ps", "python3", "pip", "node", "npm", "bun", "nouride"]);
const SYSTEM_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];
const CACHE = /\/(\.cache|cache|_cacache|_npx)\//;
/** The second line of a wrapper the daemon writes itself (`boot/ssh-config.ts`): found ahead of the system's on purpose. */
export const OWN_WRAPPER = "# Written by Nouride at every start";

export interface BinEntry {
  name: string;
  /** Where it points, for a link. */
  target?: string;
  dangling?: boolean;
  /** The link resolves into a cache directory. */
  cached?: boolean;
  /** The system copy this one is found ahead of. */
  shadows?: string;
  critical?: boolean;
}

export function binReport(bin: string): BinEntry[] {
  return listDir(bin)
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name }) => {
      const path = join(bin, name);
      const target = linkTarget(path);
      const shadows = SYSTEM_DIRS.map((dir) => join(dir, name)).find((candidate) => fileExistsSync(candidate));
      const absolute = target === null ? null : resolve(dirname(path), target);
      return {
        name,
        ...(target !== null ? { target } : {}),
        ...(target !== null && statFile(path) === null ? { dangling: true } : {}),
        ...(absolute !== null && CACHE.test(absolute) ? { cached: true } : {}),
        ...(shadows ? { shadows, critical: CRITICAL.has(name) && !ownWrapper(path, target) } : {}),
      };
    });
}

/** One sentence per entry that needs attention, for the boot log and doctor alike. */
export function binProblems(entries: BinEntry[]): { name: string; problem: string }[] {
  return entries.flatMap((entry) =>
    [
      ...(entry.dangling ? [`${entry.name} points at ${entry.target}, which is gone`] : []),
      ...(entry.cached && !entry.dangling ? [`${entry.name} is a link into a cache (${entry.target}): clearing that cache breaks it`] : []),
      ...(entry.critical ? [`${entry.name} is found ahead of the system's ${entry.shadows} by every agent command`] : []),
    ].map((problem) => ({ name: entry.name, problem })),
  );
}

function ownWrapper(path: string, target: string | null): boolean {
  if (target !== null || (statFile(path)?.size ?? Infinity) > 4096) return false;
  try {
    return readTextFileSync(path).split("\n")[1]?.startsWith(OWN_WRAPPER) ?? false;
  } catch {
    return false;
  }
}
