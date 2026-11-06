/**
 * Where a conversation goes when it gets old or too long: a rollover clears it on a clock, compaction summarises it.
 * What ending one clears — here, and on `/new`, `/reset` and a delete — is `conversation-end.ts`.
 */

import { createLogger, type ChatMessage, type LLMProvider, type LoadedAgent, type SessionKey } from "@nouride/shared";
import { contextWindowInfo, estimateMessagesTokens } from "@nouride/llm";
import { evaluateRollover } from "@/modules/sessions/rollover.ts";
import { groupTurns, resolveCompactionLimit } from "@/modules/llm/context.ts";
import { compactHistory } from "@/modules/llm/summarize.ts";
import { todaysVerdict } from "@/modules/llm/budget.ts";
import { summarizerFor, summarizerWindowFor } from "@/modules/llm/summarizer.ts";
import { compactionEnded, compactionStarted, type SayCompaction } from "@/modules/llm/compaction-steps.ts";
import type { PipelineDeps } from "./deps.ts";
import type { CompactionPlan } from "@/modules/llm/executor/types.ts";
import type { EndMode } from "./conversation-end.ts";

const log = createLogger("pipeline.session-lifecycle");

export class SessionLifecycle {
  constructor(
    private readonly deps: PipelineDeps,
    /** End a conversation the one way every ending does (`conversation-end.ts`). */
    private readonly end: (key: SessionKey, mode: EndMode) => Promise<unknown>,
  ) {}

  /**
   * Clear a conversation's context that has gone stale, before the incoming message joins it —
   * `[rollover]`. Takes a key rather than an envelope: a scheduled turn has no inbound message, and
   * this is the one thing it needs from here.
   */
  async rollOverIfStale(agent: LoadedAgent, key: SessionKey): Promise<void> {
    if (this.deps.config.rollover.mode === "none") return;

    const session = this.deps.sessions.load(key);
    if (session.messages.length === 0) return;

    const decision = evaluateRollover({
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      now: Date.now(),
      rollover: this.deps.config.rollover,
      timezone: this.deps.config.daemon.timezone,
    });
    if (!decision.stale || !decision.reason) return;

    await this.end(key, "rollover");

    log.info("conversation rolled over", {
      agent_id: agent.config.id,
      gateway_id: key.gatewayId,
      chat_id: key.chatId,
      reason: decision.reason,
      messages: session.messages.length,
    });
  }

  /**
   * Summarize a conversation on demand — the `/compact` hook.
   *
   * Shares `compactHistory` with the automatic pass rather than reimplementing it, so the summary a
   * person asks for is the same shape as the one the daemon writes on its own. The only difference is
   * the threshold: `maxTokens: 0` means "compact whatever is there", because someone typing the command
   * has already decided the history is long enough.
   */
  async compactSession(
    agentId: string,
    hookCtx: { gatewayId: string; chatId: string },
  ): Promise<{ status: "compacted" | "empty" | "nothing_to_do" | "failed" | "over_budget"; before: number; after: number; turns: number; refusal?: string }> {
    const key = { agentId, chatId: hookCtx.chatId, gatewayId: hookCtx.gatewayId };
    const agent = this.deps.registry.get(agentId);
    const session = this.deps.sessions.load(key);
    const before = estimateMessagesTokens(session.messages);

    if (!agent) return { status: "failed", before, after: before, turns: 0 };
    if (session.messages.length === 0) return { status: "empty", before: 0, after: 0, turns: 0 };

    // A single turn is nothing to compact: it is the tail every compaction keeps.
    if (groupTurns(session.messages).length <= 1) {
      return { status: "nothing_to_do", before, after: before, turns: 0 };
    }

    const verdict = todaysVerdict(this.deps.usage, this.deps.config);
    if (verdict.action === "refuse") return { status: "over_budget", before, after: before, turns: 0, refusal: verdict.message };

    // The limit the automatic pass would use, less a rough share for the prompt and tools it subtracts
    // there — this path has no prompt in hand, and the number only shapes the tail and the parts.
    const model = agent.config.llm.model;
    const total = resolveCompactionLimit(agent.config.llm.compactAtTokens, this.deps.config.llm.context.compactAtTokens, model);
    // A conversation's compaction asked for by hand: charged to it, with no turn to hang it on — and written by the
    // model a turn's would be (`llm/summarizer.ts`).
    const { provider, model: summaryModel } = summarizerFor(this.deps, { agentId, profile: agent.config.llm.provider, sessionId: session.id, tiers: agent.config.llm })(model);
    const result = await compactHistory(session.messages, {
      provider,
      model: summaryModel,
      maxTokens: 0,
      limit: Math.floor(total.tokens * 0.7),
      // The agent's declared window is its own model's; another model summarising has its own (as `prepareTurn` reads it).
      summarizerWindow: summarizerWindowFor(summaryModel, model, agent.config.llm.contextWindow ?? contextWindowInfo(model).tokens),
      timezone: this.deps.config.daemon.timezone,
      key: session.id,
      ...(this.deps.spill ? { keep: this.deps.spill.keeperFor({ agentId, sessionId: session.id }) } : {}),
    });

    // Unchanged without a failure means everything there already fits in the kept tail.
    if (!result.compacted) {
      return result.failed
        ? { status: "failed", before, after: before, turns: 0 }
        : { status: "nothing_to_do", before, after: before, turns: 0 };
    }

    const after = estimateMessagesTokens(result.messages);
    this.deps.sessions.save(key, result.messages, after);
    return { status: "compacted", before, after, turns: result.summarizedTurns };
  }
}

/**
 * Compact a conversation right after its reply has gone out.
 *
 * The pass inside the next turn's preparation is what used to do this, and it made whoever asked the
 * next question wait ten or twenty seconds for a summary before their answer started. Called from the
 * turn's own queue slot, after the answer: the next message only waits if it arrives during those
 * seconds, and the session is never written by two things at once. The pre-turn pass stays, as the
 * net for a compaction that failed or was skipped here.
 */
export async function compactAfterReply(
  deps: Pick<PipelineDeps, "config" | "sessions" | "usage" | "spill">,
  turn: {
    key: SessionKey;
    sessionId: string;
    stored: ChatMessage[];
    /**
     * In the estimator's tokens at the scale the turn measured, so it is held against the estimate as it
     * is: a log that tokenizes at 2.3x its estimate compacts at its real size (`context-scale.ts`).
     */
    plan: CompactionPlan;
    /** Metered by the caller, as the turn's compaction. */
    provider: LLMProvider;
    /** The turn's: a `/stop` while this holds the conversation's slot cuts the summary short. */
    signal?: AbortSignal;
    say?: SayCompaction;
  },
): Promise<void> {
  if (deps.config.llm.context.truncationStrategy !== "summary") return;
  if (estimateMessagesTokens(turn.stored) <= turn.plan.threshold) return;
  // Past today's cap the turn that crossed it has answered; its summary waits for the next turn, which compacts
  // first if it is let through at all.
  const verdict = todaysVerdict(deps.usage, deps.config);
  if (verdict.action === "refuse") {
    log.info("compaction after the reply skipped: over today's cap", { session_id: turn.sessionId });
    return;
  }
  const result = await compactHistory(turn.stored, {
    provider: turn.provider,
    model: turn.plan.summaryModel,
    maxTokens: turn.plan.threshold,
    limit: turn.plan.limit,
    summarizerWindow: turn.plan.summarizerWindow,
    timezone: deps.config.daemon.timezone,
    key: turn.sessionId,
    ...(turn.signal ? { signal: turn.signal } : {}),
    onStart: ({ turns, tokens }) => compactionStarted(turn.say, turns, tokens),
    ...(deps.spill ? { keep: deps.spill.keeperFor({ agentId: turn.key.agentId, sessionId: turn.sessionId }) } : {}),
  });
  if (result.compacted) deps.sessions.save(turn.key, result.messages, estimateMessagesTokens(result.messages));
  // Said on the turn that just ended — after its end row: a reader sees why the next one starts smaller.
  compactionEnded(turn.say, result, "the next turn will compact first");
}
