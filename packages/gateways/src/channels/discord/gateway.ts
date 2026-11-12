/**
 * Discord gateway — §5.4 SPEC.
 *
 * discord.js with the gateway intents Nouride actually needs. Threads are separate chat ids
 * (a thread is its own conversation), replies are split at Discord's 2000-character limit,
 * and the typing indicator is refreshed by the executor rather than here.
 */

import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  AttachmentBuilder,
  MessageFlags,
  Options,
  Partials,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from "discord.js";
import {
  contained,
  GatewayAuthError,
  GatewayError,
  type Attachment,
  type AttachmentStream,
  type GatewayResilienceConfig,
  type Logger,
  type MessageButton,
  type MessageEnvelope,
  type OutboundMessage,
  type GatewayPresence,
} from "@nouride/shared";
import { openDownload } from "../../commons/download.ts";
import { Pacer } from "../../commons/pace.ts";
import { chunk, sendsText } from "../../commons/text.ts";
import { voiceMessageUpload } from "../../commons/voice.ts";
import { discordEdit, discordEnvelope } from "./envelope.ts";
import { discordRoomTitle, ThreadOpeners, type RoomChannel } from "./rooms.ts";
import { heartbeatAlive } from "./heartbeat.ts";
import { buttonRow, carryOut, discordPress } from "./presses.ts";
import { BaseGateway, type GatewayIdentity, deliverInParts, UndeliverableError } from "../../commons/resilience.ts";

/** Discord rejects anything longer. */
const MAX_MESSAGE_CHARS = 2000;

/** The one option every slash command carries — see `syncCommands`. */
const SLASH_ARGS = "args";

/**
 * How long a slash command's description may be. Discord refuses the whole list over one that is longer: a
 * description of 103 characters kept every command of every bot off the menu, which went on showing the old ones.
 */
const MAX_DESCRIPTION_CHARS = 100;

/**
 * How much of Discord's state to keep in memory.
 *
 * Zero means "do not cache", which is the default for all three: nothing in this adapter reads them,
 * and unbounded is what discord.js ships. See `makeCache` in `connect` for the measurement.
 */
export interface DiscordCacheLimits {
  /** Messages per channel. 0 by default — `channel.messages.fetch()` is a REST call regardless. */
  messages?: number;
  /** Users, globally. 0 by default — an author arrives on the message payload. */
  users?: number;
  /** Guild members per guild. 0 by default — `message.member` arrives on the payload too. */
  members?: number;
}

/**
 * The cache sizes handed to discord.js — see `makeCache` in `connect` for why each is what it is. A function rather than
 * an inline literal so the policy is tested as the adapter applies it, not as a test rebuilt it.
 */
export function discordCacheSettings(cache: DiscordCacheLimits = {}) {
  return {
    ...Options.DefaultMakeCacheSettings,
    MessageManager: cache.messages ?? 0,
    UserManager: cache.users ?? 0,
    // The bot's own member always, the rest by the limit: a channel's permissions are worked out from its own roles, and
    // with none cached `permissionsFor` said nothing — whether it may view a channel was unknowable (`sees`, 0.8.12).
    GuildMemberManager: { maxSize: cache.members ?? 0, keepOverLimit: (member: { id: string; client: { user: { id: string } | null } }) => member.id === member.client.user?.id },
    // Not configurable, because there is no reading of them to buy back: presences need an
    // intent this adapter does not request, and nothing here touches reactions.
    PresenceManager: 0,
    ReactionManager: 0,
    GuildEmojiManager: 0,
    GuildStickerManager: 0,
  };
}

export interface DiscordGatewayOptions extends GatewayIdentity {
  token: string;
  resilience?: Partial<GatewayResilienceConfig>;
  cache?: DiscordCacheLimits;
}

/** A token Discord refused — malformed (`TokenInvalid`) or revoked (401) — rather than a network failure. */
export function refusedToken(err: unknown): boolean {
  const failure = err as { code?: unknown; status?: unknown } | null;
  return failure?.code === "TokenInvalid" || failure?.status === 401 || /\b401\b|Unauthorized|Authentication failed|invalid token/i.test(String(err));
}

/**
 * Discord's answers no retry changes, by their JSON error codes: Unknown Channel (10003), Unknown User (10013), Missing
 * Access (50001), Cannot send messages to this user (50007), Missing Permissions (50013).
 */
const REFUSED_FOR_GOOD = new Set([10003, 10013, 50001, 50007, 50013]);

/** Discord's Unknown Channel: an id that names no channel this bot can see — perhaps a person's (`resolveChannel`). */
const UNKNOWN_CHANNEL = 10003;

/** The refusal in Discord's words, or null for a failure worth another try. */
export function discordRefusal(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && REFUSED_FOR_GOOD.has(code) ? (err as Error).message || `Discord refused it (${code})` : null;
}

/**
 * A shard's reconnects, each a line at info — the journal's only account of them (`memory-growth-since-0-6`).
 *
 * discord.js brings a shard back by itself and said nothing here: `ShardReconnecting` when a socket closes with a code
 * it recovers from, then `ShardResume` when the session picks up where it was, or `ShardReady` when Discord started a
 * new one — which sends every guild again, into the caches `connect` keeps. An idle box's memory took a step with
 * nothing in the journal at that moment, and none of these could be ruled in or out. A replaced client's are not this
 * connection's (`current`). Its own function, called by `connect`, so a test can emit the events on a stand-in.
 */
export function logShardLifecycle(client: Pick<Client, "on">, log: Logger, current: () => boolean): void {
  client.on(
    Events.ShardReconnecting,
    contained(log, "could not log a shard reconnecting", (shard) => {
      if (current()) log.info("shard reconnecting", { shard });
    }),
  );
  client.on(
    Events.ShardResume,
    contained(log, "could not log a shard resuming", (shard, replayed) => {
      if (current()) log.info("shard resumed", { shard, replayed_events: replayed });
    }),
  );
  client.on(
    Events.ShardReady,
    contained(log, "could not log a shard's session", (shard, unavailable) => {
      if (current()) log.info("shard ready with a new session", { shard, unavailable_guilds: unavailable?.size ?? 0 });
    }),
  );
}

export class DiscordGateway extends BaseGateway {
  /** The bot's presence, following its agent (0.8.0) — kept, so a reconnect shows it again. */
  private presence: GatewayPresence = "online";

  setPresence(presence: GatewayPresence): void {
    this.presence = presence;
    try {
      this.client?.user?.setPresence({ status: presence });
    } catch (err) {
      this.log.debug("presence not set", { error: String(err) });
    }
  }

  /** What the agent is told about writing here — `Gateway.formatting`: sent as written, no tables, split at 2000. */
  readonly formatting =
    "Formatting: Discord markdown, sent as written. Discord does not render tables, so use short labelled lines or a code block. Keep replies under 2000 characters where you can; longer ones are split across messages.";
  private client?: Client;
  /** Each thread's opening message, fetched once (`rooms.ts`, 0.7.24). */
  private readonly openers = new ThreadOpeners();
  /** Discord's limit for a channel: five messages in five seconds. Its client already waits out a 429 on its own. */
  protected pacer = new Pacer({ perChat: () => ({ count: 5, perMs: 5_000 }) });
  /** A row of buttons under a message, and a press on one an interaction — `Gateway.buttons`. */
  readonly buttons = true;

  constructor(private readonly options: DiscordGatewayOptions) {
    super(options, options.resilience);
  }

  /** `<@id>` — what Discord turns into a real mention when an agent writes it. */
  get selfMention(): string | undefined {
    const id = this.client?.user?.id;
    return id ? `<@${id}>` : undefined;
  }

  get selfId(): string | undefined {
    return this.client?.user?.id;
  }

  protected async connect(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        // Privileged intent: without it every message arrives with empty content, which
        // looks like a silent bug rather than a missing checkbox in the developer portal.
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // DM channels arrive uncached; without this partial, DMs are dropped. Messages are never cached (below), and
      // without theirs discord.js says nothing when one is edited — an edit is a message it holds.
      partials: [Partials.Channel, Partials.Message],
      /**
       * Caches sized for what this adapter actually reads, which is almost nothing.
       *
       * discord.js defaults bound only `MessageManager` (200 per channel) and leave `UserManager`,
       * `GuildMemberManager`, `PresenceManager` and `ReactionManager` unbounded, with a sweeper that
       * only sweeps threads. On a box running one bot per agent that is six of everything, and it
       * showed: the daemon started at 76MB and climbed to 97MB over twenty minutes, roughly a
       * megabyte a minute until the caches plateaued.
       *
       * None of it was being read. `message.member?.displayName` and `message.mentions.users` come
       * off the gateway payload, not out of a cache; `channel.messages.fetch()` is a REST call by
       * definition; and the one lookup that does consult a cache — `client.channels.cache.get()` in
       * `resolveChannel` — already falls back to `fetch`. So `ChannelManager` and `GuildManager` stay
       * cached, because they are small and bound by how many places the bot has been added to, and
       * everything that grows with *traffic* is off.
       *
       * Configurable rather than hardcoded: an operator whose agents need member lookups should be
       * able to buy them back without editing this file.
       */
      makeCache: Options.cacheWithLimits(discordCacheSettings(this.options.cache)),
      /**
       * Sweep whatever the limits above still allow to accumulate.
       *
       * A limit caps a collection; a sweeper is what releases entries that stopped mattering. Without
       * one, an operator who raises `cache_messages` gets the old unbounded growth back one channel
       * at a time.
       */
      sweepers: {
        ...Options.DefaultSweeperSettings,
        messages: { interval: 600, lifetime: 1800 },
      },
    });

    /**
     * Only the client we are currently using gets to report a problem, or take a message in.
     *
     * A replaced client keeps its listeners, and discord.js can emit an error or a shard close that was
     * already queued when `destroy()` ran. Acted on, that event tears down the connection which just
     * replaced it — so the reconnect that fixed things schedules another one, and the gateway flaps for
     * reasons that have already been dealt with.
     *
     * The window is narrow now that `attemptConnect` destroys the previous client before building a
     * new one, and it is not zero. Telegram carries the same guard, where the same event was fatal
     * rather than merely wasteful: its abandoned poll is *guaranteed* to fail, because the replacement
     * is what terminates it. The WhatsApp bridge learned it first — "a replaced socket kept its
     * listeners and a second `close` started another reconnect".
     *
     * A replaced client can also live on: its `destroy()` waits for a `close` that may never come, and the reconnect goes
     * ahead without it (`BaseGateway`). What it takes in, the current client takes in too — or nothing could answer it.
     */
    const current = () => this.client === client;

    // discord.js emits from its socket, so a listener's throw is uncaught and ends the daemon (`lint:timers`).
    client.on(
      Events.MessageCreate,
      contained(this.log, "could not take in a message", async (message) => {
        if (!current()) return;
        const envelope = await discordEnvelope(message, this.id);
        if (!envelope) return;
        // A message in a thread carries what the thread was started from; the engine uses it on the first turn there.
        const opener = await this.openers.of(message.channelId, message.channel as unknown as RoomChannel, message.id);
        this.emitMessage(opener ? { ...envelope, threadOpener: opener } : envelope);
      }),
    );
    // A person's edit of a message they sent: reported as the edit it is, and the engine decides what it does.
    client.on(
      Events.MessageUpdate,
      contained(this.log, "could not take in an edit", async (_before, message) => {
        if (!current()) return;
        const envelope = await discordEdit(message as Parameters<typeof discordEdit>[0], this.id);
        if (envelope) this.emitMessage(envelope);
      }),
    );

    /**
     * Native slash commands, which were registered and then ignored.
     *
     * `syncCommands` has always published the hook list to Discord, so `/status` appeared in the
     * picker with this agent's name beside it — and nothing ever listened for the interaction it
     * produces. Discord waits three seconds and says "The application did not respond". The command
     * worked only when typed as ordinary text (`@Nexa /status`), because that arrives as a message
     * and messages had a handler.
     *
     * A slash command is not a message: it is an interaction on a separate delivery channel, and it
     * has to be acknowledged before anything else happens. Registering without handling is the whole
     * bug, and it is invisible from this side — the registration succeeds.
     */
    client.on(
      Events.InteractionCreate,
      contained(this.log, "could not answer an interaction", async (interaction) => {
        if (!current()) return;
        // A press on one of our buttons: the engine's answer, carried out inside the interaction's three seconds.
        if (interaction.isButton()) return await carryOut(interaction, this.answerPress(discordPress(interaction, this.id)), this.log);
        if (!interaction.isChatInputCommand()) return;
        await this.handleSlashCommand(interaction);
      }),
    );

    client.on(
      Events.Error,
      contained(this.log, "could not handle a client error", (err) => {
        if (!current()) {
          this.log.debug("error from a replaced client", { error: String(err) });
          return;
        }
        this.log.warn("client error", { error: String(err) });
        this.handleDisconnect(String(err));
      }),
    );

    client.on(
      Events.ShardDisconnect,
      contained(this.log, "could not handle a shard closing", (event) => {
        if (!current()) {
          this.log.debug("shard close from a replaced client", { code: event.code });
          return;
        }
        this.log.warn("shard disconnected", { code: event.code });
        this.handleDisconnect(`shard closed with ${event.code}`);
      }),
    );
    logShardLifecycle(client, this.log, current);

    /**
     * Assigned before `login`, not after it resolves.
     *
     * Two reasons, and the second is the one that bites. `current()` above has to be true from the
     * first event, or every error during login is discarded as coming from a replaced client — the
     * guard would silently swallow exactly the failures it must not. And a login that times out leaves
     * a live client behind; unassigned, `disconnect()` cannot see it to destroy it, which is the leak
     * this whole change is about.
     */
    this.client = client;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GatewayError(this.id, "login timed out")), 30_000);
      client.once(Events.ClientReady, () => {
        try {
          if (current()) {
            this.log.info("ready", { user: client.user?.tag });
            // A new session shows what the agent is, not Discord's default.
            if (this.presence !== "online") client.user?.setPresence({ status: this.presence });
          } else {
            // A replaced client's login can land after the reconnect went ahead without it — a second session for the same
            // bot, held for nothing. Its first `destroy()` waits on a socket it has since replaced; this one closes it.
            this.log.info("a replaced client logged in; closing it", { user: client.user?.tag });
            client.destroy().catch((err: unknown) => this.log.debug("a replaced client did not close", { error: String(err) }));
          }
        } catch {
          // A line that could not be logged; the login still succeeded.
        } finally {
          clearTimeout(timer);
          resolve();
        }
      });
      client.login(this.options.token).catch((err: unknown) => {
        clearTimeout(timer);
        reject(refusedToken(err) ? new GatewayAuthError(this.id, `Discord refused the bot token: ${String(err)}`) : new GatewayError(this.id, `login failed: ${String(err)}`));
      });
    });
  }

  protected async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.destroy();
  }

  /**
   * Rewrite a message we sent, for the live progress line.
   *
   * `allowedMentions` is repeated rather than inherited from the original send: Discord applies the
   * edit's own value, so leaving it out would let an edited line ping a whole server with text a
   * model produced — the exact thing `deliver` guards against.
   */
  override async editMessage(chatId: string, messageId: string, text: string): Promise<boolean> {
    try {
      const channel = await this.resolveChannel(chatId);
      const message = await channel.messages.fetch(messageId);
      await message.edit({
        content: text.slice(0, MAX_MESSAGE_CHARS),
        allowedMentions: { parse: [] },
      });
      return true;
    } catch (err) {
      // The message may have been deleted by a human, or the bot may have lost the channel. Neither
      // is worth failing a turn over — the answer itself still goes out.
      this.log.debug("edit failed", { chat_id: chatId, error: String(err) });
      return false;
    }
  }

  /**
   * A message we sent with buttons, settled: rewritten, its components gone — or `keep` for a question still open.
   * Mentions parsed from nothing, as every edit of ours is — the text is ours, and an edit applies its own `allowedMentions`.
   */
  override async settleButtons(chatId: string, messageId: string, text: string, keep: readonly MessageButton[] = []): Promise<boolean> {
    try {
      const message = await (await this.resolveChannel(chatId)).messages.fetch(messageId);
      const components = keep.length > 0 ? buttonRow(keep) : [];
      await message.edit({ content: text.slice(0, MAX_MESSAGE_CHARS), components, allowedMentions: { parse: [] } });
      return true;
    } catch (err) {
      this.log.debug("could not settle a message's buttons", { chat_id: chatId, error: String(err) });
      return false;
    }
  }

  protected async deliver(msg: OutboundMessage): Promise<string[]> {
    const channel = await this.resolveChannel(msg.chatId);

    // An attachment-only message is a legitimate send, and `chunk("")` answers `["(empty response)"]`
    // — a deliberate guard so a reply that produced no text still says something rather than
    // vanishing. Applied here it posted that placeholder before every file, which is how three files
    // arrived in a real chat behind three lines of noise. The guard is for a *reply*; a message
    // carrying a file is not one.
    const textParts = sendsText(msg)
      ? chunk(msg.text, MAX_MESSAGE_CHARS)
      : [];

    // Text in parts, then files — and if a part fails after one landed, only what is left goes into the
    // buffer (`deliverInParts`).
    return await deliverInParts(msg, textParts, {
      text: async (part, index, ids) => {
        const sent = await channel.send({
          // No conversion: Discord renders the same markdown a model writes, so anything done here would
          // be translating a dialect into itself. What it does *not* do is protect a server from the
          // text — see `allowedMentions` below.
          content: part,
          // Discord suppresses a preview with a flag on the message, not a send option.
          ...(msg.suppressPreview ? { flags: [MessageFlags.SuppressEmbeds] } : {}),
          // The agent's words are a model's output, and a model quoting a page that says `@everyone`
          // would otherwise notify a whole server. Replies still ping the person being answered, which
          // is the one mention that was actually intended by a human.
          allowedMentions: { parse: ["users"], repliedUser: true },
          // Only the first chunk is a reply; the rest follow it in the channel.
          ...(index === 0 && msg.replyTo
            ? { reply: { messageReference: msg.replyTo, failIfNotExists: false } }
            : {}),
          // Buttons under the last part: the one a person reads last, and the one a settled question rewrites.
          ...(msg.buttons?.length && index === textParts.length - 1 ? { components: buttonRow(msg.buttons) } : {}),
        });
        // One id per chunk: a long answer is several messages and a human can reply to any of them.
        ids.push(sent.id);
      },

      // Files go as their own messages, after the text.
      //
      // Not attached to the first chunk, which would have been fewer requests: a caption on Discord is
      // just the message content, so a long answer plus a file would need the file to ride on a chunk
      // whose text was cut to fit a budget it does not share. One message per file keeps the answer
      // readable and each file individually replyable.
      attachment: async (attachment, ids) => {
        const body = attachment.buffer;
        if (!body) {
          // A path-only attachment means whoever built it expected the gateway to read the disk. It
          // does not, and never will — the gateway runs in the same process today and might not
          // tomorrow. Skipping loudly beats sending an empty message.
          this.log.warn("outbound attachment has no bytes, so it is skipped", {
            filename: attachment.filename,
          });
          return;
        }
        /**
         * A voice note goes as a *voice message* when the file can prove it is one.
         *
         * Discord's voice message is its own message type — player, scrub bar, duration — and it wants
         * `duration_secs` and a waveform on the upload plus the `IsVoiceMessage` flag. `voiceMessageUpload`
         * reads the duration out of the Ogg stream and answers `null` for anything it cannot measure, so
         * an mp3 the agent called a voice note still arrives as an ordinary audio attachment rather than
         * as a voice message with a scrub bar that does not match the audio.
         *
         * Content must be empty on a voice message — Discord rejects one that carries text — so a caption
         * goes out as its own message first rather than being dropped.
         */
        const voice = attachment.type === "voice" ? voiceMessageUpload(body) : null;
        if (voice) {
          if (attachment.caption) {
            const note = await channel.send({
              content: attachment.caption.slice(0, MAX_MESSAGE_CHARS),
              allowedMentions: { parse: ["users"], repliedUser: true },
            });
            ids.push(note.id);
          }

          const file = new AttachmentBuilder(Buffer.from(body), {
            name: attachment.filename ?? "voice.ogg",
          })
            .setDuration(voice.durationSecs)
            .setWaveform(voice.waveform);

          const sentVoice = await channel.send({
            files: [file],
            flags: MessageFlags.IsVoiceMessage,
            allowedMentions: { parse: ["users"], repliedUser: true },
          });
          ids.push(sentVoice.id);
          // Which of the two paths a file took, because the difference is invisible afterwards: a voice
          // message and an audio attachment are the same bytes with the same filename, and the only way
          // to tell which was sent is to look at Discord. Logged for both, so "why is this not a voice
          // note" is answerable from the daemon.
          this.log.info("sent as a voice message", {
            filename: attachment.filename,
            duration_secs: Number(voice.durationSecs.toFixed(2)),
          });
          return;
        }

        if (attachment.type === "voice") {
          this.log.info("voice note sent as a plain attachment, because its duration could not be read", {
            filename: attachment.filename,
            mime_type: attachment.mimeType,
          });
        }

        const sent = await channel.send({
          ...(attachment.caption ? { content: attachment.caption.slice(0, MAX_MESSAGE_CHARS) } : {}),
          files: [{ attachment: Buffer.from(body), name: attachment.filename ?? "file" }],
          allowedMentions: { parse: ["users"], repliedUser: true },
        });
        ids.push(sent.id);
      },
    }, () => this.pacer.take(msg.chatId));
  }

  protected async ping(): Promise<boolean> {
    const client = this.client;
    if (!client?.isReady()) return false;
    return heartbeatAlive(client.ws.ping, client.readyTimestamp, Date.now());
  }

  /**
   * Discord attachments are plain CDN URLs, so this is a GET whose body goes to the engine unread — the engine's
   * store is the size guard, counting as it writes.
   *
   * Still routed through the adapter rather than done in the engine: the URL came from the platform
   * and only the adapter knows that its links are directly fetchable, which is not true of every
   * platform.
   */
  override async fetchAttachment(attachment: Attachment, signal?: AbortSignal): Promise<AttachmentStream | null> {
    if (!attachment.url) return null;
    try {
      const download = await openDownload(attachment.url, signal);
      if ("status" in download) {
        this.log.warn("attachment download failed", { status: download.status });
        return null;
      }
      return download;
    } catch (err) {
      this.log.warn("attachment fetch failed", { error: String(err) });
      return null;
    }
  }

  override async setTyping(chatId: string): Promise<void> {
    try {
      const channel = await this.resolveChannel(chatId);
      await channel.sendTyping();
    } catch {
      // Decoration only — never fail a turn over it.
    }
  }

  /**
   * Replace the application's global slash commands with the daemon's current hook list.
   *
   * Uses discord.js's `ApplicationCommandManager.set()`, which bulk-overwrites all global
   * commands in one call — same replace semantics as Telegram. Global commands may take up
   * to an hour to propagate; guild commands would be instant but require a guild id.
   */
  override async syncCommands(
    commands: { command: string; description: string }[],
  ): Promise<{ synced: number }> {
    const client = this.client;
    if (!client?.application) {
      throw new Error("Discord client not connected or application not available");
    }
    await client.application.commands.set(
      commands.map((c) => ({
        name: c.command,
        // Cut to what Discord takes, so one long description costs its own tail and not the menu.
        description: c.description.length > MAX_DESCRIPTION_CHARS ? `${c.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : c.description,
        type: 1, // CHAT_INPUT
        /**
         * One optional free-text option on every command, rather than a schema per command.
         *
         * The daemon's hooks take their arguments as the rest of the line — `/approve always`,
         * `/grants revoke <id>` — and it publishes them here as a name and a description with no
         * shape at all. Registering them without this made every one of them argument-less, so the
         * commands that need an argument were reachable and useless.
         *
         * Uniform on purpose: a per-command schema would be a second description of the hooks that
         * has to be kept in step with the first, and the surface that drifts is the one nobody runs.
         */
        options: [
          {
            name: SLASH_ARGS,
            description: "Anything the command takes after its name. Optional.",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      })),
    );
    return { synced: commands.length };
  }

  /**
   * One slash command, turned into the message it would have been if somebody had typed it.
   *
   * ## The acknowledgement comes first
   *
   * Discord gives three seconds. Past that the interaction is dead, the person is told the
   * application did not respond, and nothing done afterwards can reach them — which is what the
   * screenshot showed while the agent was, in fact, working. So the defer is the first statement,
   * before the envelope is built and before anything touches the pipeline.
   *
   * ## And then it gets out of the way
   *
   * The answer is not delivered through the interaction. It goes out the ordinary path, as a message
   * in the channel from this agent's bot — byte for byte what `@Nexa /status` already produces, which
   * is the behaviour the operator is used to and the one every other surface agrees with. The
   * ephemeral placeholder is deleted once the message is on its way, so nothing is left behind
   * saying "thinking" about a turn that has moved on.
   *
   * A failure is the exception: it is edited into the placeholder instead, because a slash command
   * that silently does nothing is the thing this whole handler exists to stop.
   */
  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      // Already expired, or answered by another shard. Nothing to do and nothing to report to: the
      // person's client has moved on.
      this.log.debug("could not acknowledge a slash command", { error: String(err) });
      return;
    }

    try {
      this.emitMessage(this.interactionEnvelope(interaction));
      await interaction.deleteReply();
    } catch (err) {
      this.log.warn("slash command failed", { command: interaction.commandName, error: String(err) });
      await interaction
        .editReply(`\`/${interaction.commandName}\` could not be delivered: ${String(err)}`)
        .catch(() => {});
    }
  }

  /**
   * The envelope a slash command becomes.
   *
   * `mentionsSelf`, because it is one. A Discord command belongs to the application that registered
   * it, so an interaction arriving here was aimed at *this* agent by name — the same thing a tag
   * means, expressed by the platform instead of by the person. Without it the message reaches a
   * channel agent that only answers when addressed and is dropped.
   *
   * `args` is the one option every command is registered with, so `/approve always` and
   * `/grants revoke <id>` survive the trip. Discord hands options as structured fields and the engine
   * parses a command out of a line of text, so they are joined back into the line the person would
   * have typed — one shape reaching the parser, from both surfaces.
   */
  private interactionEnvelope(interaction: ChatInputCommandInteraction): MessageEnvelope {
    const args = interaction.options.getString(SLASH_ARGS)?.trim();
    return {
      // The interaction's own id. Unique, and never collides with a message id, which matters because
      // the attachment index keys files by the id of the message that carried them.
      id: interaction.id,
      timestamp: interaction.createdTimestamp,
      gateway: "discord",
      gatewayId: this.id,
      chatId: interaction.channelId,
      chatType:
        interaction.channel?.type === ChannelType.DM
          ? "dm"
          : interaction.channel?.type === ChannelType.GroupDM
            ? "group"
            : "channel",
      senderId: interaction.user.id,
      senderName: interaction.member && "displayName" in interaction.member
        ? String(interaction.member.displayName)
        : interaction.user.username,
      text: args ? `/${interaction.commandName} ${args}` : `/${interaction.commandName}`,
      mentions: [],
      mentionsSelf: true,
      raw: interaction,
    };
  }

  protected override refusal(err: unknown): string | null {
    return discordRefusal(err);
  }

  /**
   * Whether this bot may view a server channel or thread — `Gateway.sees` (0.8.12). From the channels Discord sends with
   * each server, whether or not the bot may view them, so nothing is fetched; nothing for a DM, or a channel not held.
   */
  sees(chatId: string): boolean | undefined {
    const me = this.client?.user;
    const channel = this.client?.channels.cache.get(chatId) as { permissionsFor?: (user: unknown) => { has(flag: bigint): boolean } | null } | undefined;
    if (!me || typeof channel?.permissionsFor !== "function") return undefined;
    return channel.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel);
  }

  /** `#channel` or a thread's own name — `Gateway.roomTitle` (0.7.24). Nothing for a DM, or a channel this bot cannot see. */
  async roomTitle(chatId: string): Promise<string | undefined> {
    const client = this.client;
    if (!client) return undefined;
    const channel = client.channels.cache.get(chatId) ?? (await client.channels.fetch(chatId).catch(() => null));
    return discordRoomTitle(channel as unknown as RoomChannel | null);
  }

  /**
   * A channel by its id — or, for an id that is a person's, their DM, opened here (0.8.0). A person's account on Discord
   * is their user id (`discord:214` in People), and a one-to-one with them is a channel of another id: the morning line
   * and `send_message` address one by the account, and Discord answered Unknown Channel. On the live box the owner's
   * morning line fell through to Telegram.
   */
  private async resolveChannel(chatId: string): Promise<TextBasedChannel & { send: Function; sendTyping: Function }> {
    const client = this.client;
    if (!client) throw new GatewayError(this.id, "not connected");

    const channel =
      client.channels.cache.get(chatId) ??
      (await client.channels.fetch(chatId).catch(async (err: unknown) => {
        if ((err as { code?: unknown } | null)?.code !== UNKNOWN_CHANNEL) throw err;
        const person = await client.users.fetch(chatId).catch(() => null);
        if (!person) throw err;
        return await person.createDM();
      }));
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new UndeliverableError(this.id, `channel ${chatId} is not a text channel this bot can post to`);
    }
    return channel as TextBasedChannel & { send: Function; sendTyping: Function };
  }
}

