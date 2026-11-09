import { describe, expect, test } from "bun:test";
import { KeyedQueue, type DropReason } from "../src/index.ts";
import { sleep } from "./wait.ts";

interface Job {
  chat: string;
  n: number;
  text?: string;
}

const tick = () => sleep(5);

describe("KeyedQueue ordering", () => {
  test("processes items with the same key strictly in order", async () => {
    const seen: number[] = [];
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      handler: async (j) => {
        // Descending delays: with any concurrency, item 1 would finish last and the
        // recorded order would not match the arrival order.
        await sleep(15 - j.n * 4);
        seen.push(j.n);
      },
    });

    for (let n = 1; n <= 3; n++) queue.push({ chat: "a", n });
    await queue.idle();

    expect(seen).toEqual([1, 2, 3]);
  });

  test("runs different keys in parallel", async () => {
    let concurrent = 0;
    let peak = 0;
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      handler: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(10);
        concurrent -= 1;
      },
    });

    queue.push({ chat: "a", n: 1 });
    queue.push({ chat: "b", n: 1 });
    queue.push({ chat: "c", n: 1 });
    await queue.idle();

    expect(peak).toBe(3);
  });

  test("honours maxConcurrentPerKey above 1", async () => {
    let concurrent = 0;
    let peak = 0;
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      maxConcurrentPerKey: 2,
      handler: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(10);
        concurrent -= 1;
      },
    });

    for (let n = 1; n <= 4; n++) queue.push({ chat: "a", n });
    await queue.idle();

    expect(peak).toBe(2);
  });

  test("the limit can depend on the item", async () => {
    /**
     * Two kinds of conversation share one key shape, and they want opposite answers.
     *
     * A one-to-one chat has to stay serial: two turns at once is one agent answering two things
     * simultaneously, interleaving writes to one session. A room's conversations are per *agent*, so
     * serialising the chat makes every member wait for whichever one was asked first — which on a
     * live box meant a question for one agent sat behind another agent reading a web page, in a room
     * whose whole point is that the others are free.
     */
    const peak = new Map<string, number>();
    const live = new Map<string, number>();
    const queue = new KeyedQueue<Job & { kind: "dm" | "room" }>({
      key: (j) => j.chat,
      maxConcurrentPerKey: (job) => (job.kind === "dm" ? 1 : 4),
      handler: async (job) => {
        const now = (live.get(job.chat) ?? 0) + 1;
        live.set(job.chat, now);
        peak.set(job.chat, Math.max(peak.get(job.chat) ?? 0, now));
        await sleep(10);
        live.set(job.chat, (live.get(job.chat) ?? 1) - 1);
      },
    });

    for (let n = 1; n <= 3; n++) queue.push({ chat: "dm", n, kind: "dm" });
    for (let n = 1; n <= 3; n++) queue.push({ chat: "room", n, kind: "room" });
    await queue.idle();

    expect(peak.get("dm")).toBe(1);
    expect(peak.get("room")).toBeGreaterThan(1);
  });
});

describe("KeyedQueue backpressure", () => {
  test("drops the oldest waiting item when depth is exceeded", async () => {
    const dropped: { job: Job; reason: DropReason }[] = [];
    const handled: number[] = [];
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      maxQueueDepth: 2,
      handler: async (j) => {
        if (j.n === 1) await gate;
        handled.push(j.n);
      },
      onDropped: (job, reason) => dropped.push({ job, reason }),
    });

    queue.push({ chat: "a", n: 1 }); // starts, blocks on the gate
    await tick();
    queue.push({ chat: "a", n: 2 });
    queue.push({ chat: "a", n: 3 });
    queue.push({ chat: "a", n: 4 }); // depth is now 3 → oldest waiting (2) drops

    release();
    await queue.idle();

    expect(dropped.map((d) => d.job.n)).toEqual([2]);
    expect(dropped[0]?.reason).toBe("queue_full");
    expect(handled).toEqual([1, 3, 4]);
  });

  test("drops an item that waited past the timeout instead of running it", async () => {
    const dropped: DropReason[] = [];
    let now = 1000;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      queueTimeoutMs: 500,
      now: () => now,
      handler: async (j) => {
        if (j.n === 1) await gate;
      },
      onDropped: (_job, reason) => dropped.push(reason),
    });

    queue.push({ chat: "a", n: 1 });
    await tick();
    queue.push({ chat: "a", n: 2 });

    // Two minutes pass while the first item is still in flight — answering the queued
    // message now would be answering a conversation that has moved on.
    now += 600;
    release();
    await queue.idle();

    expect(dropped).toEqual(["timeout"]);
  });
});

describe("KeyedQueue dedup", () => {
  test("ignores a repeat inside the window", async () => {
    const handled: string[] = [];
    let now = 0;
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      dedupId: (j) => `${j.chat}:${j.text}`,
      dedupWindowMs: 1000,
      now: () => now,
      handler: async (j) => {
        handled.push(j.text ?? "");
      },
    });

    expect(queue.push({ chat: "a", n: 1, text: "hello" })).toBe(true);
    expect(queue.push({ chat: "a", n: 2, text: "hello" })).toBe(false);
    await queue.idle();

    expect(handled).toEqual(["hello"]);
  });

  test("accepts the same text again after the window passes", async () => {
    const handled: string[] = [];
    let now = 0;
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      dedupId: (j) => `${j.chat}:${j.text}`,
      dedupWindowMs: 1000,
      now: () => now,
      handler: async (j) => {
        handled.push(j.text ?? "");
      },
    });

    queue.push({ chat: "a", n: 1, text: "ping" });
    now = 2000;
    // A user genuinely repeating themselves later is not a duplicate delivery.
    queue.push({ chat: "a", n: 2, text: "ping" });
    await queue.idle();

    expect(handled).toEqual(["ping", "ping"]);
  });

  test("does not dedup items that opt out", async () => {
    const handled: number[] = [];
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      dedupId: () => null,
      handler: async (j) => {
        handled.push(j.n);
      },
    });

    queue.push({ chat: "a", n: 1 });
    queue.push({ chat: "a", n: 1 });
    await queue.idle();

    expect(handled).toHaveLength(2);
  });
});

describe("KeyedQueue resilience", () => {
  test("keeps processing after a handler throws", async () => {
    const handled: number[] = [];
    const errors: unknown[] = [];
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      handler: async (j) => {
        if (j.n === 1) throw new Error("boom");
        handled.push(j.n);
      },
      onError: (_job, err) => errors.push(err),
    });

    queue.push({ chat: "a", n: 1 });
    queue.push({ chat: "a", n: 2 });
    await queue.idle();

    expect(errors).toHaveLength(1);
    // The message after a failure is often the user asking what went wrong.
    expect(handled).toEqual([2]);
  });

  test("releases key state once idle so the map does not grow unbounded", async () => {
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      handler: async () => {},
    });

    for (let i = 0; i < 50; i++) queue.push({ chat: `chat-${i}`, n: 1 });
    await queue.idle();

    // Every one of the fifty is counted as done: a new version's proof it has handled something.
    expect(queue.stats()).toEqual({ keys: 0, waiting: 0, running: 0, completed: 50 });
  });

  test("drain refuses new work and waits for in-flight items", async () => {
    const handled: number[] = [];
    const dropped: DropReason[] = [];
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      handler: async (j) => {
        await sleep(10);
        handled.push(j.n);
      },
      onDropped: (_job, reason) => dropped.push(reason),
    });

    queue.push({ chat: "a", n: 1 });
    const draining = queue.drain();
    expect(queue.push({ chat: "a", n: 2 })).toBe(false);
    await draining;

    expect(handled).toEqual([1]);
    expect(dropped).toEqual(["shutdown"]);
  });

  test("idle resolves immediately when nothing is queued", async () => {
    const queue = new KeyedQueue<Job>({ key: (j) => j.chat, handler: async () => {} });
    await expect(queue.idle()).resolves.toBeUndefined();
  });
});

/**
 * Parallelism between keys is the point of this queue; *unbounded* parallelism is a different thing.
 * Fifty active chats meant fifty handlers at once, and where a handler is a provider call that is fifty
 * times the spend per second and a rate limit hit immediately. The per-key cap looks like it covers
 * this and does not.
 */
describe("the global ceiling", () => {
  /**
   * Handlers that block until the gate opens.
   *
   * `open()` stays open — a handler that starts *after* it must not block, or freeing the first slots
   * would simply move the deadlock to the next batch. That mistake made this test hang rather than
   * fail, which is a worse way to be wrong.
   */
  function blocking() {
    const pending: (() => void)[] = [];
    let opened = false;
    let started = 0;
    let peak = 0;
    let live = 0;
    return {
      get started() {
        return started;
      },
      get peak() {
        return peak;
      },
      releaseAll() {
        opened = true;
        for (const release of pending.splice(0)) release();
      },
      handler: async () => {
        started += 1;
        live += 1;
        peak = Math.max(peak, live);
        if (!opened) await new Promise<void>((resolve) => pending.push(resolve));
        live -= 1;
      },
    };
  }

  test("never runs more than the ceiling, however many keys are ready", async () => {
    const work = blocking();
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      maxConcurrentTotal: 2,
      handler: work.handler,
    });

    for (let n = 1; n <= 6; n++) queue.push({ chat: `chat-${n}`, n });
    await tick();

    expect(work.started).toBe(2);
    expect(queue.stats().running).toBe(2);
    expect(queue.stats().waiting).toBe(4);

    work.releaseAll();
    await queue.idle();
    expect(work.peak).toBe(2);
    expect(work.started).toBe(6);
  });

  test("a freed slot goes to a different key, not only the one that finished", async () => {
    // The stall this pins: the `finally` used to re-pump its own key only. Under a ceiling the blocked
    // key is usually a different one, so it would sit parked until unrelated traffic happened to
    // arrive — indistinguishable from the daemon ignoring that chat.
    const order: string[] = [];
    let release: (() => void) | undefined;
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      maxConcurrentTotal: 1,
      handler: async (j) => {
        order.push(j.chat);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });

    queue.push({ chat: "a", n: 1 });
    await tick();
    queue.push({ chat: "b", n: 2 });
    await tick();
    expect(order).toEqual(["a"]);

    // Let `a` finish. `b` has to be picked up by the freed slot.
    release?.();
    await tick();
    expect(order).toEqual(["a", "b"]);
    release?.();
    await queue.idle();
  });

  test("waiting keys are served oldest-first, not in the order they were created", async () => {
    // Map order is roughly when a key was first seen, which says nothing about who has waited. Under a
    // ceiling that difference is one busy chat starving every other.
    const order: string[] = [];
    const pending: (() => void)[] = [];
    let opened = false;
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      maxConcurrentTotal: 1,
      handler: async (j) => {
        order.push(j.chat);
        if (!opened) await new Promise<void>((resolve) => pending.push(resolve));
      },
    });

    queue.push({ chat: "first", n: 1 });
    await tick();
    // `old` is enqueued before `new`, so it goes first when the slot frees — even though `first`
    // created its key earliest.
    queue.push({ chat: "old", n: 2 });
    queue.push({ chat: "new", n: 3 });
    await tick();

    pending.shift()?.();
    await tick();
    expect(order).toEqual(["first", "old"]);

    opened = true;
    for (const release of pending.splice(0)) release();
    await queue.idle();
    expect(order).toEqual(["first", "old", "new"]);
  });

  test("no ceiling by default, and 0 lifts it", async () => {
    // The ceiling is opt-in at the queue level; the daemon supplies one from config.
    for (const maxConcurrentTotal of [undefined, 0]) {
      const work = blocking();
      const queue = new KeyedQueue<Job>({
        key: (j) => j.chat,
        ...(maxConcurrentTotal === undefined ? {} : { maxConcurrentTotal }),
        handler: work.handler,
      });

      for (let n = 1; n <= 5; n++) queue.push({ chat: `chat-${n}`, n });
      await tick();

      expect(work.started).toBe(5);
      work.releaseAll();
      await queue.idle();
    }
  });

  test("the ceiling does not break per-key ordering", async () => {
    // Two guarantees at once: at most N at a time, and still strictly in order within a chat.
    const seen: number[] = [];
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      maxConcurrentTotal: 2,
      handler: async (j) => {
        await sleep(15 - j.n * 4);
        seen.push(j.n);
      },
    });

    for (let n = 1; n <= 3; n++) queue.push({ chat: "a", n });
    await queue.idle();

    expect(seen).toEqual([1, 2, 3]);
  });
});

/**
 * A scheduled turn ran outside the queue and outside its ceiling: eight due jobs were eight more provider turns
 * beside the eight chat turns `max_concurrent_turns` allowed. `runOutside` puts it under the same ceiling.
 */
describe("work outside the queue", () => {
  type Item = { key: string; id: string };
  const gate = () => {
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  };

  test("waits for a slot at the ceiling, and is handed the next one before a queued item", async () => {
    const order: string[] = [];
    const first = gate();
    const queue = new KeyedQueue<Item>({
      key: (item) => item.key,
      maxConcurrentTotal: 1,
      handler: async (item) => {
        order.push(`start ${item.id}`);
        if (item.id === "a") await first.opened;
        order.push(`end ${item.id}`);
      },
    });

    queue.push({ key: "chat-1", id: "a" });
    const job = queue.runOutside(async () => void order.push("job"));
    queue.push({ key: "chat-2", id: "b" });
    await Promise.resolve();
    expect(order).toEqual(["start a"]);

    first.open();
    await job;
    await queue.idle();

    // The job waited for "a", and went before "b", which had been queued behind the ceiling all along.
    expect(order).toEqual(["start a", "end a", "job", "start b", "end b"]);
  });

  test("counts against the ceiling while it runs: a queued item waits for it", async () => {
    const order: string[] = [];
    const job = gate();
    const queue = new KeyedQueue<Item>({ key: (item) => item.key, maxConcurrentTotal: 1, handler: async (item) => void order.push(item.id) });

    const running = queue.runOutside(() => job.opened);
    queue.push({ key: "chat-1", id: "a" });
    await Promise.resolve();
    expect(order).toEqual([]);

    job.open();
    await running;
    await queue.idle();
    expect(order).toEqual(["a"]);
  });

  test("is not what idle() waits for — the CLI waits on it for its own reply, not a job's", async () => {
    const job = gate();
    const queue = new KeyedQueue<Item>({ key: (item) => item.key, maxConcurrentTotal: 4, handler: async () => {} });

    const running = queue.runOutside(() => job.opened);
    queue.push({ key: "chat-1", id: "a" });

    await queue.idle();
    job.open();
    await running;
  });

  test("with no ceiling, runs at once", async () => {
    const queue = new KeyedQueue<Item>({ key: (item) => item.key, handler: async () => {} });
    expect(await queue.runOutside(async () => 42)).toBe(42);
  });
});

/**
 * A turn's helpers and peers, counted without waiting: the slot a helper would wait for may be held by the
 * very turn waiting on it.
 */
describe("borrowing a slot", () => {
  type Item = { key: string; id: string };

  test("takes a free slot now, and none at the ceiling — it never waits", () => {
    const queue = new KeyedQueue<Item>({ key: (item) => item.key, maxConcurrentTotal: 2, handler: async () => {} });
    const first = queue.borrow();
    const second = queue.borrow();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(queue.stats().running).toBe(2);
    expect(queue.borrow()).toBeNull();

    // Given back once, however often it is called.
    first!();
    first!();
    expect(queue.stats().running).toBe(1);
    second!();
    expect(queue.stats().running).toBe(0);
  });

  test("a slot given back goes to what waits outside for one, as any slot does", async () => {
    const queue = new KeyedQueue<Item>({ key: (item) => item.key, maxConcurrentTotal: 1, handler: async () => {} });
    const lent = queue.borrow();
    let ran = false;
    const job = queue.runOutside(async () => void (ran = true));
    await Promise.resolve();
    expect(ran).toBe(false);
    lent!();
    await job;
    expect(ran).toBe(true);
    expect(queue.stats().running).toBe(0);
  });

  test("with no ceiling, always", () => {
    const queue = new KeyedQueue<Item>({ key: (item) => item.key, handler: async () => {} });
    for (let i = 0; i < 20; i++) expect(queue.borrow()).not.toBeNull();
  });
});

/**
 * What still waits, found and changed before it runs — a message its sender edited before it was answered. The
 * item itself comes back, so the change is what the handler is given; one already running is not waiting.
 */
describe("find", () => {
  test("an item still waiting is found, and what it is changed to is what runs", async () => {
    let release: () => void = () => {};
    const ran: string[] = [];
    const queue = new KeyedQueue<Job>({
      key: (j) => j.chat,
      handler: async (j) => {
        if (j.n === 1) await new Promise<void>((resolve) => (release = resolve));
        ran.push(`${j.n}:${j.text}`);
      },
    });
    queue.push({ chat: "a", n: 1, text: "first" });
    queue.push({ chat: "a", n: 2, text: "teh second" });
    queue.push({ chat: "b", n: 3, text: "elsewhere" });
    await tick();

    // The first holds its key, so it is running, not waiting; the second waits behind it.
    expect(queue.find((j) => j.n === 1)).toBeUndefined();
    const waiting = queue.find((j) => j.chat === "a" && j.n === 2);
    expect(waiting?.text).toBe("teh second");
    waiting!.text = "the second";
    release();
    await queue.idle();

    expect(ran).toContain("2:the second");
    expect(ran).not.toContain("2:teh second");
    // Gone once it ran.
    expect(queue.find((j) => j.n === 2)).toBeUndefined();
  });
});
