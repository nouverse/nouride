/**
 * A turn that is over, held as live while its answer is still being written out.
 *
 * An answer is written out as it comes (`useTypewriter` in `Turn.tsx`). One that came whole as its turn ended, as a
 * model that is silent while its calls run hands it over, was drawn as nothing and then everything: the page stopped
 * writing the moment the turn was over, and the history, which has every word of an ended turn a moment later, took
 * the turn from the live view (`splitForDisplay`).
 *
 * Held from the read that found the turn over, and let go by its view once its last word is shown (`LiveTurnView`).
 * Not on the view's word alone: the history had the turn before the view had drawn once. Only a turn this page saw at
 * work: one first seen when it is over was watched by nobody, and held it would be drawn live and then again from
 * the history, on every conversation opened.
 */

import { useCallback, useRef, useState } from "react";
import type { LiveTurn } from "@nouride/wire";

export interface Revealing {
  /** The turn held, for `splitForDisplay`. */
  turnId: string | null;
  /** Each read of the conversation's live turn, as it comes. */
  read: (turn: Pick<LiveTurn, "id" | "status"> | null) => void;
  /** Its view's word: whether the ended turn's answer is still being written out. */
  say: (turnId: string, on: boolean) => void;
  /** Another conversation: nothing of the last one is held. */
  reset: () => void;
}

export function useRevealing(): Revealing {
  const [turnId, setTurnId] = useState<string | null>(null);
  /** The turn seen at work, until it is found over. */
  const watched = useRef("");
  const read = useCallback((turn: Pick<LiveTurn, "id" | "status"> | null) => {
    if (!turn) return;
    if (turn.status === "running") watched.current = turn.id;
    else if (watched.current === turn.id) {
      // Once: the same ended turn is read again every few seconds, and is not held a second time.
      watched.current = "";
      setTurnId(turn.id);
    }
  }, []);
  const say = useCallback((id: string, on: boolean) => setTurnId((was) => (on ? id : was === id ? null : was)), []);
  const reset = useCallback(() => {
    watched.current = "";
    setTurnId(null);
  }, []);
  return { turnId, read, say, reset };
}
