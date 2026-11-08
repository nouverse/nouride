/**
 * One turn read whole by its id (`routes/turns.ts`), what `nouride turns show` prints: each model call with why it
 * ended, what each request carried, and the work it handed to the background. Every newer part is optional: a daemon
 * from before 0.7.26 answers without it.
 */

import type { StopReason } from "@nouride/shared";
import type { TurnCause, TurnStatus, TurnStep } from "./chat.ts";

/** One provider call the turn made — its own, or a helper's or a peer's counted with it. */
export interface TurnModelCall {
  at: number;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** What the call was for, when it was not the turn answering: a compaction, a helper's, a peer's… */
  purpose?: string;
  /** Why the provider says it ended (0.7.26) — `max_tokens` is a reply cut at the output limit. Absent: no reason given. */
  stopReason?: StopReason;
}

/** What one model request carried (0.7.26): its size, the tool results cleared out of it, whether a summary was in it. */
export interface TurnContextLine {
  request: number;
  estimatedTokens: number;
  cleared: number;
  /** Where the results cleared since the line before were kept. */
  keptAt?: string[];
  summary: boolean;
  notes: boolean;
  /** A helper's or a peer's request, inside the turn that waited on it. */
  via?: string;
  by?: string;
}

/** A delegate's own turn, as the turn that started it lists it (0.7.26). */
export interface HandedOffTurn {
  id: string;
  agentId: string;
  status: TurnStatus;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  cause?: TurnCause;
}

export interface TurnRecordDetail {
  turn: { id: string; agentId: string; status: TurnStatus; prompt: string; reply: string; cause?: TurnCause };
  calls: TurnModelCall[];
  steps: Pick<TurnStep, "seq" | "kind" | "text">[];
  contexts?: TurnContextLine[];
  delegated?: HandedOffTurn[];
}
