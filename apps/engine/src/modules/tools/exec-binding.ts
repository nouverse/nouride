/**
 * What an exec grant is bound to: the command's argv in its directory, the secrets it is handed, and the digest
 * of every file it runs — each segment's script, and a program run by a path inside the agent's roots. Change any of
 * those files and the key changes, so the next run asks again: "allow always" for `./deploy.sh` is for that
 * deploy.sh, not for whatever the agent, or text in its context, writes there afterwards.
 *
 * One function for every command, with secrets or without. Two used to exist, and the one for a command handed no
 * secret hashed only an interpreter's script — `bash deploy.sh` was bound to deploy.sh, `./deploy.sh` to nothing.
 *
 * Hashing happens here, once, at decision time, because the digest has to be identical in the key looked up and the
 * key stored when the operator answers `allow-always`; two computations would drift into a grant that never matches.
 */

import { join, resolveWithin, sha256File, sha256Text } from "@nouride/runtime";
import { commandSegments, execGrantKey, executedFileArgIndex, looseSegments } from "@nouride/policy";

/**
 * The grant key, the digest that went into it, and whether every file the command runs is in it.
 *
 * A file that cannot be read, or lies outside the roots, leaves nothing to bind: `pinned` is then false, and a command
 * handed a secret asks every time (`secretGate`). So does a script the strict reader gives up on — it is read loosely
 * here (`looseSegments`), for the files it can name, and what that misses still runs. A command handed no secret
 * keeps the digest of what could be read: an interpreter's guessed operand that is no file, `python3 -m pytest`,
 * must not take the grant away. A program run by a path elsewhere is an installed one, named by that path in the argv
 * the key holds. A `cd` moves where the segments after it look; one to somewhere unknown, `cd ~`, leaves their
 * relative paths unbound.
 *
 * The digest of one file is that file's sha256, as a grant has recorded since script grants began, so a
 * `bash deploy.sh` grant made before still matches; of several, the sha256 of their list.
 */
export function grantBinding(
  argv: readonly string[],
  cwd: string,
  roots: readonly string[],
  agentId: string,
  secrets: readonly string[] = [],
): { key: string; digest: { fileSha256?: string }; pinned: boolean } {
  /** Where the segment being read runs: `cwd`, until a `cd` moves it — null once one goes somewhere unknown. */
  let dir: string | null = cwd;
  /** The path inside one of the roots, or null — read only there: a gate must not open a device or a stranger's file. */
  const inside = (path: string): string | null => {
    const absolute = path.startsWith("/") ? path : dir === null ? null : join(dir, path);
    if (absolute === null) return null;
    for (const root of [cwd, ...roots]) {
      try {
        return resolveWithin(root, absolute);
      } catch {
        // Not under this one.
      }
    }
    return null;
  };
  const shas: string[] = [];
  let pinned = true;
  const bind = (path: string | null) => {
    const sha = path ? sha256File(path) : null;
    if (sha) shas.push(sha);
    else pinned = false;
  };
  const strict = commandSegments(argv);
  if (strict === null) pinned = false;
  for (const segment of strict ?? looseSegments(argv)) {
    if (segment[0] === "cd") {
      dir = movedTo(dir, segment);
      continue;
    }
    const index = executedFileArgIndex(segment);
    if (index !== null) bind(inside(segment[index] ?? ""));
    const program = segment[0] ?? "";
    // A relative path after a `cd` to somewhere unknown is a file nobody can say, not an installed program.
    if (program.includes("/") && (inside(program) || (dir === null && !program.startsWith("/")))) bind(inside(program));
  }
  const digest = shas.length === 0 ? {} : { fileSha256: shas.length === 1 ? shas[0]! : sha256Text(shas.join("\n")) };
  return { key: execGrantKey({ agentId, cwd, argv, ...digest, secrets }), digest, pinned };
}

/** Where a `cd` leaves the segments after it: the directory it names, or null for one this cannot know — `cd`, `cd -`, `cd ~`, `cd $X`. */
function movedTo(dir: string | null, segment: readonly string[]): string | null {
  const to = segment[1];
  if (segment.length !== 2 || !to || /^[-~$]/.test(to)) return null;
  if (to.startsWith("/")) return to;
  return dir === null ? null : join(dir, to);
}
