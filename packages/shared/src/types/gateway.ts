/** Gateway contract and resilience settings — §5.3–5.5 SPEC. */

import type { Attachment, ChatType, GatewayName, MessageButton, MessageEnvelope, OutboundMessage } from "./envelope.ts";

/** Somebody pressed a button under a message this gateway sent (`OutboundMessage.buttons`). */
export interface ButtonPress {
  /** The connection the message is on — the instance it was sent through. */
  gatewayId: string;
  chatId: string;
  chatType: ChatType;
  /** The message the button is under. */
  messageId: string;
  /** What the button carries — its `MessageButton.data`. */
  data: string;
  /** Who pressed it: their id on the platform, and the name they go by there. */
  senderId: string;
  senderName: string;
}

/**
 * What becomes of a press, said by the engine and carried out by the gateway the way its platform does it. Both absent
 * is a press acknowledged and nothing more.
 */
export interface PressAnswer {
  /** A line for the person who pressed, and nobody else: Telegram's answer to the press, Discord's reply only they see. */
  notice?: string;
  /** The message rewritten to this, its buttons gone: what it asked is settled. Markdown, as `send` takes it. */
  settled?: string;
}

/**
 * An attachment's download, its body not yet read — what an adapter that fetches over the network hands the
 * engine. The engine refuses a declared length past its cap before reading a byte, writes the body to disk as it
 * arrives, counting, and stops the moment the count passes the cap: a platform that did not say how big a file
 * is, or said wrong, can no longer put the whole of it in memory first.
 */
export interface AttachmentStream {
  /** `content-length`, when the server sent one. A claim, so the body is still counted. */
  declaredBytes: number | null;
  body: ReadableStream<Uint8Array>;
}

export type GatewayStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "dead";

export interface GatewayResilienceConfig {
  maxReconnectAttempts: number;
  reconnectBackoffMs: number;
  reconnectBackoffMaxMs: number;
  reconnectBackoffMultiplier: number;
  healthCheckIntervalMs: number;
  /**
   * How long a connection must hold before its retry budget is handed back.
   *
   * Optional so the per-platform defaults elsewhere do not all have to name it; `DEFAULT_RESILIENCE`
   * supplies the value. See `BaseGateway` for what goes wrong without it — a `connect()` that resolves
   * is not yet a connection that works, and crediting it immediately turns a repeating failure into an
   * unbounded sub-second retry loop that never reaches `maxReconnectAttempts`.
   */
  connectionStableAfterMs?: number;
  /** How long the teardown before a connect may take before the connect goes ahead without it — `BaseGateway`. */
  teardownTimeoutMs?: number;
}

export const DEFAULT_RESILIENCE: GatewayResilienceConfig = {
  maxReconnectAttempts: 10,
  reconnectBackoffMs: 1000,
  reconnectBackoffMaxMs: 60_000,
  reconnectBackoffMultiplier: 2,
  healthCheckIntervalMs: 30_000,
  connectionStableAfterMs: 60_000,
  teardownTimeoutMs: 30_000,
};

export type GatewayEvent =
  | { type: "status"; gatewayId: string; status: GatewayStatus; error?: string }
  /** `auth_failed`: the platform refused its credentials, so no reconnect was tried past the first. */
  | { type: "dead"; gatewayId: string; attempts: number; reason?: "auth_failed"; detail?: string }
  | { type: "session_expired"; gatewayId: string }
  /**
   * The platform accepted a message and then refused to deliver it.
   *
   * Its own category because it is not a connection problem and no amount of reconnecting fixes it:
   * the gateway is healthy, the send returned, and the platform said no afterwards. WhatsApp does
   * this when an account is restricted from starting new chats, and it cost a day of staring at an
   * empty chat while every log on both sides reported success.
   */
  | {
      type: "delivery_refused";
      gatewayId: string;
      chatId: string;
      /** Platform code, e.g. WhatsApp's `463`. */
      code: string;
      /** What an operator can do about it, in words. */
      reason: string;
      /** True when retrying makes the situation worse rather than better. */
      terminal: boolean;
    };

/**
 * Implemented once per platform, instantiated once per connection.
 *
 * `send` is expected to handle platform limits itself — chunking Discord's 2000 chars,
 * Telegram's markdown escaping — so the engine can hand it arbitrary text.
 */
export interface Gateway {
  /** Instance id, `platform:name`. */
  readonly id: string;
  readonly platform: GatewayName;
  readonly status: GatewayStatus;
  /**
   * The exact text another agent writes to tag this bot on this platform.
   *
   * `<@1111111111111111111>` on Discord, `@some_bot` on Telegram — the syntax belongs to the adapter,
   * and the engine only passes the token through to the prompt. That is what keeps this out of the
   * engine: it would otherwise have to know which platform spells a mention which way.
   *
   * An id rather than a name wherever the platform has one. A bot's display name is whatever its
   * application is called and can be renamed at any time; the id cannot. Naming was what the first
   * version relied on, and `@Nero | Infra Agent` matched nothing.
   *
   * Absent before the connection is up, or on a platform with no mentions.
   */
  readonly selfMention?: string | undefined;

  /**
   * This connection's own account id on the platform, unformatted — `1111111111111111111` on
   * Discord, not `<@1111111111111111111>`.
   *
   * Known the moment the connection is up, unlike `OutboundRegistry`'s per-message record of who
   * sent what: that is written only after this daemon's own `send()` call returns, and a sibling
   * connection's inbound copy of the very same message can reach the router before that write
   * lands — a plain race between an HTTP response and a websocket push, with nothing ordering
   * the two. Comparing a sender id against every other connection's own id sidesteps the race
   * entirely, at the cost of only ever answering "which agent's bot is this", not "which agent
   * wrote this particular message" — the latter still needs the registry, for the case where
   * several agents share one bot token.
   *
   * Absent before the connection is up, or on a platform this was never given for.
   */
  readonly selfId?: string | undefined;

  /**
   * What the agent is told about writing for this platform — one line of its prompt: how markdown is sent, how wide
   * the screen is, a length the platform splits at. The adapter knows its platform; the engine said it for each
   * platform by name until 0.7.11, and keeps a line only for a connection that says nothing (the dashboard's).
   */
  readonly formatting?: string | undefined;

  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Put a message on the wire.
   *
   * Answers the platform's ids for what it sent — one per chunk, because a long reply is several
   * messages and a human can reply to any of them. Empty when the platform gave none, or when the
   * send was buffered for a reconnect: the caller treats "no ids" as "nothing to remember", which is
   * exactly right in both cases.
   */
  send(msg: OutboundMessage): Promise<string[]>;

  /** Show the platform's "typing" affordance. No-op where unsupported. */
  setTyping(chatId: string): Promise<void>;
  /**
   * Mark an inbound message read, where the platform shows it.
   *
   * Optional, because "read" is not a concept every platform has — a gateway that cannot show it
   * should not be forced to declare a method that does nothing.
   *
   * Called after the daemon accepts a message, never on arrival: a read marker on a message that is
   * then dropped tells the sender they were seen by something that is ignoring them.
   */
  markRead?(chatId: string, messageId: string): Promise<void>;

  /**
   * Rewrite a message this gateway already sent. `false` when it could not be done.
   *
   * Optional, like `fetchAttachment`: a gateway with no concept of editing simply omits it, and the
   * engine falls back to saying nothing rather than pretending.
   *
   * Exists for one thing — showing what a turn is doing while it does it. The alternative, a fresh
   * message per step, is what it replaces: a twenty-iteration turn becomes twenty messages and, on a
   * phone, twenty notifications. An edit re-notifies nobody, which is the whole reason this is a
   * capability rather than more `send` calls.
   */
  editMessage?(chatId: string, messageId: string, text: string): Promise<boolean>;

  /**
   * Fetch an inbound attachment: its bytes, its download still on the wire, or `null` when it cannot be retrieved.
   *
   * The adapter does the fetching because only it knows how: Telegram needs `getFile` plus the bot
   * token to mint a link that expires in an hour, Discord has a direct CDN URL. The engine decides
   * *where* the bytes go, how big is too big and how long is too long — one policy, not one per platform:
   * `signal` is its deadline, and every request the adapter makes for this file is to carry it.
   *
   * A download comes back as an `AttachmentStream`, unread, so it never sits whole in memory. Bytes are for a
   * file already on this machine, which is the size it is.
   *
   * Optional: a gateway with no attachment concept (the in-process `local` one) simply omits it,
   * and the engine reports that the file could not be retrieved rather than pretending.
   */
  fetchAttachment?(attachment: Attachment, signal?: AbortSignal): Promise<Uint8Array | AttachmentStream | null>;

  /**
   * Sync the daemon's slash commands to this platform's command menu.
   *
   * Replaces the platform's command list wholesale: commands we have but the platform
   * doesn't get added, commands the platform has but we don't get removed, commands on
   * both get updated. A no-op on platforms with no command menu (e.g. WhatsApp).
   *
   * `commands` carries bare names (`"help"`, not `"/help"`) and short descriptions.
   */
  syncCommands?(commands: { command: string; description: string }[]): Promise<{ synced: number }>;

  /**
   * True when this gateway's client puts approvals to the operator itself.
   *
   * The engine posts an "I am waiting on you" notice into the conversation, because a chat platform
   * otherwise shows the agent falling silent for the whole approval timeout. The `local` gateway's only
   * client is the CLI, which polls `/approvals` and prompts inline — so the notice is a duplicate, and a
   * worse one than it sounds: the CLI delivers replies when the turn *ends*, so the notice lands after
   * the approval was already answered, describing a state that has passed.
   *
   * A capability the adapter declares rather than a check on the gateway id, so the engine keeps having
   * no idea which platform it is talking to.
   */
  readonly promptsApprovals?: boolean;
  /**
   * A connection the daemon runs for itself — a mission's conversations (0.8.0) — rather than one a person connects:
   * left out of the lists of connections (`/health`, `/status`), where it would read as one more platform to check.
   */
  readonly internal?: boolean;
  /**
   * Show the bot's own presence — online, idle, do not disturb — following its agent's status (0.8.0). A capability:
   * only a platform that shows one has it; setting a bot's own presence needs no permission there.
   */
  setPresence?(presence: GatewayPresence): void;

  /**
   * False when this transport has no addressable message ids.
   *
   * `send` answers with ids so a human's reply can be traced back to what it answered. A gateway with
   * no such thing returns an empty array — and the caller cannot tell that apart from "the platform
   * refused it", which is the same array.
   *
   * That ambiguity shipped: `send_file` in the dashboard reported `could not be delivered — the gateway
   * did not accept it` for two images that were delivered, were on screen, and were in the transcript.
   * The agent then told the operator the gateway was broken and asked them to restart the daemon. A
   * tool that says the opposite of what happened is worse than one that fails, because the failure is
   * the part the model passes on.
   *
   * Declared here rather than inferred, so nothing has to branch on which platform it is talking to.
   * Absent means "this transport has ids", which is true of every chat platform.
   */
  readonly addressableMessages?: boolean;

  /**
   * How much of a turn's working-out this platform should carry.
   *
   * `"live"` is the edited bubble that tracks each tool as it runs — right for a channel that exists
   * for the work: a Telegram bot, a Discord channel where a turn's steps are the interesting part.
   *
   * `"summary"` shows nothing while the turn runs and leaves one closing line — `✓ 5 steps · 57s`.
   * For a platform that is somebody's personal messenger, where a live trace of `exec sh -c node -v`
   * arriving between two sentences reads as the tool talking over the conversation. The line at the
   * end still says work happened, and how much.
   *
   * Declared by the adapter, for the same reason as `addressableMessages` above: it is a fact about
   * the platform, and nothing in the engine may branch on which platform it is talking to. Absent
   * means `"live"`.
   */
  readonly progressStyle?: "live" | "summary";

  /**
   * False when this transport does not hand our own messages back to us — to this connection or to
   * any other bot of ours in the room.
   *
   * Discord does: it delivers a bot's message to every other bot in the room, which is how one agent's
   * reply becomes another agent's inbound event — the mechanism the whole shared-room feature is built
   * on. Telegram does not: a bot never receives another bot's messages, so there the engine carries
   * room history and handovers itself. It is also how a room's history gets recorded, because
   * `RoomMemory.observe` runs on inbound messages and an agent's reply arrives as one.
   *
   * The local gateway is the exception, and it is the one the dashboard uses. `send` pushes the reply
   * to a waiting HTTP caller or to the turn record; nothing comes back through `onMessage`. So an
   * agent's reply in a dashboard room was never observed, and a second agent tagged afterwards was
   * handed a room history with the other agents' turns missing from it — one message of context where
   * there had been four. The engine now echoes those messages into room memory itself when this is
   * false, which is why the fact has to be declared rather than guessed.
   *
   * Absent means "this transport echoes". Declared by the
   * adapter for the same reason as the two flags above: nothing in the engine may branch on which
   * platform it is talking to.
   */
  readonly echoesOwnMessages?: boolean;

  /**
   * True when a message this gateway sends can carry buttons (`OutboundMessage.buttons`) and a press on one comes back
   * to `onPress`. Absent means it cannot, and a message is sent as its text alone — so whoever asks something
   * says how to answer it in words too.
   *
   * Declared by the adapter, like `progressStyle`: nothing in the engine may branch on which platform it is talking to.
   */
  readonly buttons?: boolean;

  /**
   * Where a press on one of this gateway's buttons goes: the engine decides what it means and answers it (`PressAnswer`),
   * and the gateway carries the answer out — the notice to the person who pressed, the message settled. Always answered:
   * a platform shows a press as pending until it is (Telegram's spinner, Discord's three seconds).
   */
  onPress?(handler: (press: ButtonPress) => Promise<PressAnswer>): void;

  /**
   * Rewrite a message this gateway sent with buttons to `text`, and take its buttons away: what it asked is settled,
   * however it was answered. `false` when it could not be done. Markdown, as `send` takes it.
   *
   * `keep`, the buttons it goes on carrying: a question still open, said again — how many more wait behind it (0.8.7).
   * A plain `editMessage` cannot do that: Telegram drops a message's keyboard from any edit that does not repeat it.
   */
  settleButtons?(chatId: string, messageId: string, text: string, keep?: readonly MessageButton[]): Promise<boolean>;

  /**
   * The platform's own name for a room (0.7.24): a WhatsApp group's subject, a Telegram group's title, a Discord
   * channel as `#name` or a thread by its own name — never a server's or a workspace's, and nothing for a one-to-one.
   * `undefined` when the platform has none or could not say. The engine asks rarely and keeps the answer
   * (`rooms/room-names.store.ts`), so an adapter may fetch; it must not throw for a room it cannot see.
   *
   * Optional, a capability like `editMessage`: the engine tests for the method, never for a platform.
   */
  roomTitle?(chatId: string): Promise<string | undefined>;

  /**
   * Whether this connection's own account can read a room — a Discord channel its role may not view (0.8.12). `true` or
   * `false` where the platform says, from what the connection already holds; `undefined` where it cannot tell, which the
   * engine reads as it always has. Asked on every turn in a room, so it must not fetch.
   *
   * Optional, a capability like `roomTitle`. Live: in a server channel only Nouva's bot could view, Nouva was told it
   * could tag Nexa there, tagged her, and Nexa's bot never received it.
   */
  sees?(chatId: string): boolean | undefined;

  onMessage(handler: (env: MessageEnvelope) => void): void;
  onEvent(handler: (event: GatewayEvent) => void): void;
}

/**
 * Full jitter exponential backoff. Jitter is not decoration: without it, every
 * gateway that dropped during the same upstream outage reconnects in lockstep
 * and rebuilds the thundering herd that caused it.
 */
export function backoffDelay(
  attempt: number,
  cfg: GatewayResilienceConfig,
  random: () => number = Math.random,
): number {
  const exponential = cfg.reconnectBackoffMs * cfg.reconnectBackoffMultiplier ** attempt;
  const capped = Math.min(exponential, cfg.reconnectBackoffMaxMs);
  return Math.round(capped / 2 + random() * (capped / 2));
}

/** What a bot's presence says about its agent: working or waiting, idle, asleep. */
export type GatewayPresence = "online" | "idle" | "dnd";
