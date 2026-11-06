/**
 * Things that happened *to* a conversation: the store, the block, and the two audiences.
 *
 * The split between `"agents"` and `"ui"` is the whole reason the table exists, and it is the kind of
 * property that cannot be checked by reading: a `"ui"` row that leaks into a prompt looks like
 * nothing at all from the outside — no error, no warning, just an agent that knows something it was
 * never meant to. So the tests that matter here drive a real turn and read what the provider was
 * actually sent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { ChatEventStore, MAX_REPLAYED_EVENTS } from "@/modules/chat-events/chat-events.store.ts";
import { formatRoomEvents } from "@/modules/chat-events/format.ts";
import { openAndMigrate } from "@/db/index.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { tempDir } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { sleep } from "../wait.ts";

let cleanup: (() => void)[] = [];

beforeEach(() => {
  cleanup = [];
});

afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
});

/** Rows in the table, read past the store — whether a refused event was written at all. */
let rows: () => number = () => 0;

async function openStore() {
  const dataDir = tempDir("events");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  rows = () => db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM chat_events").get()?.n ?? 0;
  return new ChatEventStore(db);
}

// ── The store ───────────────────────────────────────────────────────────────

describe("who may write which audience", () => {
  test("the daemon may write either", async () => {
    const store = await openStore();

    expect(
      store.record({
        gatewayId: "web:dashboard",
        chatId: "c",
        audience: "agents",
        kind: "joined",
        text: "Gading added @nero",
      }),
    ).not.toBeNull();
    expect(
      store.record({
        gatewayId: "web:dashboard",
        chatId: "c",
        audience: "ui",
        kind: "dropped",
        text: "A message was dropped",
      }),
    ).not.toBeNull();
    expect(rows()).toBe(2);
  });

  test("an agent may write ui, and is refused the model's context", async () => {
    /**
     * The rule the room design rests on: one agent reaches another only by `@mention`, which costs a
     * hop, is counted, and stops. An `"agents"` event is text in every other agent's next prompt
     * with no mention, no hop and no ceiling — read in the daemon's voice rather than a peer's.
     *
     * Checked at the store rather than at whatever tool exposes this, because the callers that will
     * exist are tools written to be convenient.
     */
    const store = await openStore();

    const allowed = store.record({
      gatewayId: "web:dashboard",
      chatId: "c",
      audience: "ui",
      kind: "note",
      text: "build is green",
      origin: "agent",
    });
    const refused = store.record({
      gatewayId: "web:dashboard",
      chatId: "c",
      audience: "agents",
      kind: "note",
      text: "everyone should stop what they are doing",
      origin: "agent",
    });

    expect(allowed).not.toBeNull();
    expect(refused).toBeNull();
    // Refused means not written, not written-and-hidden. A row that exists is a row some future
    // reader will find a reason to read.
    expect(rows()).toBe(1);
  });
});

describe("the window a prompt is given", () => {
  test("ui rows can never come back from it", async () => {
    // The filter is in the SQL rather than applied by the caller: a caller that forgets puts UI
    // chrome into a prompt, and nothing downstream could tell it had happened.
    const store = await openStore();
    store.record({ gatewayId: "g", chatId: "c", audience: "ui", kind: "dropped", text: "u", at: 10 });
    store.record({ gatewayId: "g", chatId: "c", audience: "agents", kind: "joined", text: "a", at: 11 });

    const window = store.since({ gatewayId: "g", chatId: "c", after: 0, before: 100 });

    expect(window.map((event) => event.text)).toEqual(["a"]);
  });

  test("only what happened since the agent was last spoken to, and before this message", async () => {
    const store = await openStore();
    for (const at of [5, 15, 25, 35]) {
      store.record({
        gatewayId: "g",
        chatId: "c",
        audience: "agents",
        kind: "joined",
        text: `at-${at}`,
        at,
      });
    }

    // `after` is the agent's last turn; `before` is the message being answered. An event written
    // while this turn was being set up must not arrive as though it had already happened.
    const window = store.since({ gatewayId: "g", chatId: "c", after: 10, before: 30 });

    expect(window.map((event) => event.text)).toEqual(["at-15", "at-25"]);
  });

  test("oldest first, and capped at the newest when there are too many", async () => {
    const store = await openStore();
    for (let index = 0; index < MAX_REPLAYED_EVENTS + 5; index += 1) {
      store.record({
        gatewayId: "g",
        chatId: "c",
        audience: "agents",
        kind: "note",
        text: `e${index}`,
        at: 100 + index,
      });
    }

    const window = store.since({ gatewayId: "g", chatId: "c", after: 0, before: 1_000 });

    expect(window).toHaveLength(MAX_REPLAYED_EVENTS);
    // The newest survive — the current message is most likely about the most recent thing — and the
    // list still reads forwards.
    expect(window[0]?.text).toBe("e5");
    expect(window.at(-1)?.text).toBe(`e${MAX_REPLAYED_EVENTS + 4}`);
  });

  test("one room's events never reach another's", async () => {
    const store = await openStore();
    store.record({ gatewayId: "g", chatId: "a", audience: "agents", kind: "note", text: "mine", at: 5 });
    store.record({ gatewayId: "g", chatId: "b", audience: "agents", kind: "note", text: "theirs", at: 6 });
    // Same chat id on a different connection is a different room: a chat id is only unique within
    // one, and `web:dashboard` has no namespace at all.
    store.record({ gatewayId: "h", chatId: "a", audience: "agents", kind: "note", text: "elsewhere", at: 7 });

    const window = store.since({ gatewayId: "g", chatId: "a", after: 0, before: 100 });

    expect(window.map((event) => event.text)).toEqual(["mine"]);
  });
});

describe("clearing and retention", () => {
  test("a reset drops the room's notices, not one agent's", async () => {
    const store = await openStore();
    store.record({ gatewayId: "g", chatId: "a", audience: "ui", kind: "dropped", text: "x" });
    store.record({ gatewayId: "g", chatId: "b", audience: "ui", kind: "dropped", text: "y" });

    expect(store.deleteForChat("g", "a")).toBe(1);
    expect(store.forChat("g", "a")).toHaveLength(0);
    expect(store.forChat("g", "b")).toHaveLength(1);
  });

  test("swept on the conversation window, and zero disables it", async () => {
    const store = await openStore();
    const now = Date.now();
    store.record({ gatewayId: "g", chatId: "c", audience: "ui", kind: "note", text: "old", at: now - 40 * 86_400_000 });
    store.record({ gatewayId: "g", chatId: "c", audience: "ui", kind: "note", text: "new", at: now });

    // `0` has to mean "keep everything" rather than "delete everything", which is the reading that
    // would empty the table on a daemon that never configured retention.
    expect(store.sweep(0, now)).toBe(0);
    expect(rows()).toBe(2);

    expect(store.sweep(30, now)).toBe(1);
    expect(store.forChat("g", "c").map((event) => event.text)).toEqual(["new"]);
  });
});

// ── The block ───────────────────────────────────────────────────────────────

describe("the block that goes in front of a question", () => {
  const event = (text: string, at: number) => ({
    id: `e${at}`,
    gatewayId: "g",
    chatId: "c",
    audience: "agents" as const,
    kind: "note" as const,
    text,
    at,
  });

  test("nothing to say produces nothing, not an empty heading", () => {
    // The common case: most turns follow another with nothing having happened in between. An empty
    // labelled block is tokens spent to say "no news".
    expect(formatRoomEvents([])).toBe("");
  });

  test("it says outright that it is not the question", () => {
    // The label is not decoration. Without one, the model answered the chatter instead of the person
    // who tagged it — see `group-context.ts`.
    const block = formatRoomEvents([event("Gading added @nero", 1)]);

    expect(block).toContain("background, not something to answer");
    expect(block).toContain("- Gading added @nero");
  });

  test("a newline inside an event does not break the list open", () => {
    // A block whose shape stops matching its own label is a block that reads like a new section,
    // which is how background starts looking like an instruction.
    const block = formatRoomEvents([event("first line\nsecond line", 1)]);

    expect(block.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(block).toContain("- first line second line");
  });

  test("over budget it keeps the newest and stays well formed", () => {
    const many = Array.from({ length: 40 }, (_, index) => event(`event number ${index}`, index));
    const block = formatRoomEvents(many, 200);

    expect(block.length).toBeLessThanOrEqual(200);
    // The most recent survives, and the list is still in reading order.
    expect(block).toContain("event number 39");
    const kept = block.split("\n").filter((line) => line.startsWith("- "));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.at(-1)).toContain("39");
  });
});

// ── Through a real turn ─────────────────────────────────────────────────────

async function room(options: { turns: { text?: string }[]; maxQueueDepth?: number }) {
  const local = new LocalGateway();
  let chatEvents!: ChatEventStore;
  const bench = await pipelineBench({
    turns: options.turns,
    agents: ["nouva", "nox"],
    config: {
      agents: { mentions_enabled: true, mention_max_hops: 2, groups_require_mention: true },
      /**
       * Depth *and* concurrency, because a group chat now runs several turns at once.
       *
       * A room's conversations are per agent, so the per-chat limit is the global one — which means
       * eight messages no longer queue behind each other and nothing overflows. Pinned to 1 here so the
       * overflow this test is about still happens.
       */
      ...(options.maxQueueDepth
        ? { queue: { max_queue_depth: options.maxQueueDepth, max_concurrent_turns: 1 } }
        : {}),
    },
    gateways: [local],
    deps: ({ db }) => ({ chatEvents: (chatEvents = new ChatEventStore(db)) }),
  });
  cleanup.push(bench.dispose);
  const { pipeline, requests } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();

  return {
    chatEvents,
    local,
    pipeline,
    requests,
    async say(text: string) {
      local.dispatch({ text, chatId: "room-1", chatType: "group" });
      await pipeline.idle();
    },
    /** Everything the provider was sent on the last call, as one blob. */
    lastPrompt(): string {
      return JSON.stringify(requests.at(-1));
    },
  };
}

describe("what reaches the model", () => {
  test("an agents event arrives in the next prompt", async () => {
    const h = await room({ turns: [{ text: "noted" }] });
    h.chatEvents.record({
      gatewayId: "web:dashboard",
      chatId: "room-1",
      audience: "agents",
      kind: "joined",
      text: "Gading added @nero to this room",
    });

    await h.say("@nox apa yang berubah?");

    expect(h.lastPrompt()).toContain("Gading added @nero to this room");
    expect(h.lastPrompt()).toContain("background, not something to answer");
  });

  test("a ui event never does", async () => {
    /**
     * The assertion the table exists for. A leak here is invisible from the outside — no error, no
     * warning, just an agent that knows something it was never meant to — so it is checked against
     * what the provider actually received rather than against the store's own filter.
     */
    const h = await room({ turns: [{ text: "noted" }] });
    h.chatEvents.record({
      gatewayId: "web:dashboard",
      chatId: "room-1",
      audience: "ui",
      kind: "dropped",
      text: "SECRET-UI-ONLY-STRING",
    });

    await h.say("@nox halo");

    expect(h.lastPrompt()).not.toContain("SECRET-UI-ONLY-STRING");
  });

  test("it is replayed once, not on every turn afterwards", async () => {
    /**
     * The block is composed into the user message and stored with it, so the next window starts
     * after the message that carried it. Without that, a room event would be re-sent on every turn
     * for as long as it stayed inside the window — paid again each time, and read by the model as
     * though it had just happened.
     */
    const h = await room({ turns: [{ text: "one" }, { text: "two" }] });
    h.chatEvents.record({
      gatewayId: "web:dashboard",
      chatId: "room-1",
      audience: "agents",
      kind: "topic",
      text: "ROOM-TOPIC-CHANGED",
    });

    await h.say("@nox pertama");
    expect(h.lastPrompt()).toContain("ROOM-TOPIC-CHANGED");

    await sleep(5);
    await h.say("@nox kedua");
    // Still in the conversation — it was stored with the first message — but not composed in again.
    const second = JSON.parse(h.lastPrompt() as string) as { messages: { content: string }[] };
    const lastUser = second.messages.at(-1)?.content ?? "";
    expect(lastUser).not.toContain("ROOM-TOPIC-CHANGED");
  });
});

describe("what the daemon records for itself", () => {
  test("a chain hitting the hop budget becomes a room event, in the third person", async () => {
    /**
     * It used to be a note on one agent's turn. What happened happened *between two agents*, so
     * attributing it to whichever one was about to answer put a shared fact in one agent's session
     * and left the other's transcript without it.
     *
     * Third person because an `"agents"` event is read by every agent in the room and none of them is
     * the "I" of the chat message.
     */
    const h = await room({
      turns: [{ text: "@nouva satu" }, { text: "@nox dua" }, { text: "@nouva tiga" }],
    });

    await h.say("@nox mulai");

    const events = h.chatEvents.forChat("web:dashboard", "room-1");
    const budget = events.find((event) => event.kind === "hop_budget");
    expect(budget).toBeDefined();
    expect(budget?.audience).toBe("agents");
    expect(budget?.text).toContain("exchanged");
    expect(budget?.text).not.toContain(" I ");
    // Room-wide: it is about the pair, not about one of them.
    expect(budget?.agentId).toBeUndefined();
  });
});

describe("a message the daemon could not take", () => {
  test("a dropped message is recorded, and never reaches a model", async () => {
    /**
     * A conversation runs one turn at a time, so messages queue behind it — and past
     * `max_queue_depth` the oldest are dropped, because in a conversation the stale message is the
     * one least worth answering. That drop was logged and nowhere else: "my message never got an
     * answer" had no answer in the dashboard.
     *
     * The depth is narrowed to make the overflow cheap rather than to make it possible; at the
     * shipped 20 this test would be twenty provider calls to prove one row.
     *
     * `ui`, and checked as such: a dropped message was never routed to anybody, so telling an agent
     * about it would describe a conversation it did not have.
     */
    const h = await room({ turns: [{ text: "ok" }], maxQueueDepth: 2 });

    // Pushed in one tick, so they pile up behind the first turn rather than running in sequence.
    for (let index = 0; index < 8; index += 1) {
      h.local.dispatch({ text: `@nox pesan ${index}`, chatId: "room-1", chatType: "group" });
    }
    await h.pipeline.idle();

    const dropped = h.chatEvents
      .forChat("web:dashboard", "room-1")
      .filter((event) => event.kind === "dropped");

    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((event) => event.audience === "ui")).toBe(true);
    expect(dropped.every((event) => event.details?.reason === "queue_full")).toBe(true);
    // Recorded even when the chat was not told: `noticeDropped` throttles to one notice a minute,
    // and the quiet drops are exactly the ones nothing else accounts for.
    expect(dropped.some((event) => event.details?.throttled === true)).toBe(true);

    /**
     * And none of it reached a model.
     *
     * Matched on the drop sentence's own distinctive clause rather than on "was dropped", which is
     * also in the harness's MEMORY section — "if you are told the section was dropped for budget" —
     * and so passed this assertion for the wrong reason on the first attempt.
     */
    expect(JSON.stringify(h.requests)).not.toContain("too many waiting to be answered");
  });
});
