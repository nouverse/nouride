/**
 * Approval gate — §7.3 SPEC.
 *
 * Phase 1 defines the seam; Phase 2 fills in the SQLite-backed queue and the chat
 * buttons. The interface exists now so the executor is written against it once, rather
 * than being retrofitted later around an `if (approvalsEnabled)`.
 */

import {
  type ApprovalDecision,
  type ApprovalPreview,
  type ApprovalStatus,
  type ToolGrantPayload,
  type ApprovalRequest,
  type ExecGrantPayload,
  type GatewayName,
  type HardlineClass,
} from "@nouride/shared";

/** One job's standing yes, as an approval carries it until it is answered. */
export interface JobGrantPayload {
  jobId: string;
  /** Where, by key (`SendsOut.to`). */
  keys: string[];
  /** What, in words. */
  label: string;
}

export interface ApprovalAsk {
  agentId: string;
  chatId: string;
  gateway: GatewayName;
  /** Instance the request came from, so the approval prompt goes back to the right bot. */
  gatewayId: string;
  senderId: string;
  /** The turn asking — on the request's audit row, and how a restart finds the turn it takes up waiting on it. */
  turnId?: string;
  tool: string;
  params: Record<string, unknown>;
  /**
   * Whether `allow-always` is on offer.
   *
   * False for a hardline command, for `ask = "always"`, and for every non-exec tool. The prompt
   * must reflect it: offering a button that silently does nothing is worse than not offering it.
   */
  grantable: boolean;
  /**
   * Whether an approval level (`/approvals balanced`) may answer this without a human.
   *
   * A separate question from `grantable`, and they used to be answered by the same field. `grantable`
   * is about `allow-always` — can this become a standing permission. This is about "stop asking me" —
   * is this the kind of thing that sentence was meant to cover. A `sudo cat` is ungrantable (a command
   * identity that can never be trusted forever) and perfectly coverable (nothing is changed by it).
   */
  autoCoverable: boolean;
  /** The fixed list's entry it is asked under, stored with the row: who may answer reads it (`approval-answerers.ts`). */
  hardlineClass?: HardlineClass;
  /**
   * How long the caller will wait, when that is shorter than the request stays answerable.
   *
   * Two clocks: this one bounds the *turn*, `approval_timeout_ms` bounds the *question*. Sized so the
   * model still has room to react to a refusal before its own deadline — without it the turn always
   * died first (both default to 300s and the turn starts earlier), so the "tool result the model can
   * adapt to" path was unreachable by construction.
   */
  waitMs?: number;
  /**
   * How long the question stays answerable, when not the daemon's `approval_timeout_ms` — a mission's parked call, which
   * nobody waits on, stays open for a day (0.8.0).
   */
  answerableMs?: number;
  /** Why a human is being asked, phrased for someone deciding in a chat. */
  reason: string;
  /** The daemon's own line under the question — the hint under `careful` (`careful-hint.ts`). Shown, never stored. */
  hint?: string;
  /** Precomputed grant, persisted only on `allow-always` when `grantable`. */
  grant?: ExecGrantPayload;
  /** What the human is being asked to approve, summarised at request time. */
  preview?: ApprovalPreview;
  /** Precomputed directory-scoped grant, for a tool that is not `exec`. */
  toolGrant?: ToolGrantPayload;
  /**
   * What *always for this job* allows (0.8.0): this destination for this job's runs — written on the job, never the agent,
   * when `allow-always` is the answer to one of a job's guards (`tool-caller.ts`, `jobGrantFor`).
   */
  jobGrant?: JobGrantPayload;
  /**
   * The turn's deadline, so a parked request dies with the turn that asked.
   *
   * Without it `max_turn_duration_ms` did not bound a turn at all once it was waiting on a human: the
   * executor checks the abort signal at the top of each tool-loop iteration, and a turn parked inside
   * this promise never reaches the top of another iteration. The turn ran until the *approval* timeout
   * instead, holding its conversation's queue the whole time — and since both defaults are 300s, the
   * two happened to expire together and hid it.
   */
  signal?: AbortSignal;
  /**
   * The wait, said: called once the request exists — a new one, or one still open that this call waits on — and, for
   * a new one, finished before it is put in front of anybody. The executor writes the turn's `waiting` step here,
   * naming the approval (`approvalId`, stream 1.2), and the progress bubble is sealed above the prompt. Not called when
   * nobody is asked: an answer already given, or a gate that refuses at once.
   */
  asking?: (approvalId: string) => void | Promise<void>;
}

/**
 * Who answered a request: the id the gate records (`resolved_by`, the audit log's actor) — a sender id, a dashboard
 * account, `cli` — and, where the answer came with one, the name a person reads, which a settled prompt says.
 */
export interface Answerer {
  id: string;
  name?: string;
}

/** How a request settled — said once, to whatever showed the question (`ApprovalStoreOptions.onSettled`). */
export interface Settlement {
  status: Exclude<ApprovalStatus, "pending">;
  /** The answerer's id, or `timeout` / `system` for a request nobody answered. */
  by: string;
  name?: string;
  decision?: ApprovalDecision;
}

export type ApprovalOutcome =
  | {
      status: "approved";
      /** The request answered — absent when an earlier yes for calls like it covered this one, which asked nobody. */
      id?: string;
      by: string;
      /** Which of the three answers arrived. Absent for gates that do not model the distinction. */
      decision?: ApprovalDecision;
      /** `allow-always` was answered but could not be honoured — the caller tells the model. */
      downgraded?: boolean;
    }
  | { status: "denied"; by: string; reason?: string }
  | {
      status: "expired";
      /**
       * The caller stopped waiting, but the question is still open.
       *
       * The difference the model needs: "nobody answered in time and it is now dead" versus "I gave
       * up waiting, you can still say yes and I will pick it up". Only the second is worth telling
       * someone about, and only the second is followed by a wake-up.
       */
      stillAnswerable?: boolean;
    }
  | { status: "unavailable"; reason: string };

export interface ApprovalGate {
  /**
   * Whether a human can actually be asked right now.
   *
   * Surfaced so the system prompt can tell the agent the truth. Without it the agent is handed
   * tools it will always be refused, promises the user it is running them, and looks broken —
   * the model has no way to discover the gate is missing except by trying.
   */
  readonly available: boolean;

  request(ask: ApprovalAsk): Promise<ApprovalOutcome>;
  /**
   * Is a human reachable right now?
   *
   * Distinct from `available`, which is about the gate existing at all. This is about whether a
   * prompt would land anywhere, and a request nobody can answer is refused rather than parked — parking
   * it just burns the approval timeout and looks like a hang.
   */
  canAsk?(): boolean;
  pending(agentId?: string): ApprovalRequest[];
  /** What a request showed the person, as stored with it (0.8.13): read after a restart too. */
  previewOf?(id: string): ApprovalPreview | null;
  /**
   * Called on `/reset`: nothing may stay parked across it. With `chat`, only what this agent asked in that
   * conversation — what deleting it expires (`pipeline/conversation-end.ts`). A restart keeps them.
   */
  expireAll(agentId?: string, chat?: { gatewayId: string; chatId: string }): number;
}
