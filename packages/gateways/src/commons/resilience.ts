/**
 * Reconnection, health checks and outbound buffering — §5.5 SPEC.
 *
 * Every gateway inherits this. Platform adapters implement four primitives
 * (`connect`, `disconnect`, `deliver`, `ping`) and get the retry loop, the
 * exponential backoff, the bounded send buffer and the status events for free.
 * Three copies of this logic would have drifted apart within a month.
 */

import {
  backoffDelay,
  contained,
  createLogger,
  DEFAULT_RESILIENCE,
  GatewayAuthError,
  type Attachment,
  type AttachmentStream,
  type ButtonPress,
  type Gateway,
  type GatewayEvent,
  type GatewayName,
  type GatewayResilienceConfig,
  type GatewayStatus,
  type MessageEnvelope,
  type OutboundMessage,
  type PressAnswer,
} from "@nouride/shared";

/** Outbound messages held while disconnected. Beyond this, the oldest is dropped. */
const OUTBOUND_BUFFER_LIMIT = 100;

/** Consecutive failed pings before we stop believing a "connected" socket. */
const HEALTH_FAILURE_THRESHOLD = 3;

/**
 * Refused credentials in a row before a gateway is given up on (G8). Two, not one: Telegram answers a 401 now and
 * then for a token that is fine, and one more try costs a second where ten cost ten minutes.
 */
const AUTH_FAILURES_TO_DIE = 2;

/**
 * How long a connection has to hold before the retry budget is handed back.
 *
 * The counter used to reset the instant `connect()` returned, which is not the same thing as being
 * connected. Telegram's `connect()` returns as soon as `bot.init()` validates the token — polling
 * starts afterwards and can fail a third of a second later. It did: two instances were polling the
 * same token, every cycle went connect → reset to zero → 409 → "reconnecting, attempt 1", and the
 * backoff never got past its first step. Sub-second reconnects against the Telegram API for as long
 * as it lasted, `maxReconnectAttempts` unreachable, so the `dead` event that would have alerted the
 * operator never fired and nothing in the log said this was a loop rather than one bad minute.
 *
 * A minute is long enough that a connection which survives it is genuinely up, and short enough that
 * an ordinary overnight blip does not carry its attempt count into the next day.
 */
const CONNECTION_STABLE_AFTER_MS = 60_000;

/**
 * How long the teardown before a connect may take. discord.js waits for the old socket's `close` with no limit of its
 * own, and on the live box one never came: a login timed out, the retry's `destroy()` of that client never returned,
 * and the gateway sat at "connecting" for good — its old client still taking messages in, nothing able to answer them.
 * Thirty seconds, Telegram's own long poll, so an honest close — `bot.stop()` drains its poll — always has the time.
 */
const TEARDOWN_TIMEOUT_MS = 30_000;


/**
 * A message that landed in part: its first chunks or attachments went out, then one failed. Thrown by a
 * gateway's `deliver` so `send` buffers only what is left — re-sending the whole message would show the
 * person the part they already have a second time.
 */
export class PartialDeliveryError extends Error {
  override name = "PartialDeliveryError";
  constructor(
    /** The ids of what did go out — the message was delivered, if not all of it. */
    readonly sentIds: string[],
    /** What is still to send: the remaining text and attachments, quoting nothing. */
    readonly remaining: OutboundMessage,
    readonly reason: unknown,
  ) {
    super(`delivered in part: ${String(reason)}`);
  }
}

/**
 * A message the platform refused for good: a chat the bot cannot write to — its own id, a person who blocked it, a room
 * it was removed from — or a file it will never take. Never buffered or retried, since the same request gets the same
 * answer: thrown to the caller, who can say it was not delivered. Buffered, it was retried twice, dropped in the log,
 * and a scheduled run reported its reply as delivered.
 */
export class UndeliverableError extends Error {
  override name = "UndeliverableError";
  constructor(
    readonly gatewayId: string,
    /** The platform's own words for the refusal. */
    readonly reason: string,
    readonly cause?: unknown,
  ) {
    super(reason);
  }
}

/** What a failed part leaves to send: the rest of the text, or — once the text went — the rest of the files. */
export function remainingAfter(
  msg: OutboundMessage,
  at: { textParts: readonly string[]; textIndex: number } | { attachmentIndex: number },
): OutboundMessage {
  const { replyTo: _replyTo, ...rest } = msg;
  return "textIndex" in at
    ? { ...rest, text: at.textParts.slice(at.textIndex).join("\n\n") }
    : { ...rest, text: "", attachments: (msg.attachments ?? []).slice(at.attachmentIndex) };
}

/**
 * Send a message the way every adapter does — its text in parts, then its files, each part pushing the id
 * it got onto `ids` — and when a part fails after an earlier one landed, throw a `PartialDeliveryError`
 * naming what is left. The adapters keep everything that is platform-specific; this keeps the one rule
 * they share.
 */
export async function deliverInParts(
  msg: OutboundMessage,
  textParts: readonly string[],
  send: {
    text: (part: string, index: number, ids: string[]) => Promise<void>;
    attachment: (attachment: Attachment, ids: string[]) => Promise<void>;
  },
  /** Waited for before each part — every one is a message of its own to the platform (`Pacer`, G7). */
  pace: () => Promise<void> = async () => {},
): Promise<string[]> {
  const ids: string[] = [];
  let at: Parameters<typeof remainingAfter>[1] = { textParts, textIndex: 0 };
  try {
    for (const [index, part] of textParts.entries()) {
      at = { textParts, textIndex: index };
      await pace();
      await send.text(part, index, ids);
    }
    for (const [index, attachment] of (msg.attachments ?? []).entries()) {
      at = { attachmentIndex: index };
      await pace();
      await send.attachment(attachment, ids);
    }
  } catch (err) {
    if (ids.length === 0) throw err;
    throw new PartialDeliveryError([...ids], remainingAfter(msg, at), err);
  }
  return ids;
}

export interface GatewayIdentity {
  /** Instance id, `platform:name`. */
  id: string;
  platform: GatewayName;
}

export abstract class BaseGateway implements Gateway {
  readonly id: string;
  readonly platform: GatewayName;

  protected readonly resilience: GatewayResilienceConfig;
  protected readonly log: ReturnType<typeof createLogger>;

  private _status: GatewayStatus = "disconnected";
  private messageHandlers: ((env: MessageEnvelope) => void)[] = [];
  private eventHandlers: ((event: GatewayEvent) => void)[] = [];
  private pressHandler?: (press: ButtonPress) => Promise<PressAnswer>;
  private outboundBuffer: OutboundMessage[] = [];
  private reconnectAttempts = 0;
  private healthFailures = 0;
  /** Connects in a row the platform refused the credentials for (`AUTH_FAILURES_TO_DIE`). */
  private authFailures = 0;
  /**
   * Minimum delay before the next reconnect, set by whatever failed. See `handleDisconnect`.
   *
   * Not a config value: it is a property of a *failure*, not of a gateway, and only the adapter that
   * read the error knows whether one is needed.
   */
  private settleMs = 0;
  private healthTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Pending "this connection has held long enough" reset — see `CONNECTION_STABLE_AFTER_MS`. */
  private stableTimer?: ReturnType<typeof setTimeout>;
  private stopping = false;

  constructor(identity: GatewayIdentity, resilience: Partial<GatewayResilienceConfig> = {}) {
    this.id = identity.id;
    this.platform = identity.platform;
    this.resilience = { ...DEFAULT_RESILIENCE, ...resilience };
    // Logger is namespaced by instance, not platform: with two Telegram bots running, "which
    // one reconnected?" is the first question anyone asks.
    this.log = createLogger(`gateway.${identity.id}`);
  }

  get status(): GatewayStatus {
    return this._status;
  }

  // ── Platform primitives ───────────────────────────────────────────────────

  /** Open the connection. Throw to signal failure; the retry loop handles the rest. */
  protected abstract connect(): Promise<void>;

  /** Close the connection. Must not throw — it runs during shutdown. */
  protected abstract disconnect(): Promise<void>;

  /** Actually put the message on the wire, including platform-specific chunking. */
  protected abstract deliver(msg: OutboundMessage): Promise<string[]>;

  /** Liveness probe. `false` counts toward the failure threshold. */
  protected abstract ping(): Promise<boolean>;

  /**
   * Whether the connection is alive, as the health timer asks it: `ping()`, unless the adapter already hears from the
   * platform on a schedule of its own and can answer from that (E11) — a request every thirty seconds per bot, at
   * idle, to learn what the last poll already said. The probe after a failed send still pings: it asks about now.
   */
  protected async alive(): Promise<boolean> {
    return await this.ping();
  }

  /**
   * The platform's words when `err` is a refusal no retry changes, or null for a failure worth another try. Each
   * adapter knows its platform's answers (invariant 2); by default nothing is final.
   */
  protected refusal(_err: unknown): string | null {
    return null;
  }

  /** Show the platform's typing affordance. Default is a no-op. */
  async setTyping(_chatId: string): Promise<void> {}

  /**
   * Mark an inbound message as read, on platforms that show it.
   *
   * Called once the daemon has *accepted* a message rather than when it arrives — a read marker on a
   * message that is then dropped tells the sender they were seen by something that is ignoring them.
   * A no-op everywhere it has no meaning.
   */
  async markRead(_chatId: string, _messageId: string): Promise<void> {}

  /**
   * No editing by default.
   *
   * Declared here rather than left off so the adapters that implement it can say `override` and have
   * that mean something — the same pattern `setTyping` and `fetchAttachment` follow. `false` reads the
   * same to the engine either way: the message stands as it was.
   */
  async editMessage(_chatId: string, _messageId: string, _text: string): Promise<boolean> {
    return false;
  }

  /**
   * No attachment retrieval by default.
   *
   * Declared here rather than left off the base class so the two adapters that implement it can say
   * `override` and have that mean something — the same pattern `setTyping` follows. `null` reads the
   * same to the engine either way: the bytes could not be retrieved, say so in the turn.
   */
  async fetchAttachment(_attachment: Attachment, _signal?: AbortSignal): Promise<Uint8Array | AttachmentStream | null> {
    return null;
  }

  /**
   * No command menu by default.
   *
   * Platforms that have one (Telegram, Discord) override this; the rest inherit a no-op
   * that reports zero synced, which is accurate rather than misleading.
   */
  async syncCommands(_commands: { command: string; description: string }[]): Promise<{ synced: number }> {
    return { synced: 0 };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopping = false;
    await this.attemptConnect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearInterval(this.healthTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.stableTimer);
    try {
      if (!(await this.teardown())) this.log.warn("disconnect did not finish during stop", { after_ms: this.teardownMs() });
    } catch (err) {
      this.log.warn("disconnect failed during stop", { error: String(err) });
    }
    this.setStatus("disconnected");
  }

  async send(msg: OutboundMessage): Promise<string[]> {
    if (this._status !== "connected") {
      this.buffer(msg);
      // Buffered, so there are no ids yet and there may never be. The caller reads that as nothing to
      // remember, which is correct: a message that has not been sent cannot be replied to.
      return [];
    }
    try {
      return await this.deliver(msg);
    } catch (err) {
      // Refused for good: thrown, not buffered — or, after a part landed, the part that did is what the caller gets.
      const refused = this.refusalOf(err);
      if (refused !== null) {
        this.log.warn("the platform refused the message, so it is not retried", { chat_id: msg.chatId, error: refused });
        if (err instanceof PartialDeliveryError) return err.sentIds;
        throw err instanceof UndeliverableError ? err : new UndeliverableError(this.id, refused, err);
      }
      // Delivered in part: only the rest is buffered, and the caller learns the message did land.
      if (err instanceof PartialDeliveryError) {
        this.log.warn("send failed part-way, buffering the rest", { chat_id: msg.chatId, sent: err.sentIds.length, error: String(err.reason) });
        this.buffer(err.remaining);
        void this.probeAfterSendFailure();
        return err.sentIds;
      }
      /**
       * Buffered, and then the connection is *asked* rather than assumed dead.
       *
       * This used to call `handleDisconnect` outright, on the reasoning that a send failing on a socket
       * we believed healthy is evidence it is not. That is true as evidence and wrong as a conclusion:
       * on Telegram outbound and inbound are separate HTTP requests to the same API, so one `sendPhoto`
       * losing its connection says nothing about whether `getUpdates` is working. And it is the *most*
       * likely request to fail on its own — it uploads megabytes where a poll sends a few bytes.
       *
       * Live, that inference was the whole incident: one failed photo upload tore down a poll that was
       * working, and the reconnect it triggered took Telegram's inbound down for an hour.
       *
       * `ping()` and the consecutive-failure threshold already exist to answer "is this connection
       * dead". A one-off failure now defers to them, and the message it buffered is flushed as soon as
       * the probe says the connection is fine — so nothing is stranded by not reconnecting.
       */
      this.log.warn("send failed, buffering", { chat_id: msg.chatId, error: String(err) });
      this.buffer(msg);
      void this.probeAfterSendFailure();
      return [];
    }
  }

  /** Why `err` — or, for a message delivered in part, what stopped it — is final, or null when it is worth a retry. */
  private refusalOf(err: unknown): string | null {
    const cause = err instanceof PartialDeliveryError ? err.reason : err;
    return cause instanceof UndeliverableError ? cause.reason : this.refusal(cause);
  }

  onMessage(handler: (env: MessageEnvelope) => void): void {
    this.messageHandlers.push(handler);
  }

  onEvent(handler: (event: GatewayEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /** Where a press goes — `Gateway.onPress`. One: a press has one answer. */
  onPress(handler: (press: ButtonPress) => Promise<PressAnswer>): void {
    this.pressHandler = handler;
  }

  /**
   * No buttons by default — `Gateway.settleButtons`. Declared here so an adapter that has them says `override`; `false`
   * reads the same to the engine either way: the message stands as it was.
   */
  async settleButtons(_chatId: string, _messageId: string, _text: string): Promise<boolean> {
    return false;
  }

  // ── For subclasses ────────────────────────────────────────────────────────

  /**
   * What to do about a press, from whoever listens — nothing beyond acknowledging it when nobody does, or when the answer
   * could not be had. Never throws: the adapter acknowledges the press whatever comes back, or the platform shows it
   * pending (Telegram's spinner) or failed (Discord, after three seconds).
   */
  protected async answerPress(press: ButtonPress): Promise<PressAnswer> {
    if (!this.pressHandler) return {};
    try {
      return await this.pressHandler(press);
    } catch (err) {
      this.log.error("press handler threw", { error: String(err) });
      return { notice: "That did not go through. Answer with the command in the message instead." };
    }
  }

  protected emitMessage(env: MessageEnvelope): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(env);
      } catch (err) {
        this.log.error("message handler threw", { error: String(err) });
      }
    }
  }

  /**
   * Call when the platform library reports a dropped connection.
   *
   * `settleMs` is for a failure that cannot be retried quickly however healthy the network is.
   * Telegram is the case: it holds a `getUpdates` session open server-side for up to ~30 seconds after
   * the client goes away, so a reconnect inside that window is answered with a 409 no matter how clean
   * the local teardown was. The generic backoff starts at one second, which is guaranteed to land
   * inside it — so the first few attempts were doomed by arithmetic rather than by anything wrong.
   *
   * A floor rather than a fixed delay: whichever of the two is longer wins, so a long backoff late in
   * the budget is not shortened by it.
   */
  protected handleDisconnect(reason?: string, settleMs?: number): void {
    if (this.stopping || this._status === "reconnecting") return;
    if (settleMs !== undefined) this.settleMs = Math.max(this.settleMs, settleMs);
    this.setStatus("reconnecting", reason);
    this.scheduleReconnect();
  }

  /** Call when the platform reports credentials are no longer usable (WhatsApp QR). */
  protected handleSessionExpired(): void {
    this.setStatus("dead", "session expired");
    this.emitEvent({ type: "session_expired", gatewayId: this.id });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** `disconnect()`, given `TEARDOWN_TIMEOUT_MS`: whether it finished in that time. What it throws, it throws. */
  private async teardown(): Promise<boolean> {
    let waiting: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.disconnect().then(() => true),
        new Promise<false>((resolve) => (waiting = setTimeout(() => resolve(false), this.teardownMs()))),
      ]);
    } finally {
      clearTimeout(waiting);
    }
  }

  private teardownMs(): number {
    return this.resilience.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS;
  }

  private async attemptConnect(): Promise<void> {
    this.setStatus("connecting");

    /**
     * Tear the previous attempt down before starting another. This is the load-bearing line.
     *
     * Without it `connect()` built a *second* live connection beside the one that had just been
     * declared broken, and on Telegram that is fatal in a specific way: long polling allows exactly
     * one `getUpdates` per token, so the new poll terminates the old one, Telegram returns 409 to the
     * old one, its `start()` rejects, that rejection is read as another dropped connection, and the
     * next attempt terminates the poll that just replaced it. One flaky `sendPhoto` produced a
     * ping-pong of exactly one 409 per reconnect until the retry budget ran out and inbound was dead —
     * with a log full of "another bot instance is running" naming an instance that was us.
     *
     * `disconnect()` is idempotent by contract in all three adapters ("must not throw — runs during
     * shutdown"), so this is safe on the first attempt when there is nothing to tear down.
     */
    try {
      // Every adapter forgets its connection before closing it, so one that never finishes closing is not the current
      // one, and the next is built clean beside it.
      if (!(await this.teardown())) this.log.warn("teardown before connect did not finish; connecting anyway", { after_ms: this.teardownMs() });
    } catch (err) {
      // Never fatal: a teardown that fails must not stop the connect it precedes, or one bad close
      // leaves the gateway permanently down for a reason nobody would look for here.
      this.log.warn("teardown before connect failed", { error: String(err) });
    }

    try {
      await this.connect();
      // Deliberately *not* `reconnectAttempts = 0` here. See `CONNECTION_STABLE_AFTER_MS`: a
      // `connect()` that resolves is not yet a connection that works, and crediting it immediately is
      // what turned a repeating failure into an unbounded fast retry loop.
      this.healthFailures = 0;
      clearTimeout(this.stableTimer);
      const stableAfter = this.resilience.connectionStableAfterMs ?? CONNECTION_STABLE_AFTER_MS;
      this.stableTimer = setTimeout(
        contained(this.log, "could not hand back the retry budget", () => {
          if (this._status === "connected" && this.reconnectAttempts > 0) {
            this.log.info("connection held; retry budget reset", {
              after_ms: stableAfter,
              attempts_forgiven: this.reconnectAttempts,
            });
            this.reconnectAttempts = 0;
            // The floor belongs to the failure that asked for it, not to the gateway. A connection that
            // held for a minute has cleared whatever needed settling.
            this.settleMs = 0;
          }
        }),
        stableAfter,
      );
      // Nothing is waiting on this: it hands back a retry budget. Left referenced it keeps a process
      // — or a test that never calls `stop()` — alive for a minute after everything else is done.
      this.stableTimer.unref?.();
      this.authFailures = 0;
      this.setStatus("connected");
      this.startHealthChecks();
      await this.flushBuffer();
    } catch (err) {
      this.authFailures = err instanceof GatewayAuthError ? this.authFailures + 1 : 0;
      if (this.authFailures >= AUTH_FAILURES_TO_DIE) {
        // Refused again: a token that is wrong or revoked answers the same way however often it is asked (G8).
        this.setStatus("dead", `auth_failed: ${String(err)}`);
        this.log.error("gateway dead: the platform refused its credentials", { error: String(err) });
        this.emitEvent({ type: "dead", gatewayId: this.id, attempts: this.reconnectAttempts, reason: "auth_failed", detail: String(err) });
        return;
      }
      this.log.warn("connect failed", {
        attempt: this.reconnectAttempts,
        error: String(err),
      });
      this.setStatus("reconnecting", String(err));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    clearInterval(this.healthTimer);
    // The connection did not hold, so it does not get its retry budget back.
    clearTimeout(this.stableTimer);

    if (this.reconnectAttempts >= this.resilience.maxReconnectAttempts) {
      this.setStatus("dead");
      this.log.error("gateway dead: max reconnect attempts exceeded", {
        attempts: this.reconnectAttempts,
      });
      this.emitEvent({ type: "dead", gatewayId: this.id, attempts: this.reconnectAttempts });
      return;
    }

    const delay = Math.max(backoffDelay(this.reconnectAttempts, this.resilience), this.settleMs);
    this.reconnectAttempts += 1;
    this.log.info("reconnecting", { in_ms: delay, attempt: this.reconnectAttempts });
    // `attemptConnect` catches what a connect does; contained for anything else, since a rejection out of this timer
    // would reach nobody and leave the gateway `connecting` without a word.
    this.reconnectTimer = setTimeout(contained(this.log, "a reconnect attempt threw", () => this.attemptConnect()), delay);
  }

  private startHealthChecks(): void {
    clearInterval(this.healthTimer);
    this.healthTimer = setInterval(
      contained(this.log, "a health check could not run", async () => {
        if (this._status !== "connected") return;
        let alive = false;
        try {
          alive = await this.alive();
        } catch {
          alive = false;
        }
        if (alive) {
          this.healthFailures = 0;
          return;
        }
        this.healthFailures += 1;
        this.log.warn("health check failed", { consecutive: this.healthFailures });
        if (this.healthFailures >= HEALTH_FAILURE_THRESHOLD) {
          this.healthFailures = 0;
          this.handleDisconnect("health check failed");
        }
      }),
      this.resilience.healthCheckIntervalMs,
    );
  }

  private buffer(msg: OutboundMessage): void {
    if (this.outboundBuffer.length >= OUTBOUND_BUFFER_LIMIT) {
      // Dropping the oldest, not the newest: in a chat, a reply that arrives late
      // is worth less than the one that arrives now, and an unbounded buffer would
      // flush an hour of stale replies on reconnect.
      const dropped = this.outboundBuffer.shift();
      this.log.warn("outbound buffer full, dropped oldest", { chat_id: dropped?.chatId });
    }
    this.outboundBuffer.push(msg);
  }

  /**
   * One probe, after a send failed on a connection we still believe in.
   *
   * Alive: the failure was the request's own, so the buffered message goes out now — a buffer that only
   * drains on reconnect would strand it for as long as the connection stays healthy, which is the
   * opposite of what anyone wants.
   *
   * Dead: this is the same conclusion the health timer would have reached, up to thirty seconds sooner.
   */
  private async probeAfterSendFailure(): Promise<void> {
    if (this.stopping || this._status !== "connected") return;

    let alive = false;
    try {
      alive = await this.ping();
    } catch {
      alive = false;
    }

    if (!alive) {
      this.healthFailures = 0;
      this.handleDisconnect("a send failed and the connection did not answer a probe");
      return;
    }

    this.healthFailures = 0;
    await this.flushBuffer();
  }

  /**
   * Whether a message can go out now, for what `connected` does not say. True for most platforms; WhatsApp's bridge is
   * reachable — `connected` — before its number is linked, and while it is not, nothing can be sent.
   */
  protected deliverable(): boolean {
    return true;
  }

  /** What the buffer holds, sent — when connected, a probe says the connection is fine, or the adapter says it can send again. */
  protected async flushBuffer(): Promise<void> {
    if (this.outboundBuffer.length === 0) return;
    /**
     * Not while the platform cannot take a message: the buffer waits, and the adapter flushes it when it can. Live, a
     * WhatsApp number dropped off with the internet and the bridge stayed reachable, so every probe said "fine", every
     * flush spent twenty seconds per message waiting for a link and then dropped it — the replies people were owed,
     * thrown away for a fault that was not theirs (2026-10-21).
     */
    if (!this.deliverable()) return;
    const pending = this.outboundBuffer;
    this.outboundBuffer = [];
    this.log.info("flushing buffered outbound", { count: pending.length });

    for (const [index, msg] of pending.entries()) {
      try {
        await this.deliver(msg);
        msg.onDelivered?.();
      } catch (err) {
        const refused = this.refusalOf(err);
        // The platform went away mid-flush: this and the rest wait for it, in their order, ahead of anything newer.
        if (refused === null && !this.deliverable()) {
          const rest = [err instanceof PartialDeliveryError ? err.remaining : msg, ...pending.slice(index + 1)];
          this.log.warn("buffered send failed: the platform cannot take messages now, so they are kept", { count: rest.length, error: String(err) });
          const newer = this.outboundBuffer;
          this.outboundBuffer = [];
          for (const kept of [...rest, ...newer]) this.buffer(kept);
          return;
        }
        // Refused, or failing on a platform that takes others: dropped, so one bad message cannot hold the rest forever.
        this.log.error("buffered send failed, dropping", { chat_id: msg.chatId, error: refused ?? String(err) });
      }
    }
  }

  private setStatus(status: GatewayStatus, error?: string): void {
    if (this._status === status) return;
    this._status = status;
    this.log.info("status", { status, ...(error ? { error } : {}) });
    this.emitEvent({ type: "status", gatewayId: this.id, status, error });
  }

  protected emitEvent(event: GatewayEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.log.error("event handler threw", { error: String(err) });
      }
    }
  }
}
