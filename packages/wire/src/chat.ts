/**
 * Conversations (`routes/chat.ts`, `routes/conversations.ts`, `routes/rooms.ts`): sessions, transcripts, the live turn
 * and its steps, rooms, and what a chat says happened in it.
 */

import type { TurnEventData, TurnStepKind } from "@nouride/shared";

export interface ChatMessageStep {
  name: string;
  text: string;
  at?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
  steps?: ChatMessageStep[];
}

export interface SessionSummary {
  id: string;
  agentId: string;
  chatId: string;
  gatewayId: string;
  updatedAt: number;
  /** A turn is running in it right now — what draws the spinner in the list. */
  running?: boolean;
  /** The first thing asked in it. `web-1757003921` names nothing; the question does. */
  title?: string;
}

/**
 * One thing the agent did, with how long it took.
 *
 * `kind` separates what it *said to itself* from what it *did*: `reasoning` is the model's own account
 * of what it is working out, `tool`/`tool_done` bracket a call, `waiting` is parked on a human, and
 * `note` is the daemon remarking on a call without being its result — a spilled output, which arrives
 * before the result and was read as one until it had a kind of its own.
 *
 * `steer` and `steer_reply` are said rather than done: a message sent while the turn worked, and what its
 * sender was told back at once. Drawn as the conversation inside the turn, never as steps of it.
 */
export interface TurnStep {
  seq: number;
  at: number;
  kind: TurnStepKind;
  text: string;
  /** Since the previous step, or since the turn began. Computed by the daemon from its own clock. */
  ms: number;
  /** The call a step pairs by, and the tool — absent on a turn recorded before 0.7.6. */
  callId?: string;
  name?: string;
  /** A result's failure, and how — `exit` is a command answering no, the rest the call not doing its job. */
  error?: boolean;
  outcome?: TurnEventData["tool_done"]["outcome"];
  /** A `steer` that is a person's edit: the message it changes (stream 1.3). Absent from a daemon before it. */
  editOf?: string;
}

export type TurnStatus =
  /** In flight. The only status a client polls. */
  | "running"
  /** Finished and answered. */
  | "done"
  /** Threw. `error` carries what the person was told. */
  | "failed"
  /** Somebody pressed stop. */
  | "cancelled"
  /**
   * Cut short by a restart: a turn the shutdown could not wait for, or one a dead daemon left `running`,
   * which the next boot closes. What it did is in the conversation either way.
   */
  | "interrupted";

/**
 * Why a turn was started other than by a message as it was sent. The daemon's own reasons, for a turn nobody typed: the
 * chat headed one by matching the wake-up message's words — rewording a sentence there changed what the chat said had
 * happened — so the reason travels as data. And a person's edit (`EDITED`): the turn answers a message as edited.
 */
export interface TurnCause {
  /**
   * What pushed it: `job completion`, `job quiet`, `schedule` (`SCHEDULED` in the engine's `turns.store.ts`) — a cron
   * job's own run — or `edit` (`EDITED`). Or (0.7.26) `delegate` or `ask_agent`: a delegate's own turn, working in the
   * background as the job `job`.
   */
  via: string;
  job?: string;
  /** A delegate's own turn: the turn whose call started it — where its model calls and audit rows are counted. */
  parent?: string;
  /** How the job ended, for a completion. */
  outcome?: "finished" | "failed" | "stopped" | "interrupted";
  /** For an edit: the platform id of the message edited — the turn's own message when it was edited while it waited. */
  of?: string;
  /** The job was a helper `delegate` started in the background (0.7.15), whose report this turn gives. */
  helper?: true;
  /** The job was an ask that moved to the background (0.7.19): the agent asked, whose answer this turn passes on. */
  asked?: string;
}

/**
 * One exchange, as the daemon recorded it.
 *
 * The transcript is made of these rather than of chat messages, which is what makes a reload show the
 * same thing the live view showed: the steps, the clock and the reply all come from the daemon, and
 * none of them are reconstructed here.
 */
export interface ChatTurn {
  id: string;
  agentId: string;
  /** The chat inside the conversation — what a stop is addressed by. */
  chatId: string;
  /**
   * The session that owns this turn.
   *
   * A file URL has to name it: the route treats the session in the path as a permission and refuses
   * a turn belonging to another. Building those URLs from the conversation the page had open was
   * right in a one-to-one chat and wrong in a room, where it is one member's session — so every
   * attachment from any other member came back 404 and drew a broken image.
   */
  sessionId?: string;
  /** Nobody typed this: a background job finishing woke the agent. Not drawn as the operator's words. */
  system?: boolean;
  /**
   * Who asked, in a conversation on a chat app: their name under People, else the name their app shows. Absent in the
   * dashboard's own conversations, where the one asking is the person reading, and from a daemon older than the field.
   */
  senderName?: string;
  /** Why the daemon started it, as data — absent on a turn from before 0.7.8. */
  cause?: TurnCause;
  /** Files sent with the question. Metadata only — the bytes live in the agent's attachment store. */
  attachments?: TurnAttachment[];
  status: TurnStatus;
  prompt: string;
  reply: string;
  error?: string;
  model?: string;
  toolCalls: number;
  /**
   * Model round trips.
   *
   * The number that decides what a turn cost: every round trip re-sends the whole conversation, so
   * five tool calls in one and five in five are the same work at very different prices.
   */
  iterations?: number;
  inputTokens?: number;
  outputTokens?: number;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  steps: TurnStep[];
}

/** The running (or most recent) turn, plus the cursor to ask from next time. */
export interface LiveTurn extends ChatTurn {
  cursor: number;
}

/**
 * A slash command the daemon handles itself, instead of an agent turn.
 *
 * `command` carries its leading slash, exactly as it is typed.
 */
export interface SlashCommand {
  command: string;
  description: string;
}

/** A file the daemon has taken and can attach to a turn. */
export interface UploadedFile {
  /** Where it landed. Only `/chat/send` accepts this, and only from the uploads directory. */
  path: string;
  name: string;
  mimeType: string;
  bytes: number;
}

/**
 * A file on a turn — sent by the person, or back by the agent.
 *
 * `url` is relative to the control API and addresses the file by its position on the turn; the daemon
 * is the only thing that knows where it lives on disk. Absent when the bytes were never saved (a
 * download that failed, or a file older than the retention sweep).
 */
export interface TurnAttachment {
  name: string;
  mimeType: string;
  kind: string;
  bytes?: number;
  direction: "in" | "out";
  url?: string;
}

/** Work still running in the background of this conversation. */
export interface RunningJob {
  id: string;
  /** `helper: <goal>` for a helper `delegate` started (0.7.15); `ask <agent>: <task>` for an ask that moved there (0.7.19). */
  command: string;
  startedAt: number;
  /** Absent from a daemon before 0.7.15; `ask` from 0.7.19. */
  kind?: "command" | "helper" | "ask";
}

export interface ChatSession {
  id: string;
  agentId: string;
  chatId: string;
  gatewayId: string;
  updatedAt: number;
  /** False for a conversation that happened on Telegram or Discord: readable here, answered there. */
  writable: boolean;
}

/**
 * What happened in a chat, for the wording and the icon: a chat event's kind (`chat-events.store.ts` in the engine).
 *
 * A closed set rather than free text, because the dashboard renders each differently and an
 * unrecognised kind should be a compile error here rather than a blank pill there.
 */
export type ChatEventKind =
  /** An agent or a person was added to the room. */
  | "joined"
  | "left"
  /** The room's subject changed. */
  | "topic"
  /** The conversation moved to another gateway, or arrived from one. */
  | "moved"
  /** A message the daemon could not take — a full queue, a rate limit. */
  | "dropped"
  /** Somebody was tagged and the router could not tell who. */
  | "ambiguous"
  /** An agent-to-agent chain reached its hop budget and stopped. */
  | "hop_budget"
  /**
   * One agent in this room asked another to do something.
   *
   * Recorded only in a room that holds more than one agent, because the point of it is the agents
   * who are *not* involved: without it they see nothing, and a third agent can answer as though
   * nothing were in progress or start the same work again. In a one-to-one chat there is nobody to
   * tell, and the line would land in the prompt of the agent that wrote it.
   */
  | "delegated"
  /** The daemon restarted while this conversation was open. */
  | "restart"
  /** A credential a person sent was taken out of their message before anything kept it (`pipeline/chat-secrets.ts`). */
  | "secret"
  /** Anything a caller writes deliberately, with its own sentence. */
  | "note";

/**
 * Something that happened *to* a conversation, rather than something said in it.
 *
 * `audience` is what the daemon decides and this client only displays: `"agents"` means the sentence
 * was also composed into each agent's next prompt, `"ui"` means it never reaches a model. Shown
 * either way — the distinction is about the model's context, not about who may read it.
 */
export interface ChatEvent {
  id: string;
  gatewayId: string;
  chatId: string;
  audience: "agents" | "ui";
  kind:
    | "joined"
    | "left"
    | "topic"
    | "moved"
    | "dropped"
    | "ambiguous"
    | "hop_budget"
    /** One agent in this room asked another to take something on. */
    | "delegated"
    | "restart"
    /** A credential a person sent was taken out of their message before anything kept it. */
    | "secret"
    | "note";
  text: string;
  agentId?: string;
  actor?: string;
  details?: Record<string, unknown>;
  at: number;
}

/**
 * A conversation with one person and several agents in it.
 *
 * `title` absent means nobody named it and the client shows the member list — derived here rather
 * than stored, because a name built at creation stops being right the moment a member is added.
 */
export interface Room {
  gatewayId: string;
  chatId: string;
  title?: string;
  createdBy?: string;
  createdAt: number;
  /**
   * When it was last used — the newest of its creation, its messages and its turns.
   *
   * Derived by the daemon rather than stored, and it is what the sidebar sorts on: a room ordered by
   * its creation date sinks down the list while it is the one being used.
   */
  updatedAt?: number;
  /**
   * True while an agent is mid-turn in it.
   *
   * From the daemon, not from this tab's own state, so a turn somebody else started shows too — the
   * same rule the session list's `running` follows.
   */
  running?: boolean;
  members: { agentId: string; addedBy?: string; addedAt: number }[];
}

export interface RoomMessage {
  id: string;
  gatewayId: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string;
  attachments?: { name: string; mimeType: string; kind: string }[];
  at: number;
}

export interface Transcript {
  session: ChatSession | null;
  /**
   * The conversation from before the oldest turn the daemon still keeps, read from the agent's own
   * session — messages only, no steps or timings. Always empty for a room.
   */
  earlier: ChatMessage[];
  turns: ChatTurn[];
  /**
   * Room events, newest first, for the whole chat rather than this agent's side of it.
   *
   * Their own list rather than folded into `turns`: a turn has a question, an answer and steps, and
   * an event has a sentence and a kind. One shape carrying both would make every field on a turn
   * optional and every reader of a turn check which of the two it received.
   */
  events?: ChatEvent[];
  /**
   * Set when these turns span a room rather than one agent's side of a conversation.
   *
   * Sent by the daemon rather than inferred from the member list, so the client and the router
   * cannot disagree about what kind of conversation this is.
   */
  room?: Room | null;
  /**
   * What people said in this room, whether or not anybody answered.
   *
   * Rooms only, and it is what makes a room a conversation rather than a list of answered questions:
   * an untagged message produces no turn, and its bubble comes from here. A message two agents
   * answered appears here once, with each reply attached by `messageId`.
   */
  messages?: RoomMessage[];
}
