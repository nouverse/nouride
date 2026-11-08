/**
 * Who may talk to the agents (`routes/access.ts`): who is asking, the answers, and what was answered before.
 */

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
