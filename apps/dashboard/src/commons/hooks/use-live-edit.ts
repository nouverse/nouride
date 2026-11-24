/**
 * A page that holds something open for an agent to change in place (`lib/live-edit.ts`): it says what it holds while
 * it is drawn, and is handed the change an agent wrote to that very thing, when one waits.
 *
 * `value` is read when a message is sent, never while drawing, so a page may hand a function that builds it from its
 * draft as it stands. `enabled`: only where the page can change what it holds; one that only reads it says nothing,
 * and an agent told of it would write a change nobody there could apply.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LiveEditOffer } from "@nouride/wire";
import { dropLiveEdit, endLiveEdit, holdOpen, waitingLiveEdit, watchLiveEdit } from "@/commons/lib/live-edit";

export interface LiveEditing<T> {
  /** The change waiting for this page, with the thing as it would be with it made; none where none waits. */
  offer: (Omit<LiveEditOffer, "value"> & { value: T }) | null;
  /** That change answered, applied or discarded: it no longer waits. */
  done: () => void;
  /**
   * What this page holds is over (one being made was saved as its own, or thrown away): a change waiting for it,
   * whenever it came, goes with it. Read when it is called, not when the page was last drawn.
   */
  over: () => void;
}

export function useLiveEdit<T>(page: { kind: string; id: string | null; value: () => unknown; enabled: boolean }): LiveEditing<T> {
  const value = useRef(page.value);
  value.current = page.value;
  const { kind, id, enabled } = page;
  useEffect(() => (enabled ? holdOpen({ kind, id, value: () => value.current() }) : undefined), [kind, id, enabled]);

  const waiting = useSyncExternalStore(watchLiveEdit, waitingLiveEdit, waitingLiveEdit);
  // This page's only: one for another thing waits for the page that holds it.
  const offer = enabled && waiting && waiting.kind === kind && waiting.target === id ? (waiting as LiveEditing<T>["offer"]) : null;
  return { offer, done: () => (offer ? dropLiveEdit(offer.id) : undefined), over: () => endLiveEdit(kind, id) };
}
