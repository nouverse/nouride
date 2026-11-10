/**
 * The daemon's own records, as the CLI reads them. Each is the CLI's copy of a type an engine module keeps, held to
 * it by `check-seams` (`PAIRS`): this package may not import the engine, and a field the daemon stops sending fails
 * that check where it once failed this file's compile.
 */

import type { LogEntry, StopReason, TurnEventData } from "@nouride/shared";
import type { TurnCause, TurnStatus, TurnStep } from "@nouride/wire";

/** How much work runs at once (`commons/machine.ts`). */
export interface AtOnce {
  machine: string;
  helpers: { limit: number; auto: boolean };
  missions: { limit: number; auto: boolean };
}

/** What `doctor` and `status` read of one trouble with the helper model's work (`llm/helper-trouble.ts`). */
export interface HelperTroubleLine {
  issue: string;
  summary: string;
  last: string;
  at: number;
  fix: string;
}

/** A row of the audit log with when it was written, as `nouride audit` prints it (`commons/audit.store.ts`). */
export interface AuditLine {
  action: string;
  agentId?: string;
  actor?: string;
  gatewayId?: string;
  chatId?: string;
  turnId?: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

/** A line of the log buffer (`commons/log-buffer.ts`). */
export type BufferedLog = LogEntry & { seq: number };

/** What one message sent through the control API came back with (`gateways/local.ts`). */
export interface LocalTurnResult {
  replies: string[];
  answered: boolean;
}

/** A command an agent may run without asking again (`tools/grants.store.ts`). */
export interface ExecGrantRecord {
  id: string;
  grantKey: string;
  agentId: string;
  commandText: string;
  argv: string[];
  cwd: string;
  fileSha256: string | null;
  createdAt: number;
  createdBy: string;
  approvalId: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
  useCount: number;
}

/** A tool an agent may use in a folder without asking again (`tools/tool-grants.store.ts`). */
export interface ToolGrantRecord {
  id: string;
  grantKey: string;
  agentId: string;
  tool: string;
  scopeDir: string;
  createdAt: number;
  createdBy: string;
  approvalId: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
  useCount: number;
}

/** One call to a model inside a turn, as `nouride turns show` lists it (`turns/inspection.store.ts`). */
export interface ModelCall {
  at: number;
  agentId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  /** Null when the model has no price. */
  usd: number | null;
  latencyMs?: number;
  attempts?: number;
  /** Who served it behind a gateway, where the gateway said. */
  upstream?: { provider?: string; model?: string; attempts?: number };
  purpose?: string;
  basis?: string;
  estimated?: boolean;
  stopReason?: StopReason;
}

/** `GET /turns/:id` — one turn with what it cost and did (`turns/inspection.store.ts`). */
export interface TurnInspection {
  turn: {
    id: string;
    agentId: string;
    status: TurnStatus;
    prompt: string;
    reply: string;
    messageId?: string;
    error?: string;
    startedAt: number;
    endedAt?: number;
    cause?: TurnCause;
  };
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    usd: number;
    unpriced: number;
    latencyMs: number;
    slowestMs: number;
    retries: number;
  };
  calls: ModelCall[];
  steps: Pick<TurnStep, "seq" | "at" | "kind" | "text">[];
  audit: { at: number; action: string; details: Record<string, unknown> | null }[];
  delegated?: { id: string; agentId: string; status: TurnStatus; prompt: string; startedAt: number; endedAt?: number; cause?: TurnCause }[];
  contexts?: TurnEventData["context"][];
}

/** A row of `GET /turns` (`turns/inspection.store.ts`). */
export interface TurnSummary {
  id: string;
  agentId: string;
  status: TurnStatus;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  calls: number;
  usd: number | null;
  cause?: TurnCause;
}

/** What checking a coding CLI after an update found (`external-agents/cli-update.ts`). */
export interface UpdateChecked {
  cli: string;
  passed: boolean;
  /** The version its handshake gave, where it started. */
  version?: string;
  problem?: string;
  /** The version before: the last that passed, offered back. */
  before?: string;
}
