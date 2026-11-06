/**
 * A brake for a route, in memory, with no dependencies.
 *
 * Written because the webhook endpoint had none. It is the daemon's only unauthenticated route, it
 * can start a model turn, and the only thing standing between a leaked URL and an unbounded bill was
 * `Scheduler.runNow` refusing a *concurrent* start — which serialises a flood without stopping it.
 *
 * ## What `by` is, and why it is not one answer
 *
 * The hard question is what to count against, and it is decided by **what the attacker cannot
 * change**:
 *
 * - **A webhook: the token.** Not the IP. The token *is* the credential, so it is the thing being
 *   abused, and it is the thing a legitimate caller keeps. Counting by IP gets both ends wrong: a CI
 *   runner and a crawler behind the same NAT share a limit they have no relationship to, and an
 *   attacker with the URL rotates addresses for free.
 * - **A login: the address *and* the account, whichever trips first.** Per-IP alone lets somebody
 *   spray one password across every account they can name from one host — each account sees a single
 *   attempt. Per-account alone is worse than useless: anyone can lock a known username out by
 *   failing on purpose, so the limiter becomes the denial of service. Two rules, and the account
 *   rule is deliberately the looser of the two, because a person who has genuinely forgotten their
 *   password must not be locked out by someone else's guessing.
 *
 * So `by` is a label on the rule rather than a strategy this module picks. It names what the caller
 * is passing so the log line and the error say something true, and so a second rule on the same
 * route reads as a different rule rather than a duplicate.
 *
 * ## A token bucket, not a fixed window
 *
 * A fixed window lets twice the limit through across a boundary — 60 at 11:59:59 and 60 at 12:00:00
 * — and it punishes the shape real callers have: a CI system fires five requests when a build ends
 * and nothing for an hour. A bucket that refills continuously allows the burst up to `limit` and
 * then holds the sustained rate at exactly `limit` per window, which is what the number on the
 * config line is supposed to mean.
 *
 * ## It is in memory, and that is a decision
 *
 * One process, one bucket map. A restart forgets every count, which is a real weakness against a
 * patient attacker and the right trade anyway: the alternative is a database write on every request
 * to the one route that exists to absorb floods. Persisting it would make the flood cheaper to
 * amplify, not more expensive.
 *
 * The map is bounded. A limiter keyed by something the caller chooses is itself a way to exhaust
 * memory, so full buckets — which is what an idle key becomes — are swept before a new key can grow
 * the map past `maxKeys`.
 */

/** What a rule counts against. A label, not a strategy — see the header. */
export type RateLimitSubject = "token" | "ip" | "account" | "user" | "session";

export interface RateLimitOptions {
  /** Which brake this is, for logs and for telling two rules on one route apart. */
  name: string;
  /** What the key passed to `check` means. */
  by: RateLimitSubject;
  /** How many are allowed per window, and the depth of the burst. */
  limit: number;
  /** `"30s"`, `"15m"`, `"1h"`, or milliseconds. */
  window: string | number;
  /**
   * Most distinct keys held at once. Beyond it, idle keys are dropped and — if none are idle — the
   * new key is allowed without being tracked, because a limiter that starts refusing everybody once
   * its own map is full has turned into the outage it was preventing.
   */
  maxKeys?: number;
}

export type RateLimitVerdict =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterMs: number; rule: string; by: RateLimitSubject };

const DEFAULT_MAX_KEYS = 10_000;

/** `"15m"` → 900000. A bare number passes through, so a caller with a computed value needs no unit. */
export function parseWindow(window: string | number): number {
  if (typeof window === "number") {
    if (!Number.isFinite(window) || window <= 0) throw new Error(`window must be positive, got ${window}`);
    return window;
  }
  const match = /^(\d+)(ms|s|m|h)$/.exec(window.trim());
  if (!match) throw new Error(`window must look like "500ms", "30s", "15m" or "1h", got "${window}"`);
  const n = Number(match[1]);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  if (n <= 0) throw new Error(`window must be positive, got "${window}"`);
  return n * unit;
}

/** One key's bucket. `tokens` is fractional: refill is continuous, not per-tick. */
interface Bucket {
  tokens: number;
  at: number;
}

export interface RateLimiter {
  /** Spend one against `key`. Nothing is spent when the verdict is a refusal. */
  check(key: string): RateLimitVerdict;
  /**
   * Give one back.
   *
   * For the login shape: a *successful* sign-in should not count against the person who just proved
   * who they are, or a busy admin locks themselves out of their own dashboard. Only failures should
   * accumulate, and the route knows which it was only after the check has already happened.
   */
  refund(key: string): void;
  /** Drop a key entirely — a successful login clearing the account's failures. */
  reset(key: string): void;
  /** How many keys are held. For tests and for a health line. */
  size(): number;
}

export function rateLimit(options: RateLimitOptions): RateLimiter {
  const windowMs = parseWindow(options.window);
  const { name, by, limit } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`${name}: limit must be a positive integer, got ${limit}`);
  }

  const perMs = limit / windowMs;
  const buckets = new Map<string, Bucket>();

  /** Tokens now, capped at the burst depth. Not written back — callers decide what to keep. */
  const filled = (bucket: Bucket, now: number): number =>
    Math.min(limit, bucket.tokens + (now - bucket.at) * perMs);

  /**
   * Make room, by dropping keys that have refilled completely.
   *
   * A full bucket carries no information: the next `check` on that key would produce exactly what a
   * missing key produces. So they are free to forget, and they are the only ones — dropping a
   * partially spent bucket would hand an attacker a way to clear their own count by flooding with
   * fresh keys.
   */
  const sweep = (now: number): void => {
    for (const [key, bucket] of buckets) {
      if (filled(bucket, now) >= limit) buckets.delete(key);
    }
  };

  return {
    check(key) {
      const now = Date.now();
      const existing = buckets.get(key);

      if (!existing) {
        if (buckets.size >= maxKeys) {
          sweep(now);
          // Still full: every key is mid-window, so the map is under real pressure rather than
          // holding stale entries. Allowed and untracked — see `maxKeys`.
          if (buckets.size >= maxKeys) return { ok: true, remaining: limit - 1 };
        }
        buckets.set(key, { tokens: limit - 1, at: now });
        return { ok: true, remaining: limit - 1 };
      }

      const tokens = filled(existing, now);
      if (tokens < 1) {
        // Not written back: a refused request must not push the recovery time further out, or a
        // client that retries in a loop can never get in again.
        existing.at = now;
        existing.tokens = tokens;
        return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / perMs), rule: name, by };
      }

      existing.tokens = tokens - 1;
      existing.at = now;
      return { ok: true, remaining: Math.floor(existing.tokens) };
    },

    refund(key) {
      const bucket = buckets.get(key);
      if (!bucket) return;
      const now = Date.now();
      bucket.tokens = Math.min(limit, filled(bucket, now) + 1);
      bucket.at = now;
    },

    reset(key) {
      buckets.delete(key);
    },

    size() {
      return buckets.size;
    },
  };
}
