/**
 * An `approvals` row, read as the request a person is shown — the one mapping the gate's every reader goes through.
 *
 * Out of `approvals.store.ts` because it is a pure function of a row and nothing else: the store decides when a request
 * is asked and answered, and this only says how its stored form reads back.
 */

import type { ApprovalDecision, ApprovalPreview, ApprovalRequest, ApprovalStatus, GatewayName, HardlineClass } from "@nouride/shared";
import type { KeptExtras } from "./approvals-kept.ts";

export interface ApprovalRow {
  id: string;
  agent_id: string;
  chat_id: string;
  gateway: string;
  tool: string;
  params: string;
  status: string;
  requested_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  timeout_ms: number;
  decision: string | null;
  grantable: number;
  auto_coverable: number;
  reason: string | null;
  preview_json: string | null;
  hardline_class: string | null;
  /** What only the asking process knew (076): read by `rowExtras`, and never part of the request a person is shown. */
  extras_json: string | null;
}

export function toRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    agentId: row.agent_id,
    chatId: row.chat_id,
    gateway: row.gateway as GatewayName,
    tool: row.tool,
    params: safeParams(row.params),
    status: row.status as ApprovalStatus,
    requestedAt: row.requested_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
    grantable: row.grantable === 1,
    // Every row has it: 063 filled the ones written before the column existed (0.7.22).
    autoCoverable: row.auto_coverable === 1,
    ...(row.hardline_class ? { hardlineClass: row.hardline_class as HardlineClass } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.decision ? { decision: row.decision as ApprovalDecision } : {}),
    ...(safePreview(row.preview_json) ? { preview: safePreview(row.preview_json)! } : {}),
    timeoutMs: row.timeout_ms,
  };
}

/**
 * What only the process that asked knew about a request, as its row keeps it from the moment it is asked (076): who
 * asked, its turn, the grant `always` writes. Null for a row asked before 0.8.18, or one that cannot be read: such a
 * request is kept without them, as a crash left it before, and `always` on it runs the call once.
 */
export function rowExtras(row: Pick<ApprovalRow, "extras_json">): KeptExtras | null {
  if (!row.extras_json) return null;
  try {
    const value: unknown = JSON.parse(row.extras_json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as KeptExtras) : null;
  } catch {
    return null;
  }
}

/**
 * A stored preview, or undefined.
 *
 * Never throws: a malformed blob means the prompt shows raw parameters, which is the old behaviour and
 * perfectly usable. Failing the whole pending list because one summary is corrupt would take the gate
 * offline over a cosmetic field.
 */
function safePreview(raw: string | null): ApprovalPreview | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ApprovalPreview;
  } catch {
    return undefined;
  }
}

/**
 * Params are shown to a human in full so they can judge the call (§7.3 SPEC).
 *
 * Unparseable JSON becomes a visible marker rather than an empty object: approving a request
 * whose arguments could not be read would be approving something unknown.
 */
function safeParams(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { _unreadable: raw };
  } catch {
    return { _unreadable: raw };
  }
}
