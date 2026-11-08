/** Unified message envelope — §5.1–5.3 SPEC. */

/**
 * `local` is not a chat platform — it is the in-process gateway the HTTP test endpoint and,
 * later, a CLI speak through. It is a real platform rather than a special case so a message
 * injected that way travels the identical path: routing, hooks, queue, executor, session.
 */
export type GatewayName = "discord" | "telegram" | "whatsapp" | "web";

export type ChatType = "dm" | "group" | "channel";

export type AttachmentType = "image" | "audio" | "video" | "file" | "voice";

export interface Attachment {
  type: AttachmentType;
  /** Remote URL inbound before download, local path once stored. */
  url?: string;
  /** Raw bytes for inline processing. Avoid holding these longer than a turn. */
  buffer?: Uint8Array;
  mimeType: string;
  filename?: string;
  size?: number;
  /** Seconds, for audio and video. */
  duration?: number;
  caption?: string;
  /**
   * The message was forwarded from somebody else.
   *
   * Decides whose words a voice note is. One the sender recorded is them talking to the agent, with
   * the authority of anything they type; a forwarded one is a recording of someone else, and what is
   * said in it is content to report. Absent where a platform does not say.
   */
  forwarded?: boolean;
  /**
   * Recorded in the app by the sender, the way a voice note is — a Telegram video note. What is said
   * in it is them talking, as with a voice note; an ordinary video could be anybody.
   */
  recordedBySender?: boolean;
  /**
   * The message it came with and its place in it, where a burst of media was folded into one message (the pipeline's
   * batcher). A file's ref is derived from these, and the folded message's id is the last one's: without them every
   * file of the burst was looked up under that one, and the second photo's ref pointed at the first photo's file.
   * Absent on a message nothing was folded into — its own id and position are the file's.
   */
  from?: { message: string; position: number };
}

/**
 * A person's edit of a message they sent (0.7.14): what an adapter says about one, and what the engine adds.
 */
export interface MessageEdit {
  /** The platform's id of the message the edit changes — what a reply to the edit quotes. */
  of: string;
  /** When that message was first sent, where the platform says: what makes an edit recent (`pipeline/edits.ts`). */
  sentAt?: number;
  /** What the message said before this edit, where the engine still holds it. The engine's to fill, never an adapter's. */
  was?: string;
}

/**
 * Every gateway normalizes to this before the router sees it. Agents never learn
 * which platform a message came from except through `gateway`, which exists for
 * formatting decisions, not routing logic.
 */
export interface MessageEnvelope {
  id: string;
  timestamp: number;
  /** Platform, for formatting decisions. */
  gateway: GatewayName;
  /**
   * Which connection this arrived on (`telegram:nouva`).
   *
   * Distinct from `gateway`: the platform decides how to format a reply, the instance
   * decides where to send it and whose conversation it belongs to.
   */
  gatewayId: string;
  /** Normalized chat id. Includes thread/topic id when the platform has them. */
  chatId: string;
  chatType: ChatType;
  senderId: string;
  senderName: string;
  /**
   * Did *this daemon* authenticate the sender, rather than a platform vouching for a handle?
   *
   * True for a message from a signed-in dashboard account: the name and id come from a row in this
   * daemon's own users table, reached with a password it verified. False (absent) for every chat
   * platform, where `senderName` is a string the sender typed into their own profile.
   *
   * The distinction is not cosmetic — it decides whether the agent is told the name at all in a
   * one-to-one chat. An unverified display name adds nothing there but a chance to be misread as
   * identification; a verified one is the answer to "who am I talking to". Kept as a property of the
   * *message* rather than of the gateway, because that is what it is: a future transport with signed
   * senders sets the same flag, and nothing has to learn a list of trusted platforms.
   */
  senderVerified?: boolean;
  text: string;
  replyTo?: string;
  /**
   * The message this one is replying to, as context — **not** part of `text`.
   *
   * Separate on purpose. The gateways used to prepend `> [Name]: …` to `text`, which is the field the
   * command parser, the slash-command queue bypass and the mention router all read. Replying to the
   * approval prompt with `/approve` — the obvious way to answer one — then produced text starting with
   * `>`, so it stopped being a command at all: no bypass, no hook, sent to the model as chat. A quoted
   * `@othername` rerouted the reply to whoever it named, too.
   *
   * The pipeline composes this into what the model sees, once routing and command parsing are done.
   */
  quotedText?: string;
  /** Who wrote `quotedText`, when the platform says. Shown to the model beside the quote. */
  quotedSender?: string;
  /**
   * The platform says this message was forwarded from somebody else — its text is outside content, whoever sent it
   * on. Absent where a platform does not say.
   */
  forwarded?: boolean;
  /**
   * What of this message's own text came from outside the conversation, named — a webhook's payload in a scheduled
   * job's prompt. Set by the engine where it builds a message; a platform's fact of the same kind is `forwarded`. A
   * turn answering either counts as having read outside content from its first step.
   */
  outsideContent?: string[];
  /** Agent ids the message mentions, resolved by the gateway. */
  mentions?: string[];
  /**
   * True when the platform says a bot wrote this.
   *
   * The adapter reports it; the daemon decides what it means. Whether a *particular* bot is one of
   * ours is knowledge the adapter does not have — with several agents behind one token, the platform
   * cannot tell them apart either, and the answer comes from what we recorded when we sent it.
   */
  senderIsBot?: boolean;
  /**
   * The platform resolved a mention of **this connection's own bot identity**.
   *
   * Separate from `mentions` because that list is raw platform strings, and a bot's platform name is
   * not its agent's name: `@Nero | Infra Agent` is the Discord username of the bot that owns the
   * agent `nero`, and nothing matched the two. Six bots shared a channel, one of them was tagged, and
   * because the tag resolved to nobody every gateway fell through to "my owner answers" — so all six
   * replied, none of them because it had been addressed.
   *
   * The adapter is the only thing that knows its own id on its own platform, so it answers this
   * question rather than exporting the id for the engine to compare.
   */
  mentionsSelf?: boolean;
  /**
   * The platform says the message this one replies to was written by **this connection's own identity**.
   *
   * Who wrote a quoted message is otherwise read from the outbound record (`OutboundRegistry`), which is right when
   * several agents share one bot — and in memory, sixty messages a chat. After a restart, or a reply to something older,
   * it knows nothing, and a reply that addressed the agent as plainly as a tag reached nobody: in a room that answers
   * only when addressed, silence. Live (2026-10-21, a WhatsApp group): a reply to Nouva's answer went unanswered until
   * she was tagged. The platform knows who wrote the quoted message and the adapter knows its own id, so it answers this
   * the way it answers `mentionsSelf`.
   */
  repliesToSelf?: boolean;
  /**
   * `id` means something only to the connection that received it.
   *
   * A Telegram *basic* group gives each account its own message numbering: one message is 57 to one
   * bot and 102 to the other. Everything that treats the id as the platform's — the one-turn claim,
   * the reply quote — breaks across connections there: two bots each claimed "their" message and the
   * agent answered twice, and an answer sent through the agent's own bot quoted an id that bot had
   * never seen ("message to be replied not found"). Supergroups, and every other platform, number
   * per chat and leave this unset.
   */
  idsPerConnection?: boolean;
  /**
   * The agent that wrote the message this one is answering, when we can tell.
   *
   * Two uses, both about a message coming back: a human hitting reply on something an agent said, and
   * one agent's message arriving as an inbound event.
   */
  fromAgent?: string;
  /**
   * How many agent-to-agent hops led here. Absent means a human started it.
   *
   * The hard brake on a conversation between agents. The soft one is the convention that a mention
   * hands work over and a reply without one closes it — but a model cannot be relied on to not do
   * something, and every hop is a paid provider call.
   */
  agentHops?: number;
  attachments?: Attachment[];
  /**
   * A requirement this turn's **final message** must satisfy, whatever else the turn does.
   *
   * Only set on messages this engine synthesizes — today, a background job waking its agent. It rides
   * on the envelope for the same reason `agentHops` does: the fact is invented where the message is
   * invented, and reading it back later would mean re-deriving something already known.
   *
   * It exists because an instruction in a turn's opening prompt does not survive the turn. A wake-up
   * that then reads three files and starts a build ends with the model writing prose whose freshest
   * context is the build — so the report the wake-up existed to deliver goes missing, and no rewording
   * of the opening prompt reaches far enough to stop it. This is delivered at the tail instead.
   */
  owedReport?: string;
  /**
   * A line the daemon must post in the chat when this turn *starts*.
   *
   * For a fact the engine already holds and will not leave to a model — today, that a background job
   * failed. It rides on the envelope rather than being sent when the fact is discovered, and the
   * difference is ordering: sending it at discovery time jumped the queue. Watched live, the ⚠️ line
   * landed at 22:06 and the turn explaining it began at 22:07:56, with an unrelated answer in between
   * — so a failure notice sat on its own, eighty seconds from its own explanation.
   *
   * Posted from the turn instead, it is adjacent to the reply that interprets it, which is the only
   * arrangement in which either message means anything.
   */
  announce?: string;
  /**
   * The ids of the messages a burst of media folded into this one — the pipeline's batcher. The inbox
   * settles each of them with this one, so a burst is answered once and recorded whole.
   */
  mergedIds?: string[];
  /**
   * This is a person's edit of a message they sent earlier: `text` and `mentions` are what that message says
   * now, `edit.of` names it, and `id` is the edit's own — an edit is not the message it changes, and the claim, the
   * inbox and the queue each know a message by its id. Words only: a file in an edited message is not sent again.
   *
   * The engine sets it too, with `of` the message's own id, on a message still waiting for its turn when it was
   * edited: it is answered as corrected, and its turn says so (`pipeline/edits.ts`).
   */
  edit?: MessageEdit;
  /**
   * The credentials the engine took out of `text` and `quotedText` as the message arrived, each a handle in its place
   * now (`$TMP_SECRET_…`): what the model is told each handle stands for. The values are in daemon memory only. The
   * engine's to set, never an adapter's.
   */
  secrets?: TakenSecret[];
  /** A person asked for this message as they wrote it (`/secret undo`): nothing in it is taken as a secret. The engine's. */
  asWritten?: boolean;
  /**
   * The message a thread was started from, when this room is a thread that has one (0.7.24): the adapter fills it — a
   * Discord thread's starter message — and the engine puts it in front of the first question of a conversation there,
   * so the agent knows what the thread is about. Never for a message that is itself the thread's start.
   */
  threadOpener?: ThreadOpener;
  /** Original platform payload, for gateway-specific features. Never sent to the LLM. */
  raw: unknown;
}

/** What a thread was started from (`MessageEnvelope.threadOpener`). */
export interface ThreadOpener {
  /** Who wrote it: their platform id, and the name the platform shows — the engine names them by `[[people]]`. */
  senderId: string;
  senderName: string;
  text: string;
  /** The room it was written in, by the platform's name for it: `#general`. Absent where unknown. */
  where?: string;
}

/** A credential taken out of a message: the handle that stands in its place, and what it looked like. */
export interface TakenSecret {
  /** `$TMP_SECRET_…`, as the message now says it. */
  handle: string;
  /** "a GitHub token". */
  label: string;
}

export interface OutboundMessage {
  /** Instance to send through. The engine never has to know which platform that is. */
  gatewayId: string;
  chatId: string;
  text: string;
  replyTo?: string;
  mentions?: string[];
  attachments?: Attachment[];
  /**
   * Ask the platform not to decorate a link in this message.
   *
   * For status lines, not for answers. A progress line naming `exec python3 … https://…` made Telegram
   * render a full preview card for a URL that happened to appear inside a script — a page nobody asked
   * about, dominating a line that exists to say one thing. An answer that cites a link still wants the
   * preview, which is why this is per message rather than a setting.
   */
  suppressPreview?: boolean;
  /**
   * Called once the platform has the message, when that happens later than `send` returns: a message
   * buffered because the connection was down, or the rest of one that failed part-way, flushed afterwards.
   * How a turn's reply is marked delivered when it did not land at once (`turn_records.delivered_at`).
   */
  onDelivered?: () => void;
  /**
   * Buttons under the message, in one row — on a gateway that carries them (`Gateway.buttons`); one that does not sends
   * the text alone. A press comes back as a `ButtonPress` (`Gateway.onPress`) carrying the button's `data`.
   */
  buttons?: MessageButton[];
}

/** One button under a message: what it says, and what a press on it reports back — opaque to the gateway. */
export interface MessageButton {
  label: string;
  /** What the press carries back. At most 64 bytes: Telegram refuses more. */
  data: string;
  /** How it is drawn, where the platform draws buttons differently: a yes, a no, or neither. */
  style?: "positive" | "negative";
}

/** A message the engine synthesizes rather than receives — cron, bus, heartbeat. */
export interface SystemEvent {
  kind: "cron" | "agent_bus" | "heartbeat" | "gateway";
  agentId: string;
  text: string;
  timestamp: number;
  /** Where a reply should go, when the event wants one delivered. */
  origin?: { gatewayId: string; chatId: string };
}
