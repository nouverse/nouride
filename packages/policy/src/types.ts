/**
 * The permission vocabulary.
 *
 * What may run is the operator's veto (`blocked`) and nothing else to configure: whether a command asks is the approval
 * level's, over one fixed list of what always asks (`HardlineClass`) — 0.8.0's three presets in place of the four
 * knobs that each guessed at it.
 */

import type { ApprovalDecision } from "@nouride/shared";

export type { ApprovalDecision };

export interface ExecPolicy {
  /**
   * Refused before anything else, including a durable grant and every approval level.
   *
   * The one rule an operator can write that no runtime answer can override.
   */
  blocked: string[];
}

/** A grant a human created by answering `allow-always`. */
export interface ExecGrant {
  /** Identity of the command this grant covers — see `grant-key.ts`. */
  key: string;
  /** For display in `nouride grants list`; never matched against. */
  commandText: string;
}

export interface ExecRequest {
  argv: string[];
  cwd: string;
  agentId: string;
  /**
   * sha256 of a file this command will execute, when there is one (`bash deploy.sh`).
   *
   * Folded into the grant key by the caller, so editing the script revokes the grant. Absent
   * when the command executes no file operand.
   */
  fileSha256?: string;
}

import type { HardlineVerdict } from "./hardline.ts";

/** Ask a human. `grantable` is false when `allow-always` must be downgraded to `allow-once` — a call on the fixed list. */
export interface PolicyAsk {
  action: "ask";
  grantable: boolean;
  /** On the fixed list: asked every time, never remembered. */
  hardline?: boolean;
  /** Which entry of it — what the approval level reads (`BALANCED_ASKS`). */
  hardlineClass?: HardlineVerdict["class"];
  reason: string;
}

export type PolicyOutcome =
  /** Run it. `via` says what authorized it, which is what the audit log records. */
  | { action: "run"; via: "allowlist" | "grant" }
  | PolicyAsk
  /**
   * Refuse. `unasked` is the question this stands in for when the only reason is that nobody could be
   * asked — so an approval level that answers that question by itself still can, whether or not anyone
   * happens to be reachable.
   */
  | { action: "refuse"; reason: string; unasked?: PolicyAsk };
