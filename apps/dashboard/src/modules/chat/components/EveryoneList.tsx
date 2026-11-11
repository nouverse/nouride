/**
 * An admin's Everyone, on Chats: every conversation a person has had with the agents, here and on the chat apps, set
 * apart by person — each under their name, then what scheduled jobs said on their own, then the private chats nobody in
 * People is known for. A row opens the conversation; one from a chat app is read here and answered there.
 *
 * Asked of the daemon page by page, newest first, and searched there, as History is: the first thing asked in each.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { SessionSummary } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { ConversationRow, ListHeading } from "@/commons/components/chat/ConversationRow";
import { PlatformTag } from "@/commons/components/chat/PlatformBadge";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { useDebounced } from "@/commons/hooks/use-debounced";
import { api } from "@/commons/lib/api";
import { shortWhen } from "@/commons/lib/when";
import type { ChatListData } from "../hooks/use-chat-list";
import { groupByPerson } from "../lib/history";

const PAGE = 50;
const LOCAL = "web:";

/** What the headings of nobody's conversations say. */
export const EVERYONE_WORDS = { jobs: "Scheduled jobs", unknown: "Not known" } as const;

export function EveryoneList({ data, query, current }: { data: ChatListData; query: string; current: string | undefined }) {
  const term = useDebounced(query.trim(), 250);
  const sessions = useInfiniteQuery({
    queryKey: ["sessions", "everyone", term],
    queryFn: ({ pageParam }) => api.sessions({ whose: "everyone", limit: PAGE, ...(term ? { q: term } : {}), ...(pageParam ? { before: pageParam } : {}) }),
    initialPageParam: 0,
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  // A group's and a room's conversations are on Groups, as they are for anyone.
  const listed = (sessions.data?.pages ?? []).flatMap((page) => page.sessions).filter((session) => session.kind !== "group" && session.kind !== "room");
  const groups = groupByPerson(listed, EVERYONE_WORDS);

  if (sessions.isPending) {
    return (
      <div className="px-1 pt-2">
        <ListLoading count={5} />
      </div>
    );
  }
  if (groups.length === 0) {
    return <p className="px-3 py-8 text-center text-sm text-base-content/65">{term ? `Nothing matches “${term}”.` : "Nobody has talked to the agents yet."}</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <ListHeading>{group.label}</ListHeading>
          {group.sessions.map((session) => (
            <EveryoneRow key={session.id} session={session} data={data} current={session.id === current} />
          ))}
        </section>
      ))}
      {sessions.hasNextPage ? (
        <button type="button" className="btn btn-ghost btn-sm mt-1 w-full rounded-xl text-xs" disabled={sessions.isFetchingNextPage} onClick={() => void sessions.fetchNextPage()}>
          {sessions.isFetchingNextPage ? <Loader2 size={12} className="animate-spin" /> : null}
          Older conversations
        </button>
      ) : null}
    </div>
  );
}

function EveryoneRow({ session, data, current }: { session: SessionSummary; data: ChatListData; current: boolean }) {
  const look = data.looks.get(session.agentId);
  const agent = data.nameOf(session.agentId);
  const local = session.gatewayId.startsWith(LOCAL);
  return (
    <ConversationRow
      link={{ to: "/chat/$sessionId", params: { sessionId: session.id } }}
      avatar={look ? <AgentAvatar look={look} name={agent} size="sm" /> : undefined}
      name={session.title?.trim() || "A conversation"}
      tag={local ? undefined : <PlatformTag platform={session.gatewayId} size="row" />}
      time={shortWhen(session.updatedAt)}
      line={session.running ? "Working" : `With ${agent}`}
      tone={session.running ? "working" : "said"}
      current={current}
    />
  );
}
