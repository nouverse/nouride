/**
 * A mutex per key.
 *
 * The degenerate case of what this package already does — ordered per key, parallel across keys —
 * with none of the queue's throughput machinery, because the callers are read-modify-write sequences
 * that just need to not interleave.
 *
 * It lives here rather than beside its first caller because there were two hand-rolled copies of it:
 * `memory.ts` had one from Phase 1, and `files.ts` needed the same thing for `write`/`edit`. A second
 * copy is how two subtly different lock implementations end up in one codebase.
 *
 * ## What it does and does not protect
 *
 * **Does:** two turns in the same process racing on one path. That is the real case — two agents may
 * share a workspace root, so two conversations can edit one file, and each atomic write is
 * individually fine while the *lost update* happens between them.
 *
 * **Does not:** two processes. The single-instance lock (`acquireLockFile`) is what stops a second
 * daemon on the same data directory, and that is the right layer for it — an advisory file lock here
 * would add a syscall to every write to defend against a state the daemon already refuses to enter.
 */

export interface KeyedLock {
  /** Run `fn` with exclusive access to `key`. Returns whatever `fn` returns. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Keys with work in flight or queued. For tests and diagnostics. */
  activeKeys(): string[];
}

export function createKeyedLock(): KeyedLock {
  /** Tail of the promise chain per key. Awaiting it means every earlier holder has finished. */
  const chains = new Map<string, Promise<unknown>>();

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = chains.get(key) ?? Promise.resolve();

      const current = previous.then(fn);

      // **This line is what keeps a failure from deadlocking the key.** `previous` is always a caught
      // promise, so a thrown callback cannot leave the chain permanently rejected and silently drop
      // every later write to that path.
      //
      // Written first as `previous.then(fn, fn)` with a comment claiming the second handler was doing
      // that job. It was dead code — `previous` never rejects — and a sabotage test proved it: removing
      // the handler broke nothing. Kept as a note because a confidently-wrong rationale in a lock is
      // worse than no comment.
      //
      // Held in a variable because it is what gets *stored*: comparing the map against `current` in
      // the cleanup below would never match, so the entry would never be deleted and the map would
      // grow one key per file ever touched.
      const stored = current.catch(() => undefined);
      chains.set(key, stored);

      try {
        return await current;
      } finally {
        // Only the last holder clears the entry. A later caller has already replaced it, and deleting
        // then would drop a lock someone is still waiting behind.
        if (chains.get(key) === stored) chains.delete(key);
      }
    },

    activeKeys() {
      return [...chains.keys()];
    },
  };
}
