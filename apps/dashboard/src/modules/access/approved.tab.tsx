/**
 * Who is in: everyone approved — by a code, or let in ahead with `nouride access allow` — and, when the
 * config names any, the ids it lets in without asking.
 *
 * Revoke and Block are different answers to "they should not be here". Revoke takes the approval back
 * and they may ask again — somebody who left the team. Block keeps them out until an unblock, and
 * beats the config's list as well.
 *
 * Every account says which person in People it is, because one person is usually several accounts —
 * a Telegram, a WhatsApp, a Discord on six bots — and a list of platform names cannot show that. An
 * account nobody is linked to says so, which is the one to look at.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, ShieldCheck, Users, UserX } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { PersonRecord, SenderAnswer, SenderRecord } from "@nouride/wire";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useConfirm } from "@/commons/components/ui/confirm";
import { ago } from "@/commons/lib/format";
import { BUTTON, NoMatch, SenderLine, byWhom, useSenderFilter } from "./sender-line";

/**
 * Who an account is, by People — decided as the daemon decides it, so a name here is a name the agents
 * know them by: a person's id is the platform and the account, compared exactly, on whichever connection
 * the account wrote to. A bare id names nobody, since a Telegram id and a Discord snowflake are both just
 * digits. Access stays per connection; who somebody *is* does not.
 */
export function personFor(gatewayId: string, senderId: string, people: readonly PersonRecord[]): string | undefined {
  const account = `${gatewayId.split(":")[0] ?? gatewayId}:${senderId}`;
  return people.find((person) => (person.ids ?? []).includes(account))?.name;
}

/** A config id's person: `gateway:sender` is one account; a bare id is on every platform, so nobody's. */
const configPerson = (entry: string, people: readonly PersonRecord[]) => {
  const at = entry.lastIndexOf(":");
  return entry.indexOf(":") < at ? personFor(entry.slice(0, at), entry.slice(at + 1), people) : undefined;
};

/** Which person an account is, beside its name; a link to People either way, where it is changed. */
function PersonTag({ name }: { name: string | undefined }) {
  return name ? (
    <Link
      to="/people"
      className="inline-flex items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary/20"
      title={`This account is ${name}'s, by People`}
    >
      <Users size={11} /> {name}
    </Link>
  ) : (
    <Link
      to="/people"
      className="inline-flex items-center gap-1 rounded-md border border-base-content/10 px-1.5 py-0.5 text-[11px] font-medium text-base-content/65 hover:text-base-content/70"
      title="Nobody in People has this id. Link it there to know who it is"
    >
      <Users size={11} /> not in People
    </Link>
  );
}

/** Does a config id name this sender — the bare id, or the id on this connection? As the daemon reads it. */
const covers = (entry: string, sender: SenderRecord) => entry === sender.senderId || entry === `${sender.gatewayId}:${sender.senderId}`;

export function ApprovedTab({
  senders,
  allowlist,
  blocked,
  agentOf,
}: {
  senders: SenderRecord[];
  /** `[security.access] allowlist`, as the daemon reports it. */
  allowlist: string[];
  /** Blocked senders: a block beats the config's list, and its chip says so. */
  blocked: SenderRecord[];
  agentOf: (gatewayId: string) => string | undefined;
}) {
  const me = useMe();
  const people = useQuery({ queryKey: ["people"], queryFn: api.people });
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
  const known = people.data?.people ?? [];
  const personOf = (sender: SenderRecord) => personFor(sender.gatewayId, sender.senderId, known);
  const name = (sender: SenderRecord) => sender.senderName || personOf(sender) || sender.senderId;
  const { visible, query, search } = useSenderFilter(senders, agentOf, (sender) => [personOf(sender)]);
  const { ask, dialog } = useConfirm();

  return (
    <div className="space-y-6">
      {dialog}
      <ScrollCard
        title={`Approved (${senders.length})`}
        description="Answered by the agent whose connection they wrote to. Each account says which person in People it is."
        {...search}
      >
        <ErrorNote error={answer.error} />
        {senders.length === 0 ? (
          <EmptyState pose="security" title="Nobody approved yet" />
        ) : visible.length === 0 ? (
          <NoMatch query={query} />
        ) : (
          <ul className="divide-y divide-base-content/[0.08] -my-2">
            {visible.map((sender) => (
              <SenderLine
                key={`${sender.gatewayId}:${sender.senderId}`}
                sender={sender}
                agent={agentOf(sender.gatewayId)}
                badge={<PersonTag name={personOf(sender)} />}
                when={sender.resolvedAt ? `Approved ${ago(sender.resolvedAt)}${byWhom(sender.resolvedBy)}` : null}
                actions={
                  <>
                    <button
                      type="button"
                      className={BUTTON.danger}
                      title="Take the approval back. They may ask again."
                      disabled={!operator || answer.isPending}
                      onClick={async () => {
                        const yes = await ask({
                          title: `Revoke access for ${name(sender)}?`,
                          body: "The agents stop answering them. They may ask again, and a new pairing code needs approving.",
                          confirmLabel: "Revoke",
                        });
                        if (yes) answer.mutate({ action: "revoke", sender });
                      }}
                    >
                      <UserX size={12} /> Revoke
                    </button>
                    <button
                      type="button"
                      className={BUTTON.danger}
                      title="Keep them out until you unblock them."
                      disabled={!operator || answer.isPending}
                      onClick={async () => {
                        const yes = await ask({
                          title: `Block ${name(sender)}?`,
                          body: "They are ignored until you unblock them, and cannot ask again meanwhile. Nothing is sent to them.",
                          confirmLabel: "Block",
                        });
                        if (yes) answer.mutate({ action: "block", sender });
                      }}
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

      {/* Only when the config names anybody: an install that never wrote an id needs no card saying so. */}
      {allowlist.length > 0 ? (
        <Card
          title="Always allowed"
          description="These exact accounts are answered without a pairing code, each on the connection named, and nobody else is. They are set in the server's settings, not here, and a block on this page still wins over them."
        >
          {/* For whoever runs the server: where they are set, and how one becomes managed here (0.8.19, plain words). */}
          <Details className="mb-3">
            <p>
              Set in <code>config.toml</code> by exact id. To manage one here instead, run <code>nouride access allow</code> for it and
              take it out of the file.
            </p>
          </Details>
          <ul className="flex flex-wrap gap-2">
            {allowlist.map((id) => {
              const who = configPerson(id, known);
              const blockedOn = blocked.filter((sender) => covers(id, sender)).map((sender) => sender.gatewayId);
              return (
                <li
                  key={id}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-base-200 border border-base-content/10 text-xs font-mono font-medium text-base-content/85"
                  title={who ? `${who}, by People` : "Not linked to anybody in People"}
                >
                  <ShieldCheck size={13} className={blockedOn.length > 0 ? "text-error" : "text-success"} /> {id}
                  {who ? <span className="font-sans font-semibold text-base-content"> · {who}</span> : null}
                  {blockedOn.length > 0 ? <span className="badge badge-xs badge-error font-mono">blocked on {blockedOn.join(", ")}</span> : null}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
