/**
 * A group from a chat app, read as one conversation: what people said there, kept in its log whether or not an agent
 * answered, and each of our agents' turns there (one bot each, one conversation each), put together in the order they
 * happened.
 *
 * Where the group's log holds what people said, a turn is drawn as its answer alone: its question is one of those lines
 * (`askedInLog`). Where it does not (a turn from before the oldest line kept), a turn draws its question, and a message
 * several agents answered is in each one's turn: drawn once, a turn asked the same words as the turn just before it, by
 * another agent, within a minute, is drawn without its question.
 */

import type { ChatTurn, LiveTurn, RoomMessage } from "@nouride/wire";

/** How far apart two agents' turns can start and still be answers to one message. */
const SAME_MESSAGE_MS = 60_000;

export type GroupEntry =
  | { kind: "message"; key: string; at: number; message: RoomMessage }
  | { kind: "turn"; key: string; at: number; turn: ChatTurn | LiveTurn; live: boolean; showPrompt: boolean };

/**
 * Whether what a turn was asked is one of the kept lines: a person's words, at or after the oldest line kept. A wake-up
 * is nobody's words, and a turn from before the oldest line (a busy group's log is its newest lines; a group from before
 * lines were kept) asked something no longer there, so either draws its own question.
 */
export function askedInLog(turn: ChatTurn, oldestLine: number | undefined): boolean {
  return oldestLine !== undefined && !turn.system && turn.startedAt >= oldestLine;
}

/** When the oldest of the kept lines was said; none when nothing is kept. */
export function oldestLine(messages: readonly RoomMessage[]): number | undefined {
  return messages.reduce<number | undefined>((oldest, message) => (oldest === undefined || message.at < oldest ? message.at : oldest), undefined);
}

export function groupStream(turns: readonly ChatTurn[], live: readonly LiveTurn[], messages: readonly RoomMessage[] = []): GroupEntry[] {
  const all = new Map<string, { turn: ChatTurn | LiveTurn; live: boolean }>();
  // A turn that has finished is the transcript's; one still running is the live feed's, until the transcript has it.
  for (const turn of live) all.set(turn.id, { turn, live: true });
  for (const turn of turns) all.set(turn.id, { turn, live: false });
  const ordered = [...all.values()].sort((a, b) => a.turn.startedAt - b.turn.startedAt);
  const oldest = oldestLine(messages);
  const turnEntries = ordered.map((entry, at): GroupEntry => {
    const before = ordered[at - 1]?.turn;
    const repeat =
      before !== undefined &&
      before.agentId !== entry.turn.agentId &&
      before.prompt.trim() === entry.turn.prompt.trim() &&
      entry.turn.startedAt - before.startedAt <= SAME_MESSAGE_MS;
    return { kind: "turn", key: `turn ${entry.turn.id}`, at: entry.turn.startedAt, ...entry, showPrompt: !askedInLog(entry.turn, oldest) && !repeat };
  });
  // Each of our bots in the group keeps its own copy of a line, under an id of its own where the platform numbers them
  // per bot: one line is one sender, one moment and one text.
  const lines = new Map<string, RoomMessage>();
  for (const message of messages) lines.set(`${message.senderId}\u0000${message.at}\u0000${message.text}`, message);
  const messageEntries = [...lines.values()].map((message): GroupEntry => ({ kind: "message", key: `message ${message.id}`, at: message.at, message }));
  // A line before the turn it started, when the two share a moment.
  return [...messageEntries, ...turnEntries].sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "message" ? -1 : 1));
}
