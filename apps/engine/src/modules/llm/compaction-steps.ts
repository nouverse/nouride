/**
 * What compacting a conversation says while it happens — `compact` steps, the same lines and data whether it runs
 * before a turn (`executor/prepare.ts`) or after its reply (`pipeline/session-lifecycle.ts`), so the two cannot be
 * worded apart. A summary takes ten or twenty seconds; said as it starts, a turn spending them does not look hung.
 */

import { estimateMessagesTokens } from "@nouride/llm";
import { formatTokens } from "@/modules/hooks/format.ts";
import type { CompactResult } from "./summarize.ts";

/** Where a `compact` line goes: a turn's activity, or — after the reply — straight to its record. */
export type SayCompaction = (text: string, detail: Record<string, unknown>) => void;

export function compactionStarted(say: SayCompaction | undefined, turns: number, tokens: number): void {
  say?.(`compacting the conversation: summarizing ${turns} earlier turn(s), ~${formatTokens(tokens)} tokens`, { phase: "start", turns, tokens });
}

/** The outcome, said once: compacted, failed — `failedThen` is what happens instead — or nothing to say. */
export function compactionEnded(say: SayCompaction | undefined, result: CompactResult, failedThen: string): void {
  if (result.compacted) {
    const tokens = estimateMessagesTokens(result.messages);
    say?.(
      result.summarizedTurns > 0
        ? `compacted: ${result.summarizedTurns} earlier turn(s) summarized, now ~${formatTokens(tokens)} tokens`
        : `compacted: cleared ${result.prunedToolResults} old tool result(s), now ~${formatTokens(tokens)} tokens`,
      { phase: "done", turns: result.summarizedTurns, pruned: result.prunedToolResults, tokens },
    );
  } else if (result.failed) {
    say?.(`compaction failed: ${failedThen}`, { phase: "failed" });
  }
}
