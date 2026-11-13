/**
 * One conversation: an agent's, a room's, or an agent's private chat on a chat app, read here.
 *
 * Built on the daemon's turn records. It does not hold the steps, the durations or the reply in React state; it does
 * not carry a message in the URL and re-send it on mount; it does not treat "my HTTP request is in flight" as "the agent
 * is working". All four were the same mistake — the turn belonged to the browser — and all four symptoms went with it:
 * the double-send on refresh, `1 step · 1s` after a reload, steps that vanished, and a running turn that no reopened
 * tab could see.
 *
 * Who it is with is its caller's to say, and never a picker of its own: on the Chats page the address (an agent's row
 * in the list opens its newest conversation, and a new chat is `/chat?agent=…`), in the floating chat the agent picked
 * in its bar. So is where it goes: the bar over it, the panels beside it and what becomes of a new conversation's id
 * are handed in, and the same conversation is drawn in both places.
 */

import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatTurn, LiveTurn, OpenPage, Room, SlashCommand } from "@nouride/wire";
import type { Look } from "@/commons/cat/look";
import { PersonMessage } from "@/commons/components/chat/PersonMessage";
import { ReadOnlyNote } from "@/commons/components/chat/ReadOnlyNote";
import { DropOverlay, useFileDrop } from "@/commons/components/ui/FileDrop";
import { useAnswerApproval } from "@/commons/hooks/use-answer-approval";
import { useAttachments } from "@/commons/hooks/use-attachments";
import type { ChatAgents } from "@/commons/hooks/use-chat-agents";
import { useConversation } from "@/commons/hooks/use-conversation";
import { useDraft } from "@/commons/hooks/use-draft";
import { ENTER, useMotionList } from "@/commons/hooks/use-motion-list";
import { useWorkNotes } from "@/commons/hooks/use-notes";
import { usePageFollows } from "@/commons/hooks/use-page-follows";
import { useStickyScroll } from "@/commons/hooks/use-sticky-scroll";
import { doingNow, orchestratorFirst, workingWords } from "@/commons/lib/agents";
import { api } from "@/commons/lib/api";
import { refreshChatLists } from "@/commons/lib/chat-lists";
import { eventWords } from "@/commons/lib/event-words";
import { askedInLog, oldestLine } from "@/commons/lib/group-stream";
import { interleave } from "@/commons/lib/interleave";
import { useMe } from "@/commons/lib/session";
import { startWith } from "@/commons/lib/start-with";
import { ApprovalStrip } from "./ApprovalStrip";
import { ChatLoading } from "./ChatLoading";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";
import { EventPill } from "./EventPill";
import { JobStrip } from "./Jobs";
import { applyMention, matchMentions, mentionToken, orderMentions } from "./MentionMenu";
import { PlanStrip } from "./PlanStrip";
import { applyCommand, matchCommands, slashToken } from "./SlashMenu";
import { ToNewest } from "./ToNewest";
import { EarlierMessage, LiveTurnView, TurnView, UserBubble } from "./Turn";

/** What the composer says under a room's box about a message that tags nobody: the router's answer, in words. */
function untaggedWords(untagged: string | undefined, nameOf: (agentId: string) => string): string {
  return untagged ? `Type @ to tag an agent. No tag: ${nameOf(untagged)} answers.` : "Type @ to tag an agent. No tag: nobody answers here.";
}

/** The colour of what an agent is doing, in the bar over its conversation. */
export const STATUS_TONES = { working: "text-success", success: "text-base-content/65", accent: "text-accent", muted: "text-base-content/65" } as const;

/** What a conversation knows of itself now, for the bar over it and the panels beside it, which its caller draws. */
export interface ConversationNow {
  /** The agent it is with: the daemon's answer, and in a new chat the one it starts with. */
  agentId: string;
  agentName: string;
  look: Look | undefined;
  /** What that agent is doing, and a longer tail of it for where there is room ("in the background"). */
  status: { words: string; more?: string; tone: keyof typeof STATUS_TONES };
  /** The room, when it is one: nobody may have spoken in it yet. */
  room: Room | null;
  /** The chat app a private chat lives on: read here, answered there. */
  elsewhere: string | undefined;
}

export interface ConversationProps {
  sessionId?: string;
  roomChatId?: string;
  /** The agent a new chat starts with (`lib/start-with.ts`). */
  agent?: string;
  agents: ChatAgents;
  /**
   * A new chat's first message has a conversation, and the daemon says which agent's: the Chats page goes to its
   * address, the floating chat keeps its id.
   */
  onSession: (sessionId: string, agentId: string) => void;
  header: (now: ConversationNow) => ReactNode;
  /** Panels beside it, under its bar: an agent's History, its work notes. */
  aside?: (now: ConversationNow) => ReactNode;
  /** A message written for the person to send (`useDraft`), and its giver letting go of it once it is in the box. */
  draft?: { text: string | undefined; onTaken: () => void };
  /** In a room, who answers a message that tags nobody, as the chat list says it. */
  untagged?: string | undefined;
  /** The page each message is written from, read as it is sent: the floating chat's, so the agent is told (`OpenPage`). */
  page?: () => OpenPage;
  /** The box's text, where its caller keeps it past the conversation's own life: the floating chat, while it is closed. */
  box?: [string, Dispatch<SetStateAction<string>>];
  /** Drawn in a panel a phone's width at any window's: what lays itself out by the window's width is told. */
  narrow?: boolean;
  /** A model and an effort picked for a new conversation, read as its first message is sent (`ChatChoice`). */
  firstChoice?: () => { model?: string; effort?: string };
}

const NO_TURNS: readonly LiveTurn[] = [];

export function Conversation({ sessionId, roomChatId, agent, agents: chat, onSession, header, aside, draft, untagged, page, box, narrow = false, firstChoice }: ConversationProps) {
  const queryClient = useQueryClient();
  const me = useMe();

  /**
   * The room, fetched by id rather than read out of the transcript: the bar has to be right before anybody has spoken,
   * and a room created a second ago has no turns and no sessions, only its name and its members.
   */
  const roomQuery = useQuery({ queryKey: ["rooms", roomChatId], queryFn: () => api.room(roomChatId!), enabled: Boolean(roomChatId) });
  const room = roomQuery.data?.room ?? null;

  const orchestrator = chat.orchestrator;
  /** The orchestrator first, as every list of agents has it: the one a new chat opens with when none is named. */
  const agents = orchestratorFirst(chat.agents, orchestrator);
  // In a new chat, the agent its caller named (`lib/start-with.ts`).
  const chosenAgent = startWith(agent, sessionId, agents);
  const own = useState("");
  const [input, setInput] = box ?? own;
  /** The agent's work notes: the plan kept in them is drawn over the box (`PlanStrip`). */
  const workNotes = useWorkNotes(sessionId);

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
    onSession,
    ...(firstChoice ? { firstChoice } : {}),
  });
  // Over a page (the floating chat's): the page follows what the agent does. On Chats there is no page under it.
  usePageFollows(page ? conversation.liveTurns : NO_TURNS);

  /**
   * Which agent this conversation belongs to: the daemon's answer, since a conversation is keyed by (agent, chat) and
   * the transcript on screen *is* one agent's; in a new chat, the one the link named, else the orchestrator.
   */
  const sessionAgent = conversation.session?.agentId ?? conversation.liveTurns[0]?.agentId;
  const selectedAgent = sessionAgent || chosenAgent || orchestrator || agents[0]?.id || "";
  const currentAgent = agents.find((a) => a.id === selectedAgent) ?? agents[0];
  const looks = chat.looks;

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
  useDraft({ draft: draft?.text, onTaken: () => draft?.onTaken(), setInput, textareaRef });

  /**
   * Opens at the newest message, follows the answer as it is written, lets go the moment the reader
   * scrolls up, and goes to the end for what they send. All in one place — see the hook.
   */
  const scroll = useStickyScroll({ container: scrollRef, content: streamRef, resetKey: sessionId });

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
    conversation.send(input.trim(), attachments.ready, page?.());
    // What they send is theirs to see, wherever in the conversation they were reading.
    scroll.toEnd();
    /**
     * The sidebar is asked to catch up immediately, not at its next tick.
     *
     * A brand-new conversation has no row until the daemon records a session, which happens when the
     * turn starts — under two seconds, measured. Waiting for the poll meant sending the first message
     * of a new chat and watching the history not mention it for five, which reads as the message
     * having gone nowhere. The refetch that follows this may still be a moment early; the interval
     * above then catches it, and by then it is quick because something is running.
     */
    refreshChatLists(queryClient);
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
  const working = workingWords(busy, helpers);
  const doing = currentAgent ? doingNow(currentAgent) : undefined;
  const now: ConversationNow = {
    agentId: selectedAgent,
    agentName: currentAgent?.displayName || selectedAgent || "Agent",
    look: looks.get(selectedAgent),
    status: working ? { words: working, ...(helpers > 0 ? { more: " in the background" } : {}), tone: "working" } : { words: doing?.words ?? "", tone: doing?.tone ?? "muted" },
    room,
    elsewhere,
  };

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden">
      {header(now)}

      <div className="relative flex-1 min-h-0 flex overflow-hidden">
        {aside?.(now)}

        <div className="relative flex-1 min-h-0 flex flex-col h-full overflow-hidden" {...drop.handlers}>
          {/* Anywhere in the conversation, not just over the input: a file being dragged is aimed at
              the chat, and a target the size of a text box is a target people miss. */}
          {drop.dragging && <DropOverlay />}
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 flex flex-col">
            {conversation.loading ? (
              <ChatLoading />
            ) : empty ? (
              <EmptyState
                agentName={currentAgent?.displayName}
                look={currentAgent ? looks.get(currentAgent.id) : undefined}
                room={room}
                senderName={senderName}
                narrow={narrow}
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
                    return <EventPill key={key} event={entry.event} words={eventWords(entry.event, { viewer: user?.username, nameOf: chat.nameOf })} motion={motion} />;
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
                        onRevealing={conversation.reveals}
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
          {/* On the Chats page: the floating chat is a few messages tall, and its end a flick away. */}
          {!narrow && scroll.away ? <ToNewest onPress={() => scroll.toEnd("smooth")} /> : null}

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
            {...(room ? { untaggedHint: untaggedWords(untagged, chat.nameOf) } : {})}
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
