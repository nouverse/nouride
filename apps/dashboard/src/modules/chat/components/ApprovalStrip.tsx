/**
 * Tool calls waiting for a human, at the bottom of the transcript.
 *
 * Its own component for the same reason the empty state is: it belongs to the conversation but reads
 * nothing from it, and inline it was twelve lines of nesting between the job strip and the closing
 * tags of the scroll container.
 *
 * Renders nothing when there is nothing pending — the wrapper's padding and animation would
 * otherwise leave a gap under every transcript.
 */

import { ApprovalCard } from "@/commons/components/ui/ApprovalCard";
import type { ApprovalRequest, ApprovalDecision } from "@/commons/lib/api";

export interface ApprovalStripProps {
  requests: ApprovalRequest[];
  /** True while an answer is in flight, so the buttons cannot be pressed twice. */
  answering: boolean;
  onAnswer: (request: ApprovalRequest, decision: ApprovalDecision) => void;
}

export function ApprovalStrip({ requests, answering, onAnswer }: ApprovalStripProps) {
  if (requests.length === 0) return null;
  return (
    <div className="max-w-3xl mx-auto w-full space-y-3 py-2">
      {requests.map((request) => (
        <ApprovalCard
          key={request.id}
          request={request}
          pending={answering}
          onAnswer={onAnswer}
        />
      ))}
    </div>
  );
}
