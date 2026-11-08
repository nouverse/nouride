/**
 * `@nouride/queue` — a keyed work queue: sequential within a key, parallel across
 * keys, with deduplication and a depth cap.
 *
 * The shape comes from §10.1 SPEC: messages in one chat must be handled in order
 * (turn N's reply is context for turn N+1), while different chats have no reason to
 * wait on each other. Generic over the item type because nothing about that rule is
 * specific to chat messages — the cron scheduler wants the same guarantee.
 */

import { createLogger, type Logger } from "@nouride/shared";

export interface QueueOptions<T> {
  /** Items sharing a key are processed one at a time, in arrival order. */
  key: (item: T) => string;
  /** Runs one item. Rejections are reported to `onError` and never crash the queue. */
  handler: (item: T) => Promise<void>;

  /**
   * Concurrent handlers per key. Default 1 — the ordering guarantee.
   *
   * A function when the answer depends on the item. The caller that needed this has two kinds of
   * conversation sharing one key shape: a one-to-one chat, where two turns at once means an agent
   * answering two things simultaneously and interleaving its own session writes, and a room, where
   * the conversations are per *agent* and serialising the chat makes every member wait for whichever
   * one was asked first.
   */
  maxConcurrentPerKey?: number | ((item: T) => number);
  /**
   * Concurrent handlers across **all** keys. 0 or absent means no ceiling.
   *
   * Parallelism between keys is the point of this queue, but unbounded parallelism is a different
   * thing: fifty active keys meant fifty handlers at once, and where a handler is a provider call
   * that is fifty times the spend per second and a rate limit hit immediately. Nothing capped the
   * total, because the per-key cap looks like it is doing that job and is not.
   */
  maxConcurrentTotal?: number;
  /**
   * Items that must never wait behind anything.
   *
   * They run the moment they arrive, outside both limits and outside their key's ordering. That is a
   * strong exemption, and it exists for one shape of work: the answer to a question the running item
   * is blocked on. A queue that makes the answer wait for the questioner is deadlocked by
   * construction, and no timeout tuning fixes it — the caller has to be able to say "this one is not
   * part of the ordering".
   *
   * Keep the predicate narrow. Anything it lets through runs concurrently with whatever holds the
   * key, so it must be work that cannot conflict with a turn.
   */
  urgent?: (item: T) => boolean;
  /** Waiting items per key before the oldest is dropped. Default 20. */
  maxQueueDepth?: number;
  /** Drop an item that has waited longer than this. Default 120_000. */
  queueTimeoutMs?: number;
  /** Ignore a repeat of the same dedup id inside this window. Default 1000. */
  dedupWindowMs?: number;
  /** Identity for deduplication. Return null to opt an item out. */
  dedupId?: (item: T) => string | null;

  onDropped?: (item: T, reason: DropReason) => void;
  onError?: (item: T, error: unknown) => void;
  logger?: Logger;
  now?: () => number;
}

export type DropReason = "queue_full" | "timeout" | "duplicate" | "shutdown";

interface Entry<T> {
  item: T;
  enqueuedAt: number;
}

interface KeyState<T> {
  waiting: Entry<T>[];
  running: number;
}

export interface QueueStats {
  keys: number;
  waiting: number;
  running: number;
  /** Work finished since the queue was made — scheduled work included. A new version's proof it has done any. */
  completed: number;
}

export class KeyedQueue<T> {
  private readonly states = new Map<string, KeyState<T>>();
  private readonly recentDedup = new Map<string, number>();
  private readonly log: Logger;
  private readonly now: () => number;
  private draining = false;
  private idleWaiters: (() => void)[] = [];
  /** Handlers running across every key. One counter, so the ceiling and `stats()` cannot disagree. */
  private runningTotal = 0;
  /** Of `runningTotal`, the work that is not an item — `runOutside` — and what waits outside for a slot, oldest first. */
  private outside = 0;
  private readonly slotWaiters: (() => void)[] = [];
  private completed = 0;

  constructor(private readonly options: QueueOptions<T>) {
    this.log = options.logger ?? createLogger("queue");
    this.now = options.now ?? Date.now;
  }

  /** Returns false when the item was dropped rather than accepted. */
  push(item: T): boolean {
    if (this.draining) {
      this.drop(item, "shutdown");
      return false;
    }

    if (this.isDuplicate(item)) {
      this.drop(item, "duplicate");
      return false;
    }

    // Before a key is even chosen: an urgent item has no place in any key's ordering.
    if (this.options.urgent?.(item)) {
      void this.runUrgent(item);
      return true;
    }

    const key = this.options.key(item);
    const state = this.states.get(key) ?? { waiting: [], running: 0 };
    this.states.set(key, state);

    state.waiting.push({ item, enqueuedAt: this.now() });

    const maxDepth = this.options.maxQueueDepth ?? 20;
    while (state.waiting.length > maxDepth) {
      // Oldest first: in a conversation the stale message is the one least worth
      // answering, and dropping the newest would answer questions in the wrong order.
      const dropped = state.waiting.shift();
      if (dropped) this.drop(dropped.item, "queue_full");
    }

    void this.pump(key);
    return true;
  }

  /**
   * An item still waiting that `match` picks, or undefined — for a caller that must change what one says before it runs:
   * a message its sender edited before it was answered. The item itself, so a change to it is the item that runs.
   */
  find(match: (item: T) => boolean): T | undefined {
    for (const state of this.states.values()) {
      const found = state.waiting.find((entry) => match(entry.item));
      if (found) return found.item;
    }
    return undefined;
  }

  stats(): QueueStats {
    let waiting = 0;
    for (const state of this.states.values()) waiting += state.waiting.length;
    return { keys: this.states.size, waiting, running: this.runningTotal, completed: this.completed };
  }

  /** Resolves when nothing is running or waiting. Used by tests and shutdown. */
  async idle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop accepting new items, then wait for in-flight work (§14.1 SPEC). */
  async drain(): Promise<void> {
    this.draining = true;
    await this.idle();
  }

  /**
   * Stop starting what is waiting, and hand it back — a shutdown that keeps messages for the next boot
   * rather than start work it could not finish. From here on a push is dropped as `shutdown`, as after
   * `drain()`; what is already running keeps running, and `idle()` waits for it alone.
   */
  hold(): T[] {
    this.draining = true;
    const held: T[] = [];
    for (const [key, state] of [...this.states]) {
      held.push(...state.waiting.map((entry) => entry.item));
      state.waiting = [];
      this.cleanup(key, state);
    }
    return held;
  }

  /**
   * Run work that is not an item — a scheduled turn — under the same ceiling as the chat turns.
   *
   * Counted in `runningTotal`, so the queue's items wait for it as they wait for each other, and it waits for a slot
   * when the ceiling is reached. A slot freed while it waits is handed straight to it rather than to the next item:
   * otherwise a busy room refills every slot first and the job waits for ever. Not counted by `idle()`, which is a
   * question about the queue's items — the CLI waits on it for its own reply, not for a job's.
   */
  async runOutside<R>(work: () => Promise<R>): Promise<R> {
    if (this.atCeiling()) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    } else {
      this.runningTotal += 1;
      this.outside += 1;
    }
    try {
      return await work();
    } finally {
      this.free(true);
    }
  }

  /**
   * One free slot, now or not at all — for work started by work that holds one, a turn's helpers and peers.
   *
   * Never waits, which is the difference from `runOutside`: the slot it would wait for may be held by the turn
   * waiting on it, and eight turns each waiting on a helper that waits on a slot is a daemon that has stopped. Null
   * at the ceiling; the caller runs that work on what it already holds. The function given back returns the slot,
   * once, to whatever waits for one first.
   */
  borrow(): (() => void) | null {
    if (this.atCeiling()) return null;
    this.runningTotal += 1;
    this.outside += 1;
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      this.free(true);
    };
  }

  /** A slot is done: to work waiting outside first — counted before anything can take it — else to the queue. */
  private free(wasOutside: boolean): void {
    this.runningTotal -= 1;
    this.completed += 1;
    if (wasOutside) this.outside -= 1;
    const next = this.atCeiling() ? undefined : this.slotWaiters.shift();
    if (next) {
      this.runningTotal += 1;
      this.outside += 1;
      next();
    }
    if (this.isIdle()) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
    // Every waiting key, not only one. Under a global ceiling the key that was blocked is usually a *different* one,
    // and re-pumping only ourselves would leave it parked until something else happened to arrive.
    this.pumpWaiting();
  }

  private isIdle(): boolean {
    return this.stats().waiting === 0 && this.runningTotal - this.outside === 0;
  }

  private isDuplicate(item: T): boolean {
    const id = this.options.dedupId?.(item);
    if (!id) return false;

    const window = this.options.dedupWindowMs ?? 1000;
    const now = this.now();
    const seenAt = this.recentDedup.get(id);

    // Sweep on write rather than on a timer: the map only grows while messages are
    // arriving, so the work is already proportional to the traffic.
    for (const [key, ts] of this.recentDedup) {
      if (now - ts > window) this.recentDedup.delete(key);
    }

    if (seenAt !== undefined && now - seenAt <= window) return true;
    this.recentDedup.set(id, now);
    return false;
  }

  private async pump(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;

    /**
     * Read from the item at the head of the queue, not from the key.
     *
     * The limit can depend on what is waiting — a room allows several turns at once because its
     * conversations are per agent, and a one-to-one chat allows one. Asked of the next item rather
     * than remembered per key, so a key that carries both kinds cannot end up governed by whichever
     * arrived first.
     */
    const head = state.waiting[0]?.item;
    const limit = this.options.maxConcurrentPerKey ?? 1;
    const maxConcurrent = typeof limit === "function" ? (head ? limit(head) : 1) : limit;
    if (state.running >= maxConcurrent) return;
    // Checked before anything is dequeued: an item held back by the ceiling stays queued in its own
    // order, rather than being taken out and put somewhere that would lose its place.
    if (this.atCeiling()) return;

    const timeout = this.options.queueTimeoutMs ?? 120_000;
    let next: Entry<T> | undefined;

    while ((next = state.waiting.shift())) {
      if (this.now() - next.enqueuedAt > timeout) {
        this.drop(next.item, "timeout");
        continue;
      }
      break;
    }

    if (!next) {
      this.cleanup(key, state);
      return;
    }

    state.running += 1;
    this.runningTotal += 1;
    try {
      await this.options.handler(next.item);
    } catch (err) {
      // One failed message must not stop the queue for that chat: the next message may
      // well be the user asking what went wrong.
      this.log.error("handler failed", { key, error: String(err) });
      this.options.onError?.(next.item, err);
    } finally {
      state.running -= 1;
      if (state.waiting.length === 0) this.cleanup(key, state);
      // A stall here looks exactly like the daemon ignoring a chat — see `free`.
      this.free(false);
    }
  }

  /**
   * Run one item now, bypassing the ordering and both limits.
   *
   * Still counted in `runningTotal`, so `stats()` and `idle()` stay honest — it is real work, and a
   * drain that returned while one was in flight would be lying. `pumpWaiting` afterwards because
   * finishing frees a slot for whatever the ceiling is holding back.
   */
  private async runUrgent(item: T): Promise<void> {
    this.runningTotal += 1;
    try {
      await this.options.handler(item);
    } catch (err) {
      this.log.error("urgent handler failed", { error: String(err) });
      this.options.onError?.(item, err);
    } finally {
      this.free(false);
    }
  }

  private atCeiling(): boolean {
    const ceiling = this.options.maxConcurrentTotal ?? 0;
    return ceiling > 0 && this.runningTotal >= ceiling;
  }

  /**
   * Start whoever has waited longest, until the ceiling is reached.
   *
   * Oldest-first across keys rather than in map order: map order is roughly when each key was first
   * seen, which has nothing to do with who has been waiting. Under a ceiling that difference is the
   * difference between fair service and one busy chat starving every other.
   */
  private pumpWaiting(): void {
    if (this.atCeiling()) return;

    const ready = [...this.states.entries()]
      .filter(([, state]) => state.waiting.length > 0)
      .sort((a, b) => (a[1].waiting[0]?.enqueuedAt ?? 0) - (b[1].waiting[0]?.enqueuedAt ?? 0));

    for (const [key] of ready) {
      if (this.atCeiling()) break;
      // `pump` runs synchronously up to its first await, so `runningTotal` is already updated by the
      // time the next iteration checks the ceiling. Without that, this loop would start every waiting
      // key at once and the ceiling would do nothing.
      void this.pump(key);
    }
  }

  private cleanup(key: string, state: KeyState<T>): void {
    if (state.waiting.length === 0 && state.running === 0) this.states.delete(key);
    if (this.isIdle()) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  private drop(item: T, reason: DropReason): void {
    this.log.debug("item dropped", { reason });
    this.options.onDropped?.(item, reason);
  }
}

export { createKeyedLock, type KeyedLock } from "./lock.ts";
