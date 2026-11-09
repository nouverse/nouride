/**
 * Outbound pacing, per chat and per bot.
 *
 * No adapter limited what it sent. A twelve-part answer went to Telegram as fast as the API would take it, past its
 * one-message-a-second limit for a chat, and the 429 that came back was retried at once — into the same limit — or,
 * failing that, buffered and flushed by the probe straight back into it. A token bucket per chat, and one for the
 * whole bot where the platform has a limit of its own, makes each send wait for its turn instead.
 *
 * A turn is reserved rather than queued for: two sends at once each take a slot, the second one later, so nothing
 * needs a lock and no send waits behind another chat's. Edits are not paced — the progress line is edited in place,
 * and a bucket shared with the answer it is the progress of would starve it.
 */

export interface Rate {
  count: number;
  perMs: number;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

interface Bucket {
  tokens: number;
  at: number;
}

/** Chats remembered before the ones whose bucket is full again — the same as never having sent there — are dropped. */
const REMEMBERED = 1_000;

export class Pacer {
  private readonly chats = new Map<string, Bucket>();
  private readonly bot: Bucket | null;

  constructor(
    private readonly limits: { perChat: (chat: string) => Rate; perBot?: Rate },
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {
    this.bot = limits.perBot ? { tokens: limits.perBot.count, at: clock.now() } : null;
  }

  /** Waits until one more message may go to `chat`, and counts it. */
  async take(chat: string): Promise<void> {
    const now = this.clock.now();
    const rate = this.limits.perChat(chat);
    let bucket = this.chats.get(chat);
    if (!bucket) {
      if (this.chats.size >= REMEMBERED) this.forgetIdle(now);
      bucket = { tokens: rate.count, at: now };
      this.chats.set(chat, bucket);
    }
    const wait = Math.max(reserve(bucket, rate, now), this.bot && this.limits.perBot ? reserve(this.bot, this.limits.perBot, now) : 0);
    if (wait > 0) await this.clock.sleep(wait);
  }

  /** A platform's own "retry after", waited out on this pacer's clock. */
  sleep(ms: number): Promise<void> {
    return this.clock.sleep(ms);
  }

  private forgetIdle(now: number): void {
    for (const [chat, bucket] of this.chats) {
      const rate = this.limits.perChat(chat);
      if (refilled(bucket, rate, now) >= rate.count) this.chats.delete(chat);
    }
  }
}

function refilled(bucket: Bucket, rate: Rate, now: number): number {
  return Math.min(rate.count, bucket.tokens + ((now - bucket.at) * rate.count) / rate.perMs);
}

/** Takes a token, going below zero when there is none — how far below is how long this send waits for its turn. */
function reserve(bucket: Bucket, rate: Rate, now: number): number {
  bucket.tokens = refilled(bucket, rate, now) - 1;
  bucket.at = now;
  return bucket.tokens >= 0 ? 0 : Math.ceil((-bucket.tokens * rate.perMs) / rate.count);
}
