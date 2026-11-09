/**
 * One conversation: an agent's, a room's, or an agent's private chat on a chat app, read here.
 *
 * Built on the daemon's turn records. It does not hold the steps, the durations or the reply in React state; it does
 * not carry a message in the URL and re-send it on mount; it does not treat "my HTTP request is in flight" as "the agent
 * is working". All four were the same mistake — the turn belonged to the browser — and all four symptoms went with it:
 * the double-send on refresh, `1 step · 1s` after a reload, steps that vanished, and a running turn that no reopened
 * tab could see.
 *
 * Who it is with comes from the address, not from a picker: an agent's row in the list opens its newest conversation,
 * and a new chat is `/chat?agent=…`.
 */

import { useDraft } from "../hooks/use-draft.ts";
import { AgentHeader } from "./AgentHeader.tsx";
import { RoomHeader } from "./RoomHeader.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Composer } from "./Composer.tsx";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/commons/lib/api";
import type { ChatTurn, SlashCommand } from "@nouride/wire";
import { ApprovalStrip } from "./ApprovalStrip.tsx";
import { useStickyScroll } from "@/commons/hooks/use-sticky-scroll";
import { DropOverlay, useFileDrop } from "@/commons/components/ui/FileDrop";
import { ReadOnlyNote } from "@/commons/components/chat/ReadOnlyNote";
import { PersonMessage } from "@/commons/components/chat/PersonMessage";
import { useConversation } from "@/commons/hooks/use-conversation";
import { useAttachments } from "../hooks/use-attachments";
import { useOpenChat } from "../hooks/use-open-chat";
import type { ChatListData } from "../hooks/use-chat-list";
import { EventPill } from "./EventPill";
import { interleave } from "../interleave";
import { EarlierMessage, LiveTurnView, TurnView, UserBubble } from "./Turn";
import { JobStrip } from "./Jobs";
import {
  applyMention,
  matchMentions,
  mentionToken,
  orderMentions,
} from "./MentionMenu";
import { applyCommand, matchCommands, slashToken } from "./SlashMenu";
import { canWrite, useMe } from "@/commons/lib/session";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";
import { NotesPanel } from "./NotesPanel";
import { PlanStrip } from "./PlanStrip";
import { startWith } from "../lib/start-with";
import { askedInLog, oldestLine } from "../lib/group-stream";
import { eventWords } from "../lib/event-words";
import { useWorkNotes } from "@/commons/hooks/use-notes";
import { ENTER, useMotionList } from "@/commons/hooks/use-motion-list";
import { doingNow, orchestratorFirst } from "@/commons/lib/agents";
import { workingWords } from "./ListRows";

/** What the composer says under a room's box about a message that tags nobody: the router's answer, in words. */
function untaggedWords(untagged: string | undefined, nameOf: (agentId: string) => string): string {
  return untagged ? `Type @ to tag an agent. No tag: ${nameOf(untagged)} answers.` : "Type @ to tag an agent. No tag: nobody answers here.";
}

export function Conversation(
  { sessionId, roomChatId, agent, draft, data }: { sessionId?: string; roomChatId?: string; agent?: string; draft?: string; data: ChatListData },
) {
  const navigate = useNavigate();
  const me = useMe();

  const open = useOpenChat({
    ...(sessionId ? { sessionId } : {}),
    ...(roomChatId ? { roomChatId } : {}),
    onLeave: () => void navigate({ to: "/chat" }),
  });
  const room = open.room;

  const orchestrator = data.orchestrator;
  /** The orchestrator first, as every list of agents has it: the one a new chat opens with when none is named. */
  const agents = orchestratorFirst(data.agents, orchestrator);
  // In a new chat, the agent the link named (`lib/start-with.ts`).
  const chosenAgent = startWith(agent, sessionId, agents);
  const [input, setInput] = useState("");
  /**
   * The agent's work notes, in a drawer on the right — a one-to-one conversation's, once the daemon has answered for
   * them: a room has a session per member, and a daemon that keeps none (501), or predates them (404), offers no toggle.
   */
  const workNotes = useWorkNotes(sessionId);
  /** Which conversation the drawer was opened in, so a new chat's first answer does not open it. */
  const [notesFor, setNotesFor] = useState<string | null>(null);
  const notesOpen = notesFor !== null && notesFor === sessionId && Boolean(workNotes.data);
  const closeNotes = () => setNotesFor(null);
  const toggleNotes = () => {
    // Opened, read again: what the agent wrote in a turn on another connection is there without waiting for one here.
    if (!notesOpen) void workNotes.refetch();
    setNotesFor(notesOpen ? null : (sessionId ?? null));
  };

  const user = me.data?.user;
  /**
   * What to call them on screen: the same order the daemon uses for the agent's prompt — display name, then the account
   * they signed in with. Nothing is invented when both are empty.
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
   * Which agent this conversation belongs to: the daemon's answer, since a conversation is keyed by (agent, chat) and
   * the transcript on screen *is* one agent's; in a new chat, the one the link named, else the orchestrator.
   */
  const sessionAgent = conversation.session?.agentId ?? conversation.liveTurns[0]?.agentId;
  const selectedAgent = sessionAgent || chosenAgent || orchestrator || agents[0]?.id || "";
  const currentAgent = agents.find((a) => a.id === selectedAgent) ?? agents[0];
  const looks = data.looks;

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
    open.refresh();
    setInput("");
    attachments.clear();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  /*
    What arrives in the conversation moves in: a message, a note, an answer starting. What it opens on stays still —
    another conversation starts over (`scope`) — but a conversation a new chat just started opens on its first answer,
    which is what arrives. A turn is one entry by its id, live or finished, so one that finishes does not move again.
  */
  const stream = useMotionList(
    conversation.loading ? undefined : interleave(conversation.turns, conversation.liveTurns, conversation.events, conversation.messages),
    (entry) => (entry.kind === "message" ? `message ${entry.message.id}` : entry.kind === "event" ? `event ${entry.event.id}` : `turn ${entry.turn.id}`),
    { scope: roomChatId ?? sessionId ?? "", opensEmpty: conversation.startedHere },
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

  /** A private chat on a chat app: read here, answered on its app, and its composer is a note saying so. */
  const elsewhere = !writable && conversation.session ? conversation.session.gatewayId : undefined;
  // In a room, and in a group on a chat app whose lines are kept, what was asked is a message of its own in the stream.
  const oldest = oldestLine(conversation.messages);
  const prompted = (turn: ChatTurn) => !room && !(elsewhere && askedInLog(turn, oldest));
  const helpers = conversation.jobs.filter((job) => job.kind === "helper").length;
  const roomEntry = room ? data.list.data?.rooms.find((one) => one.chatId === room.chatId) : undefined;
  const working = workingWords(busy, helpers);
  const now = currentAgent ? doingNow(currentAgent) : undefined;

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden">
      {room ? (
        <RoomHeader room={room} data={data} untagged={roomEntry?.untagged} onDelete={open.deleteOnScreen} deleting={open.deleting} />
      ) : (
        <AgentHeader
          agentId={selectedAgent}
          name={currentAgent?.displayName || selectedAgent || "Agent"}
          look={looks.get(selectedAgent)}
          status={working ? { words: working, ...(helpers > 0 ? { more: " in the background" } : {}), tone: "working" } : { words: now?.words ?? "", tone: now?.tone ?? "muted" }}
          sessionId={sessionId}
          {...(elsewhere ? { readOnly: { platform: elsewhere } } : {})}
          list={data.list.data}
          {...(workNotes.data ? { notes: { open: notesOpen, count: workNotes.data.tasks.length, toggle: toggleNotes } } : {})}
          onDelete={open.deleteOnScreen}
          deleting={open.deleting}
        />
      )}

      <div className="relative flex-1 min-h-0 flex overflow-hidden">
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

        {/* Always there, so it fades as the drawer slides: drawn only while it was open, it came and went at once.
            Hidden once faded (`invisible`), it takes no click and no focus. */}
        <button
          type="button"
          className={`absolute inset-0 bg-black/30 backdrop-blur-xs z-20 transition-[opacity,visibility] duration-200 ease-out ${
            notesOpen ? "visible opacity-100" : "invisible opacity-0"
          }`}
          onClick={closeNotes}
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
                    return elsewhere ? <PersonMessage key={key} name={entry.message.senderName} text={entry.message.text} motion={motion} /> : <UserBubble key={key} text={entry.message.text} sessionId={transcriptId} motion={motion} />;
                  }
                  if (entry.kind === "event") {
                    return <EventPill key={key} event={entry.event} words={eventWords(entry.event, { viewer: user?.username, nameOf: data.nameOf })} motion={motion} />;
                  }
                  if (entry.kind === "live") {
                    return (
                      <LiveTurnView
                        key={key}
                        turn={entry.turn}
                        sessionId={transcriptId}
                        showPrompt={prompted(entry.turn)}
                        asker={elsewhere ? (entry.turn.senderName ?? "") : undefined}
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
                      showPrompt={prompted(entry.turn)}
                      asker={elsewhere ? (entry.turn.senderName ?? "") : undefined}
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

          {elsewhere ? (
            <ReadOnlyNote platform={elsewhere} kind="chat" />
          ) : (
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
            {...(room ? { untaggedHint: untaggedWords(roomEntry?.untagged, data.nameOf) } : {})}
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
          )}
        </div>
      </div>
    </div>
  );
}
