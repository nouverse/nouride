/**
 * The gate for a run with nobody behind it.
 *
 * `[cron] unattended_approval = "deny"` selects this. It answers every request immediately instead
 * of parking it, and the difference matters: the real gate would send the question to the target
 * chat and wait out the approval timeout, so a nightly job that touches one gated tool holds a
 * turn open for five minutes at 3am and then fails anyway. Refusing at once costs nothing and the
 * model gets a result it can report.
 *
 * Not the refusal of a process with no chat surface: a cron job *has* a chat, and the reason nobody answers is the hour, not the wiring. The
 * message says so, because a model told "no approval gate is wired up in this process" will
 * reasonably conclude the daemon is misconfigured and say so to the operator.
 */

import { createLogger, type ApprovalRequest, type HeldAction } from "@nouride/shared";
import type { ApprovalAsk, ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";

const log = createLogger("cron.approval");

export class UnattendedApprovalGate implements ApprovalGate {
  readonly available = false;

  /**
   * `onHeld`: told of each question one of the job's guards put (0.8.0) — kept on the run, so a person can allow it
   * always for the job from its page, since nobody was here to answer it.
   */
  constructor(private readonly onHeld?: (held: HeldAction) => void) {}

  async request(ask: ApprovalAsk): Promise<ApprovalOutcome> {
    log.info("scheduled run refused a gated tool", { agent_id: ask.agentId, tool: ask.tool });
    if (ask.jobGrant) this.onHeld?.({ keys: ask.jobGrant.keys, label: ask.jobGrant.label, reason: ask.reason });
    return {
      // Nobody said no: there was nobody to ask. A denial reached the model as "A human denied this call", which the live
      // box showed on a scheduled run's refused send_message — the small lie that has a model tell a person they refused.
      status: "unavailable",
      reason:
        `"${ask.tool}" needs approval and this is a scheduled run, so there is nobody to ask. ` +
        `Reason: ${ask.reason}. Do what you can without it and say what you could not do.`,
    };
  }

  /** Nothing is ever parked, so there is never anything pending to list or expire. */
  canAsk(): boolean {
    return false;
  }

  pending(): ApprovalRequest[] {
    return [];
  }

  expireAll(): number {
    return 0;
  }
}
