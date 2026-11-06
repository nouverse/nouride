/**
 * Who may talk to the agents: who is asking, the answers, and what was answered before.
 *
 * Its own module rather than more lines in `api.ts`, for the reason that file's budget note gives: a
 * new endpoint group belongs in a module of its own.
 *
 * A different queue from `approvals`, and confusing the two cost an operator an hour: the bot told them
 * to approve a pairing code, the dashboard's approval list was empty because that list is for *tool*
 * calls, and the only way to answer was a CLI command nothing had mentioned. The code expired while they
 * looked. **Approvals** are on Overview — an agent is stopped mid-turn. **Access** is its own page — a
 * person is asking to be let in. Neither borrows the other's word.
 */

import { control, post, request } from "./api.client";

export type AccessMode = "open" | "allowlist" | "pair";

export interface SenderRecord {
  gatewayId: string;
  senderId: string;
  senderName: string | null;
  /** `denied` is "no, this time" — `expiresAt` says until when. `blocked` lasts until an unblock. */
  status: "pending" | "approved" | "denied" | "blocked";
  code: string | null;
  chatId: string | null;
  requestedAt: number;
  /** Pending: when the code stops working. Denied: when they may ask again. */
  expiresAt: number | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

/** One line of the history, as the audit log keeps it. */
export interface AccessEvent {
  action:
    | "access_requested"
    | "access_approved"
    | "access_denied"
    | "access_blocked"
    | "access_revoked"
    | "access_reset"
    | "access_unblocked"
    | "access_expired";
  /** A dashboard user, `cli`, `system` for an expiry — or the sender themselves, for a request. */
  actor?: string;
  gatewayId?: string;
  details?: { sender?: string; sender_name?: string | null; was?: string | null; until?: number };
  timestamp: number;
}

/** The answers about one sender beside approving. None lets anybody in: reset and unblock let them ask. */
export type SenderAnswer = "deny" | "block" | "revoke" | "reset" | "unblock";

const senderQuery = (gatewayId: string, senderId: string) =>
  `gateway=${encodeURIComponent(gatewayId)}&sender=${encodeURIComponent(senderId)}`;

export const accessApi = {
  access: () =>
    request<{
      mode: AccessMode;
      /** False when the daemon runs on built-in defaults: there is no file to write the mode to. */
      editable?: boolean;
      allowlist: string[];
      senders: SenderRecord[];
    }>(`${control}/access`),
  /** Turn pairing on or off. Live — the next inbound message is judged by the new mode, no restart. */
  setAccessMode: (mode: AccessMode) => post<{ ok: true; mode: AccessMode }>(`${control}/access/mode`, { mode }),
  /** An admin's: it hands them every agent, and "who they are" can hand them somebody's memory. */
  approveSender: (code: string, who?: { as: string; name?: string }) =>
    post<{ ok: boolean; warning?: string }>(`${control}/access/approve?${new URLSearchParams({ code, ...who })}`),
  answerSender: (action: SenderAnswer, gatewayId: string, senderId: string) =>
    post<{ ok: boolean }>(`${control}/access/${action}?${senderQuery(gatewayId, senderId)}`),
  accessHistory: () => request<{ entries: AccessEvent[] }>(`${control}/access/history`),
};
