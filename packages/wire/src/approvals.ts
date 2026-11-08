/**
 * An approval a turn waits on, as the chat and the approvals list show it, and the answers it takes.
 */

import type { ApprovalDecision } from "@nouride/shared";

export type ApprovalPreview =
  | { kind: "new_file"; path: string; lines: number; bytes: number }
  | { kind: "overwrite"; path: string; lines: number; bytes: number; wasLines: number; wasBytes: number }
  | {
      kind: "edit";
      path: string;
      added: number;
      removed: number;
      hunk: { sign: "-" | "+" | " "; text: string }[];
      clipped: boolean;
    }
  | { kind: "command"; command: string; cwd?: string; clipped: boolean; shell?: boolean }
  | { kind: "params"; json: string; clipped: boolean };

export interface ApprovalRequest {
  id: string;
  agentId: string;
  chatId: string;
  tool: string;
  params: Record<string, unknown>;
  preview?: ApprovalPreview;
  /** Whether `allow-always` would do anything. A button that is silently downgraded teaches distrust. */
  grantable?: boolean;
  reason?: string;
  requestedAt: number;
  timeoutMs: number;
  /** Not asked in its chat yet: it waits behind the question shown there, one at a time. Answerable here all the same. */
  queued?: boolean;
}

export type { ApprovalDecision };
