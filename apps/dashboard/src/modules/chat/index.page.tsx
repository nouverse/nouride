/**
 * The chat, rebuilt on the daemon's turn records.
 *
 * What this page no longer does is the interesting part. It does not hold the steps, the durations or
 * the reply in React state; it does not carry a message in the URL and re-send it on mount; it does
 * not treat "my HTTP request is in flight" as "the agent is working". All four were the same mistake —
 * the turn belonged to the browser — and all four symptoms went with it: the double-send on refresh,
 * `1 step · 1s` after a reload, steps that vanished, and a running turn that no reopened tab could see.
 *
 * The layout is unchanged on purpose. What is richer is what there now *is* to show: every step with
 * its own duration, the model's reasoning, the answer as it is written, and which conversations are
 * working right now.
 */

import { useChatHistory } from "./hooks/use-history.ts";
import { useDraft } from "./hooks/use-draft.ts";
import { ChatHeader } from "./components/ChatHeader.tsx";
import { EmptyState } from "./components/EmptyState.tsx";
import { Composer } from "./components/Composer.tsx";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  api,
  type SessionSummary,
  type SlashCommand,
} from "@/commons/lib/api";
import { ApprovalStrip } from "./components/ApprovalStrip.tsx";
import { useStickyScroll } from "@/commons/hooks/use-sticky-scroll";
import { useDebounced } from "@/commons/hooks/use-debounced";
import { DropOverlay, useFileDrop } from "@/commons/components/ui/FileDrop";
import { useConversation } from "@/commons/hooks/use-conversation";
import { useAttachments } from "./hooks/use-attachments";
import { SessionDrawer } from "./components/SessionDrawer";
import { EventPill } from "./components/EventPill";
import { interleave } from "./interleave";
import { EarlierMessage, LiveTurnView, TurnView, UserBubble } from "./components/Turn";
import { JobStrip } from "./components/Jobs";
import {
  applyMention,
  matchMentions,
  mentionToken,
  orderMentions,
} from "./components/MentionMenu";
import { applyCommand, matchCommands, slashToken } from "./components/SlashMenu";
import { canWrite, useMe } from "@/commons/lib/session";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";
import { NotesPanel } from "./components/NotesPanel";
import { PlanStrip } from "./components/PlanStrip";
import { startWith } from "./lib/start-with";
import { useWorkNotes } from "@/commons/hooks/use-notes";
import { ENTER, useMotionList } from "@/commons/hooks/use-motion-list";
import { looksOf } from "@/commons/cat/look";

export default function ChatPage(
  { sessionId, roomChatId, agent, draft }: { sessionId?: string; roomChatId?: string; agent?: string; draft?: string } = {},
) {
  const navigate = useNavigate();

  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const me = useMe();
  /**
   * The search box, and the term the query actually uses.
   *
   * Debounced rather than sent per keystroke: the daemon answers a `LIKE` across the conversation
   * list, and the filtering happens *there* — which is the difference between searching the history
   * and searching what is already on screen.
   */
  const [search, setSearch] = useState("");
  const searchTerm = useDebounced(search, 250);

  /**
   * The sidebar's data and its two deletes — see `useChatHistory`.
   *
   * Five queries that are one feature, lifted out of this component: the conversation list, the room
   * list, the open room, and the deletes that invalidate them.
   */
  const history = useChatHistory({
    searchTerm,
    ...(sessionId ? { sessionId } : {}),
    ...(roomChatId ? { roomChatId } : {}),
    onLeave: () => void navigate({ to: "/chat" }),
  });
  /**
   * The room this page is showing, when it is showing one.
   *
   * Fetched by id rather than read out of the transcript payload, because the header has to be right
   * before anybody has spoken — a room created a second ago has no turns and no sessions, and its
   * name and members are the only thing on screen.
   */
  const room = history.room;

  const orchestrator = status.data?.orchestrator ?? null;
  /**
   * The daemon's default first, the rest in the order it sent them.
   *
   * The same rule the Agents page follows, and for the same reason: the orchestrator is the one this chat
   * opens with and the one most messages go to, so making the reader find it alphabetically among six
   * near-identical names is a small tax paid on every single switch.
   */
  const agents = [...(status.data?.agents ?? [])].sort((a, b) =>
    a.id === orchestrator ? -1 : b.id === orchestrator ? 1 : 0,
  );
  /**
   * The agent picked by hand, and the conversation that choice was made for.
   *
   * The scope is what makes switching work: picking another agent moves to a *new* chat, and a plain
   * `chosenAgent` string was wiped by the reset below the moment the route changed — so the picker
   * snapped back to the orchestrator and the switch looked like it had not happened.
   */
  const [choice, setChoice] = useState<{ agentId: string; scope: string }>({ agentId: "", scope: "" });
  // Picked by hand first; else, in a new chat, the agent the link named (`lib/start-with.ts`).
  const chosenAgent = (choice.scope === (sessionId ?? "") && choice.agentId) || startWith(agent, sessionId, agents);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [input, setInput] = useState("");
  /**
   * The agent's work notes, in a drawer on the right — a one-to-one conversation's, once the daemon has answered for
   * them: a room has a session per member, and a daemon that keeps none (501), or predates them (404), offers no toggle.
   */
  const workNotes = useWorkNotes(sessionId);
  /** Which conversation the drawer was opened in — scoped like `choice`, so a new chat's first answer does not open it. */
  const [notesFor, setNotesFor] = useState<string | null>(null);
  const notesOpen = notesFor !== null && notesFor === sessionId && Boolean(workNotes.data);
  const closeNotes = () => setNotesFor(null);
  const toggleNotes = () => {
    setHistoryOpen(false);
    // Opened, read again: what the agent wrote in a turn on another connection is there without waiting for one here.
    if (!notesOpen) void workNotes.refetch();
    setNotesFor(notesOpen ? null : (sessionId ?? null));
  };

  const user = me.data?.user;
  /**
   * What to call them on screen.
   *
   * The same order the daemon uses for the agent's prompt — display name, then the account they
   * signed in with — so the corner of the screen and the agent agree. Nothing is invented when both
   * are empty: "Operator" was a name nobody chose, printed as though somebody had.
   */
  const senderName = user?.displayName?.trim() || user?.username?.trim() || "";

  const conversation = useConversation({
    ...(sessionId ? { sessionId } : {}),
    ...(roomChatId ? { roomChatId } : {}),
    agentId: chosenAgent,
    onSession: (id) =>
      void navigate({ to: "/chat/$sessionId", params: { sessionId: id }, replace: true }),
  });

  /**
   * Which agent this conversation belongs to.
   *
   * The daemon's answer wins over the dropdown: a conversation is keyed by (agent, chat), so the
   * transcript on screen *is* one agent's, and letting the picker claim otherwise is how the old view
   * ended up sending to somebody who was not in the conversation being displayed.
   */
  const sessionAgent = conversation.session?.agentId ?? conversation.liveTurns[0]?.agentId;
  const selectedAgent = chosenAgent || sessionAgent || orchestrator || agents[0]?.id || "";
  const currentAgent = agents.find((a) => a.id === selectedAgent) ?? agents[0];
  // Every agent's, as the Office works them out: a look left to the id moves off a twin, so one agent alone may differ.
  const looks = useMemo(() => looksOf(status.data?.agents ?? []), [status.data?.agents]);

  /**
   * Switching agent starts a fresh conversation.
   *
   * A transcript belongs to one (agent, chat) pair, so choosing somebody else mid-thread never
   * continued *this* conversation — the daemon opened a new session on the next send anyway, and until
   * then the screen showed one agent's name above another agent's transcript. Doing it up front is
   * what the header already implies: pick Nero, get Nero's empty room.
   */
  const pickAgent = (agentId: string) => {
    // daisyUI keeps a dropdown open while something inside it has focus, and the item just clicked
    // does. Without this the menu stays over the new, empty chat.
    (document.activeElement as HTMLElement | null)?.blur();
    if (agentId === selectedAgent) return;
    // Scoped to "no session": the choice belongs to the new chat we are about to land on.
    setChoice({ agentId, scope: "" });
    if (sessionId) {
      setHistoryOpen(false);
      setInput("");
      void navigate({ to: "/chat" });
    }
  };

  const writable = conversation.session?.writable ?? true;
  /**
   * The conversation a file belongs to.
   *
   * The daemon's own id when it has answered, the URL's otherwise — an attachment URL is built from
   * this plus the file's position on its turn, so it has to be the id the daemon will look up.
   */
  const transcriptId = conversation.session?.id ?? sessionId ?? "";
  const busy = conversation.busy;

  /**
   * Approvals for *this* conversation.
   *
   * Was `chatId === chat || agentId === agent`, so a prompt from any other conversation with the same
   * agent appeared here too — and answering it from the wrong window is a decision made without the
   * context it belonged to.
   */
  const approvalsQuery = useQuery({
    queryKey: ["approvals"],
    queryFn: api.approvals,
    // With the stream open it says when one is about to be asked (a `waiting` step refetches this), and the timer is
    // a net. Without it, a running turn is watched every second, as before.
    refetchInterval: busy ? (conversation.streaming ? 10_000 : 1_000) : 15_000,
    retry: false,
  });
  const chatId = conversation.session?.chatId ?? conversation.liveTurns[0]?.chatId;
  const pendingApprovals = (approvalsQuery.data?.pending ?? []).filter(
    (request) => chatId && request.chatId === chatId,
  );
  // What an answer did — or that it changed nothing — is said by the hook, in a toast that outlives the card.
  const answerApproval = useAnswerApproval();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  // A message written for the person to send (`AskAgentButton`): in the box once, never sent from here.
  useDraft({ draft, agent, setInput, textareaRef });

  /**
   * Opens at the newest message, follows the answer as it is written, and lets go the moment the
   * reader scrolls up. All three in one place — see the hook.
   */
  useStickyScroll({ container: scrollRef, content: streamRef, resetKey: sessionId });

  const attachments = useAttachments();
  const drop = useFileDrop({ onFiles: attachments.add, disabled: !writable });

  /**
   * The `/` menu.
   *
   * The command list is fetched once — it is fixed for the life of a build — and everything else is
   * about *when* the menu is up. There are two ways in, and they are not the same thing:
   *
   * - typing `/`, which opens it as an autocomplete over the word being written, and
   * - **pressing the button**, which opens it as a list of what there is.
   *
   * The second is why the button exists at all. A feature that only appears once you have typed the
   * character that summons it is a feature for people who already knew about it, and the commands are
   * most useful to exactly the people who do not.
   */
  const commandList = useQuery({
    queryKey: ["commands"],
    queryFn: api.commands,
    staleTime: Infinity,
    retry: false,
  });
  const [slashActive, setSlashActive] = useState(-1);
  const [slashDismissed, setSlashDismissed] = useState(false);
  /** Opened by the button rather than by typing, so it survives an empty box. */
  const [slashBrowsing, setSlashBrowsing] = useState(false);
  const commands = commandList.data?.commands ?? [];
  const token = slashToken(input);
  /**
   * Which row Enter would pick. **0, not -1** — the opposite of the slash menu, deliberately.
   *
   * The slash menu starts with nothing highlighted so that typing `/status` and pressing Enter still
   * *sends* `/status`: the text is meaningful exactly as typed, and a menu that swallowed it would be
   * a regression for anybody who already knows the commands.
   *
   * A half-typed mention is not meaningful as typed. `@no` is not an address — it reaches nobody —
   * so there is nothing to protect by leaving it alone, and every chat app completes it on Enter.
   * Picking rewrites the token and closes the menu, so the next Enter sends.
   */
  const [mentionActive, setMentionActive] = useState(0);
  /**
   * Escape and clicking away shut it, and the next keystroke opens it again.
   *
   * Same shape as the slash menu's dismissal and for the same reason: without it the menu is derived
   * purely from the text, so clicking elsewhere on the page leaves it hanging over a composer that no
   * longer has focus.
   */
  const [mentionDismissed, setMentionDismissed] = useState(false);
  /**
   * Who can be addressed, while `@` is being typed.
   *
   * Rooms only. In a one-to-one chat a tag reaches nobody — each bot has its own private
   * conversation — so offering one would be offering a token the daemon tells the *agents* does
   * nothing, and it would arrive as plain text in the message.
   */
  const mentionAt = room ? mentionToken(input) : null;
  /**
   * Who is mid-turn right now, from the room's own live feed.
   *
   * The daemon refuses a message addressed to an agent that is already working, so the menu says so
   * before the message is sent rather than after — and it is the same fact either way, read from the
   * running turns rather than guessed.
   */
  const busyAgents = new Set(
    conversation.liveTurns.filter((turn) => turn.status === "running").map((turn) => turn.agentId),
  );
  const mentionMatches =
    room && mentionAt !== null && !mentionDismissed
      ? orderMentions(
          matchMentions(
            room,
            agents.map((agent) => ({
              agentId: agent.id,
              displayName: agent.displayName,
              busy: busyAgents.has(agent.id),
            })),
            mentionAt,
            input,
          ),
        )
      : [];

  // Clamped, because the list shrinks as the token gets longer and an index left pointing past the
  // end would make Enter do nothing at all.
  const mentionIndex = Math.min(Math.max(mentionActive, 0), Math.max(mentionMatches.length - 1, 0));

  const pickMention = (agentId: string) => {
    // The keyboard path needs the same refusal the disabled row gives the mouse.
    if (busyAgents.has(agentId)) return;
    setInput((current) => applyMention(current, agentId));
    setMentionActive(0);
    setMentionDismissed(false);
    textareaRef.current?.focus();
  };
  const slashOpen = writable && !slashDismissed && (token !== null || slashBrowsing);
  const slashMatches = slashOpen ? matchCommands(commands, token ?? "") : [];

  const pickCommand = (command: SlashCommand) => {
    // Whatever is already typed becomes the argument rather than being thrown away — see
    // `applyCommand`.
    setInput(applyCommand(input, command.command));
    setSlashActive(-1);
    setSlashDismissed(true);
    setSlashBrowsing(false);
    textareaRef.current?.focus();
  };

  const closeSlash = () => {
    setSlashDismissed(true);
    setSlashBrowsing(false);
    setSlashActive(-1);
  };

  /**
   * The button's own job: show the list, or put the person in a position to type one.
   *
   * An empty box gets a `/` written into it, so that dismissing the menu and carrying on typing
   * lands somewhere sensible rather than back at nothing. A box that already has a message in it is
   * left alone — the menu is a reference then, not a composer.
   */
  const toggleSlash = () => {
    if (slashOpen) {
      closeSlash();
      return;
    }
    if (input.trim() === "") setInput("/");
    setSlashDismissed(false);
    setSlashBrowsing(true);
    setSlashActive(-1);
    textareaRef.current?.focus();
  };

  const canSend =
    writable && !attachments.uploading && (input.trim().length > 0 || attachments.ready.length > 0);

  const submit = () => {
    if (!canSend) return;
    conversation.send(input.trim(), attachments.ready);
    /**
     * The sidebar is asked to catch up immediately, not at its next tick.
     *
     * A brand-new conversation has no row until the daemon records a session, which happens when the
     * turn starts — under two seconds, measured. Waiting for the poll meant sending the first message
     * of a new chat and watching the history not mention it for five, which reads as the message
     * having gone nowhere. The refetch that follows this may still be a moment early; the interval
     * above then catches it, and by then it is quick because something is running.
     */
    history.refresh();
    setInput("");
    attachments.clear();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };


  /*
    What arrives in the conversation moves in: a message, a note, an answer starting. What it opens on stays still —
    another conversation starts over (`scope`) — and a turn is one entry by its id, live or finished, so one that
    finishes does not move again.
  */
  const stream = useMotionList(
    conversation.loading ? undefined : interleave(conversation.turns, conversation.liveTurns, conversation.events, conversation.messages),
    (entry) => (entry.kind === "message" ? `message ${entry.message.id}` : entry.kind === "event" ? `event ${entry.event.id}` : `turn ${entry.turn.id}`),
    { scope: roomChatId ?? sessionId ?? "" },
  );

  const empty =
    conversation.turns.length === 0 &&
    conversation.earlier.length === 0 &&
    // A room whose only content is a message nobody answered is not empty. Before room messages
    // existed there was nothing to count here, which is part of why an untagged message vanished.
    conversation.messages.length === 0 &&
    conversation.liveTurns.length === 0 &&
    !conversation.pending &&
    conversation.jobs.length === 0;

  const selectSession = (session: SessionSummary) => {
    setHistoryOpen(false);
    void navigate({ to: "/chat/$sessionId", params: { sessionId: session.id } });
  };

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden bg-base-100/40">
      <ChatHeader
        historyOpen={historyOpen}
        toggleHistory={() => {
          closeNotes();
          setHistoryOpen((open) => !open);
        }}
        {...(workNotes.data ? { notes: { open: notesOpen, count: workNotes.data.tasks.length, toggle: toggleNotes } } : {})}
        totalSessions={history.total}
        room={room}
        sessionId={sessionId}
        agents={agents}
        currentAgent={currentAgent}
        orchestrator={status.data?.orchestrator ?? undefined}
        pickAgent={pickAgent}
        onDelete={() => {
          if (sessionId) history.deleteSession(sessionId);
        }}
        deleting={Boolean(history.deleting)}
        newChat={() => {
          setHistoryOpen(false);
          setInput("");
          void navigate({ to: "/chat" });
        }}
      />

      <div className="relative flex-1 min-h-0 flex overflow-hidden">
        <SessionDrawer
          open={historyOpen}
          sessions={history.sessions}
          total={history.total}
          search={search}
          onSearch={setSearch}
          loading={history.loading}
          hasMore={history.hasMore}
          loadingMore={history.loadingMore}
          onLoadMore={history.loadMore}
          {...(sessionId ? { activeId: sessionId } : {})}
          onClose={() => setHistoryOpen(false)}
          onSelect={selectSession}
          onDelete={(session) => history.deleteSession(session.id)}
          rooms={history.rooms}
          {...(roomChatId ? { activeRoom: roomChatId } : {})}
          onSelectRoom={(picked) => {
            setHistoryOpen(false);
            void navigate({ to: "/chat/room/$chatId", params: { chatId: picked.chatId } });
          }}
          onDeleteRoom={(picked) => history.deleteRoom(picked.chatId)}
          {...(history.deleting ? { deleting: history.deleting } : {})}
        />

        {sessionId && workNotes.data ? (
          <NotesPanel
            key={sessionId}
            open={notesOpen}
            sessionId={sessionId}
            notes={workNotes.data}
            error={workNotes.error}
            editable={canWrite(me.data ?? null)}
            onClose={closeNotes}
          />
        ) : null}

        {/* Always there, so it fades as the drawers slide: drawn only while one was open, it came and went at once.
            Hidden once faded (`invisible`), it takes no click and no focus. */}
        <button
          type="button"
          className={`absolute inset-0 bg-black/30 backdrop-blur-xs z-20 transition-[opacity,visibility] duration-200 ease-out ${
            historyOpen || notesOpen ? "visible opacity-100" : "invisible opacity-0"
          }`}
          onClick={() => {
            setHistoryOpen(false);
            closeNotes();
          }}
          aria-label="Close drawer"
        />

        <div className="relative flex-1 min-h-0 flex flex-col h-full overflow-hidden" {...drop.handlers}>
          {/* Anywhere in the conversation, not just over the input: a file being dragged is aimed at
              the chat, and a target the size of a text box is a target people miss. */}
          {drop.dragging && <DropOverlay />}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 flex flex-col">
            {empty && !conversation.loading ? (
              <EmptyState
                agentName={currentAgent?.displayName}
                look={currentAgent ? looks.get(currentAgent.id) : undefined}
                room={room}
                senderName={senderName}
                onPick={(prompt) => {
                  setInput(prompt);
                  textareaRef.current?.focus();
                }}
              />
            ) : (
              <div ref={streamRef} className="max-w-3xl mx-auto w-full space-y-5 py-6 pb-6">
                {conversation.earlier.map((message, index) => (
                  <EarlierMessage key={`earlier-${index}`} message={message} />
                ))}
                {/*
                  Turns and room events in one stream, ordered by when they happened.
                  Interleaved rather than listed in two blocks: a pill that says "a message was
                  dropped" means nothing above the whole conversation and everything between the
                  message before it and the one after.
                */}
                {stream.map(({ key, item: entry, motion }) => {
                  if (entry.kind === "message") {
                    /*
                      What somebody typed, once, whether or not it was answered. In a room this is
                      the only place a message comes from — a turn draws its reply and nothing else,
                      so a message two agents answered is one bubble and a message nobody answered
                      is still a bubble.
                    */
                    return <UserBubble key={key} text={entry.message.text} sessionId={transcriptId} motion={motion} />;
                  }
                  if (entry.kind === "event") {
                    return <EventPill key={key} event={entry.event} motion={motion} />;
                  }
                  if (entry.kind === "live") {
                    return (
                      <LiveTurnView
                        key={key}
                        turn={entry.turn}
                        sessionId={transcriptId}
                        showPrompt={!room}
                        onStop={(agentId) => conversation.stop(agentId)}
                        motion={motion}
                      />
                    );
                  }
                  return (
                    <TurnView
                      key={key}
                      turn={entry.turn}
                      sessionId={transcriptId}
                      // In a room the question is a message of its own, above.
                      showPrompt={!room}
                      motion={motion}
                    />
                  );
                })}
                {/* Sent, and the daemon has not reported a turn for it yet: it enters as it is sent. */}
                {conversation.pending && <UserBubble text={conversation.pending} motion={ENTER} />}
                {/* Still running after the turn that started it ended. */}
                <JobStrip jobs={conversation.jobs} />

                <ApprovalStrip
                  requests={pendingApprovals}
                  answering={answerApproval.isPending}
                  onAnswer={(request, decision) => answerApproval.mutate({ request, decision })}
                />

              </div>
            )}
          </div>

          {!room && <PlanStrip plan={workNotes.data?.plan} chat={conversation.session} busy={busy} />}

          <Composer
            input={input}
            setInput={setInput}
            submit={submit}
            canSend={canSend}
            writable={writable}
            busy={busy}
            textareaRef={textareaRef}
            room={room}
            agentName={currentAgent?.displayName}
            senderName={senderName}
            attachments={attachments}
            conversation={conversation}
            slash={{
              matches: slashMatches,
              active: slashActive,
              setActive: setSlashActive,
              pick: pickCommand,
              close: closeSlash,
              onTyped: () => {
                setSlashDismissed(false);
                setSlashActive(-1);
              },
              open: slashOpen,
              toggle: toggleSlash,
            }}
            mention={{
              matches: mentionMatches,
              active: mentionActive,
              index: mentionIndex,
              setActive: setMentionActive,
              pick: (candidate) => pickMention(candidate.agentId),
              close: () => {
                setMentionDismissed(true);
                setMentionActive(0);
              },
              onTyped: () => {
                setMentionDismissed(false);
                setMentionActive(0);
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
