/**
 * A turn that is not a chat's: what a mission's turn changes about the one the pipeline runs (0.8.0).
 *
 * The pipeline runs every turn the same way — the queue, routing, the executor, the journal — and a mission is only a
 * conversation whose turns differ in four ways, each named here rather than tested for by gateway in `turn.ts`: it
 * starts from a page instead of its history, a call that needs a person is parked instead of waited on, it runs as the
 * person who started it, and the mission hears how each turn went.
 */

import type { MessageEnvelope } from "@nouride/shared";
import type { TurnResult } from "@/modules/llm/executor/index.ts";
import type { Unattended } from "@/modules/llm/executor/types.ts";

/** How a shaped turn went, for whoever shaped it. */
export interface TurnOutcome {
  toolCalls: number;
  /**
   * Calls that ran and did not fail, `plan` aside — whether the turn got anything done. A turn of refused or failing
   * calls is not progress, however many it made.
   */
  worked: number;
  /** Input and output tokens the turn spent, its own calls only. */
  tokens: number;
  /** A coding CLI's turn that reported no tokens (0.8.7): `tokens` is 0 because nothing was said, not because none went. */
  tokensUnknown?: boolean;
  /** The turn threw, or ended without an answer: `error` says what. */
  failed: boolean;
  error?: string;
  /** Stopped by a person, or by a shutdown — not the turn's doing. */
  interrupted: boolean;
  /** A call's result carried content from outside — a page, a message, an MCP answer. */
  readOutside: boolean;
}

export interface TurnShape {
  /** What the model is handed in place of the message: a mission's page, with why this turn started. */
  text: string;
  /** No history is read, and only this turn is kept: the page is the whole of what the turn starts from. */
  fresh: true;
  /** A call that needs a person is parked — asked, not waited on — and stays answerable this long. */
  parkApprovalsMs: number;
  /** The folder the work is done in: on the page for a model, where an external agent's CLI session starts (0.8.1). */
  workdir: string;
  /** The mission works in a worktree of its own (0.8.1), so `delegate` may give each helper one too (`isolated`). */
  helperWorktrees?: true;
  /** Calls parked before this turn, nobody's answered yet: it starts as one that just parked one (`parkedCalls`). */
  parked: number;
  /** Whose approval level and People entry apply, and who may answer what it asks. */
  person: { gatewayId: string; senderId: string };
  /**
   * Outside content read before this turn, named: a mission that read a page or a message in an earlier turn starts
   * every later one as a turn that has. Each turn starts fresh, so without it the mark ended with the turn that
   * read — and the guards a page puts on what follows with it.
   */
  outsideContent?: string[];
  /** Work nobody watches (0.8.0): what it is for, and, for a job's run, the one chat it sends to (`TurnRequest.unattended`). */
  unattended: Unattended;
  /** Told once the turn is settled — or has failed. Never throws into the turn. */
  ended: (outcome: TurnOutcome) => void;
}

/** What shapes the turns of a conversation that is not a chat: the missions, when the daemon runs them. */
export interface TurnShaper {
  /** Whether this conversation's turns are shaped at all — asked before anything else about a message. */
  shapes(envelope: Pick<MessageEnvelope, "gatewayId">): boolean;
  /** The shape of this turn, or null when it should not run: the mission is waiting, ended, or gone. */
  shapeFor(agentId: string, envelope: MessageEnvelope): TurnShape | null;
}

/** The calls of a turn that ran and did not fail, `plan` aside — what `TurnOutcome.worked` counts. */
function workedSteps(steps: readonly { name: string; ok: boolean }[]): number {
  return steps.filter((step) => step.ok && step.name !== "plan").length;
}

/** A turn that ran to a result, as its shape is told it. */
export function outcomeOf(result: Pick<TurnResult, "toolCalls" | "toolSteps" | "usage" | "externalTokens">, interrupted: boolean): TurnOutcome {
  // A coding CLI's turn: what it reported over ACP, its `usage` being nothing Nouride metered (0.8.7).
  const cli = result.externalTokens !== undefined;
  return {
    toolCalls: result.toolCalls,
    worked: workedSteps(result.toolSteps),
    tokens: cli ? (result.externalTokens ?? 0) : result.usage.inputTokens + result.usage.outputTokens,
    ...(cli && result.externalTokens === null ? { tokensUnknown: true } : {}),
    failed: false,
    interrupted,
    readOutside: result.toolSteps.some((step) => step.outside === true),
  };
}
