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
import { Ban, Search, ShieldCheck, Users, UserX } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { GatewayInstance, PersonRecord, SenderAnswer, SenderRecord } from "@nouride/wire";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { ListCard } from "@/commons/components/ui/ListCard";
import { useConfirm } from "@/commons/components/ui/confirm";
import { ago } from "@/commons/lib/format";
import { ImportList } from "./import-list";
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

/**
 * More in a list than the page was sent, or a search among all of them: said, with the way to the rest. A list let in
 * from a file may be thousands, and an open agent's people as many; the page holds the newest of them. `foundSaid` is
 * what a search found, and `typeWhat` what to type to find one, in the list's own words. A search still on its way, or
 * one that did not come back, is said as that, never with the list from before as its answer; the way back to the
 * newest stays either way.
 */
export function MoreListed({
  shown,
  total,
  found,
  typed,
  onFind,
  foundSaid,
  typeWhat = "an id or a name",
  searching = "done",
}: {
  shown: number;
  total: number;
  found: string;
  typed: string;
  onFind: (text: string) => void;
  foundSaid: (found: string) => string;
  typeWhat?: string;
  /** Where a search of everyone is: on its way, back, or not come back. */
  searching?: SearchState;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-base-content/[0.04] px-3 py-2 text-xs text-base-content/75" data-approved-more>
      <span className="flex items-center gap-2">
        {found && searching === "looking" ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
        {!found
          ? `The newest ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} are listed. To find another, type ${typeWhat} in the filter, then search everyone.`
          : searching === "looking"
            ? `Looking among everyone for “${found}”…`
            : searching === "failed"
              ? `The search for “${found}” did not come back. Show the newest, or search again.`
              : foundSaid(found)}
      </span>
      {found ? (
        <button type="button" className={BUTTON.plain} onClick={() => onFind("")}>
          Show the newest
        </button>
      ) : (
        <button type="button" className={BUTTON.primary} disabled={!typed.trim()} onClick={() => onFind(typed.trim())}>
          <Search size={12} /> Search everyone
        </button>
      )}
    </div>
  );
}

/** Where a search of everyone is: on its way, back, or not come back. */
export type SearchState = "looking" | "done" | "failed";

export function ApprovedTab({
  senders,
  allowlist,
  blocked,
  agentOf,
  total = senders.length,
  found = "",
  onFind,
  gateways,
  letInOn,
  searching = "done",
}: {
  senders: SenderRecord[];
  /** How many are approved in all: more than `senders` once a list was let in from a file. */
  total?: number;
  /** What everyone approved was last searched for, and the way to search again or to stop. */
  found?: string;
  onFind?: (text: string) => void;
  /** `[security.access] allowlist`, as the daemon reports it. */
  allowlist: string[];
  /** Blocked senders: a block beats the config's list, and its chip says so. */
  blocked: SenderRecord[];
  agentOf: (gatewayId: string) => string | undefined;
  /** The connections a list can be let in on: "Let in a list" is offered where the page hands them over. */
  gateways?: readonly GatewayInstance[];
  /**
   * The open agent whose connections these are, on its Open agents page: said as those let in by name before it was
   * opened, which is what they are to it, rather than as the install's approved.
   */
  letInOn?: string;
  /** A search of everyone on its way, or not come back: nothing listed is its answer then. */
  searching?: SearchState;
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
      // An open agent's people who wrote say who is blocked: theirs is refreshed with it, not half a minute later.
      await queryClient.invalidateQueries({ queryKey: ["agent-public"] });
    },
  });
  const operator = canWrite(me.data ?? null);
  const known = people.data?.people ?? [];
  const personOf = (sender: SenderRecord) => personFor(sender.gatewayId, sender.senderId, known);
  const name = (sender: SenderRecord) => sender.senderName || personOf(sender) || sender.senderId;
  // More let in than were sent, with none of them here: the box is still drawn, or the search of everyone has no words.
  const { visible, query, search } = useSenderFilter(senders, agentOf, (sender) => [personOf(sender)], Boolean(onFind) && total > senders.length);
  const { ask, dialog } = useConfirm();

  return (
    <div className="space-y-6">
      {dialog}
      <ListCard
        title={`${letInOn ? "Let in by name" : "Approved"}${found && searching !== "done" ? "" : ` (${total.toLocaleString("en-US")})`}`}
        // Another card stands under this one: a long list is cut short, and opens in full with one press.
        maxHeight="max-h-[32rem]"
        description={
          letInOn
            ? `Let in on ${letInOn}'s connections by a code or a list, before it was opened. They are not strangers to it: they are answered as people you let in, and keep that when it is closed. Revoke or block one here.`
            : "Answered by the agent whose connection they wrote to. Each account says which person in People it is."
        }
        // An admin's, as letting one person in by a code is: a list hands every agent to everybody on it.
        actions={gateways && isAdmin(me.data ?? null) ? <ImportList gateways={gateways} /> : undefined}
        {...search}
      >
        <ErrorNote error={answer.error} />
        {onFind && (found || total > senders.length) ? (
          <MoreListed
            shown={senders.length}
            total={total}
            found={found}
            typed={query}
            onFind={onFind}
            searching={searching}
            foundSaid={(words) => `Everyone ${letInOn ? "let in" : "approved"} whose id or name holds “${words}”.`}
          />
        ) : null}
        {found && searching !== "done" ? null : senders.length === 0 && (found || total === 0) ? (
          <EmptyState pose="security" title={found ? `Nobody ${letInOn ? "let in" : "approved"} matches that` : letInOn ? "Nobody was let in by name" : "Nobody approved yet"} />
        ) : senders.length === 0 ? null : visible.length === 0 ? (
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
      </ListCard>

      {/* Only when the config names anybody: an install that never wrote an id needs no card saying so. */}
      {allowlist.length > 0 ? <AlwaysAllowed allowlist={allowlist} blocked={blocked} known={known} /> : null}
    </div>
  );
}

/**
 * The ids the server's settings let in without asking, each on the connection named: its own card under the list of
 * the approved, since they are set there and not here. A block on the page still wins over one, and its chip says so.
 */
function AlwaysAllowed({ allowlist, blocked, known }: { allowlist: string[]; blocked: SenderRecord[]; known: readonly PersonRecord[] }) {
  return (
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
  );
}
