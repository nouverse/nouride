/**
 * Telegram gateway — §5.4 SPEC.
 *
 * grammY with long polling. Everything platform-specific stops here: message splitting at
 * Telegram's 4096-character limit, topic threads folded into the chat id, and the typing
 * action. The engine only ever sees a `MessageEnvelope`.
 */

import { Bot, GrammyError, InputFile } from "grammy";
import {
  contained,
  GatewayAuthError,
  GatewayError,
  type Attachment,
  type AttachmentStream,
  type GatewayResilienceConfig,
  type MessageButton,
  type OutboundMessage,
} from "@nouride/shared";
import { openDownload } from "../../commons/download.ts";
import { Pacer, type Rate } from "../../commons/pace.ts";
import { BaseGateway, type GatewayIdentity, deliverInParts } from "../../commons/resilience.ts";
import { chunkRendered, sendsText } from "../../commons/text.ts";
import { parseMarkdown, toPlainText } from "../../commons/markdown.ts";
import { toTelegramHtml } from "./html.ts";
import { sendTelegramAlbum, telegramAlbumRun } from "./album.ts";
import { foldChatId, telegramEdit, telegramEnvelope, telegramRoomTitle, topicNameOf } from "./envelope.ts";
import { inlineKeyboard, NO_BUTTONS, telegramPress } from "./presses.ts";

/** Telegram rejects anything longer; we split rather than let the send fail. */
const MAX_MESSAGE_CHARS = 4096;
/** Telegram rejects the whole send past this, so a caption is cut rather than losing its file. */
const MAX_CAPTION_CHARS = 1024;
/** What Telegram shows of an answer to a press, at most. */
const MAX_PRESS_NOTICE_CHARS = 200;

/** Telegram's own limits: a message a second in one chat, twenty a minute in a group, thirty a second in all. */
const CHAT_RATE: Rate = { count: 1, perMs: 1_000 };
const GROUP_RATE: Rate = { count: 20, perMs: 60_000 };
const BOT_RATE: Rate = { count: 30, perMs: 1_000 };
/** A 429 waited out and asked again at most this often for one message, and never longer than this each time. */
const RETRIES_AFTER_429 = 2;
const RETRY_AFTER_MAX_S = 60;

/** The seconds a 429 — Too Many Requests — names to wait, or null for any other failure. */
export function retryAfterSeconds(err: unknown): number | null {
  return err instanceof GrammyError && err.error_code === 429 ? (err.parameters?.retry_after ?? 1) : null;
}

/**
 * Telegram's answers no retry changes, in its own words: a 403 — blocked by the person, removed from the group, the
 * bot's own id — and the 400s that name a chat, a person or a right that is not there. Null for anything worth another
 * try, a formatting refusal included: that one is answered by resending as plain text.
 */
export function telegramRefusal(err: unknown): string | null {
  if (!(err instanceof GrammyError)) return null;
  if (err.error_code === 403) return err.description;
  const gone = /chat not found|user not found|PEER_ID_INVALID|bot was kicked|not enough rights|have no rights|CHAT_WRITE_FORBIDDEN|need administrator rights|TOPIC_CLOSED|upgraded to a supergroup/i;
  return err.error_code === 400 && gone.test(err.description) ? err.description : null;
}

/** One markdown part, as the document Telegram is actually sent — and actually measures. */
const renderHtml = (part: string): string => toTelegramHtml(parseMarkdown(part));
/**
 * How long Telegram is asked to hold an empty `getUpdates` open.
 *
 * Fifty, the most Telegram holds one, where grammY's default is thirty: an idle bot's poll returning is a wake-up and
 * a request over the box's radio, and at thirty seconds it was two a minute for nothing. The HTTP request
 * timeout is derived from it — see `connect`.
 */
const POLL_TIMEOUT_SECONDS = 50;

/**
 * A poll that returned this recently is proof the connection works, and the health check asks no more.
 *
 * Two poll windows: a healthy idle poll returns every fifty seconds. The health check used to send `getMe` every
 * thirty seconds beside it — two requests a minute per bot, at idle, to learn what the last poll already said.
 */
export const POLL_PROVES_ALIVE_MS = 2 * POLL_TIMEOUT_SECONDS * 1000;

/**
 * How long to wait before re-polling after a 409.
 *
 * Telegram keeps a `getUpdates` session open **server-side** for up to about thirty seconds after the
 * client stops asking. Until it expires, a fresh poll on the same token is answered with
 * `409: Conflict: terminated by other getUpdates request` — however cleanly the local side was torn
 * down, and whether or not anything else is actually running.
 *
 * The generic backoff starts at one second, so the first several attempts after a conflict were
 * *arithmetically* certain to fail. Thirty-five leaves five seconds of margin over Telegram's window.
 */
const CONFLICT_SETTLE_MS = 35_000;

export interface TelegramGatewayOptions extends GatewayIdentity {
  token: string;
  mode: "polling" | "webhook";
  resilience?: Partial<GatewayResilienceConfig>;
}


export class TelegramGateway extends BaseGateway {
  /** What the agent is told about writing here — `Gateway.formatting`: converted markdown, a phone, no tables. */
  readonly formatting =
    "Formatting: write normal markdown; it is converted before sending. Headings become bold. This is usually read on a phone, so do not use tables; write short labelled lines instead. A table you send anyway is flattened into one, which will not be the layout you intended.";
  private bot?: Bot;
  /** A group's chat id is negative, and Telegram holds a group to twenty a minute. */
  protected pacer = new Pacer({ perChat: (chat) => (chat.startsWith("-") ? GROUP_RATE : CHAT_RATE), perBot: BOT_RATE });
  private me?: { id: number; username?: string };
  /** Forum topics' names, by folded chat id (`-100123:45`), as messages in them said (0.7.24). */
  private readonly topics = new TopicNames();
  /**
   * `@some_bot` — Telegram addresses a bot by username, not by id.
   *
   * The one platform here where a name is the only handle: a numeric id in the text is not a mention.
   * A bot's username is at least stable in a way a Discord application name is not — changing it
   * changes the address, which is a deliberate act.
   */
  get selfMention(): string | undefined {
    return this.me?.username ? `@${this.me.username}` : undefined;
  }

  /**
   * A bot never receives another bot's messages on Telegram — privacy mode or not, admin or not.
   *
   * So an agent's reply reaches no other agent through the platform: not as room chatter, and not as
   * a handover when it tags one. The engine carries both itself when this is false.
   */
  readonly echoesOwnMessages = false;

  /** An inline keyboard under a message, and a press on it a `callback_query` — `Gateway.buttons`. */
  readonly buttons = true;

  get selfId(): string | undefined {
    return this.me ? String(this.me.id) : undefined;
  }

  constructor(private readonly options: TelegramGatewayOptions) {
    super(options, options.resilience);
  }

  protected async connect(): Promise<void> {
    if (this.options.mode === "webhook") {
      throw new GatewayError(this.id, 'webhook mode is not implemented; use mode = "polling"');
    }

    /**
     * `timeoutSeconds` is the whole reason this is not `new Bot(token)`.
     *
     * grammY defaults it to **500 seconds**, and long polling asks Telegram to hold the connection
     * for 30. When the socket dies without an RST — a NAT table dropping an idle entry, an uplink
     * blipping, which is every homelab — the `getUpdates` request does not fail, it *waits*, and
     * inbound is dead for up to eight and a half minutes. Silently: grammY retries polling errors
     * internally behind its own debug logger, so there is no reconnect, no warning, nothing in the
     * journal at all.
     *
     * Seen live. A `/approve` and its follow-up were sent 30 seconds apart, arrived together three
     * and a half minutes later, and by then the approval they were answering had expired with its
     * turn — so the operator got "Nothing is waiting for approval" for a request they had answered
     * in time. From the outside the bot had simply frozen.
     *
     * 40 seconds: comfortably above the 30s Telegram itself holds the poll open, so a healthy poll
     * never trips it, and a dead one is abandoned in ten. grammY then sleeps 3s and re-polls, which
     * caps an inbound blackout at ~43 seconds instead of 500.
     */
    const bot = new Bot(this.options.token, {
      client: { timeoutSeconds: POLL_TIMEOUT_SECONDS + 10 },
    });
    this.lastPollAt = 0;
    // Every `getUpdates` that answers, empty or not, is the platform saying the connection works — see `alive`.
    bot.api.config.use(async (prev, method, payload, signal) => {
      const result = await prev(method, payload, signal);
      if (method === "getUpdates" && this.bot === bot) this.lastPollAt = Date.now();
      return result;
    });

    const self = () => ({ gatewayId: this.id, me: this.me });
    bot.on(
      "message",
      contained(this.log, "could not take in a message", (ctx) => {
        // A forum topic's name, as its messages say it — what `roomTitle` answers for that topic.
        const topic = topicNameOf(ctx.message);
        if (topic) this.topics.remember(foldChatId(ctx.message.chat.id, ctx.message.message_thread_id), topic);
        const envelope = telegramEnvelope(ctx.message, self());
        if (envelope) this.emitMessage(envelope);
      }),
    );
    // A person's edit of a message they sent: reported as the edit it is, and the engine decides what it does.
    bot.on(
      "edited_message",
      contained(this.log, "could not take in an edit", (ctx) => {
        const envelope = telegramEdit(ctx.editedMessage, self());
        if (envelope) this.emitMessage(envelope);
      }),
    );
    /**
     * A press on a button under one of our messages. Answered always — Telegram shows a spinner on the button until
     * `answerCallbackQuery` — with the engine's notice for the presser alone, and the message settled when it says so.
     */
    bot.on(
      "callback_query",
      contained(this.log, "could not answer a press", async (ctx) => {
        const press = telegramPress(ctx.callbackQuery, this.id);
        const answer = press ? await this.answerPress(press) : {};
        await ctx
          .answerCallbackQuery(answer.notice ? { text: answer.notice.slice(0, MAX_PRESS_NOTICE_CHARS) } : undefined)
          .catch((err: unknown) => this.log.debug("could not answer a press", { error: String(err) }));
        if (press && answer.settled) await this.settleButtons(press.chatId, press.messageId, answer.settled);
      }),
    );

    /**
     * Only the bot we are currently using gets to report a problem.
     *
     * A replaced instance keeps its handlers and its in-flight request, and its failure arrives
     * *later* — after the replacement is already connected and healthy. Acted on, that failure tears
     * down the connection that succeeded, which schedules another reconnect, which produces another
     * abandoned instance. It is the same defect as the WhatsApp bridge's "a replaced socket kept its
     * listeners and a second close started another reconnect", and on Telegram its abandoned request
     * is guaranteed to fail, because the replacement's poll is what terminates it.
     *
     * `this.bot` is assigned before polling starts, so this comparison is meaningful from the first
     * tick rather than only after `connect()` returns.
     */
    const current = () => this.bot === bot;

    // grammY surfaces middleware failures here. Anything other than a bad request means the
    // connection is suspect, so it goes through the same reconnect path as a dropped socket.
    bot.catch((err) => {
      if (!current()) return;
      this.log.warn("polling error", { error: String(err.error) });
      const status = err.error instanceof GrammyError ? err.error.error_code : undefined;
      if (status !== 400) this.handleDisconnect(String(err.error));
    });

    // `init()` validates the token and fetches our own identity before polling starts, so a
    // wrong token fails connect() instead of looping silently in the background.
    try {
      await bot.init();
    } catch (err) {
      // 401, or 404 for a token Telegram cannot even read: the token, not the network — given up on, not retried.
      if (err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404)) {
        throw new GatewayAuthError(this.id, `Telegram refused the bot token: ${err.description}`);
      }
      throw err;
    }
    this.me = {
      id: bot.botInfo.id,
      ...(bot.botInfo.username ? { username: bot.botInfo.username } : {}),
    };
    /**
     * Said at connect, because it decides what a group can reach and nothing else ever says it.
     *
     * With privacy mode on — BotFather's default — a bot that is not an admin receives, in a group,
     * only commands, replies to its own messages and service messages. **Not** a message that tags its
     * `@username`: verified live, two bots with privacy on received nothing at all for `@TheirBot halo`,
     * not even at debug level. From the chat that is indistinguishable from the bot being down.
     */
    if (bot.botInfo.can_read_all_group_messages === false) {
      this.log.warn(
        "privacy mode is on: in groups where it is not an admin, @" +
          (bot.botInfo.username ?? "this bot") +
          " receives only commands and replies to its own messages; tags and agent names never reach it. " +
          "Turn it off with BotFather /setprivacy (then remove and re-add the bot to each group), or make the bot a group admin",
        { username: bot.botInfo.username },
      );
    }

    // Not awaited: `start()` resolves only when polling stops. It also **rejects** when polling
    // fails — most commonly a 409 from `getUpdates` when something else is polling the same token,
    // which is transient and recovers on its own.
    //
    // `bot.catch` above does not cover it: that handles errors raised inside *middleware*, and a
    // polling-loop failure is not one. So this rejection had no handler at all, became an unhandled
    // rejection at process level, and the daemon's `unhandledRejection` handler shut the whole thing
    // down — every conversation on every gateway, for a Telegram hiccup. Seen in production: 409,
    // shutdown, restart, 409 again.
    //
    // Routed into `handleDisconnect` instead, which is where a lost connection has always belonged:
    // reconnect with backoff, buffer outbound, give up only after `maxReconnectAttempts`.
    /**
     * Assigned *before* polling starts, so `current()` can tell this instance from a replacement and
     * so `disconnect()` can stop it if the attempt is abandoned half-built.
     */
    this.bot = bot;

    void bot
      .start({
        ...pollingOptions(),
        onStart: () => {
          this.log.info("polling started", { username: this.me?.username });
        },
      })
      .catch((err: unknown) => {
        if (!current()) {
          // Expected, and not a fault: this instance was replaced and its request was terminated by
          // the one that replaced it. Logged at debug so the pattern is visible without reading as an
          // incident.
          this.log.debug("abandoned poll ended", { error: String(err) });
          return;
        }
        this.log.warn("polling stopped", { error: String(err) });
        // A conflict cannot be retried until Telegram's own session expires — see CONFLICT_SETTLE_MS.
        this.handleDisconnect(String(err), isConflict(err) ? CONFLICT_SETTLE_MS : undefined);
      });
  }

  protected async disconnect(): Promise<void> {
    const bot = this.bot;
    this.bot = undefined;
    if (!bot) return;
    try {
      // Awaited, and that is the point: `stop()` drains the in-flight `getUpdates` before returning,
      // so the next poll does not start beside one that is still open.
      await bot.stop();
    } catch (err) {
      // grammY throws when the bot is not running, which is the ordinary case here: the poll usually
      // ended by rejecting, and that rejection is what brought us to a teardown in the first place.
      this.log.debug("bot was already stopped", { error: String(err) });
    }
  }

  /**
   * Rewrite a message we sent, for the live progress line.
   *
   * Plain text, not the HTML `deliver` renders: a progress line is one short sentence naming a tool,
   * and running it through the markdown pipeline only creates ways for an unclosed tag to make
   * Telegram reject the edit. Nothing here is worth that risk.
   */
  override async editMessage(rawChatId: string, messageId: string, text: string): Promise<boolean> {
    const bot = this.bot;
    if (!bot) return false;
    const { chatId } = splitChatId(rawChatId);

    try {
      await bot.api.editMessageText(chatId, Number(messageId), text.slice(0, MAX_MESSAGE_CHARS), {
        // Always, for edits: the only thing this daemon edits is a status line.
        link_preview_options: { is_disabled: true },
      });
      return true;
    } catch (err) {
      // Routinely non-fatal: Telegram rejects an edit whose text is identical to what is already
      // there, and a progress line that has not changed hits that every time. Never worth a warning,
      // and never worth failing a turn over.
      this.log.debug("edit failed", { chat_id: rawChatId, error: String(err) });
      return false;
    }
  }

  /**
   * A group's title, or a forum topic's name once a message in it said it — `Gateway.roomTitle` (0.7.24). Nothing for a
   * one-to-one. A topic not yet named here is called by its group's title until it is.
   */
  async roomTitle(rawChatId: string): Promise<string | undefined> {
    const bot = this.bot;
    if (!bot) return undefined;
    const topic = this.topics.get(rawChatId);
    if (topic) return topic;
    return telegramRoomTitle(await bot.api.getChat(splitChatId(rawChatId).chatId));
  }

  /**
   * A message we sent with buttons, settled: rewritten — rendered as `deliver` renders, plain when Telegram refuses
   * the formatting — and given an empty keyboard, so its buttons go, or `keep` for a question still open: an edit
   * without a keyboard takes it away. `false` when Telegram would not have it.
   */
  override async settleButtons(rawChatId: string, messageId: string, text: string, keep: readonly MessageButton[] = []): Promise<boolean> {
    const bot = this.bot;
    if (!bot) return false;
    const { chatId } = splitChatId(rawChatId);
    const nodes = parseMarkdown(text.slice(0, MAX_MESSAGE_CHARS));
    const options = { reply_markup: keep.length > 0 ? inlineKeyboard(keep) : NO_BUTTONS, link_preview_options: { is_disabled: true } };
    try {
      await bot.api.editMessageText(chatId, Number(messageId), toTelegramHtml(nodes), { ...options, parse_mode: "HTML" });
      return true;
    } catch (err) {
      this.log.debug("a settled message's formatting was refused; rewriting it plain", { error: String(err) });
    }
    try {
      await bot.api.editMessageText(chatId, Number(messageId), toPlainText(nodes), options);
      return true;
    } catch (err) {
      this.log.debug("could not settle a message's buttons", { chat_id: rawChatId, error: String(err) });
      return false;
    }
  }

  protected async deliver(msg: OutboundMessage): Promise<string[]> {
    const bot = this.requireBot();
    const { chatId, threadId } = splitChatId(msg.chatId);

    // See the note in the Discord gateway (`channels/discord/gateway.ts`): `chunk("")` yields the "(empty response)" guard, which belongs to
    // a reply that produced no text and not to a message whose content is a file.
    // Budgeted against the HTML, not the markdown it came from: Telegram counts what it is sent, and
    // rendering makes the text longer. See `chunkRendered` — a reply that fit as markdown and did not
    // fit as HTML was rejected twice and dropped.
    const textParts = sendsText(msg)
      ? chunkRendered(msg.text, MAX_MESSAGE_CHARS, renderHtml)
      : [];

    // Text in parts, then files — and if a part fails after one landed, only what is left goes into the
    // buffer (`deliverInParts`).
    return await deliverInParts(msg, textParts, {
      text: async (part, index, ids) => {
        const options = {
          ...(threadId ? { message_thread_id: threadId } : {}),
          ...(msg.suppressPreview ? { link_preview_options: { is_disabled: true } } : {}),
          // Buttons under the last part: the one a person reads last, and the one a settled question rewrites.
          ...(msg.buttons?.length && index === textParts.length - 1 ? { reply_markup: inlineKeyboard(msg.buttons) } : {}),
          // Only the first chunk quotes the triggering message; repeating the quote on every
          // part of a long answer is unreadable.
          ...(index === 0 && msg.replyTo && replyParameters(msg.replyTo)
            ? { reply_parameters: replyParameters(msg.replyTo)! }
            : {}),
        };

        // Chunked as markdown and rendered per part, in that order. Rendering first would mean cutting
        // a byte budget through generated HTML, and a chunk boundary inside a tag is a document Telegram
        // rejects rather than a mark that fails to render.
        const nodes = parseMarkdown(part);

        try {
          const sent = await this.afterRetryAfter(() =>
            bot.api.sendMessage(chatId, toTelegramHtml(nodes), {
              ...options,
              parse_mode: "HTML",
            }),
          );
          // One id per chunk: a long answer is several messages and a human can reply to any of them.
          ids.push(String(sent.message_id));
        } catch (err) {
          // A rejected entity fails the whole send, so the reply would simply not arrive. Losing the
          // formatting is a far smaller failure than losing the message, and the log keeps the cause.
          // Not a 429 still refused after its waits: that is the limit, and the plain text would meet it too. Nor a
          // refusal of the chat: the plain text would be refused the same — it was resent and buffered, three refusals.
          if (!(err instanceof GrammyError) || err.error_code === 429 || telegramRefusal(err) !== null) throw err;
          this.log.warn("telegram rejected the formatted message; resending as plain text", {
            error: err.description,
          });
          const sent = await this.afterRetryAfter(() => bot.api.sendMessage(chatId, toPlainText(nodes), options));
          ids.push(String(sent.message_id));
        }
      },

      attachment: async (attachment, ids) => {
        const id = await this.deliverAttachment(attachment, chatId, threadId);
        if (id) ids.push(id);
      },
      album: {
        take: telegramAlbumRun,
        send: async (files, ids) =>
          void ids.push(...(await sendTelegramAlbum(files, { api: bot.api, chatId, threadId, captionMax: MAX_CAPTION_CHARS, retry: (call) => this.afterRetryAfter(call), refused: (err) => telegramRefusal(err) !== null, one: (file) => this.deliverAttachment(file, chatId, threadId), log: this.log }))),
      },
    }, () => this.pacer.take(chatId));
  }

  /**
   * A call Telegram answered 429 made again once the `retry_after` it named has passed — twice at most. A 429
   * used to fall into the plain-text resend with the formatting errors and go straight back into the limit.
   */
  private async afterRetryAfter<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call();
      } catch (err) {
        const seconds = retryAfterSeconds(err);
        if (seconds === null || attempt > RETRIES_AFTER_429) throw err;
        this.log.warn("telegram asked to slow down", { retry_after: seconds, attempt });
        await this.pacer.sleep(Math.min(seconds, RETRY_AFTER_MAX_S) * 1_000);
      }
    }
  }

  /**
   * One file, through whichever Telegram method suits it.
   *
   * The method choice is the adapter's job and nowhere else's (invariant 2): the engine hands over an
   * `Attachment` with a type, and which of five endpoints that becomes is a fact about Telegram. Sent
   * as `sendDocument` when in doubt, because a document always arrives — `sendPhoto` rejects anything
   * it cannot decode, so guessing wrong there loses the file rather than presenting it plainly.
   */
  private async deliverAttachment(
    attachment: Attachment,
    chatId: string,
    threadId: number | undefined,
  ): Promise<string | null> {
    const body = attachment.buffer;
    if (!body) {
      this.log.warn("outbound attachment has no bytes, so it is skipped", { filename: attachment.filename });
      return null;
    }

    const file = new InputFile(body, attachment.filename ?? "file");
    const options = {
      ...(threadId ? { message_thread_id: threadId } : {}),
      // Telegram caps a caption at 1024 characters and rejects the whole send past it, so a long
      // caption would lose the file it belongs to.
      ...(attachment.caption ? { caption: attachment.caption.slice(0, MAX_CAPTION_CHARS) } : {}),
    };
    const api = this.requireBot().api;

    try {
      const sent = await this.afterRetryAfter<{ message_id: number }>(() =>
        attachment.type === "image"
          ? api.sendPhoto(chatId, file, options)
          : attachment.type === "video"
            ? api.sendVideo(chatId, file, options)
            : attachment.type === "voice"
              ? api.sendVoice(chatId, file, options)
              : attachment.type === "audio"
                ? api.sendAudio(chatId, file, options)
                : api.sendDocument(chatId, file, options),
      );
      return String(sent.message_id);
    } catch (err) {
      if (!(err instanceof GrammyError) || err.error_code === 429 || telegramRefusal(err) !== null) throw err;
      // Telegram refuses a photo it cannot decode, and a screenshot saved with the wrong extension
      // hits that. The file itself is fine, so it goes as a document rather than being lost.
      this.log.warn("telegram refused the typed upload; resending as a document", {
        type: attachment.type,
        error: err.description,
      });
      const sent = await this.afterRetryAfter(() => api.sendDocument(chatId, new InputFile(body, attachment.filename ?? "file"), options));
      return String(sent.message_id);
    }
  }

  protected override refusal(err: unknown): string | null {
    return telegramRefusal(err);
  }

  protected async ping(): Promise<boolean> {
    try {
      await this.requireBot().api.getMe();
      return true;
    } catch {
      return false;
    }
  }

  /** When a `getUpdates` last answered, or 0 since this connection began. */
  private lastPollAt = 0;

  /** The last poll's answer when it is recent, and `getMe` only when it is not. */
  protected override async alive(now = Date.now()): Promise<boolean> {
    if (this.lastPollAt > 0 && now - this.lastPollAt < POLL_PROVES_ALIVE_MS) return true;
    return await this.ping();
  }

  /**
   * Telegram hands out a temporary path, not a URL.
   *
   * `getFile` mints a `file_path` valid for at least an hour, and the download URL embeds the bot
   * token — which is why this cannot live in the engine. Bots are also capped at 20MB by Telegram
   * itself, so a larger file fails here no matter what our own limit says.
   */
  override async fetchAttachment(attachment: Attachment, signal?: AbortSignal): Promise<AttachmentStream | null> {
    const fileId = attachment.url;
    if (!fileId) return null;

    try {
      // Both requests under the engine's deadline: a `getFile` that hangs is as stuck as a download that does.
      // grammY types the signal as its Node shim's; at run time it only listens for "abort", as on any signal.
      const file = await this.requireBot().api.getFile(fileId, signal as Parameters<Bot["api"]["getFile"]>[1]);
      if (!file.file_path) return null;

      const download = await openDownload(`https://api.telegram.org/file/bot${this.options.token}/${file.file_path}`, signal);
      if ("status" in download) {
        this.log.warn("attachment download failed", { status: download.status });
        return null;
      }
      return download;
    } catch (err) {
      // Never fatal: a message whose attachment could not be fetched still has its text, and the
      // turn says the file was unavailable rather than dying.
      this.log.warn("attachment fetch failed", { error: String(err) });
      return null;
    }
  }

  override async setTyping(chatId: string): Promise<void> {
    try {
      const { chatId: id, threadId } = splitChatId(chatId);
      await this.requireBot().api.sendChatAction(id, "typing", {
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    } catch {
      // A typing indicator is decoration. Failing to show it must never fail the turn.
    }
  }

  /**
   * Replace the bot's command menu with the daemon's current hook list.
   *
   * Telegram's `setMyCommands` does a full replace, which is exactly the semantics we want:
   * stale entries are removed, new ones are added, and existing ones are updated in one call.
   *
   * Names go in as `telegramMenu` spells them — see there.
   */
  override async syncCommands(
    commands: { command: string; description: string }[],
  ): Promise<{ synced: number }> {
    await this.requireBot().api.setMyCommands(telegramMenu(commands));
    return { synced: commands.length };
  }

  private requireBot(): Bot {
    if (!this.bot) throw new GatewayError(this.id, "not connected");
    return this.bot;
  }
}

/**
 * Quote the message being answered — and still answer if it is gone.
 *
 * Without `allow_sending_without_reply`, Telegram refuses the whole message when the one it quotes
 * was deleted ("message to be replied not found"). The plain-text retry quoted it too and was refused
 * the same way, the buffer's retry after that as well, and the answer was dropped: live, in a group, a
 * person deleted their `@nero halo` while nero was answering it, and from the chat nero never spoke.
 * The quote is a courtesy; the answer is the point.
 */
export function replyParameters(
  replyTo: string,
): { message_id: number; allow_sending_without_reply: true } | undefined {
  // Only a Telegram message id can be quoted. An internal handover carries the engine's own id —
  // there is no Telegram message behind it on this bot — and `Number("msg_…")` is not a message.
  if (!/^\d+$/.test(replyTo)) return undefined;
  return { message_id: Number(replyTo), allow_sending_without_reply: true };
}

/** Forum topics' names, bounded: cleared past the cap, and a topic is named again by its next message. */
class TopicNames {
  private readonly names = new Map<string, string>();
  remember(chatId: string, name: string): void {
    if (this.names.size >= 1_000) this.names.clear();
    this.names.set(chatId, name);
  }
  get(chatId: string): string | undefined {
    return this.names.get(chatId);
  }
}

/** `-100123:45` → chat -100123, topic 45. */
function splitChatId(value: string): { chatId: string; threadId?: number } {
  const separator = value.lastIndexOf(":");
  if (separator === -1) return { chatId: value };
  const thread = Number.parseInt(value.slice(separator + 1), 10);
  return Number.isNaN(thread)
    ? { chatId: value }
    : { chatId: value.slice(0, separator), threadId: thread };
}

/**
 * A command menu as Telegram takes it. A name is `[a-z0-9_]` only, and one that is not refuses the whole
 * list — every command's menu entry, for one name. So `daemon-restart` goes in as `daemon_restart`, the
 * spelling a tap then sends, which the daemon answers too.
 */
export function telegramMenu(commands: { command: string; description: string }[]): { command: string; description: string }[] {
  return commands.map((c) => ({ command: c.command.replaceAll("-", "_"), description: c.description }));
}

/**
 * `409 Conflict` from `getUpdates` — one poll too many on one token.
 *
 * Matched on the code and not the sentence: Telegram's wording has changed before, and the code is the
 * part that carries the meaning. The sentence ("make sure that only one bot instance is running") is
 * also actively misleading once the local side is correct, because the other instance it names was
 * usually this daemon's own previous poll.
 */
export function isConflict(err: unknown): boolean {
  if (err instanceof GrammyError) return err.error_code === 409;
  // The polling loop can surface the same failure wrapped, and `instanceof` does not survive a second
  // copy of the module. The code is still in the text — and the code is all that is matched.
  return /\b409\b/.test(String(err));
}

/** The updates this adapter handles — and so the only ones it asks Telegram for (`pollingOptions`). */
const TELEGRAM_UPDATES = ["message", "edited_message", "callback_query"] as const;
type TelegramUpdate = (typeof TELEGRAM_UPDATES)[number];

/**
 * How this adapter polls — with no callbacks in it, so what is asked of Telegram can be read and tested on its own.
 */
export function pollingOptions(): { drop_pending_updates: boolean; allowed_updates: TelegramUpdate[]; timeout: number } {
  return {
    /**
     * Kept, on the first poll of a process and on every reconnect after it.
     *
     * It was dropped at startup, for a sound reason: a daemon that was down overnight should not wake
     * up and answer yesterday. But nothing could tell yesterday from a minute ago, so the message sent
     * during a one-minute reboot — an update, a power cut — went with it. The engine's inbox decides
     * now (`pipeline/inbox.store.ts`): a message sent in the last quarter hour is answered, an older
     * one gets a notice saying it came in while the daemon was offline, and one that arrives twice —
     * an update a dead process never confirmed — is answered once.
     *
     * It was once unconditionally true, which meant every reconnect silently threw away everything
     * sent while the gateway was down. Live: two "tes" messages during an hour-long outage got no
     * reply even after the connection came back — which reads as the bot ignoring you rather than as
     * an outage.
     */
    drop_pending_updates: false,
    /**
     * What this adapter handles, and nothing else: `message`, and from 0.7.14 a person's edit of one (`edited_message`)
     * and a press on a button under ours (`callback_query`). Without the list Telegram sends every kind the bot is
     * allowed — channel posts, member changes — each fetched over the card's network and then dropped. Said on every
     * poll because Telegram remembers the last list it was given.
     */
    allowed_updates: [...TELEGRAM_UPDATES],
    // Stated rather than left to grammY's default, because the client timeout the bot is built with is
    // derived from it. The two have to move together or the request timeout starts cutting healthy polls.
    timeout: POLL_TIMEOUT_SECONDS,
  };
}
