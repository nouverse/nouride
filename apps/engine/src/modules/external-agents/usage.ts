/**
 * What a coding CLI says it spent, and what it says of its context (0.8.8) — read into what Nouride records and shows.
 *
 * A CLI's prompt reported its tokens over ACP (`PromptResponse.usage`) since 0.8.7, and only a mission counted them:
 * no CLI turn reached `llm_usage`, so `/status` said "0 in / 0 out" after hours of work. And its context is its own —
 * kept and compacted by the CLI — which `/status` read off the daemon's transcript instead.
 */

import type { InitializeResult, PromptUsage } from "@nouride/acp";
import type { TokenUsage } from "@nouride/shared";
import type { CliAnswering } from "@/modules/pipeline/brain.ts";

/**
 * A prompt's usage as `llm_usage` holds a provider's: the cache read and written inside `inputTokens`, as
 * `TokenUsage` defines it, where ACP counts them beside it — its `totalTokens` is the sum of every kind, and both
 * claude-agent-acp and codex-acp send the input without the cache. A cache count the CLI did not send stays absent:
 * "said nothing" is not "no hits".
 */
export function cliUsage(usage: PromptUsage): TokenUsage {
  const read = usage.cachedReadTokens;
  const written = usage.cachedWriteTokens;
  // A CLI that says only its `totalTokens` was recorded as 0 in and 0 out (A2). The total is the whole prompt; how it
  // splits is not said, so it is counted as input and marked an estimate — a reader knows the split is ours.
  if (usage.inputTokens + usage.outputTokens + (read ?? 0) + (written ?? 0) === 0 && usage.totalTokens > 0) {
    return { inputTokens: usage.totalTokens, outputTokens: 0, estimated: true, cli: true };
  }
  return {
    inputTokens: usage.inputTokens + (read ?? 0) + (written ?? 0),
    outputTokens: usage.outputTokens,
    ...(read === null ? {} : { cachedInputTokens: read }),
    ...(written === null ? {} : { cacheCreationInputTokens: written }),
    cli: true,
  };
}

/**
 * What a CLI's prompt has spent so far, while it runs — an estimate, from what it says of its context (0.8.8).
 *
 * ACP says what a prompt spent only when it ends (`PromptResponse.usage`), and a coding CLI's mission works in one or two
 * prompts of hours: msn_3d28e0 spent 140M tokens in one, past its limit by 40M, which nothing could see until it ended.
 * Each model call reads the whole context again, and `usage_update` says how big it is as the call runs — so a call's
 * last `used` is what it spent, input, cache and output together, as `cliUsage` counts the prompt's. A call ends where
 * the CLI runs its steps: the first `used` after a step finished, with none still running, is the next call's — Claude
 * Code runs a call's steps side by side, and one done while its output still streamed counted the call twice (1.25M for
 * 1.12M on the live box). A compaction's smaller context is the same call's, and the larger stands.
 */
export class PromptSpend {
  private ended = 0;
  private call = 0;
  private stepped = false;

  /** `running`: the steps not finished yet — while any is, the call they came from is not over. */
  context(used: number, running = 0): void {
    if (this.stepped && running === 0) {
      this.ended += this.call;
      this.call = 0;
      this.stepped = false;
    }
    this.call = Math.max(this.call, used);
  }

  /** A step finished: the next context it says is the next model call's. */
  step(): void {
    this.stepped = true;
  }

  get tokens(): number {
    return this.ended + this.call;
  }
}

/**
 * What the CLI turn running in each conversation has spent so far, by agent and conversation (`PromptSpend`): what a
 * mission's limit reads while its turn runs. In memory, and only while the turn runs.
 */
export class CliSpending {
  private readonly now = new Map<string, number>();

  set(agentId: string, key: string, tokens: number): void {
    this.now.set(`${agentId}|${key}`, tokens);
  }

  of(agentId: string, key: string): number {
    return this.now.get(`${agentId}|${key}`) ?? 0;
  }

  clear(agentId: string, key: string): void {
    this.now.delete(`${agentId}|${key}`);
  }
}

/** A CLI session's context as it last said (`usage_update`): the tokens in it, of its window. */
export interface CliContext {
  used: number;
  size: number;
}

/** What each conversation's CLI session last said of its context, by agent and conversation. In memory: a restart forgets it. */
export class CliContexts {
  private readonly kept = new Map<string, CliContext>();

  keep(agentId: string, key: string, context: CliContext): void {
    this.kept.set(`${agentId}|${key}`, context);
  }

  of(agentId: string, key: string): CliContext | null {
    return this.kept.get(`${agentId}|${key}`) ?? null;
  }

  forget(agentId: string, key: string): void {
    this.kept.delete(`${agentId}|${key}`);
  }
}

/**
 * What answers an agent its CLI answers, as `/status` says it: the CLI, what answered its handshake while it runs, the
 * model — the pack's, else the one its last session opened on — and the context it last said.
 */
export function answeringOf(cli: string, packModel: string | undefined, handshake: InitializeResult["agentInfo"], runsOn: string | null, context: CliContext | null): CliAnswering {
  return {
    cli,
    running: handshake ? [handshake.name ?? handshake.title, handshake.version].filter(Boolean).join(" ") || null : null,
    model: packModel ? { name: packModel, by: "pack" } : runsOn ? { name: runsOn, by: "cli" } : null,
    context,
  };
}
