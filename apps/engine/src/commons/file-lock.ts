/**
 * The one lock every writer of an agent's files shares.
 *
 * It has to be a single **instance**, not a single implementation. `files.ts` and `memory.ts` each
 * called `createKeyedLock()` and each documented itself as using the shared lock — which was true of
 * the code and false of the object. Two locks keyed on the same path serialize nothing against each
 * other, so `edit` on `MEMORY.md` and `memory_write` on `MEMORY.md` could interleave: both read the
 * pre-edit text, both compute from it, and the second write silently discards the first. That is
 * exactly the lost update the lock exists to prevent, one layer up from where it was being prevented.
 *
 * Atomic writes do not help. Each write is individually atomic; the loss happens between them.
 *
 * Module-scoped, because two agents sharing a workspace root are two callers of the same tool
 * instances — a lock created per call would protect nothing. The dashboard's file editor takes it too,
 * since an operator saving `SOUL.md` in a browser while the agent rewrites its own memory is the same
 * race with a slower participant.
 *
 * It guards one process. A second daemon on the same data directory is what `acquireLockFile` refuses,
 * which is the right layer for that.
 *
 * Keyed by the file's real path, resolved here: one lock instance is not enough if two writers spell one file two
 * ways. The file editor reached a pack through `resolveWithin`, which follows symlinks, and the settings routes
 * through `join(agent.dir)`, which does not — two keys for one `config.toml`, so the two serialized nothing against
 * each other.
 */

import { realPath } from "@nouride/runtime";
import { createKeyedLock } from "@nouride/queue";

const lock = createKeyedLock();

/** Run `fn` with exclusive access to `path`, however it is spelled. */
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return lock.run(realPath(path), fn);
}
