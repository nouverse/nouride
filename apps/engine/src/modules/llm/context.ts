/**
 * Context window management — §6.4 SPEC.
 *
 * Sliding window for the MVP. The one non-obvious rule: history is dropped in whole
 * **turns**, never message by message. A tool result whose `tool_call` was trimmed away
 * is rejected outright by Anthropic and confuses OpenAI, so trimming mid-turn turns a
 * long conversation into a hard error — exactly the situation truncation exists to avoid.
 */

import { compactionLimitInfo, estimateMessageTokens, estimateMessagesTokens } from "@nouride/llm";
import { messageText, type ChatMessage } from "@nouride/shared";

export interface TruncateOptions {
  /** Budget for the conversation alone; the system prompt and tools are already deducted. */
  maxTokens: number;
  /** Turns always kept, however large. Default 4. */
  preserveRecentTurns: number;
}

export interface TruncateResult {
  messages: ChatMessage[];
  /** Messages removed from the head. Kept by the caller for the transcript. */
  dropped: ChatMessage[];
  tokens: number;
  truncated: boolean;
}

/**
 * A turn: a user message plus everything the assistant did in response — text, tool
 * calls, and the tool results that answer them. Leading assistant/tool messages with no
 * user message (a cron-initiated turn, say) form their own group.
 */
export function groupTurns(messages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) turns.push(current);

  return turns;
}

export function truncateContext(
  messages: ChatMessage[],
  options: TruncateOptions,
): TruncateResult {
  // Measured per turn, and the total summed from those: one pass over the messages, not one for the
  // total and another for the turns.
  const turns = groupTurns(messages);
  const turnTokens = turns.map((turn) => estimateMessagesTokens(turn));
  const total = turnTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (total <= options.maxTokens) {
    return { messages, dropped: [], tokens: total, truncated: false };
  }

  const preserve = Math.max(1, options.preserveRecentTurns);

  // Drop the oldest turn at a time until we fit, but never go below the preserved tail.
  let start = 0;
  let keptTokens = total;
  while (start < turns.length - preserve) {
    if (keptTokens <= options.maxTokens) break;
    keptTokens -= turnTokens[start] ?? 0;
    start += 1;
  }

  const keptTurns = turns.slice(start);
  const kept = keptTurns.flat();
  const dropped = turns.slice(0, start).flat();

  return {
    messages: kept,
    dropped,
    // Reported honestly: when the preserved tail alone exceeds the budget there is
    // nothing more to drop, and a caller that trusted a capped number would be lied to.
    tokens: keptTokens,
    truncated: dropped.length > 0,
  };
}

/**
 * When to start compacting, in tokens.
 *
 * The lower of a share of the budget and a flat ceiling, and it needs both because the two answer
 * different questions. The ratio keeps a small model from compacting a conversation that still fits;
 * the ceiling keeps a large one from carrying half a million tokens per call just because it *can*.
 *
 * Ratio alone was the bug. On a million-token window it put the line near 610k, so a 426k-token
 * Telegram session never compacted once and every iteration resent the whole thing — 11,957,058
 * input tokens in one turn on 2026-09-04, ~15 seconds a call, dead on the five-minute deadline while
 * still making progress. A context window states what a model *can* read. It was never a claim about
 * what it should carry to answer well.
 */
export function compactionThreshold(budget: number, ratio: number, ceilingTokens: number): number {
  return Math.min(Math.floor(budget * ratio), ceilingTokens);
}

/** The whole-request compaction limit, and where it came from. First match wins. */
export function resolveCompactionLimit(
  agentLimit: number | undefined,
  globalLimit: number | undefined,
  model: string,
): { tokens: number; source: string } {
  if (agentLimit !== undefined) return { tokens: agentLimit, source: "agent" };
  if (globalLimit !== undefined) return { tokens: globalLimit, source: "config" };
  const byModel = compactionLimitInfo(model);
  return { tokens: byModel.tokens, source: `model:${byModel.rule}` };
}

/**
 * Tokens available for conversation history, once the system prompt and tool schemas
 * have taken their share.
 *
 * Floored at zero rather than allowed to go negative: a negative budget would make
 * `truncateContext` drop everything, and an agent with no history at all is a worse
 * failure than one that slightly overshoots and gets a provider error naming the cause.
 */
export function conversationBudget(params: {
  contextWindow: number;
  maxContextRatio: number;
  systemPromptTokens: number;
  toolsTokens: number;
  maxOutputTokens: number;
  /**
   * What the provider counts per estimated token (`context-scale.ts`). The window and the output are the
   * provider's tokens and the prompt and tools are estimates, so the room left is divided by it before
   * they are subtracted — the budget is in the estimator's tokens, like the history measured against it.
   */
  scale?: number;
}): number {
  const usable = Math.floor(params.contextWindow * params.maxContextRatio);
  return Math.max(
    0,
    Math.floor((usable - params.maxOutputTokens) / (params.scale ?? 1)) - params.systemPromptTokens - params.toolsTokens,
  );
}

/**
 * Bound what is *stored* for a conversation, in whole turns.
 *
 * Distinct from `truncateContext`, which bounds what is *sent*: dropped history is
 * deliberately kept in the session for recall, but "kept" cannot mean "forever". Without a
 * cap the stored messages grow for the life of the chat and every turn re-measures a longer
 * array. `max_conversation_turns` is that cap.
 *
 * Turn-aligned for the same reason as everything else here — a stored `tool_result` whose
 * `tool_use` was cut would be replayed into the next request and rejected.
 */
export function capStoredTurns(messages: ChatMessage[], maxTurns: number): ChatMessage[] {
  if (maxTurns <= 0) return messages;
  const turns = groupTurns(messages);
  return turns.length <= maxTurns ? messages : turns.slice(turns.length - maxTurns).flat();
}

/** Marks a tool result whose output was dropped to make room — with nowhere kept, the fallback. */
export const TRIMMED_TOOL_PREFIX = "[earlier tool output dropped to make room]";

/** Marks a tool result moved out of the context, with its whole content kept in a file the marker names. */
const KEPT_TOOL_PREFIX = "[earlier tool output moved out of context to make room";

/** Where a cleared result's whole content was put, and how big that content is. */
export interface KeptToolOutput {
  path: string;
  lines: number;
  kb: number;
}

/**
 * Keep a tool result's content before the marker replaces it: the file it now lives in, or null when it could not be
 * written — then the old marker is used, and the keeper has said why (`ToolOutputSpill.keepCleared`).
 *
 * Live, before this: 107 results in one conversation replaced by "read it again", often for the call just made. The
 * agent re-ran commands, and a fact that came from a command that changed something was gone for good.
 */
export type KeepCleared = (message: ChatMessage, text: string) => KeptToolOutput | null;

/**
 * Below this, a tool result is left alone.
 *
 * Replacing "done" with a sentence explaining that "done" was removed makes the request *bigger*. Only
 * output large enough to be worth the marker is worth trimming.
 */
const MIN_TRIMMABLE_CHARS = 400;

export interface TrimToolResultsOptions {
  /** Trimming starts once the messages are above this. */
  maxTokens: number;
  /** Most recent tool results left verbatim, however large. */
  keepRecent: number;
  /** Where a trimmed result's content is kept, so the marker can name it. Absent: dropped, as before. */
  keep?: KeepCleared;
}

export interface TrimToolResultsResult {
  messages: ChatMessage[];
  /** How many tool results were replaced. Zero means the input is returned unchanged. */
  trimmed: number;
  /** The messages' estimate as returned — what the line was compared against. */
  tokens: number;
  /**
   * Whether the last resort fired — a result inside `keepRecent` had to be squeezed.
   *
   * Reported so it can be logged, because it is a signal about the *configuration* rather than about
   * this turn: it means `keepRecent × the per-result cap` does not fit in this model's budget, and the
   * agent is going to lose output it was still using until that changes.
   */
  reachedProtected?: boolean;
}

/**
 * Where a cleared result's content was kept, read off its marker (`trimNotice`) — null for one dropped with nowhere
 * kept, and for anything that is not a cleared result. What a request's line names (`executor/context-line.ts`).
 */
export function keptPathOf(message: ChatMessage): string | null {
  if (message.role !== "tool") return null;
  const text = messageText(message.content);
  if (!text.startsWith(KEPT_TOOL_PREFIX)) return null;
  return /, kept at (.+?); read it with /.exec(text)?.[1] ?? null;
}

export function isTrimmedToolResult(message: ChatMessage): boolean {
  // Tool results are always strings; `messageText` is here so the narrowing is stated rather
  // than assumed, and stays correct if that ever changes.
  if (message.role !== "tool") return false;
  const text = messageText(message.content);
  return text.startsWith(KEPT_TOOL_PREFIX) || text.startsWith(TRIMMED_TOOL_PREFIX);
}

/**
 * Make room *inside* a turn by shrinking old tool output.
 *
 * The gap this fills: compaction runs once, before the tool loop. Inside the loop the working set grows
 * with every assistant message and every tool result — up to `max_tool_iterations` of them — and nothing
 * measured it again. The only net was reactive, in `ProviderCaller.call`: catch the provider's overflow error
 * and retry with harder truncation. But truncation is turn-aligned and the running turn is the one it
 * preserves, so that net can only drop *history* — never the turn's own tool output, which is exactly
 * what overflowed. Four `read` calls at the 256KB tool cap were enough to make a turn unrecoverable.
 *
 * ## Content, never the message
 *
 * A tool result is replaced with a marker; it is never removed. Removing it would orphan the
 * `tool_use` that asked for it, which Anthropic rejects outright — the failure this whole module is
 * arranged to make impossible. Shrinking the content keeps the pairing intact by construction.
 *
 * ## Oldest first, and only as far as needed
 *
 * Stops as soon as the set fits. The newest results are what the model is still working from; the
 * oldest have been read, acted on, and are being carried only because nothing removed them.
 *
 * No provider call, deliberately — this runs in the middle of a turn somebody is waiting on, and a
 * summarisation request there would add latency to the wait it exists to protect.
 *
 * Runs before every round, so it is measured once and then kept current: each replacement changes the
 * total by what it saved. Re-measuring the whole set after every trim was a full pass per trimmed result
 * (E9) — a turn trimming forty results measured its working set forty times.
 */
export function trimToolResults(
  messages: ChatMessage[],
  options: TrimToolResultsOptions,
): TrimToolResultsResult {
  let tokens = estimateMessagesTokens(messages);
  if (tokens <= options.maxTokens) return { messages, trimmed: 0, tokens };

  /**
   * The results of the last round — after the last assistant message — are never trimmed: the model has not read them
   * yet. Cleared, it reads "[cleared]" for the call it just made and makes it again; with a window nothing knows,
   * budgeted at a guess its prompt and tools alone fill, that was every result of every turn (SMART_AUTOMATION §3.6).
   * Too big for the window, the request says so, and the provider's overflow is answered as one.
   */
  const lastAnswer = messages.findLastIndex((message) => message.role === "assistant");
  const toolIndexes = messages.flatMap((message, index) => (message.role === "tool" && index < lastAnswer ? [index] : []));
  const keep = Math.max(0, options.keepRecent);
  const cut = Math.max(0, toolIndexes.length - keep);
  const candidates = toolIndexes.slice(0, cut);
  const protectedIndexes = toolIndexes.slice(cut);

  const out = [...messages];
  let trimmed = 0;
  let reachedProtected = false;

  /** Trim oldest-first through one group, stopping the moment the set fits. */
  const trimThrough = (indexes: number[]): boolean => {
    for (const index of indexes) {
      const message = out[index];
      if (!message || isTrimmedToolResult(message)) continue;
      const text = messageText(message.content);
      if (text.length < MIN_TRIMMABLE_CHARS) continue;

      // Only tool output is trimmed, and tool output is text — so replacing the whole content
      // with a notice cannot discard a picture.
      const notice: ChatMessage = { ...message, content: trimNotice(text, options.keep?.(message, text)) };
      tokens += estimateMessageTokens(notice) - estimateMessageTokens(message);
      out[index] = notice;
      trimmed += 1;
      // Checked after each one rather than estimated up front: stopping at the first point that fits
      // keeps the maximum amount of real output in the request.
      if (tokens <= options.maxTokens) return true;
    }
    return tokens <= options.maxTokens;
  };

  /**
   * The protected results are a *preference*, not a guarantee — and that is the fix.
   *
   * `keepRecent` exists because the newest results are what the model is still working from, and
   * trimming them costs it the thing it is mid-way through using. Right. But it was absolute, and an
   * absolute protection multiplies: `keepRecent × the per-result cap` is the floor of what no pass can
   * remove, and nothing checked that product against the budget. Three protected results at the 25k cap
   * is 75k tokens — a tenth of a million-token window and *three quarters* of a 128k one, leaving a
   * quarter of the budget for the conversation the tools were called in service of.
   *
   * Worse, it made `preserve_recent_tool_results` unsafe to raise: at 6 on a 200k model the floor
   * exceeds the whole budget, so every request overflows with nothing any pass is allowed to touch. The
   * reactive net cannot help either — it drops *history* and preserves the running turn, which is
   * exactly where these live.
   *
   * So: candidates first, and only if the set still does not fit do the protected ones get squeezed,
   * oldest of them first. Nothing changes in the ordinary case, where trimming the older results is
   * enough. What changes is that "does not fit" is no longer a state the trimmer is forbidden to leave.
   */
  if (!trimThrough(candidates) && protectedIndexes.length > 0) {
    const before = trimmed;
    trimThrough(protectedIndexes);
    reachedProtected = trimmed > before;
  }

  return trimmed > 0 ? { messages: out, trimmed, tokens, reachedProtected } : { messages, trimmed: 0, tokens };
}

export interface PruneToolOutputsOptions {
  /** The newest tool output, in tokens, that is never touched. */
  protectTokens: number;
  /**
   * The newest turns whose tool output is never touched, counted from the person's messages (0.8.13, TOKEN_SAVINGS
   * §3.2): at a turn's start, output older than the last few turns goes, however little of it there is.
   */
  protectTurns?: number;
  /** Below this saving nothing is changed — a prune rewrites the prefix and costs the cache. */
  minSavingsTokens: number;
  /** Where a cleared result's content is kept — written only once the prune is certain to happen. */
  keep?: KeepCleared;
}

/**
 * Between turns, clear old tool output from the stored history — the cheap pass before a summary.
 *
 * The bulk of a long working session is tool output that was read once, acted on, and is now carried
 * for no reason but that nothing removed it. Clearing it is free (no model call) and often enough on
 * its own. omp and Claude Code both do this first, for the same reason.
 *
 * Counted in tokens from the newest result backwards, rather than in results like `trimToolResults`:
 * that one runs inside a turn, where the newest few are what the model is mid-way through using.
 * Between turns the question is how much recent output to keep, and a count cannot say — three results
 * are 600 tokens one day and 75k the next.
 *
 * All or nothing against `minSavingsTokens`, because each prune changes the conversation's prefix and
 * a provider's prompt cache with it. Paying that for a few hundred tokens is a loss.
 */
export function pruneToolOutputs(
  messages: ChatMessage[],
  options: PruneToolOutputsOptions,
): { messages: ChatMessage[]; pruned: number; savedTokens: number } {
  let seen = 0;
  let saved = 0;
  const candidates: number[] = [];
  // Where the protected turns begin: the person's message that opens the oldest of them.
  const userAt = messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  const turnsFrom = options.protectTurns === undefined ? messages.length : (userAt[userAt.length - options.protectTurns] ?? 0);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "tool" || isTrimmedToolResult(message)) continue;
    if (index >= turnsFrom) continue;
    const tokens = estimateMessageTokens(message);
    seen += tokens;
    if (seen <= options.protectTokens) continue;
    const text = messageText(message.content);
    if (text.length < MIN_TRIMMABLE_CHARS) continue;
    candidates.push(index);
    saved += tokens - estimateMessageTokens({ ...message, content: trimNotice(text) });
  }
  if (candidates.length === 0 || saved < options.minSavingsTokens) return { messages, pruned: 0, savedTokens: 0 };

  const out = [...messages];
  for (const index of candidates) {
    const message = out[index]!;
    const text = messageText(message.content);
    out[index] = { ...message, content: trimNotice(text, options.keep?.(message, text)) };
  }
  return { messages: out, pruned: candidates.length, savedTokens: saved };
}

/**
 * What replaces the output.
 *
 * The size is reported because the model asked for this and is entitled to know it existed and is
 * gone — silently substituting an empty result invites it to conclude the file was empty.
 *
 * Kept (the ordinary case): the marker says where the whole output is, and to open it with `read` rather than run
 * anything again — a command that changed something cannot be re-run to see what it said. Not kept (no spill store, a
 * write that failed): the old remedy, which says which re-runs are safe.
 */
function trimNotice(content: string, kept?: KeptToolOutput | null): string {
  if (kept) {
    return `${KEPT_TOOL_PREFIX}: ${kept.lines} lines, ~${kept.kb}KB, kept at ${kept.path}; read it with \`read\` (offset/limit) instead of re-running the command]`;
  }
  const lines = content.split("\n").length;
  const kb = Math.max(1, Math.round(content.length / 1024));
  return `${TRIMMED_TOOL_PREFIX} (${lines} lines, ~${kb}KB). If you still need it, read it again: re-read the file or re-run a read-only command; never re-run a command that changed something.`;
}
