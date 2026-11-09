/**
 * A group from a chat app, read here: what the agents in it were asked and answered, one conversation however many of
 * our bots sit in it, and their work as it happens. Nothing is written from here — the group lives on its app, and in
 * place of the box to write in, a note says so.
 *
 * A group can be pinned to Chats, in this browser, to keep it with the conversations.
 */

import { useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, MessagesSquare, Pin, PinOff } from "lucide-react";
import type { ChatListGroup, ChatTurn, LiveTurn } from "@nouride/wire";
import { GroupAvatar } from "@/commons/components/chat/Avatars";
import { PlatformTag } from "@/commons/components/chat/PlatformBadge";
import { ReadOnlyNote } from "@/commons/components/chat/ReadOnlyNote";
import { PersonMessage } from "@/commons/components/chat/PersonMessage";
import { ListLoading } from "@/commons/components/ui/Spinner";
import { EmptyState } from "@/commons/components/ui/ui";
import { useStickyScroll } from "@/commons/hooks/use-sticky-scroll";
import { api } from "@/commons/lib/api";
import { platformName, roomWord } from "@/commons/lib/platform";
import { cn } from "@/commons/lib/utils";
import type { ChatListData } from "../hooks/use-chat-list";
import { usePinnedGroups } from "../hooks/use-pinned";
import { groupKey } from "../lib/chat-list";
import { groupStream } from "../lib/group-stream";
import { HEADER_BUTTON } from "./AgentHeader";
import { groupName } from "./ListRows";
import { LiveTurnView, TurnView } from "./Turn";

export function GroupConversation({ platform, chatId, data }: { platform: string; chatId: string; data: ChatListData }) {
  const group = data.list.data?.groups.find((one) => one.platform === platform && one.chatId === chatId);
  if (!group) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-[4.25rem] shrink-0 items-center border-b border-base-content/[0.08] px-2 md:hidden">
          <Link to="/chat" className="btn btn-ghost btn-square size-11 rounded-[14px]" aria-label="Back to chats">
            <ChevronLeft size={22} aria-hidden="true" />
          </Link>
        </div>
        {data.list.isPending ? (
          <div className="mx-auto w-full max-w-3xl p-6">
            <ListLoading count={3} />
          </div>
        ) : (
          <EmptyState icon={Pin} title="This group is not here any more" description="No agent has talked in it lately, or it was left. Pick another from Groups." />
        )}
      </div>
    );
  }
  return <GroupView group={group} data={data} />;
}

function GroupView({ group, data }: { group: ChatListGroup; data: ChatListData }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const [pinned, togglePin] = usePinnedGroups();
  const key = groupKey(group);
  const isPinned = pinned.includes(key);
  const app = platformName(group.platform);
  const name = groupName(group);

  // Each agent's side of the group, asked again while one works there; the turn at work, from its live feed.
  const transcripts = useQueries({
    queries: group.sessions.map((session) => ({
      queryKey: ["transcript", session.sessionId],
      queryFn: () => api.transcript(session.sessionId),
      refetchInterval: group.working ? 3_000 : 15_000,
    })),
  });
  const lives = useQueries({
    queries: group.sessions.map((session) => ({
      queryKey: ["group-live", session.sessionId],
      queryFn: () => api.live(session.sessionId, 0),
      enabled: group.working,
      refetchInterval: group.working ? 1_500 : false,
    })),
  });
  const turns: ChatTurn[] = transcripts.flatMap((query) => query.data?.turns ?? []);
  // What people said there, kept by each of our bots' connections: one line once, whichever kept it (`groupStream`).
  const said = transcripts.flatMap((query) => query.data?.messages ?? []);
  const running = lives.flatMap((query) => (group.working && query.data?.turn?.status === "running" ? [query.data.turn as LiveTurn] : []));
  const stream = groupStream(turns, running, said);
  const loading = transcripts.some((query) => query.isPending);

  useStickyScroll({ container: scrollRef, content: streamRef, resetKey: key });

  const agentsHere = group.agents.map(data.nameOf).join(", ");
  const people = group.people === 1 ? "1 person" : `${group.people} people`;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <header className="z-20 flex h-[4.25rem] shrink-0 items-center gap-1.5 border-b border-base-content/[0.08] bg-base-100/80 px-2 backdrop-blur-xl sm:gap-2.5 sm:px-5">
        <Link to="/chat" className="btn btn-ghost btn-square size-11 shrink-0 rounded-[14px] md:hidden" aria-label="Back to chats">
          <ChevronLeft size={22} aria-hidden="true" />
        </Link>
        <GroupAvatar name={name} platform={group.platform} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pl-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate font-display text-lg font-medium tracking-tight text-base-content">{name}</h2>
            <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
              <PlatformTag>{`${app} ${roomWord(group.platform)}`}</PlatformTag>
              <PlatformTag>Read-only</PlatformTag>
            </span>
          </div>
          <p className="truncate text-xs text-base-content/65">
            <span className="sm:hidden">Read-only · {app} · </span>
            {group.agents.length > 0 ? `Agents here: ${agentsHere}` : "No agent here yet"}
            {group.people > 0 ? ` · ${people}` : ""}
          </p>
        </div>
        <button type="button" aria-pressed={isPinned} className={cn(HEADER_BUTTON, isPinned && "bg-secondary/10 text-secondary")} aria-label={isPinned ? "Unpin from Chats" : "Pin to Chats"} onClick={() => togglePin(key)}>
          {isPinned ? <PinOff size={17} aria-hidden="true" /> : <Pin size={17} aria-hidden="true" />}
          <span className="max-sm:hidden">{isPinned ? "Unpin" : "Pin to Chats"}</span>
        </button>
      </header>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-6">
        {/*
          One element from the first paint, loading or not: the sticky scroll watches it from mount. Drawn only once the
          transcript came, it was never watched, and a group with more than a screen of history opened at its oldest
          line (live on the box: a Discord channel at 09:20 when its last word was at 10:11).
        */}
        <div ref={streamRef} data-stream="" className={cn("mx-auto w-full max-w-3xl py-6", !loading && stream.length === 0 ? "my-auto" : "space-y-5")}>
          {loading ? (
            <ListLoading count={3} />
          ) : stream.length === 0 ? (
            <EmptyState icon={MessagesSquare} title="Nothing said here yet" description={`What people say in this ${roomWord(group.platform)} on ${app}, and what the agents answer, shows here.`} />
          ) : (
            <>
            {/* People on the left under their names: in a group on a chat app, none of it is the reader's own. */}
            {stream.map((entry) =>
              entry.kind === "message" ? (
                <PersonMessage key={entry.key} name={entry.message.senderName} text={entry.message.text} />
              ) : entry.live ? (
                <LiveTurnView key={entry.key} turn={entry.turn as LiveTurn} sessionId={entry.turn.sessionId ?? ""} showPrompt={entry.showPrompt} asker={entry.turn.senderName ?? ""} />
              ) : (
                <TurnView key={entry.key} turn={entry.turn} sessionId={entry.turn.sessionId ?? ""} showPrompt={entry.showPrompt} asker={entry.turn.senderName ?? ""} />
              ),
            )}
            {stream.every((entry) => entry.kind === "message") ? <p className="text-center text-xs text-base-content/65">No agent has said anything here yet.</p> : null}
            </>
          )}
        </div>
      </div>

      <ReadOnlyNote platform={group.platform} kind={roomWord(group.platform)} />
    </div>
  );
}
