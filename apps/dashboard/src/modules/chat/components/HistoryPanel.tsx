/**
 * One agent's History, from its chat's header: only that agent's conversations — the dashboard's, and its private chats
 * on Telegram, Discord or WhatsApp, each saying where it is from — newest first, under the day they belong to, and
 * searchable by what was first asked in them. Under its button on a laptop, a sheet from the foot of a phone.
 *
 * A private chat on a chat app opens read-only here: it is answered on its app.
 */

import { useState, type RefObject } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, Monitor, Plus } from "lucide-react";
import type { ChatListPayload, SessionSummary } from "@nouride/wire";
import { ConversationRow, ListHeading } from "@/commons/components/chat/ConversationRow";
import { PlatformTag } from "@/commons/components/chat/PlatformBadge";
import { PopoverSheet } from "@/commons/components/ui/PopoverSheet";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { useDebounced } from "@/commons/hooks/use-debounced";
import { api } from "@/commons/lib/api";
import { platformName } from "@/commons/lib/platform";
import { shortWhen } from "@/commons/lib/when";
import { groupByDate, ownConversations } from "../lib/history";

const PAGE = 50;
const LOCAL = "web:";

/** Where a conversation is from, on its row's second line. */
function from(session: SessionSummary): string {
  return session.gatewayId.startsWith(LOCAL) ? "On the dashboard" : `A private chat on ${platformName(session.gatewayId)}`;
}

export function HistoryPanel({
  open,
  onClose,
  anchor,
  agentId,
  agentName,
  current,
  list,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  agentId: string;
  agentName: string;
  /** The conversation on screen, marked in the list. */
  current: string | undefined;
  list: ChatListPayload | undefined;
}) {
  return (
    <PopoverSheet open={open} onClose={onClose} anchor={anchor} label={`${agentName}'s conversations`} width={420}>
      <HistoryBody agentId={agentId} agentName={agentName} current={current} list={list} onClose={onClose} />
    </PopoverSheet>
  );
}

function HistoryBody({ agentId, agentName, current, list, onClose }: { agentId: string; agentName: string; current: string | undefined; list: ChatListPayload | undefined; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const term = useDebounced(search, 250);
  const sessions = useInfiniteQuery({
    queryKey: ["sessions", "agent", agentId, term],
    queryFn: ({ pageParam }) => api.sessions({ agent: agentId, limit: PAGE, ...(term ? { q: term } : {}), ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const own = ownConversations((sessions.data?.pages ?? []).flatMap((page) => page.sessions), list);
  const groups = groupByDate(own);

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2.5 px-4 pt-3 pb-2">
        <h2 className="font-display text-lg font-medium tracking-tight">{agentName}'s conversations</h2>
        <SearchInput value={search} onChange={setSearch} placeholder="Search by what was asked" label={`Search ${agentName}'s conversations`} className="input-md h-11 w-full sm:h-10" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {sessions.isPending ? (
          <div className="px-2 py-1">
            <ListLoading count={3} />
          </div>
        ) : own.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-base-content/65">
            {term ? `Nothing matches “${term}”. Only what was first asked in each conversation is searched.` : `No conversations with ${agentName} yet.`}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <ListHeading className="sticky top-0 z-10 bg-base-100 pt-2">{group.label}</ListHeading>
              {group.sessions.map((session) => {
                const local = session.gatewayId.startsWith(LOCAL);
                return (
                  <ConversationRow
                    key={session.id}
                    link={{ to: "/chat/$sessionId", params: { sessionId: session.id } }}
                    name={session.title?.trim() || "A conversation"}
                    tag={local ? undefined : <PlatformTag>{`${platformName(session.gatewayId)} · read-only`}</PlatformTag>}
                    time={shortWhen(session.updatedAt)}
                    line={
                      session.running ? (
                        "Working"
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {local ? <Monitor size={12} aria-hidden="true" /> : null}
                          {from(session)}
                        </span>
                      )
                    }
                    tone={session.running ? "working" : "said"}
                    current={session.id === current}
                  />
                );
              })}
            </section>
          ))
        )}
        {sessions.hasNextPage ? (
          <button type="button" className="btn btn-ghost btn-sm mt-1 w-full rounded-xl text-xs" disabled={sessions.isFetchingNextPage} onClick={() => void sessions.fetchNextPage()}>
            {sessions.isFetchingNextPage ? <Loader2 size={12} className="animate-spin" /> : null}
            Older conversations
          </button>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-base-content/[0.06] p-3">
        <Link to="/chat" search={{ agent: agentId }} onClick={onClose} className="btn btn-primary h-11 w-full rounded-[14px]">
          <Plus size={16} aria-hidden="true" /> New chat with {agentName}
        </Link>
      </div>
    </>
  );
}
