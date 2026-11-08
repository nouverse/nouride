/**
 * Small renderers the hook replies share.
 */

import { createLogger, plural, toUserMessage, type ChatMessage } from "@nouride/shared";
import { estimateMessagesTokens } from "@nouride/llm";
import { groupTurns } from "@/modules/llm/context.ts";
import type { HookContext } from "./types.ts";

const log = createLogger("hooks");

/**
 * What a command says when its work failed: the sentence a chat may see, and the whole error in the log.
 *
 * `String(err)` went to the chat — a group saw the install's paths, its provider profile names and a platform's
 * API body. The detail is the operator's, and the log is where the operator reads it (`nouride logs`).
 */
export function failed(what: string, err: unknown, ctx: HookContext): string {
  log.warn(`${what} failed`, { agent_id: ctx.agent.config.id, chat_id: ctx.envelope.chatId, error: String(err) });
  return `${what} failed. ${toUserMessage(err)}`;
}

/**
 * The " Saved to memory." tail on a reset reply, or nothing.
 *
 * Silent when the feature is off or the conversation was empty — a note about a capture that did not
 * happen invites someone to go looking for the file. Silent on failure too, because the log carries
 * that and a chat reply cannot act on it; what the user needs to know is that the reset worked.
 */
export function memoryNote(result: { episodes: number } | undefined): string {
  if (!result || result.episodes === 0) return "";
  return " Saved to memory; it is filed tonight.";
}

export function sessionKey(ctx: HookContext) {
  return { agentId: ctx.agent.config.id, chatId: ctx.chatId, gatewayId: ctx.gatewayId };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * What a conversation held when it was cleared, for `/new` and `/reset`: turns, messages and about how many tokens —
 * the estimate the context is planned with, so "~". Asked for by the owner (2026-10-21): "Context cleared" said nothing
 * about how much.
 */
export function clearedSize(messages: ChatMessage[]): string {
  const turns = groupTurns(messages).length;
  return `${turns} ${plural(turns, "turn")}, ${messages.length} ${plural(messages.length, "message")}, ~${formatTokens(estimateMessagesTokens(messages))} tokens`;
}

export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
