/**
 * Who is waiting to be let in, across every agent, and the answers to one.
 *
 * Every request on the daemon in one list, because a code expires in fifteen minutes and an agent's
 * own tab sat three clicks behind a name you had to guess. Approving is an admin's, as the daemon
 * enforces: it hands somebody every agent, and saying who they are can hand them somebody's memory.
 *
 * Two ways to say no, and they are different answers:
 * - **Deny** — no, this time. They are ignored for a day, then may ask again; Reset on Denied ends it sooner.
 * - **Block** — no, until somebody unblocks them. For the person who should not be asking at all.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Ban, Check, UserCheck, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { PersonTarget, SenderAnswer, SenderRecord } from "@nouride/wire";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useToast } from "@/commons/components/ui/toast";
import { useConfirm } from "@/commons/components/ui/confirm";
import { PersonPicker } from "@/commons/components/people/PersonPicker";
import { ago, inTime } from "@/commons/lib/format";
import { BUTTON, NoMatch, SenderLine, useSenderFilter } from "./sender-line";

export function PendingTab({
  senders,
  agentOf,
  pairingOn,
}: {
  senders: SenderRecord[];
  agentOf: (gatewayId: string) => string | undefined;
  pairingOn: boolean;
}) {
  const me = useMe();
  const self = useQuery({ queryKey: ["people-me"], queryFn: api.peopleMe });
  const queryClient = useQueryClient();
  const toast = useToast();
  const [choosing, setChoosing] = useState<string | null>(null);
  const refresh = async () => {
    setChoosing(null);
    await queryClient.invalidateQueries({ queryKey: ["access"] });
    await queryClient.invalidateQueries({ queryKey: ["access-history"] });
    await queryClient.invalidateQueries({ queryKey: ["people"] });
  };
  /**
   * Approved as somebody, when it is said who: the approver themselves, a person already known, or a
   * new one. That adds their id on this platform to the person, so every agent knows them by name.
   */
  const approve = useMutation({
    mutationFn: ({ code, who }: { code: string; who?: PersonTarget | "me" }) =>
      api.approveSender(
        code,
        who === "me" ? { as: "me" } : who && "person" in who ? { as: `person:${who.person}` } : who ? { as: "new", name: who.name } : undefined,
      ),
    onSuccess: async (result) => {
      // In the page's words (0.8.23): the server's holds why the link was refused, in its own.
      if (result.warning) toast.warning("Approved", result.plain ?? result.warning);
      await refresh();
    },
  });
  const answer = useMutation({
    mutationFn: ({ action, sender }: { action: SenderAnswer; sender: SenderRecord }) =>
      api.answerSender(action, sender.gatewayId, sender.senderId),
    onSuccess: refresh,
  });

  const admin = isAdmin(me.data ?? null);
  const operator = canWrite(me.data ?? null);
  const selfLinked = Boolean(self.data?.person);
  const busy = approve.isPending || answer.isPending;
  const { visible, query, search } = useSenderFilter(senders, agentOf);
  const { ask, dialog } = useConfirm();

  return (
    <>
    {dialog}
    <ScrollCard
      title={`Waiting to be approved (${senders.length})`}
      description={
        senders.length > 0
          ? "Someone new messaged an agent. Codes expire 15 minutes after they were given."
          : pairingOn
            ? "Nobody is waiting. A stranger who messages a bot gets a code and appears here."
            : "New senders are being turned away without a code, so nobody new will appear here."
      }
      className={senders.length > 0 ? "border-warning/40 bg-warning/5" : ""}
      {...search}
    >
      <ErrorNote error={approve.error ?? answer.error} />
      {senders.length === 0 ? (
        <EmptyState pose="security" title="No pending requests" />
      ) : visible.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        <ul className="divide-y divide-base-content/[0.08] -my-2">
          {visible.map((sender) => {
            const key = `${sender.gatewayId}:${sender.senderId}`;
            return (
              <SenderLine
                key={key}
                sender={sender}
                agent={agentOf(sender.gatewayId)}
                badge={
                  sender.code ? (
                    <span className="font-mono text-xs font-bold px-2 py-0.5 rounded-md bg-warning/20 text-warning border border-warning/30">
                      {sender.code}
                    </span>
                  ) : null
                }
                when={`Asked ${ago(sender.requestedAt)}${sender.expiresAt ? ` · the code expires ${inTime(sender.expiresAt)}` : ""}`}
                actions={
                  <>
                    {selfLinked ? (
                      <button
                        type="button"
                        className={BUTTON.primary}
                        title={`Approve, and record that this is you (${self.data?.person?.name})`}
                        disabled={!admin || !sender.code || busy}
                        onClick={() => sender.code && approve.mutate({ code: sender.code, who: "me" })}
                      >
                        <UserCheck size={12} />
                        It's me
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={BUTTON.plain}
                      disabled={!admin || !sender.code || busy}
                      onClick={() => setChoosing(choosing === key ? null : key)}
                    >
                      Approve as…
                    </button>
                    <button
                      type="button"
                      className={BUTTON.plain}
                      title="Approve without saying who they are"
                      disabled={!admin || !sender.code || busy}
                      onClick={() => sender.code && approve.mutate({ code: sender.code })}
                    >
                      <Check size={12} />
                      Approve
                    </button>
                    <button
                      type="button"
                      className={BUTTON.danger}
                      title="No, this time: ignored for a day, then they may ask again. Reset on the Denied tab ends the wait."
                      disabled={!operator || busy}
                      onClick={() => answer.mutate({ action: "deny", sender })}
                    >
                      <X size={12} />
                      Deny
                    </button>
                    <button
                      type="button"
                      className={BUTTON.danger}
                      title="Keep them out until you unblock them. Nothing is sent to them."
                      disabled={!operator || busy}
                      onClick={async () => {
                        const yes = await ask({
                          title: `Block ${sender.senderName || sender.senderId}?`,
                          body: "They are ignored until you unblock them: they cannot ask again, and nothing is sent to them. Deny instead keeps them out for a day.",
                          confirmLabel: "Block",
                        });
                        if (yes) answer.mutate({ action: "block", sender });
                      }}
                    >
                      <Ban size={12} />
                      Block
                    </button>
                  </>
                }
              >
                {choosing === key && sender.code ? (
                  <PersonPicker
                    label="Approve"
                    busy={approve.isPending}
                    suggestedName={sender.senderName ?? ""}
                    onPick={(who) => approve.mutate({ code: sender.code!, who })}
                  />
                ) : null}
              </SenderLine>
            );
          })}
        </ul>
      )}
    </ScrollCard>
    </>
  );
}
