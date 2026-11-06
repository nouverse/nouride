/**
 * The order a transcript is drawn in.
 *
 * Its own module because every bug this has had was an ordering one, and each looked like a data
 * problem: the reply above the question, the question below a progress card it predates. A pure
 * function can be tested; a `.sort()` inside a nine-hundred-line component can only be looked at.
 */

import type { ChatEvent, ChatTurn, LiveTurn, RoomMessage } from "@/commons/lib/api";

export type Entry =
  | { kind: "turn"; turn: ChatTurn; at: number }
  | { kind: "live"; turn: LiveTurn; at: number }
  | { kind: "event"; event: ChatEvent; at: number }
  | { kind: "message"; message: RoomMessage; at: number };

/**
 * Everything on screen, in the order it happened — including the turns still running.
 *
 * A running turn used to be appended after the whole list, which is correct in a one-to-one chat
 * because there is only ever one and it is always the newest thing. In a room it put every progress
 * card at the bottom: ask Nouva something slow, then ask Nero, and Nero's question appeared *above*
 * Nouva's progress — the question you had already asked, drawn after the one you asked later.
 *
 * A running turn is stamped when it began, which is what puts it back where it belongs.
 */
export function interleave(
  turns: ChatTurn[],
  live: LiveTurn[],
  events: ChatEvent[],
  messages: RoomMessage[],
): Entry[] {
  const entries: Entry[] = [
    ...turns.map((turn) => ({ kind: "turn" as const, turn, at: turn.startedAt })),
    ...live.map((turn) => ({ kind: "live" as const, turn, at: turn.startedAt })),
    ...events.map((event) => ({ kind: "event" as const, event, at: event.at })),
    ...messages.map((message) => ({ kind: "message" as const, message, at: message.at })),
  ];
  /**
   * Ties are broken by kind, and they have to be.
   *
   * A message and the turn it started land in the same millisecond — the envelope is stamped when it
   * arrives and the record when the turn begins, and on a local dispatch that is the same tick. A
   * stable sort then keeps whatever order the array was built in, which put the *reply above the
   * question*: on a live box the message and its turn both read 1788766362278, and the answer was
   * drawn first.
   *
   * The relative order of the three is fixed rather than incidental: something that happened to the
   * room, then what somebody said, then what an agent did about it.
   */
  const rank = { event: 0, message: 1, turn: 2, live: 2 } as const;
  return entries.sort((a, b) => a.at - b.at || rank[a.kind] - rank[b.kind]);
}
