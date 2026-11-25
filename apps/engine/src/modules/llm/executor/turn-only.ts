/**
 * A tool result that is the turn's alone (`ToolResult.turnOnly`): what one person told an agent in private, read in a
 * group on a turn they are the one speaking. The model is shown it for the rest of that turn. The conversation keeps a
 * line in its place, so the next person's turn, which reads the same conversation, holds none of it; and it is written
 * to no file, where a later turn's `read` would find it.
 */

import { cutAtWord, isOpenAgent, type AgentAccess, type ChatMessage, type ToolResult } from "@nouride/shared";

/** A tool's result as the turn's next request carries it: with what the run noticed said under it, and its mark when it is the turn's alone. */
export function resultMessage(result: ToolResult, callId: string, nudge: string | null): ChatMessage {
  return {
    role: "tool",
    content: nudge ? `${result.content}\n\n${nudge}` : result.content,
    toolCallId: callId,
    timestamp: Date.now(),
    ...(result.turnOnly !== undefined ? { turnOnly: result.turnOnly } : {}),
  };
}

/** The message as the conversation keeps it: its line, where it is the turn's alone, and the message itself otherwise. */
export function keptOf(message: ChatMessage): ChatMessage {
  if (message.turnOnly === undefined) return message;
  const { turnOnly, ...rest } = message;
  return { ...rest, content: turnOnly };
}

/**
 * Whether nothing of an agent's conversations is written to a file for a later turn to open: a long result's whole
 * text, a result the context cleared. True for an agent open to everyone: what a stranger sent it would be kept on
 * disk past the conversation, and named to its model by a path of this server.
 */
export function keepsNothing(agent: { config: { access?: AgentAccess } }): boolean {
  return isOpenAgent(agent);
}

/**
 * A result that is the turn's alone, within the room a result has: one too long is cut, where another would be written
 * to a file with an excerpt left. Said in the result, so the agent asks for less instead of taking the cut for the end.
 */
export function withinRoom(result: ToolResult, chars: number, why = ", since this is one person's own"): ToolResult {
  if (chars <= 0 || result.content.length <= chars) return result;
  return { ...result, content: `${cutAtWord(result.content, chars)}\n\n[Cut here: the rest is not kept anywhere${why}. Ask for one part of it at a time.]` };
}
