/**
 * A line per model request (0.7.26): what one request of a turn carried, said in the turn's record — never the request.
 *
 * On 2026-10-20/21 a conversation reached ~150k tokens a request, and what had been taken out of it — tool results
 * cleared to make room, a summary in place of earlier turns — was read off guesses. Each request now says it: about how
 * many tokens it was, how many earlier tool results in it were cleared and where those were kept (0.7.25's
 * `cleared-<callId>-<hash>.txt`, named in each marker), whether a compaction's summary was in it, and whether the
 * conversation's work notes rode at its end (`ChatParams.tail`).
 *
 * The size is the daemon's estimate at the scale the provider last measured (`context-scale.ts`), and says so in its
 * name: the provider's own count for the same call is its `usage` row. A request that failed has no count of its own,
 * and is the one whose size matters most.
 */

import type { ChatMessage, TurnEventData } from "@nouride/shared";
import { isTrimmedToolResult, keptPathOf } from "@/modules/llm/context.ts";
import { isSummary } from "@/modules/llm/summarize.ts";

/** One request's line, as the stream's `context` row carries it (1.4) — a helper's or a peer's marks added by its sink. */
export type ContextLine = Omit<TurnEventData["context"], "via" | "by">;

/**
 * Paths a line names, at most. The rest were cleared too and are counted in `cleared`; this keeps a row well under the
 * stream's size bound however long the conversation.
 */
const KEPT_LISTED = 20;

/**
 * A turn's lines, one per request, numbered from 1. A cleared result is named where it first appears — a line lists
 * the ones cleared since the line before it — so a long turn says each path once, not at every request.
 */
export function requestLines(): (messages: readonly ChatMessage[], estimatedTokens: number, notes?: boolean) => ContextLine {
  let request = 0;
  const named = new Set<string>();
  return (messages, estimatedTokens, notes = false) => {
    request += 1;
    let cleared = 0;
    const keptAt: string[] = [];
    for (const message of messages) {
      if (!isTrimmedToolResult(message)) continue;
      cleared += 1;
      const path = keptPathOf(message);
      if (!path || named.has(path) || keptAt.length >= KEPT_LISTED) continue;
      named.add(path);
      keptAt.push(path);
    }
    return {
      request,
      estimatedTokens: Math.max(0, Math.round(estimatedTokens)),
      cleared,
      ...(keptAt.length > 0 ? { keptAt } : {}),
      summary: messages.some(isSummary),
      notes,
    };
  };
}
