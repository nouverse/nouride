/**
 * The built-in skills, as a build carries them: staged beside the binary as `skills/`.
 */

import { cp } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;

/**
 * Skills that ship with the daemon — the `builtin` scope.
 *
 * Travels with the binary because `resolveBuiltinSkillsDir()` looks for `skills/` beside the
 * executable, and an install without it is not a broken daemon: it is a daemon that has quietly
 * forgotten how to do things, with nothing in the log to connect that to a missing directory. A
 * source checkout has it under `content/` and so never noticed. Staged as plain `skills/`: the
 * tarball has nothing to group it with, and the resolver looks for both names.
 */
const BUILTIN_SKILLS = join(ROOT, "content/skills");

/**
 * Whether a path under the skills is one the repository tracks. A test run, or a skill tried by hand, leaves Python's
 * cache beside a script (`__pycache__`, ignored by git and by the image's context), and a build from that checkout
 * carried it into the tarball: five files a release built on a clean checkout does not have.
 */
export function isSkillFile(path: string): boolean {
  return !path.split(/[\\/]/).includes("__pycache__") && !path.endsWith(".pyc");
}

/** The built-in skills, as tracked, into `dest`. */
export const copySkills = (dest: string) => cp(BUILTIN_SKILLS, dest, { recursive: true, filter: isSkillFile });
