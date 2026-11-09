/**
 * A small choice kept in this browser: whether the menu is open beside the chat, which groups are pinned to Chats, what
 * was last read. Per browser on purpose — nothing here is worth a round trip to the daemon or follows a person between
 * machines — and every read and write is guarded: a locked-down browser, a private window or a full storage throws, and
 * the page then works from the fallback for as long as it is open.
 *
 * One store per key for the whole page, so two places that show the same choice (the header's Pin and the list's pinned
 * row) change together without waiting for a reload.
 */

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();
/**
 * What was last read or written, by key, with the stored text it came from: the snapshot `useSyncExternalStore`
 * compares stays the same object until the stored text changes — written here, or by another tab.
 */
const cache = new Map<string, { raw: string | null; value: unknown }>();
/** Written here but not stored (a browser that refuses): kept for this page. */
const unstored = new Map<string, unknown>();

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function read<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  if (unstored.has(key)) return unstored.get(key) as T;
  const raw = stored(key);
  const was = cache.get(key);
  if (was && was.raw === raw) return was.value as T;
  let value = fallback;
  try {
    const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
    if (valid(parsed)) value = parsed;
  } catch {
    // Not JSON: the fallback, as if nothing had been kept.
  }
  cache.set(key, { raw, value });
  return value;
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    unstored.delete(key);
  } catch {
    unstored.set(key, value);
  }
  for (const listener of listeners.get(key) ?? []) listener();
}

export function useKept<T>(key: string, fallback: T, valid: (value: unknown) => value is T): [T, (next: T | ((was: T) => T)) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const set = listeners.get(key) ?? new Set();
      set.add(listener);
      listeners.set(key, set);
      // Another tab of this dashboard changing it: this one follows.
      const elsewhere = (event: StorageEvent) => {
        if (event.key === key) listener();
      };
      window.addEventListener("storage", elsewhere);
      return () => {
        set.delete(listener);
        window.removeEventListener("storage", elsewhere);
      };
    },
    [key],
  );
  // Read inside the callbacks, not captured: the fallback and the check are a call's, and the store is the key's.
  const value = useSyncExternalStore(subscribe, () => read(key, fallback, valid), () => fallback);
  const set = useCallback(
    (next: T | ((was: T) => T)) => {
      const was = read(key, fallback, valid);
      write(key, typeof next === "function" ? (next as (was: T) => T)(was) : next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the store; a caller's inline fallback is not a new one
    [key],
  );
  return [value, set];
}

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
