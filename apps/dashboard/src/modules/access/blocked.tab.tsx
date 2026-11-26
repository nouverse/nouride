/**
 * Who is kept out until somebody says otherwise — "no, until unblocked".
 *
 * Ignored, with no reply, however often they write. Unblock lets them ask again; it lets nobody in. On an agent open to
 * everyone, where nobody asks, it means they are answered again: the Open agents page says so (`whileOpen`).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Unlock } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { SenderRecord } from "@nouride/wire";
import { canWrite, useMe } from "@/commons/lib/session";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ListCard } from "@/commons/components/ui/ListCard";
import { ago } from "@/commons/lib/format";
import { BUTTON, NoMatch, SenderLine, byWhom, useSenderFilter } from "./sender-line";

export function BlockedTab({ senders, agentOf, whileOpen = false }: { senders: SenderRecord[]; agentOf: (gatewayId: string) => string | undefined; whileOpen?: boolean }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const unblock = useMutation({
    mutationFn: (sender: SenderRecord) => api.answerSender("unblock", sender.gatewayId, sender.senderId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["access"] });
      await queryClient.invalidateQueries({ queryKey: ["access-history"] });
      // An open agent's people who wrote say who is blocked: theirs is refreshed with it, not half a minute later.
      await queryClient.invalidateQueries({ queryKey: ["agent-public"] });
    },
  });
  const operator = canWrite(me.data ?? null);
  const { visible, query, search } = useSenderFilter(senders, agentOf);

  return (
    <ListCard title={`Blocked (${senders.length})`} description="Ignored, with no reply, until you unblock them." {...search}>
      <ErrorNote error={unblock.error} />
      {senders.length === 0 ? (
        <EmptyState pose="security" title="Nobody is blocked" />
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
                  title={whileOpen ? "Answer them again: their next message is answered, as anyone's is while this agent is open." : "Let them ask again. Their next message is a new request; it lets nobody in."}
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
    </ListCard>
  );
}
