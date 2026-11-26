/**
 * The people who wrote to an agent that is open to everyone, on the Open agents page.
 *
 * Their conversations are nobody's own, so they are kept out of the list of chats, where they would bury the household's
 * own, and listed here: who wrote, on which app, what they first asked and when. A row opens the conversation as any
 * is read, and Block keeps that sender out from their next message, which is the answer to somebody who should not be
 * writing. An admin's to read, as every other person's conversations are. Nothing is drawn for an agent that is not
 * open.
 *
 * Anyone may write, so they can be many: the rows scroll inside the card, the rest of the page staying where it is, and
 * a person is looked for by name, number or what they first asked. Asked of the daemon on a button, never as it is
 * typed, and over every conversation it keeps, not only the pages on screen.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Ban, X } from "lucide-react";
import type { AgentSummary, PublicConversation } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { ago } from "@/commons/lib/format";
import { isAdmin, useMe } from "@/commons/lib/session";
import { PlatformTag } from "@/commons/components/chat/PlatformBadge";
import { useConfirm } from "@/commons/components/ui/confirm";
import { SearchForm } from "@/commons/components/ui/SearchForm";
import { Card, ErrorNote } from "@/commons/components/ui/ui";

/** Who a row is from, as far as anybody knows: the name their app gave, or the id it knows them by. */
export function whoWrote(conversation: Pick<PublicConversation, "sender" | "kind">): string {
  const who = conversation.sender ? (conversation.sender.name ?? conversation.sender.id) : "Somebody";
  return conversation.kind === "group" ? `${who}, in a group` : who;
}

export function PeopleWhoWrote({ agent }: { agent: AgentSummary }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const open = agent.access === "open";
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();
  /** The pages read so far: each "Show more" reads the next under the ones on screen. */
  const [cursors, setCursors] = useState<number[]>([0]);
  /** What is typed, and what was last searched for: the list is the search's until it is cleared. */
  const [typed, setTyped] = useState("");
  const [find, setFind] = useState("");
  const pages = useQuery({
    queryKey: ["agent-public", agent.id, find, cursors],
    queryFn: () => Promise.all(cursors.map((before) => api.agentPublic(agent.id, before || undefined, find || undefined))),
    enabled: open && admin,
    refetchInterval: 30_000,
    // The rows on screen stay while a search is asked, rather than the card emptying under the person who asked.
    placeholderData: keepPreviousData,
  });
  /** A new search starts at its first page; an empty one is the whole list again. */
  const search = (words: string) => {
    setFind(words);
    setCursors([0]);
  };
  const block = useMutation({
    mutationFn: async (conversation: PublicConversation) => {
      const sender = conversation.sender!;
      const sure = await ask({
        title: `Block ${sender.name ?? sender.id}?`,
        body: "Their messages are ignored from now on, with no reply, on this connection. What they already wrote stays here. You can unblock them below, under Blocked.",
        confirmLabel: "Block",
      });
      if (sure) await api.answerSender("block", conversation.gatewayId, sender.id);
      return sure;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agent-public", agent.id] });
      await queryClient.invalidateQueries({ queryKey: ["access"] });
    },
  });

  if (!open || !admin) return null;
  const conversations = (pages.data ?? []).flatMap((page) => page.conversations);
  const total = pages.data?.[0]?.total ?? 0;
  const next = pages.data?.at(-1)?.nextBefore;
  const searching = find !== "";

  return (
    <Card title="People who wrote" description="This agent's conversations with people you do not know. They are kept out of your own list of chats, and go when conversations of their age do.">
      {dialog}
      <ErrorNote error={pages.error ?? block.error} />
      {conversations.length > 0 || searching ? (
        <div className="mb-3">
          <SearchForm
            value={typed}
            onChange={setTyped}
            onSearch={search}
            allowEmpty
            placeholder="Name or number"
            label="Look for a person who wrote"
            busy={pages.isFetching && pages.isPlaceholderData}
            after={
              searching ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm rounded-xl gap-1"
                  onClick={() => {
                    setTyped("");
                    search("");
                  }}
                >
                  <X size={14} aria-hidden="true" /> Clear
                </button>
              ) : null
            }
          />
        </div>
      ) : null}
      {pages.data && !pages.isPlaceholderData && conversations.length === 0 ? (
        <p className="text-base-content/65 text-sm [overflow-wrap:anywhere]">{searching ? `Nobody matches “${find}”.` : "Nobody has written to it yet."}</p>
      ) : null}
      {/* Held to a height and scrolled inside the card: a busy agent's public would otherwise push the rest of the page
          a screen down for every few dozen people. */}
      {conversations.length > 0 ? (
        <div className="-my-2 max-h-[26rem] overflow-y-auto overscroll-contain" data-public-scroll>
          <ul className="divide-y divide-base-content/[0.08]" data-public-conversations>
            {conversations.map((conversation) => (
              <li key={conversation.sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5" data-public-row={conversation.sessionId}>
                <div className="min-w-0 flex-[1_1_14rem]">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{whoWrote(conversation)}</span>
                    <PlatformTag platform={conversation.gatewayId} size="row" />
                    {conversation.sender?.blocked ? <span className="badge badge-xs badge-ghost font-semibold font-mono">Blocked</span> : null}
                  </p>
                  <p className="text-base-content/65 mt-0.5 text-xs [overflow-wrap:anywhere]">
                    {conversation.title ? `“${conversation.title}”` : "No message kept"} · {ago(conversation.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Link to="/chat/$sessionId" params={{ sessionId: conversation.sessionId }} className="btn btn-xs">
                    Read
                  </Link>
                  {conversation.sender && !conversation.sender.blocked ? (
                    <button type="button" className="btn btn-xs btn-ghost" disabled={block.isPending} onClick={() => block.mutate(conversation)}>
                      <Ban size={12} aria-hidden="true" /> Block
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {next !== undefined ? (
            <button type="button" className="btn btn-sm btn-ghost my-3" disabled={pages.isFetching} onClick={() => setCursors([...cursors, next])}>
              Show more ({total - conversations.length} more)
            </button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
