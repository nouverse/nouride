/**
 * A group from a chat app, read as one conversation: each of our agents in it keeps its own conversation there (one
 * bot each), so the group is their turns put together in the order they happened.
 *
 * A message several agents answered is in each one's turn as its question. Drawn once: a turn asked the same words as
 * the turn just before it, by another agent, within a minute, is drawn without its question.
 */

import type { ChatTurn, LiveTurn } from "@nouride/wire";

/** How far apart two agents' turns can start and still be answers to one message. */
const SAME_MESSAGE_MS = 60_000;

export interface GroupEntry {
  turn: ChatTurn | LiveTurn;
  live: boolean;
  /** Whether its question is drawn above its answer. */
  showPrompt: boolean;
}

export function groupStream(turns: readonly ChatTurn[], live: readonly LiveTurn[]): GroupEntry[] {
  const all = new Map<string, { turn: ChatTurn | LiveTurn; live: boolean }>();
  // A turn that has finished is the transcript's; one still running is the live feed's, until the transcript has it.
  for (const turn of live) all.set(turn.id, { turn, live: true });
  for (const turn of turns) all.set(turn.id, { turn, live: false });
  const ordered = [...all.values()].sort((a, b) => a.turn.startedAt - b.turn.startedAt);
  return ordered.map((entry, at) => {
    const before = ordered[at - 1]?.turn;
    const repeat =
      before !== undefined &&
      before.agentId !== entry.turn.agentId &&
      before.prompt.trim() === entry.turn.prompt.trim() &&
      entry.turn.startedAt - before.startedAt <= SAME_MESSAGE_MS;
    return { ...entry, showPrompt: !repeat };
  });
}
