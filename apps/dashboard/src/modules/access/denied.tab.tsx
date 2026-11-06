/**
 * Who was turned away for now — "no, this time".
 *
 * Each is ignored until their day is up, then their next message is a new request with a new code.
 * Reset ends the wait at once, for a "no" given to the wrong code; Block makes it last.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, RotateCcw, ShieldOff } from "lucide-react";
import { api, type SenderRecord } from "@/commons/lib/api";
import type { SenderAnswer } from "@/commons/lib/api.access";
import { canWrite, useMe } from "@/commons/lib/session";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { ago, inTime } from "@/commons/lib/format";
import { BUTTON, NoMatch, SenderLine, byWhom, useSenderFilter } from "./sender-line";

export function DeniedTab({ senders, agentOf }: { senders: SenderRecord[]; agentOf: (gatewayId: string) => string | undefined }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const answer = useMutation({
    mutationFn: ({ action, sender }: { action: SenderAnswer; sender: SenderRecord }) =>
      api.answerSender(action, sender.gatewayId, sender.senderId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["access"] });
      await queryClient.invalidateQueries({ queryKey: ["access-history"] });
    },
  });
  const operator = canWrite(me.data ?? null);
  const { visible, query, search } = useSenderFilter(senders, agentOf);

  return (
    <ScrollCard
      title={`Denied (${senders.length})`}
      description="Turned away for now. Each may ask again once their wait is over, or at once after a reset."
      {...search}
    >
      <ErrorNote error={answer.error} />
      {senders.length === 0 ? (
        <EmptyState icon={ShieldOff} title="Nobody is waiting out a denial" />
      ) : visible.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        <ul className="divide-y divide-base-content/[0.08] -my-2">
          {visible.map((sender) => (
            <SenderLine
              key={`${sender.gatewayId}:${sender.senderId}`}
              sender={sender}
              agent={agentOf(sender.gatewayId)}
              when={
                <>
                  Denied {sender.resolvedAt ? ago(sender.resolvedAt) : ""}
                  {byWhom(sender.resolvedBy)}
                  {sender.expiresAt ? <> · may ask again {inTime(sender.expiresAt)}</> : null}
                </>
              }
              actions={
                <>
                  <button
                    type="button"
                    className={BUTTON.plain}
                    title="End the wait: their next message is a new request with a new code."
                    disabled={!operator || answer.isPending}
                    onClick={() => answer.mutate({ action: "reset", sender })}
                  >
                    <RotateCcw size={12} /> Reset
                  </button>
                  <button
                    type="button"
                    className={BUTTON.danger}
                    title="Keep them out until you unblock them, instead of for a day."
                    disabled={!operator || answer.isPending}
                    onClick={() => answer.mutate({ action: "block", sender })}
                  >
                    <Ban size={12} /> Block
                  </button>
                </>
              }
            />
          ))}
        </ul>
      )}
    </ScrollCard>
  );
}
