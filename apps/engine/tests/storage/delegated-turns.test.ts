/**
 * A delegate's own turn in the turn store (0.7.26): a helper working in the background, an ask moved there.
 *
 * It is recorded where a chat turn is, in the chat's conversation — so `nouride turns show` reads it and whoever may
 * follow the chat sees its rows — and it is no turn of that conversation. Each read here is one that would go wrong if
 * it counted one: the transcript and the live view would draw a helper's brief as something the person said, a file the
 * agent sends would land on the helper's record, memory would file the brief as an exchange and wait on a helper four
 * hours long before cutting the chat, and a restart would take a helper's turn up as a chat turn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { EventStore } from "@/modules/events/events.store.ts";
import { EventedTurnStore } from "@/modules/events/turn-events.store.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { tempDir } from "../helpers.ts";

let dir: string;
let db: SqliteDb;
let events: EventStore;
let turns: EventedTurnStore;
beforeEach(async () => {
  dir = tempDir("delegated");
  db = await openAndMigrate(join(dir, "test.db"));
  events = new EventStore(db, Date.now, { strict: true });
  turns = new EventedTurnStore(db, events);
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const chat = { agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" };
const SESSION = "nouva:telegram:main:chat-1";

/** The person's turn, and the helper it started in the background, both still running in the chat. */
function aChatWithAHelper() {
  const own = turns.begin({ ...chat, sessionId: SESSION, prompt: "cek semua link di docs dong" });
  const helper = turns.begin({
    ...chat,
    sessionId: `${SESSION}:sub:sub_1`,
    prompt: "GOAL\nFind every broken link on the docs site",
    cause: { via: "delegate", job: "job_1", parent: own },
  });
  return { own, helper };
}

describe("a delegate's own turn is no turn of the conversation", () => {
  test("the transcript and the live view leave it out", () => {
    const { own } = aChatWithAHelper();
    expect(turns.forChat(chat.gatewayId, chat.chatId).map((turn) => turn.id)).toEqual([own]);
    expect(turns.runningForChat(chat.gatewayId, chat.chatId).map((turn) => turn.id)).toEqual([own]);
  });

  test("a file the agent sends is its own turn's — the helper is the same agent, in the same chat, and newer", () => {
    const { own } = aChatWithAHelper();
    expect(turns.runningFor(chat.agentId, chat.gatewayId, chat.chatId)).toBe(own);
  });

  test("memory files no brief as something said, and does not wait on a helper still running to cut the chat", () => {
    const { own, helper } = aChatWithAHelper();
    turns.finish(own, { status: "done", reply: "Siap, helper lagi ngecek.", model: "m" });
    turns.finish(helper, { status: "done", reply: "Found 3 broken links.", model: "m" });
    expect(turns.exchangesBetween(chat.gatewayId, chat.chatId, 0, Date.now() + 1).map((exchange) => exchange.prompt)).toEqual(["cek semua link di docs dong"]);

    const running = turns.begin({ ...chat, sessionId: `${SESSION}:sub:sub_2`, prompt: "GOAL\nanother", cause: { via: "delegate", job: "job_2", parent: own } });
    expect(running).toBeTruthy();
    expect(turns.chatsActiveSince(0)).toEqual([{ gatewayId: chat.gatewayId, chatId: chat.chatId, runningSince: null }]);
  });

  test("the nightly pass, which waits for no conversation to be at work, does not wait out a helper", () => {
    const { own } = aChatWithAHelper();
    expect(turns.runningSessions()).toEqual(new Set([SESSION]));
    turns.finish(own, { status: "done", reply: "ok" });
    expect(turns.runningSessions().size).toBe(0);
  });

  test("a person who sent nothing since has not moved on because a helper started", () => {
    const own = turns.begin({ ...chat, sessionId: SESSION, prompt: "first" });
    turns.finish(own, { status: "failed", error: "provider down" });
    // A millisecond after the person's turn began, and the helper's begun no earlier: only the helper's being no turn
    // of the conversation can make the answer false. `Date.now() - 1` fell on the person's own turn under load.
    const since = turns.get(own)!.startedAt + 1;
    while (Date.now() < since) {
      // the store reads the clock itself
    }
    turns.begin({ ...chat, sessionId: `${SESSION}:peer:peer_1`, prompt: "check the disk", agentId: "nero", cause: { via: "ask_agent", job: "job_3", parent: own } });
    expect(turns.startedInChatSince(chat.gatewayId, chat.chatId, since)).toBe(false);
  });

  test("a restart closes it, ends it in the stream, and neither reports it to the chat nor takes it up again", () => {
    const { own, helper } = aChatWithAHelper();
    const closed = turns.interruptOrphaned();
    expect(closed.turns).toBe(2);
    expect(closed.conversations.map((conversation) => conversation.turnId)).toEqual([own]);
    expect(closed.delegated).toEqual([helper]);
    expect(turns.get(helper)?.status).toBe("interrupted");
    const ends = events.list({ kinds: ["turn"] }).filter((row) => row.data.phase === "end").map((row) => row.turnId);
    expect(ends.sort()).toEqual([own, helper].sort());
    expect(turns.interruptedSince(0).map((turn) => turn.id)).toEqual([own]);
  });

  test("its start says whose it is, for a reader following the chat (stream 1.4)", () => {
    const { own, helper } = aChatWithAHelper();
    const starts = events.list({ kinds: ["turn"] });
    expect(starts.find((row) => row.turnId === helper)?.data).toMatchObject({ phase: "start", via: "delegate", by: "nouva" });
    expect(starts.find((row) => row.turnId === own)?.data).not.toHaveProperty("via");
  });
});

describe("deleting a conversation", () => {
  test("takes its delegates' turns and what they streamed — and not a conversation whose id only begins the same", () => {
    const { own, helper } = aChatWithAHelper();
    turns.step(helper, "tool", "exec ls", { callId: "c1", name: "exec" });
    // A thread of the same chat has a conversation of its own whose id starts with this one's.
    const thread = turns.begin({ ...chat, chatId: "chat-1:7", sessionId: `${SESSION}:7`, prompt: "in the thread" });

    // The turns cleared are the conversation's own: a helper's is no turn the person had.
    expect(turns.deleteForSession(SESSION)).toBe(1);
    expect(turns.get(own)).toBeNull();
    expect(turns.get(helper)).toBeNull();
    expect(events.list({ turnId: helper })).toEqual([]);
    expect(turns.get(thread)?.prompt).toBe("in the thread");
  });
});

describe("read whole", () => {
  test("the turn that asked lists what it handed off; the delegate's says which turn asked and which job it is", () => {
    const { own, helper } = aChatWithAHelper();
    turns.begin({ ...chat, sessionId: SESSION, prompt: "an unrelated turn" });
    const inspector = new TurnInspector(db);
    expect(inspector.inspect(own)?.delegated?.map((turn) => [turn.id, turn.cause?.via, turn.prompt])).toEqual([[helper, "delegate", "GOAL\nFind every broken link on the docs site"]]);
    expect(inspector.inspect(helper)?.turn.cause).toEqual({ via: "delegate", job: "job_1", parent: own });
    expect(inspector.inspect(helper)?.delegated).toEqual([]);
  });
});
