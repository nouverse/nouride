/**
 * An emoji by the name GitHub gives it (`:rocket:`).
 *
 * The names are the gemoji project's list (MIT), which is GitHub's own, kept here as `emoji-names.json`: a name to
 * its character, and nothing else of that list. It is a chunk of its own, asked for the first time a text holds a
 * name, so a chat that holds none loads nothing for it. Until it is here, and for a name the list does not have, the
 * name is drawn as it was written: `:30:` in a time of day is no emoji.
 */

import { useSyncExternalStore } from "react";

let names: Readonly<Record<string, string>> | null = null;
let asked = false;
const waiting = new Set<() => void>();

function ask(): void {
  if (asked) return;
  asked = true;
  void import("./emoji-names.json").then(
    (loaded) => {
      names = loaded.default as Record<string, string>;
      for (const told of waiting) told();
    },
    () => {
      // The list did not come: the names stay as they were written, and the next text asks again.
      asked = false;
    },
  );
}

function subscribe(told: () => void): () => void {
  waiting.add(told);
  ask();
  return () => waiting.delete(told);
}

/** The character a name stands for, or null: no such name, or the list is not here yet. */
export function useEmoji(name: string): string | null {
  const list = useSyncExternalStore(
    subscribe,
    () => names,
    () => null,
  );
  return list?.[name] ?? null;
}
