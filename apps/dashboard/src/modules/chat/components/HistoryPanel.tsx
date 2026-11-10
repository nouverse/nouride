/**
 * One agent's History, from its chat's header: only that agent's conversations — the dashboard's, and its private chats
 * on Telegram, Discord or WhatsApp, each saying where it is from — newest first, under the day they belong to, and
 * searchable by what was first asked in them. A drawer from the left of the conversation (`Drawer`), the work notes'
 * twin on the other side, at every width.
 *
 * A private chat on a chat app opens read-only here: it is answered on its app.
 *
 * Each row has a menu at its end with Delete, asked as the conversation's own bar asks it (`DELETE_CONVERSATION`): the
 * owner looked for it on the rows, as History had it before the chat page was rebuilt, not only on the conversation
 * open on screen.
 */

import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Ellipsis, Loader2, Monitor, Plus, Trash2 } from "lucide-react";
import type { ChatListPayload, SessionSummary } from "@nouride/wire";
import { ConversationRow, ListHeading } from "@/commons/components/chat/ConversationRow";
import { PlatformRowTag } from "@/commons/components/chat/PlatformBadge";
import { useConfirm } from "@/commons/components/ui/confirm";
import { Drawer, DrawerHead } from "@/commons/components/ui/Drawer";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { useToast } from "@/commons/components/ui/toast";
import { SearchInput } from "@/commons/components/ui/SearchInput";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { useDebounced } from "@/commons/hooks/use-debounced";
import { api } from "@/commons/lib/api";
import { platformName } from "@/commons/lib/platform";
import { shortWhen } from "@/commons/lib/when";
import { DELETE_CONVERSATION, groupByDate, ownConversations } from "../lib/history";

const PAGE = 50;
const LOCAL = "web:";

/** Where a conversation is from, on its row's second line. */
function from(session: SessionSummary): string {
  return session.gatewayId.startsWith(LOCAL) ? "On the dashboard" : `A private chat on ${platformName(session.gatewayId)}`;
}

export function HistoryPanel({
  open,
  onClose,
  agentId,
  agentName,
  current,
  list,
}: {
  open: boolean;
  onClose: () => void;
  agentId: string;
  agentName: string;
  /** The conversation on screen, marked in the list. */
  current: string | undefined;
  list: ChatListPayload | undefined;
}) {
  const label = `${agentName}'s conversations`;
  return (
    // Its list is read when it is first opened, not with every conversation on screen.
    <Drawer open={open} onClose={onClose} side="left" label={label} lazy>
      <DrawerHead title={label} closeLabel="Close History" onClose={onClose} />
      <HistoryBody agentId={agentId} agentName={agentName} current={current} list={list} onClose={onClose} />
    </Drawer>
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
  const { ask, dialog } = useConfirm();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: (_, id) => {
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["chat-list"] });
      // The one on screen leaves it, where its bar's Delete goes (`useOpenChat`).
      if (id === current) void navigate({ to: "/chat" });
    },
    onError: (error: unknown) => toast.error("Could not delete the conversation", error),
  });

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2.5 px-4 pb-2">
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
                    tag={local ? undefined : <PlatformRowTag platform={session.gatewayId} />}
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
                    menu={
                      <DropdownMenu
                        trigger={<Ellipsis size={16} aria-hidden="true" />}
                        triggerClassName="btn btn-ghost btn-square size-11 rounded-xl text-base-content/65 hover:text-base-content sm:size-9"
                        ariaLabel={`More for “${session.title?.trim() || "A conversation"}”`}
                        width={220}
                        menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
                      >
                        {(close) => (
                          <li>
                            <button
                              type="button"
                              className="min-h-11 gap-3 rounded-xl text-sm text-error"
                              disabled={remove.isPending}
                              onClick={async () => {
                                close();
                                if (await ask(DELETE_CONVERSATION)) remove.mutate(session.id);
                              }}
                            >
                              <Trash2 size={16} aria-hidden="true" /> Delete conversation
                            </button>
                          </li>
                        )}
                      </DropdownMenu>
                    }
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
      {dialog}
    </>
  );
}
