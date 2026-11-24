/**
 * Who may talk to the agents (`routes/access.ts`): who is asking, the answers, and what was answered before.
 */

/** An install asks a stranger to pair, or takes only who is listed. Open to everyone is one agent's (`AgentSummary.access`). */
export type AccessMode = "allowlist" | "pair";

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
    | "access_expired"
    /** A list of senders let in ahead at once: one line for the list, its counts in `details`. */
    | "access_imported";
  /** A dashboard user, `cli`, `system` for an expiry — or the sender themselves, for a request. */
  actor?: string;
  gatewayId?: string;
  details?: { sender?: string; sender_name?: string | null; was?: string | null; until?: number; added?: number; already?: number; blocked?: number };
  timestamp: number;
}

/** What `GET /access` answers: the rule in force and who stands where. */
export interface AccessListing {
  mode: AccessMode;
  /** False when the daemon runs on built-in defaults: there is no file to write the mode to. */
  editable?: boolean;
  allowlist: string[];
  /** Everyone asking, denied or blocked, and the newest approved: at most 500 of those. */
  senders: SenderRecord[];
  /** How many are approved in all. More than `senders` holds where a list was let in from a file. Absent from a daemon before it. */
  approvedTotal?: number;
}

/**
 * What letting a list in answers (`POST /access/import`), or would answer (`dryRun`): of the lines read, how many are
 * new, how many were in already, how many are blocked and stay out, how many said the same sender twice, and which
 * could not be a sender on that connection.
 */
export interface AccessImported {
  gateway: string;
  dryRun: boolean;
  read: number;
  added: number;
  already: number;
  blocked: number;
  duplicates: number;
  invalid: { count: number; examples: string[] };
}

/** The answers about one sender beside approving. None lets anybody in: reset and unblock let them ask. */
export type SenderAnswer = "deny" | "block" | "revoke" | "reset" | "unblock";
