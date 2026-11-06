import type { ApprovalRequest } from "@nouride/shared";

/**
 * Putting pending approvals to the operator exactly once.
 *
 * Reported from real use, and it made the CLI unusable: the same request printed over and over, and
 * typing `y` produced another copy. Two causes, both structural rather than incidental —
 *
 * - The poll runs on an interval while a turn is in flight, and the daemon keeps a request **pending
 *   until it is answered**, which includes every second spent waiting for the human. So each tick saw it
 *   again and printed it again.
 * - A pass blocks for as long as the operator takes to read. The interval kept firing, so several passes
 *   overlapped on one readline, each with its own prompt — and remembering what had been asked was not
 *   enough on its own, because an overlapping pass reads that memory before the first pass has finished
 *   asking.
 *
 * Extracted from the chat loop so both properties are testable against the code that actually runs. The
 * first version of this fix was tested against a re-implementation of the same shape, which would have
 * passed just as happily with the real loop still broken.
 */

/**
 * A pending request, as the daemon sends it.
 *
 * `ApprovalRequest` rather than the `{ id: string }` this used to be. The poller itself only needs
 * the id — that is all its dedupe compares — but the `ask` callback prints the tool, the reason and a
 * preview of the parameters, and under `Promise<any>` on the client that read as fine. Narrowing a
 * type to what one consumer touches makes every other consumer's field invisible.
 */
export type PendingApproval = ApprovalRequest;

export interface ApprovalPoller {
  /** Safe to call on an interval. Overlapping calls return immediately. */
  poll(): Promise<void>;
}

export function createApprovalPoller(deps: {
  /** Null when the request failed — a poll that cannot reach the daemon does nothing, quietly. */
  fetchPending(): Promise<PendingApproval[] | null>;
  /** Put one request to the operator. Resolves when it has been dealt with. */
  ask(request: PendingApproval): Promise<void>;
}): ApprovalPoller {
  /**
   * Never cleared. An id identifies one request, so a re-ask after an answer is the bug — not a case to
   * support. Bounded by the number of approvals in one CLI session, which is bounded by the operator's
   * patience.
   */
  const asked = new Set<string>();
  let inFlight = false;

  return {
    async poll(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const pending = await deps.fetchPending();
        for (const request of pending ?? []) {
          if (asked.has(request.id)) continue;
          // Marked before asking, not after: `ask` blocks on a human, and the next tick must already
          // consider this one taken.
          asked.add(request.id);
          await deps.ask(request);
        }
      } finally {
        inFlight = false;
      }
    },
  };
}
