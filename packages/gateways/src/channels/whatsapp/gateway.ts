/**
 * WhatsApp gateway — a *client of the bridge*, never a Baileys integration.
 *
 * Nothing in this file imports `@whiskeysockets/baileys`; the entire coupling is the newline-delimited
 * JSON protocol in `@nouride/shared/types/bridge`, spoken over a channel the engine supplies. That
 * separation is §6 ARCHITECTURE, and it is what lets the adapter serve the bridge the engine hosts in its
 * own process, and a test drive it with a fake channel and no bridge at all.
 *
 * Pairing is the part that shapes the design. WhatsApp has no bot token — you scan a QR with a phone,
 * once, and the credentials that come back are what must survive a restart. So the QR is not logged
 * and forgotten: it is held here, handed to whoever asks through the control API, and cleared the
 * moment the link is established. A bridge that reprints a QR on every boot is a bridge whose session
 * directory is not being persisted, which is the failure this is built to avoid.
 */

import { join, randomUuid, tempDir, writeBytesSync } from "@nouride/runtime";
import {
  BRIDGE_PROTOCOL_VERSION,
  contained,
  type Attachment,
  type BridgeCommand,
  type BridgeEvent,
  type GatewayResilienceConfig,
  type OutboundMessage,
} from "@nouride/shared";
import { parseMarkdown } from "../../commons/markdown.ts";
import { chunkRendered, sendsText } from "../../commons/text.ts";
import { BaseGateway, type GatewayIdentity, deliverInParts, UndeliverableError } from "../../commons/resilience.ts";
import { whatsappEnvelope } from "./envelope.ts";
import { toWhatsAppText } from "./format.ts";

/**
 * How the bridge is reached.
 *
 * An interface the engine fills in with the bridge it hosts in its own process
 * (`apps/engine/src/modules/gateways/bridge.ts`). A test hands over a fake.
 */
export interface BridgeChannel {
  writeLine(line: string): void;
  lines(): AsyncIterableIterator<string>;
  close(): void;
  /** Resolves when the far side goes away. */
  closed: Promise<void>;
}

/**
 * What the opener needs that the config alone cannot give it.
 *
 * The session key travels this way rather than in the `hello` line on purpose: the protocol is
 * newline JSON that both sides log when something goes wrong, and a credential in it would end up in
 * a journal. The bridge the daemon hosts is handed it here.
 */
export interface BridgeContext {
  sessionDir: string;
  encryptionKey: string;
}

export type BridgeChannelFactory = (
  context: BridgeContext,
) => BridgeChannel | Promise<BridgeChannel>;

/**
 * How a WhatsApp connection reconnects, over every platform's (`DEFAULT_RESILIENCE`): fewer attempts, further apart. Its
 * login is the flakiest of the three, and a session WhatsApp has started refusing is not mended by asking it faster.
 * A gateway's `[resilience]` table set these until 0.8.0, which nobody tuned — the adapter's own now.
 */
const WHATSAPP_PACING: Partial<GatewayResilienceConfig> = {
  maxReconnectAttempts: 5,
  reconnectBackoffMs: 2000,
  reconnectBackoffMaxMs: 120_000,
};

export interface WhatsAppGatewayOptions extends GatewayIdentity {
  sessionDir: string;
  /** Hex key for encrypting the session at rest. */
  encryptionKey: string;
  /**
   * The agent this connection belongs to.
   *
   * Needed because WhatsApp tags a number, not a name: turning "this number was tagged" into a
   * mention the router can act on requires knowing whose number it is.
   */
  agentId?: string;
  /** Over `WHATSAPP_PACING`. A test's own. */
  resilience?: Partial<GatewayResilienceConfig>;
  /** Opens the transport. Supplied by the engine, which decides where the bridge runs (`gateways/bridge.ts`). */
  openChannel: BridgeChannelFactory;
}

/**
 * How long to let the bridge act on `logout` before the process is stopped.
 *
 * It has one round trip to make to WhatsApp and a few files to delete. Long enough for that on a
 * slow link, short enough that a delete does not feel hung.
 */
const LOGOUT_GRACE_MS = 3_000;

/** How long a `send` waits for its ack before giving up. */
const ACK_TIMEOUT_MS = 30_000;

/**
 * How long a send waits for the number to finish linking.
 *
 * Short enough that a reply is not left hanging, long enough to cover the reconnect WhatsApp forces
 * immediately after a QR scan — which is exactly when the first message tends to arrive.
 */
const LINK_WAIT_MS = 20_000;

/**
 * How long a number that was linked may be down before the bridge counts as unhealthy (`ping`) and is restarted: past
 * the bridge's own first tries, short of leaving a chat unanswered for long.
 */
const LINK_LOST_MS = 3 * 60_000;

/**
 * WhatsApp's own ceiling on a text message.
 *
 * The platform's limit, not a readability choice — a smaller number here would split messages
 * WhatsApp would have delivered whole, and chunking exists to stop a send being *rejected*, not to
 * enforce brevity. Keeping a reply short enough to read on a phone is the prompt's job, and it says
 * so. Larger than Discord's 2000 and Telegram's 4096 by a wide margin, which is why this adapter went
 * without chunking at all and nothing visibly broke: a reply long enough to hit it is rare, and the
 * failure when it arrives is the whole message being refused.
 */
const MAX_MESSAGE_CHARS = 65_536;

interface Pending {
  resolve: (id: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class WhatsAppGateway extends BaseGateway {
  /** What the agent is told about writing here — `Gateway.formatting`: markdown made WhatsApp's marks, a phone, short. */
  readonly formatting =
    "Formatting: write normal markdown; it is converted to WhatsApp's own marks before sending. Headings become bold. This is a phone, so do not use tables; write short labelled lines instead. A table you send anyway is flattened into one, which will not be the layout you intended. Keep replies short and keep code blocks brief.";
  /**
   * No live step bubble here — one closing line instead. See `Gateway.progressStyle`.
   *
   * WhatsApp is where people talk to people. A bubble reading `⏳ 💻 exec sh -c node -v && npm -v`
   * landing in the middle of an answer is the machinery becoming the conversation, and it is the one
   * platform of the three that has no "bot channel" convention to absorb it. The `✓ 5 steps · 57s`
   * line at the end still shows the work.
   */
  readonly progressStyle = "summary" as const;

  private channel: BridgeChannel | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private linked = false;
  /** Linked at least once in this process — what makes a new bridge's wait a lost link rather than pairing (`connect`). */
  private everLinked = false;
  /** When a link that was there was lost, while it stays lost. Never set for a number still pairing. */
  private unlinkedSince: number | null = null;
  /** Set when WhatsApp says this session is finished, so the close that follows is not a hiccup. */
  private expired = false;
  /**
   * Chats WhatsApp has refused to deliver to, and why.
   *
   * Kept so the next message does not walk into the same wall. `463` means the account is restricted
   * from starting new chats, and Baileys is explicit that each attempt "counts as another reach out
   * and worsens the restriction" — so trying again is not neutral, it is harmful.
   */
  private readonly refused = new Map<string, { code: string; reason: string; at: number }>();
  /** Sends parked until the bridge reports `ready`. See `awaitLink`. */
  private linkWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

  /**
   * The most recent pairing code, or null once linked.
   *
   * Public because the control API serves it: a QR that only ever reached the log is a QR nobody can
   * scan, since the person holding the phone is usually not the person reading `journalctl`.
   */
  private qrCode: { qr: string; at: number } | null = null;
  /** Groups' subjects, as the bridge said them on their messages (0.7.24) — what `roomTitle` answers. */
  private readonly titles = new Map<string, string>();

  constructor(private readonly options: WhatsAppGatewayOptions) {
    super(options, { ...WHATSAPP_PACING, ...options.resilience });
  }

  /** The pending pairing code, if the bridge is waiting to be linked. */
  pairingCode(): { qr: string; at: number } | null {
    return this.qrCode;
  }

  /** Whether the session directory already holds working credentials. */
  isLinked(): boolean {
    return this.linked;
  }

  protected async connect(): Promise<void> {
    /**
     * Idempotent, because the base class does not know this one spawns a process.
     *
     * `attemptConnect()` calls `connect()` on every reconnect and never calls `disconnect()` first.
     * For Telegram and Discord that is harmless — the old client object becomes garbage. Here it
     * leaked an entire `bun` + Baileys process per reconnect, each still holding a WhatsApp session
     * and still writing the same credential files. On a live box that reached load average 204 and
     * exhausted 4GB, to the point sshd could not complete a banner exchange.
     *
     * So connecting closes whatever was open first. The fix belongs here rather than in the base
     * class: owning a subprocess is this adapter's problem, and every other adapter would pay for a
     * teardown it does not need.
     */
    await this.disconnect();
    this.expired = false;
    // A new bridge is linked when it says so. One that was linked before gets its own grace before `ping` gives up on it.
    this.linked = false;
    if (this.everLinked) this.unlinkedSince = Date.now();

    const channel = await this.options.openChannel({
      sessionDir: this.options.sessionDir,
      encryptionKey: this.options.encryptionKey,
    });
    this.channel = channel;

    // Read before saying hello. The handshake reply is an event like any other, and a reader started
    // afterwards can miss it on a fast bridge.
    void this.readLoop(channel);

    this.send_({
      type: "hello",
      version: BRIDGE_PROTOCOL_VERSION,
      sessionDir: this.options.sessionDir,
    });

    void channel.closed.then(() => {
      if (this.channel === channel) {
        this.channel = null;
        this.failPending("the bridge process exited");
        this.handleDisconnect("bridge exited");
      }
    });
  }

  protected async disconnect(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    this.failPending("the gateway is shutting down");
    if (!channel) return;
    try {
      // Asked to leave rather than killed, so Baileys can close its socket cleanly. A hard kill
      // mid-write is one way a session directory ends up half-written.
      channel.writeLine(JSON.stringify({ type: "shutdown" } satisfies BridgeCommand));
    } catch {
      // Already gone. Closing below is still correct.
    }
    channel.close();
  }

  /**
   * Wait for the bridge to finish signing in.
   *
   * The gateway reports `connected` as soon as the bridge process is reachable, which is what lets a
   * QR be fetched at all — but reachable is not signed in. A reply written in that window used to be
   * handed straight to Baileys, which threw `authState.creds.me.id is undefined` and the message was
   * dropped. It cost a real answer to a real person: they were approved, they messaged, and nothing
   * came back.
   *
   * Bounded, because waiting forever is its own failure. Past the bound the send fails and the base
   * class buffers it for the next successful connect, which is the outcome that loses nothing.
   */
  private awaitLink(timeoutMs: number): Promise<void> {
    if (this.linked) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(
        contained(this.log, "could not stop waiting for the WhatsApp link", () => {
          this.linkWaiters = this.linkWaiters.filter((waiter) => waiter !== entry);
          reject(new Error("the WhatsApp number has not finished linking"));
        }),
        timeoutMs,
      );
      this.linkWaiters.push(entry);
    });
  }

  protected async deliver(msg: OutboundMessage): Promise<string[]> {
    if (!this.channel) throw new Error("the WhatsApp bridge is not connected");

    // Refused before, terminally. Attempting again would make the restriction worse, so this stops
    // here — loudly, because the alternative is a chat that silently never answers.
    const wall = this.refused.get(msg.chatId);
    if (wall) {
      this.log.error("not sending: WhatsApp has refused this chat", {
        chat_id: msg.chatId,
        code: wall.code,
        reason: wall.reason,
      });
      throw new UndeliverableError(this.id, wall.reason);
    }

    await this.awaitLink(LINK_WAIT_MS);


    // Same guard as the other two adapters: `chunk("")` yields the "(empty response)" placeholder,
    // which belongs to a reply that produced no text and not to a message whose content is a file.
    const textParts = sendsText(msg)
      ? chunkRendered(msg.text, MAX_MESSAGE_CHARS, (part) => toWhatsAppText(parseMarkdown(part)))
      : [];

    // Text in parts, then files — and if a part fails after one landed, only what is left goes into the
    // buffer (`deliverInParts`).
    return await deliverInParts(msg, textParts, {
      text: async (part, index, ids) => {
        // Chunked as markdown and converted per part, in that order — the same reason Telegram renders
        // after chunking: a byte budget cut through converted output lands inside a mark, and a `*`
        // with no partner is drawn as an asterisk on every phone in the chat.
        //
        // The engine hands every platform the same markdown; WhatsApp's marks are not markdown's, so
        // the conversion happens here and nowhere upstream. See `channels/whatsapp/format.ts`.
        const text = toWhatsAppText(parseMarkdown(part));

        // Only the jids this part actually tags. WhatsApp notifies everyone in `mentionedJid` whether
        // or not their tag is in the text, so carrying the whole list onto every chunk would ping a
        // person once per part of an answer that names them once.
        const mentions = (msg.mentions ?? []).filter((jid) => text.includes(jid.split("@")[0] ?? jid));

        ids.push(
          await this.request((id) => ({
            type: "send",
            id,
            chatId: msg.chatId,
            text,
            // Only the first chunk quotes the trigger; repeating the quote on every part is unreadable.
            ...(index === 0 && msg.replyTo ? { replyTo: msg.replyTo } : {}),
            ...(mentions.length > 0 ? { mentions } : {}),
          })),
        );
      },

      attachment: async (attachment, ids) => {
        let path = attachment.url;
        if (path && /^https?:\/\//i.test(path)) path = undefined;

        if (!path && attachment.buffer) {
          const tmpName = `wa_out_${randomUuid()}_${attachment.filename ?? "file"}`;
          path = join(tempDir(), tmpName);
          writeBytesSync(path, attachment.buffer);
        }

        if (!path) return;

        ids.push(
          await this.request((id) => ({
            type: "send_media",
            id,
            chatId: msg.chatId,
            path: path!,
            mimeType: attachment.mimeType ?? "application/octet-stream",
            // The intent, which the mime type cannot express: `audio/ogg` is both a voice note and an
            // audio file, and only one of them gets the push-to-talk bubble.
            ...(attachment.type === "voice" ? { voice: true } : {}),
            ...(attachment.caption ? { caption: attachment.caption } : {}),
            ...(msg.mentions?.length ? { mentions: msg.mentions } : {}),
          })),
        );
      },
    });
  }

  /**
   * A group's subject — `Gateway.roomTitle` (0.7.24) — as the bridge last said it on a message from the group. The
   * bridge asks WhatsApp in the background, so a group's first message may come without one; nothing for a one-to-one.
   */
  async roomTitle(chatId: string): Promise<string | undefined> {
    return this.titles.get(chatId);
  }

  private rememberTitle(chatId: string, title: string): void {
    if (this.titles.size >= 2_000 && !this.titles.has(chatId)) this.titles.clear();
    this.titles.set(chatId, title);
  }

  override async setTyping(chatId: string): Promise<void> {
    if (this.channel) this.send_({ type: "typing", chatId });
  }

  /**
   * Fetch an inbound attachment's bytes for WhatsApp.
   *
   * `wa-bridge` downloads media to a local file on disk before emitting the message event,
   * so `attachment.url` is already a path on disk. `fetch("file://...")` reads the local file.
   */
  override async fetchAttachment(attachment: Attachment): Promise<Uint8Array | null> {
    if (attachment.buffer) return attachment.buffer;
    if (!attachment.url) return null;

    try {
      const url =
        attachment.url.startsWith("http://") || attachment.url.startsWith("https://")
          ? attachment.url
          : attachment.url.startsWith("file://")
            ? attachment.url
            : `file://${attachment.url}`;
      const response = await fetch(url);
      if (!response.ok) {
        this.log.warn("whatsapp attachment download failed", { status: response.status, url });
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      this.log.warn("whatsapp attachment fetch failed", { url: attachment.url, err: String(err) });
      return null;
    }
  }

  /**
   * Blue ticks, once the daemon has actually taken the message.
   *
   * Deliberately not sent on arrival. In `pair` mode an unknown sender's message is dropped, and
   * marking it read would tell them they had been seen by something that is ignoring them.
   */
  override async markRead(chatId: string, messageId: string): Promise<void> {
    if (this.channel) this.send_({ type: "read", chatId, messageId });
  }

  /** Nothing goes out until the number is linked: the buffer waits for `ready` (`flushBuffer`). */
  protected override deliverable(): boolean {
    return this.linked;
  }

  /**
   * Whether the *bridge* is reachable — deliberately not whether WhatsApp is linked.
   *
   * Those are different facts and conflating them breaks pairing. An unlinked bridge is healthy: it
   * is up, it is talking, and it is waiting for a human to scan a code. Reporting it as unhealthy
   * made the health check fail every 30 seconds, tear the gateway down after three, and respawn the
   * bridge — which throws away the QR the person was in the middle of scanning. Seen on the live
   * box, one restart after the first WhatsApp gateway was created.
   *
   * Whether it is linked is answered by `isLinked()`, which the control API serves alongside the
   * pairing code.
   */
  protected async ping(): Promise<boolean> {
    if (this.channel === null) return false;
    /**
     * Unless a number that was linked has been down too long. Then the bridge is reachable and useless — it reported
     * itself trying while the internet was gone, and gave up — and the gateway said `connected` throughout while every
     * reply waited for a link that never came (2026-10-21). Not for a number never linked here: that is pairing, above.
     */
    if (!this.linked && this.unlinkedSince !== null && Date.now() - this.unlinkedSince > LINK_LOST_MS) return false;
    return true;
  }

  /**
   * Unlink this account and delete the session, then stop.
   *
   * The bridge's `logout` handler is the only path that deletes credentials — it calls WhatsApp's own
   * logout so the device disappears from the phone's linked-devices list, then clears the auth files.
   * Nothing sent it until now: removing a gateway deleted the session *directory* and left the
   * account linked, so the phone still showed a device for a connection that no longer existed.
   *
   * Ordering is the whole point of putting this on the gateway rather than doing it from the caller.
   * Baileys rewrites `creds.enc` on every credential update, so deleting the directory underneath a
   * live bridge simply gets it written again — which is exactly what "I deleted it and it is still
   * there" looked like. Logout, then stop, then the caller may remove what is left.
   *
   * Never throws. A bridge that is already gone, or an account already unlinked from the phone, both
   * mean the same thing to the caller: there is nothing left to log out of. Reported so the reply can
   * be honest about whether the device was actually released.
   */
  async logoutAndStop(): Promise<{ loggedOut: boolean; reason?: string }> {
    if (!this.channel) {
      await this.stop();
      return { loggedOut: false, reason: "the bridge was not running" };
    }

    try {
      this.send_({ type: "logout" });
      // No ack to wait on — `logout` carries no id, by design: the bridge tears its socket down as
      // part of handling it, so an acknowledgement would race the teardown. A short grace period is
      // the honest alternative to a promise that cannot be kept.
      await new Promise((resolve) => setTimeout(resolve, LOGOUT_GRACE_MS));
      await this.stop();
      return { loggedOut: true };
    } catch (err) {
      // Stopped regardless. Leaving the bridge running after a delete is worse than an unclean
      // logout: it holds the memory and can write the session files back.
      await this.stop();
      return { loggedOut: false, reason: String(err) };
    }
  }

  // ── Protocol ───────────────────────────────────────────────────────────────

  private send_(command: BridgeCommand): void {
    this.channel?.writeLine(JSON.stringify(command));
  }

  /** A command that expects an ack, resolved by id. */
  private request(build: (id: string) => BridgeCommand): Promise<string> {
    const id = `c${++this.nextId}`;
    const command = build(id);
    // Logged at info, not debug: an outbound message that vanishes leaves nothing else behind, and
    // the whole reason this line exists is that one did — with no error anywhere, on either side.
    this.log.info("sending to the bridge", {
      id,
      kind: command.type,
      ...("chatId" in command ? { chat_id: command.chatId } : {}),
    });

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        contained(this.log, "could not time out a command the WhatsApp bridge did not acknowledge", () => {
          this.pending.delete(id);
          reject(new Error(`the WhatsApp bridge did not acknowledge within ${ACK_TIMEOUT_MS}ms`));
        }, { id }),
        ACK_TIMEOUT_MS,
      );

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send_(command);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private failPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
    // **Rejected**, not resolved. Releasing them as success let the send carry on into a channel that
    // no longer exists, where it then waited the full ack timeout — the test caught exactly that.
    // Failing here is what hands the message back to the base class to buffer for the next connect.
    for (const waiter of this.linkWaiters.splice(0)) waiter.reject(new Error(reason));
  }

  private async readLoop(channel: BridgeChannel): Promise<void> {
    try {
      for await (const line of channel.lines()) {
        let event: BridgeEvent;
        try {
          event = JSON.parse(line) as BridgeEvent;
        } catch {
          // Not fatal: the bridge's dependencies write to stdout uninvited, and one stray line is
          // not a reason to drop a working session.
          this.log.warn("unparseable line from the bridge", { line: line.slice(0, 200) });
          continue;
        }
        this.handleEvent(event);
      }
    } catch (err) {
      this.log.warn("bridge read loop ended", { error: String(err) });
    }
  }

  private handleEvent(event: BridgeEvent): void {
    switch (event.type) {
      case "ready":
        if (event.version !== BRIDGE_PROTOCOL_VERSION) {
          // Refused rather than tolerated: the two protocol files are hand-copied across the licence
          // boundary, and a silent drift is exactly what the version field exists to catch.
          this.log.error("bridge protocol mismatch", {
            engine: BRIDGE_PROTOCOL_VERSION,
            bridge: event.version,
          });
          this.handleDisconnect("protocol version mismatch");
          return;
        }
        this.linked = true;
        this.everLinked = true;
        this.unlinkedSince = null;
        this.expired = false;
        this.qrCode = null;
        // A relink is the one moment the restriction may have lifted, so the wall is worth retesting.
        this.refused.clear();
        for (const waiter of this.linkWaiters.splice(0)) waiter.resolve();
        this.log.info("whatsapp linked", { number: maskedNumber(event.jid) });
        // What waited for the link goes now: nothing else would send it while the bridge stays connected.
        void this.flushBuffer();
        return;

      case "qr":
        // Held, not just logged — the control API serves this to the dashboard so the QR reaches a
        // phone rather than a terminal.
        this.qrCode = { qr: event.qr, at: Date.now() };
        this.log.info("whatsapp pairing code ready; scan it from the dashboard");
        return;

      case "status":
        // The bridge trying again says `connecting`, never seen above — but the link is gone from that moment.
        if (event.status !== "connected" && this.linked) {
          this.linked = false;
          this.unlinkedSince = Date.now();
        }
        if (event.status === "disconnected") {
          this.linked = false;
          // The bridge sends `session_expired` and then a `disconnected` for the same event. Without
          // this the reconnect path immediately overwrote the `dead` status the expiry had just set,
          // and the daemon went back to respawning a bridge that can only show a QR.
          if (this.expired) {
            this.log.warn("not reconnecting: this session needs to be linked again");
            return;
          }
          this.handleDisconnect(event.reason);
        }
        return;

      case "session_expired":
        this.linked = false;
        this.expired = true;
        this.qrCode = null;
        this.log.warn("whatsapp session expired; the phone must scan a new code");
        this.handleSessionExpired();
        return;

      case "message": {
        if (event.chatTitle) this.rememberTitle(event.chatId, event.chatTitle);
        const envelope = whatsappEnvelope(event, { gatewayId: this.id, agentId: this.options.agentId });
        if (envelope) this.emitMessage(envelope);
        return;
      }

      case "ack": {
        const entry = this.pending.get(event.id);
        if (!entry) {
          // An ack for something we are no longer waiting on — a retry that raced its own timeout.
          // Said, because silence here once hid a send that never resolved.
          this.log.debug("ack for an unknown command", { id: event.id });
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(event.id);
        this.log.debug("bridge acked", { id: event.id });
        entry.resolve(event.id);
        return;
      }

      case "delivery_refused": {
        const { reason, terminal } = explainRefusal(event.code);
        if (terminal) this.refused.set(event.chatId, { code: event.code, reason, at: Date.now() });
        // `error`, not `warn`: from the outside this is the agent ignoring somebody, and it was
        // invisible until now — the send resolved, the ack came back, and the reply never arrived.
        this.log.error("whatsapp refused to deliver a message", {
          chat_id: event.chatId,
          code: event.code,
          reason,
        });
        this.emitEvent({
          type: "delivery_refused",
          gatewayId: this.id,
          chatId: event.chatId,
          code: event.code,
          reason,
          terminal,
        });
        return;
      }

      case "error": {
        if (event.id) {
          const entry = this.pending.get(event.id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(event.id);
            entry.reject(new Error(event.message));
            return;
          }
        }
        this.log.warn("bridge error", { message: event.message });
        return;
      }
    }
  }
}

/**
 * What a platform refusal means, and whether trying again helps.
 *
 * `463` is the one seen in practice. WhatsApp blocks a restricted account from *starting* chats while
 * leaving established ones alone, so it reads as "the bot works for nobody" from the outside. The
 * cause is almost always a fresh number that linked repeatedly and then sent automated replies to
 * someone who had not saved it.
 */
function explainRefusal(code: string): { reason: string; terminal: boolean } {
  if (code === "463") {
    return {
      terminal: true,
      reason:
        "WhatsApp refused to deliver it: this number is restricted from starting new chats " +
        "(error 463, missing privacy token). Save the bot's number as a contact on the other phone " +
        "and message it again, or wait out the restriction. Do not retry: each attempt counts as " +
        "another reach-out and makes it worse.",
    };
  }
  if (code === "479") {
    return {
      terminal: false,
      reason: "WhatsApp rejected the stanza (479): usually a stale device session. A relink fixes it.",
    };
  }
  return { terminal: false, reason: `WhatsApp refused it with code ${code}.` };
}

/**
 * The linked number as the journal may hold it: its last four digits. "whatsapp linked" logged the whole JID at info,
 * which put the box owner's phone number in every journal and log table a box keeps.
 */
export function maskedNumber(jid: string): string {
  const digits = jid.split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? "";
  return digits.length > 4 ? `…${digits.slice(-4)}` : "…";
}
