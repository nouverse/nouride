/**
 * Which brain answers a turn (0.8.1): an external agent's coding CLI where its pack has `[external]`, the executor
 * otherwise. The one place the three kinds of turn — a chat's, an `ask_agent`, a scheduled job's — choose, by what the
 * agent declares and never by which agent it is.
 *
 * A CLI that cannot answer a turn — signed out, its account at a limit it refuses past, gone — does not leave the person
 * with nothing: the agent's own model answers that turn instead, and says so first (the owner, 2026-10-26: an agent
 * never goes silent). Not where the CLI had already said something — the answer would be told twice — nor a turn a
 * person stopped.
 */

import { createTypingKeepalive } from "@nouride/gateways";
import { NourideError, type LoadedAgent } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { TYPING_REFRESH_MS, type ExecutorDeps, type TurnBrain, type TurnRequest, type TurnResult } from "@/modules/llm/executor/types.ts";

/** What answers an agent its coding CLI answers, as `/status` tells it (0.8.8). */
export interface CliAnswering {
  /** The CLI by its name: "Claude Code". */
  cli: string;
  /** What answered its handshake, as it named itself — "@agentclientprotocol/claude-agent-acp 0.95.0" — while it runs; null when it is stopped. */
  running: string | null;
  /** The model: the pack's, else the CLI's own, as its last session opened on it; null where neither says, and the CLI chooses. */
  model: { name: string; by: "pack" | "cli" } | null;
  /** The conversation's context as the CLI last said: the tokens in it, of its window. Null before it said. */
  context: { used: number; size: number } | null;
}

/** What the pipeline needs of the external agents (`modules/external-agents`). */
export interface ExternalBrains {
  runnerFor(agent: LoadedAgent, deps: ExecutorDeps): TurnBrain | null;
  /** Stop every CLI, once the turns are drained at a shutdown. */
  stopAll?(): Promise<void>;
  /** Why an agent's CLI cannot answer, or null — its status's `unavailable`. */
  unavailable?(agentId: string): string | null;
  /** A conversation ended: its CLI session goes with it, and the next message opens a new one. */
  forgetSession?(agentId: string, gatewayId: string, chatId: string): void;
  /** The commands the CLIs left running in the background, as a restart waits for them (0.8.6). */
  working?(): { id: string; command: string; startedAt: number }[];
  /**
   * What the agent's CLI takes in a prompt besides text — pictures, sound — as it said itself; null for an agent its
   * own model answers. What a message's attachments are told decides by it (0.8.7).
   */
  takes?(agent: LoadedAgent): Promise<{ image: boolean; audio: boolean } | null>;
  /** The efforts the agent's CLI offered for the model its last session opened on, for `/effort`; empty before one. */
  offeredEfforts?(agentId: string): string[];
  /** What answers the agent in a conversation, for `/status`; null for an agent its own model answers. */
  answering?(agent: LoadedAgent, gatewayId: string, chatId: string): CliAnswering | null;
  /**
   * Whether the agent's CLI takes a message into a prompt still running (`_session/steering`, 0.8.10) — false while none
   * is connected, or where it did not say so. Where not, a steer is its next prompt, once the running one ends.
   */
  steersMidPrompt?(agentId: string): boolean;
}

export function brainFor(external: ExternalBrains | undefined, agent: LoadedAgent, deps: ExecutorDeps): TurnBrain {
  let said = false;
  const watched: ExecutorDeps = { ...deps, onText: (delta) => ((said = said || delta.length > 0), deps.onText?.(delta)) };
  const cli = external?.runnerFor(agent, watched);
  if (!cli) return new TurnExecutor(deps);
  return {
    run: async (req: TurnRequest): Promise<TurnResult> => {
      // The executor keeps the chat's typing indicator up for its own turns; a CLI's turn never did, and the indicator
      // went out five seconds into every one of them (0.8.5). Stopped before the fallback, which keeps its own.
      const typing = deps.onTyping
        ? createTypingKeepalive({ intervalMs: deps.typingRefreshMs ?? TYPING_REFRESH_MS, onTick: () => deps.onTyping?.() })
        : undefined;
      typing?.start();
      try {
        return await cli.run(req);
      } catch (err) {
        typing?.stop();
        if (said || req.signal?.aborted) throw err;
        const why = err instanceof NourideError ? err.userMessage : err instanceof Error ? err.message : String(err);
        const note = `_${agent.config.external?.cli ?? "Its CLI"} could not answer: ${why.replace(/\.$/, "")}. ${agent.config.displayName}'s own model answered this time._\n\n`;
        deps.onActivity?.("note", `the CLI could not answer; the agent's model answers this turn: ${why}`);
        deps.onText?.(note);
        const answered = await new TurnExecutor(deps).run(req);
        return { ...answered, text: `${note}${answered.text}` };
      } finally {
        typing?.stop();
      }
    },
  };
}
