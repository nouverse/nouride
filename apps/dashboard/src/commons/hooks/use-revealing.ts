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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatTurn, LiveTurn } from "@nouride/wire";
import { splitRoomForDisplay, type HeldTurn } from "@/commons/lib/turn-display";

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

export interface RoomRevealing {
  /** What the room draws: its finished turns, and the ones drawn live. */
  history: ChatTurn[];
  live: LiveTurn[];
  /** Each read of the room's turns at work: one that was there and is gone is held from here. */
  read: (atWork: LiveTurn[]) => void;
  say: (turnId: string, on: boolean) => void;
  reset: () => void;
}

/**
 * The same hold for a room, whose list of turns at work never has an ended one: a turn seen there and then gone is
 * kept as it was last seen, and drawn live until the history has it and its view has written its answer out
 * (`splitRoomForDisplay`). Several at once, since a room's agents end when they end.
 */
export function useRoomRevealing(recorded: ChatTurn[], atWork: LiveTurn[], readAt: number): RoomRevealing {
  const [held, setHeld] = useState<readonly HeldTurn[]>([]);
  const [revealing, setRevealing] = useState<ReadonlySet<string>>(() => new Set());
  /** The turns at work at the last read, as they were then. */
  const watched = useRef(new Map<string, LiveTurn>());
  const read = useCallback((atWork: LiveTurn[]) => {
    const now = new Set(atWork.map((turn) => turn.id));
    const gone = [...watched.current.values()].filter((turn) => !now.has(turn.id));
    watched.current = new Map(atWork.map((turn) => [turn.id, turn]));
    if (gone.length === 0) return;
    const leftAt = Date.now();
    setHeld((was) => [...was, ...gone.map((turn) => ({ turn, leftAt }))]);
    // Held from the read that found it over, as a one-to-one conversation's is: the history can have the turn
    // before its view has drawn once.
    setRevealing((was) => new Set([...was, ...gone.map((turn) => turn.id)]));
  }, []);
  const say = useCallback((id: string, on: boolean) => {
    setRevealing((was) => {
      if (was.has(id) === on) return was;
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    watched.current = new Map();
    setHeld([]);
    setRevealing(new Set());
  }, []);

  const shown = useMemo(() => splitRoomForDisplay(recorded, atWork, held, revealing, readAt), [recorded, atWork, held, revealing, readAt]);
  // A turn the history has taken is held no longer: a room open all day would keep every turn it ever saw end.
  useEffect(() => {
    const live = new Set(shown.live.map((turn) => turn.id));
    setHeld((was) => (was.every((one) => live.has(one.turn.id)) ? was : was.filter((one) => live.has(one.turn.id))));
  }, [shown]);
  return { history: shown.history, live: shown.live, read, say, reset };
}
