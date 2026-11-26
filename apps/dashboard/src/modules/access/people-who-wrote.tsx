/**
 * Who wrote to an agent that is open to everyone: the Open agents page's first tab, drawn as the Access page's lists
 * are, a row a conversation.
 *
 * Their conversations are nobody's own, so they are kept out of the list of chats, where they would bury the household's
 * own, and listed here: who wrote, on which app, what they first asked and when. A row opens the conversation as any
 * is read, and Block keeps that sender out from their next message, which is the answer to somebody who should not be
 * writing. An admin's to read, as every other person's conversations are.
 *
 * Anyone may write, so they can be many. The page's filter, in the row that stays at the top of the window, narrows the
 * rows on screen as it does on the Access page; where more wrote than were sent, the daemon is asked to search all of
 * them on a press (`MoreListed`), never as it is typed, by name, number or what they first asked.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useContext, useState } from "react";
import { Ban, MessageSquare } from "lucide-react";
import type { AgentSummary, PublicConversation } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { ago } from "@/commons/lib/format";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { useConfirm } from "@/commons/components/ui/confirm";
import { ListCard } from "@/commons/components/ui/ListCard";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { MoreListed, type SearchState } from "./approved.tab";
import { BUTTON, NoMatch, SenderLine, SenderQuery } from "./sender-line";

/** Who a row is from, as far as anybody knows: the name their app gave, or the address it knows them by. */
export function writerName(conversation: Pick<PublicConversation, "sender">): string {
  return conversation.sender ? (conversation.sender.name ?? conversation.sender.id) : "Somebody";
}

/**
 * Its conversations' first page: what the Wrote tab's count and its list both read, one request on one timer, so the
 * count in the tab never says another number than the list under it.
 */
export function wroteFirst(agentId: string, found: string) {
  return {
    queryKey: ["agent-public", agentId, found, "first"],
    // What it answers says which search it is, so the rows of another, kept while this one is asked, are never its answer.
    queryFn: async () => ({ found, page: await api.agentPublic(agentId, undefined, found || undefined) }),
    refetchInterval: 30_000,
  };
}

/** A row's tag: a group's conversation, or one whose sender is kept out. */
const tag = (text: string) => <span className="badge badge-sm badge-ghost font-semibold font-mono">{text}</span>;

export function WroteTab({ agent, found, onFind }: { agent: AgentSummary; found: string; onFind: (words: string) => void }) {
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();
  const shared = useContext(SenderQuery);
  const query = shared?.query ?? "";
  /** The pages read so far: each "Show more" reads the next under the ones on screen; a new search starts again. */
  const [read, setRead] = useState({ found, cursors: [0] });
  const cursors = read.found === found ? read.cursors : [0];
  // The rows on screen stay while the next page is asked, rather than the list emptying under the person who asked.
  const first = useQuery({ ...wroteFirst(agent.id, found), placeholderData: keepPreviousData });
  const later = cursors.slice(1);
  const more = useQuery({
    queryKey: ["agent-public", agent.id, found, "later", later],
    queryFn: async () => ({ found, pages: await Promise.all(later.map((before) => api.agentPublic(agent.id, before, found || undefined))) }),
    enabled: later.length > 0,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const block = useMutation({
    mutationFn: async (conversation: PublicConversation) => {
      const sender = conversation.sender!;
      const sure = await ask({
        title: `Block ${writerName(conversation)}?`,
        body: "Their messages are ignored from now on, with no reply, on this connection. What they already wrote stays here. You can unblock them under Blocked.",
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

  // A search on its way, or not come back: said, with nothing listed as its answer.
  const searching: SearchState = first.data && first.data.found !== found ? "looking" : !first.data && first.error && found ? "failed" : !first.data && found ? "looking" : "done";
  const laterPages = later.length > 0 && more.data?.found === found ? more.data.pages : [];
  const answered = searching === "done" && first.data ? [first.data.page, ...laterPages] : undefined;
  const conversations = (answered ?? []).flatMap((page) => page.conversations);
  const total = answered?.[0]?.total ?? 0;
  const next = answered?.at(-1)?.nextBefore;
  const visible = useTextFilter(conversations, query, (conversation) => [writerName(conversation), conversation.sender?.id, conversation.chatId, conversation.title]);

  return (
    <ListCard title={`Wrote${searching === "done" ? ` (${total.toLocaleString("en-US")})` : ""}`} description="Its conversations with people you do not know. They are kept out of your own list of chats, and go when conversations of their age do.">
      {dialog}
      <ErrorNote error={first.error ?? more.error ?? block.error} />
      {found || (answered && total > conversations.length) ? (
        <MoreListed
          searching={searching}
          shown={conversations.length}
          total={total}
          found={found}
          typed={query}
          onFind={onFind}
          typeWhat="a name, a number or what they asked"
          foundSaid={(words) => `Everyone who wrote whose name, number or first message holds “${words}”.`}
        />
      ) : null}
      {!answered ? null : conversations.length === 0 ? (
        <EmptyState pose="security" title={found ? "Nobody who wrote matches that" : "Nobody has written to it yet"} />
      ) : visible.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        <ul className="divide-y divide-base-content/[0.08] -my-2" data-public-conversations>
          {visible.map((conversation) => (
            <SenderLine
              key={conversation.sessionId}
              rowId={conversation.sessionId}
              sender={{ gatewayId: conversation.gatewayId, senderId: conversation.sender?.id ?? conversation.chatId, senderName: writerName(conversation) }}
              badge={
                <>
                  {conversation.kind === "group" ? tag("in a group") : null}
                  {conversation.sender?.blocked ? tag("Blocked") : null}
                </>
              }
              when={`${conversation.title ? `“${conversation.title}”` : "No message kept"} · ${ago(conversation.updatedAt)}`}
              actions={
                <>
                  <Link to="/chat/$sessionId" params={{ sessionId: conversation.sessionId }} className={BUTTON.plain}>
                    <MessageSquare size={12} aria-hidden="true" /> Read
                  </Link>
                  {conversation.sender && !conversation.sender.blocked ? (
                    <button type="button" className={BUTTON.danger} disabled={block.isPending} onClick={() => block.mutate(conversation)}>
                      <Ban size={12} aria-hidden="true" /> Block
                    </button>
                  ) : null}
                </>
              }
            />
          ))}
        </ul>
      )}
      {next !== undefined && conversations.length > 0 ? (
        <div className="flex justify-center pt-3">
          <button type="button" className="btn btn-ghost btn-sm gap-1.5 rounded-full" disabled={more.isFetching} onClick={() => setRead({ found, cursors: [...cursors, next] })}>
            Show more ({(total - conversations.length).toLocaleString("en-US")} more)
          </button>
        </div>
      ) : null}
    </ListCard>
  );
}
