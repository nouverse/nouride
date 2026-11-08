/**
 * Who is kept out until somebody says otherwise — "no, until unblocked".
 *
 * Ignored, with no reply, however often they write. Unblock lets them ask again; it lets nobody in.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Unlock } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { SenderRecord } from "@nouride/wire";
import { canWrite, useMe } from "@/commons/lib/session";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { ago } from "@/commons/lib/format";
import { BUTTON, NoMatch, SenderLine, byWhom, useSenderFilter } from "./sender-line";

export function BlockedTab({ senders, agentOf }: { senders: SenderRecord[]; agentOf: (gatewayId: string) => string | undefined }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const unblock = useMutation({
    mutationFn: (sender: SenderRecord) => api.answerSender("unblock", sender.gatewayId, sender.senderId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["access"] });
      await queryClient.invalidateQueries({ queryKey: ["access-history"] });
    },
  });
  const operator = canWrite(me.data ?? null);
  const { visible, query, search } = useSenderFilter(senders, agentOf);

  return (
    <ScrollCard title={`Blocked (${senders.length})`} description="Ignored, with no reply, until you unblock them." {...search}>
      <ErrorNote error={unblock.error} />
      {senders.length === 0 ? (
        <EmptyState icon={Ban} title="Nobody is blocked" />
      ) : visible.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        <ul className="divide-y divide-base-content/[0.08] -my-2">
          {visible.map((sender) => (
            <SenderLine
              key={`${sender.gatewayId}:${sender.senderId}`}
              sender={sender}
              agent={agentOf(sender.gatewayId)}
              when={sender.resolvedAt ? `Blocked ${ago(sender.resolvedAt)}${byWhom(sender.resolvedBy)}` : "Blocked"}
              actions={
                <button
                  type="button"
                  className={BUTTON.plain}
                  title="Let them ask again. Their next message is a new request; it lets nobody in."
                  disabled={!operator || unblock.isPending}
                  onClick={() => unblock.mutate(sender)}
                >
                  <Unlock size={12} /> Unblock
                </button>
              }
            />
          ))}
        </ul>
      )}
    </ScrollCard>
  );
}
