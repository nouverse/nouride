/**
 * Motion for a list's items, where the list changes and only there (`main.css`, "Motion").
 *
 * What a list holds when it is first drawn with its data stays still: a page opening on a long list moves nothing in
 * it. An item that arrives after enters (`animate-enter`), and keeps the class while it stays, so a redraw does not cut
 * it short. One that goes is kept where it was for LEAVE_MS, leaving (`animate-leave`), then dropped — and enters again
 * if it comes back. One a filter hides (`shown`) neither leaves nor enters: typing in a search moves nothing.
 */

import { useEffect, useRef, useState } from "react";
import { LEAVE_MS } from "@/commons/lib/motion";

export const ENTER = "animate-enter";
/** Leaving, it takes no click: what it offered is already gone. */
export const LEAVE = "animate-leave pointer-events-none";
export type Motion = "" | typeof ENTER | typeof LEAVE;

export interface Moving<T> {
  key: string;
  item: T;
  motion: Motion;
}

interface Memory<T> {
  scope: unknown;
  /** Every key drawn since the list first had its data; null before that. */
  seen: Set<string> | null;
  /** The keys among them that arrived after. */
  arrived: Set<string>;
  /** What was drawn last, leaving ones included, in order. */
  drawn: Moving<T>[];
  /** When each leaving one began to leave. */
  leaving: Map<string, number>;
}

const fresh = <T>(scope: unknown): Memory<T> => ({ scope, seen: null, arrived: new Set(), drawn: [], leaving: new Map() });

/**
 * `items` undefined while the list loads, so what its first answer brings is not new. A new `scope` (another
 * conversation, say) starts over: what it opens on is not new either.
 */
export function useMotionList<T>(
  items: readonly T[] | undefined,
  keyOf: (item: T) => string,
  { shown = () => true, scope = null }: { shown?: (item: T) => boolean; scope?: unknown } = {},
): Moving<T>[] {
  const memory = useRef<Memory<T>>(fresh(scope));
  const [, redraw] = useState(0);
  const current = memory.current.scope === scope ? memory.current : fresh<T>(scope);

  const present = new Map((items ?? []).map((item) => [keyOf(item), item] as const));
  // What was drawn and is gone now waits to be put back where it was: before the next one that stays, or at the end.
  const before = new Map<string, Moving<T>[]>();
  let waiting: Moving<T>[] = [];
  for (const entry of current.drawn) {
    if (!present.has(entry.key)) waiting.push({ key: entry.key, item: entry.item, motion: LEAVE });
    else if (waiting.length > 0) {
      before.set(entry.key, waiting);
      waiting = [];
    }
  }
  const entries: Moving<T>[] = [];
  for (const [key, item] of present) {
    entries.push(...(before.get(key) ?? []));
    if (!shown(item)) continue;
    const arrived = current.seen !== null && (current.arrived.has(key) || !current.seen.has(key));
    entries.push({ key, item, motion: arrived ? ENTER : "" });
  }
  entries.push(...waiting);

  useEffect(() => {
    memory.current = current;
    if (items !== undefined) {
      if (current.seen === null) current.seen = new Set(present.keys());
      for (const key of present.keys()) {
        if (current.seen.has(key)) continue;
        current.seen.add(key);
        current.arrived.add(key);
      }
    }
    current.drawn = entries;
    for (const key of current.leaving.keys()) if (present.has(key)) current.leaving.delete(key);
    for (const { key, motion } of entries) if (motion === LEAVE && !current.leaving.has(key)) current.leaving.set(key, Date.now());
    if (current.leaving.size === 0) return;
    const due = Math.min(...current.leaving.values()) + LEAVE_MS - Date.now();
    const timer = setTimeout(() => {
      for (const [key, since] of current.leaving) {
        if (Date.now() - since < LEAVE_MS) continue;
        current.leaving.delete(key);
        current.drawn = current.drawn.filter((entry) => entry.key !== key);
        current.seen?.delete(key);
        current.arrived.delete(key);
      }
      redraw((n) => n + 1);
    }, Math.max(0, due));
    return () => clearTimeout(timer);
  });

  return entries;
}
