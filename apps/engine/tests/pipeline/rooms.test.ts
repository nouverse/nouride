/**
 * Who is in a room, and what narrows because of it.
 *
 * The store is the easy half. The half worth testing is the **fallback**: a chat with no membership
 * list must behave exactly as it did before this table existed, because that is every Discord and
 * Telegram conversation on every install. A membership list that narrowed by default would silence
 * them, and the failure would look like a routing bug rather than a schema decision.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { ChatEventStore } from "@/modules/chat-events/chat-events.store.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { openAndMigrate } from "@/db/index.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { SessionStore } from "@/modules/sessions/sessions.store.ts";
import { conversationOf, tempDir, turnStore } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { sleep } from "../wait.ts";

let cleanup: (() => void)[] = [];

beforeEach(() => {
  cleanup = [];
});

afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
});

async function openStore() {
  const dataDir = tempDir("rooms");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  return new RoomStore(db);
}

// ── The store ───────────────────────────────────────────────────────────────

describe("a room's membership", () => {
  test("an undefined chat reports no members, which is not an empty room", async () => {
    /**
     * The contract everything else depends on. `membersOf` returning `[]` has to be read by callers
     * as "nothing knows", because a Discord channel is exactly this case and narrowing on an empty
     * list would stop every agent there from answering.
     */
    const store = await openStore();

    expect(store.membersOf("discord:nero", "1234")).toEqual([]);
    expect(store.hasMembers("discord:nero", "1234")).toBe(false);
    expect(store.get("discord:nero", "1234")).toBeNull();
  });

  test("creating is idempotent and does not lose the title", async () => {
    // A client that retries a create must not end up with a room it cannot name any more.
    const store = await openStore();
    store.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva"], title: "Product" });
    store.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });

    const room = store.get("web:dashboard", "r1");
    expect(room?.title).toBe("Product");
    expect(room?.members.map((member) => member.agentId).sort()).toEqual(["nero", "nouva"]);
  });

  test("adding twice happens once, and says so", async () => {
    /**
     * The boolean is what decides whether a `joined` event is written. A room whose history says
     * "Nero joined" three times is a history nobody trusts, so the store answers the question rather
     * than leaving each caller to check first and race.
     */
    const store = await openStore();
    store.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva"] });

    expect(store.add({ gatewayId: "web:dashboard", chatId: "r1", agentId: "nero" })).toBe(true);
    expect(store.add({ gatewayId: "web:dashboard", chatId: "r1", agentId: "nero" })).toBe(false);
    // Membership, not order — see the ordering test below for what the order actually promises.
    expect([...store.membersOf("web:dashboard", "r1")].sort()).toEqual(["nero", "nouva"]);
  });

  test("removing reports whether anything was there", async () => {
    const store = await openStore();
    store.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });

    expect(store.remove("web:dashboard", "r1", "nero")).toBe(true);
    expect(store.remove("web:dashboard", "r1", "nero")).toBe(false);
    expect(store.membersOf("web:dashboard", "r1")).toEqual(["nouva"]);
  });

  test("one room's members are not another's", async () => {
    const store = await openStore();
    store.create({ gatewayId: "web:dashboard", chatId: "a", agentIds: ["nouva"] });
    store.create({ gatewayId: "web:dashboard", chatId: "b", agentIds: ["nero"] });
    // Same chat id on a different connection is a different room.
    store.create({ gatewayId: "other:one", chatId: "a", agentIds: ["nox"] });

    expect(store.membersOf("web:dashboard", "a")).toEqual(["nouva"]);
    expect(store.membersOf("web:dashboard", "b")).toEqual(["nero"]);
    expect(store.membersOf("other:one", "a")).toEqual(["nox"]);
  });

  test("the order is stable, and says so the same way twice", async () => {
    /**
     * `added_at` alone does not break the tie: members created together share a millisecond, and
     * SQLite is then free to return them in any order — differently between reads. The list is drawn
     * as a row of avatars in a room header, so an unstable order is avatars swapping places between
     * renders for no reason a reader can see.
     *
     * What the order promises is *stability*, not insertion order. Who joined when is a question
     * `chat_events` answers with a timestamp per join; this is a list, and it is sorted so it looks
     * the same every time.
     */
    const store = await openStore();
    store.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nox", "nero", "nouva"] });

    const first = store.membersOf("web:dashboard", "r1");
    expect(store.membersOf("web:dashboard", "r1")).toEqual(first);
    expect(store.get("web:dashboard", "r1")?.members.map((m) => m.agentId)).toEqual(first);

    // Added later, so it sorts after the three that share a creation timestamp.
    store.add({ gatewayId: "web:dashboard", chatId: "r1", agentId: "late", at: Date.now() + 1_000 });
    expect(store.membersOf("web:dashboard", "r1").at(-1)).toBe("late");
  });

  test("a name clears back to nothing rather than to a stale string", async () => {
    // The client shows the member list when there is no title, and a title derived at write time
    // stops being right the moment a member is added.
    const store = await openStore();
    store.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva"], title: "Old" });

    expect(store.rename("web:dashboard", "r1", null)).toBe(true);
    expect(store.get("web:dashboard", "r1")?.title).toBeUndefined();
  });

  test("deleting a room leaves nothing behind", async () => {
    const store = await openStore();
    store.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });
    store.delete("web:dashboard", "r1");

    expect(store.get("web:dashboard", "r1")).toBeNull();
    expect(store.membersOf("web:dashboard", "r1")).toEqual([]);
  });
});

// ── What narrows because of it ──────────────────────────────────────────────

async function daemon(options: {
  turns: { text?: string }[];
  /** Held open until the returned gate is released — for testing what runs *while* something runs. */
  hold?: (agentId: string) => Promise<void> | undefined;
}) {
  const local = new LocalGateway();
  let rooms!: RoomStore;
  let roomMessages!: RoomMessageStore;
  let chatEvents!: ChatEventStore;
  const bench = await pipelineBench({
    turns: options.turns,
    /**
     * The provider, optionally held open per agent.
     *
     * Concurrency cannot be tested against an instant provider: every turn is over before the next
     * message arrives, so a serialised queue and a parallel one look identical. The hold is read from
     * the request's own system prompt, which is the only place the agent's identity appears on the
     * wire.
     */
    ...(options.hold
      ? {
          fetch: (scripted: typeof fetch) =>
            (async (url: string | URL | Request, init?: RequestInit) => {
              const body = String(init?.body ?? "");
              const agentId = /- Name: ([a-z0-9_-]+)/.exec(body)?.[1] ?? "";
              await options.hold!(agentId);
              return scripted(url, init);
            }) as typeof fetch,
        }
      : {}),
    agents: ["nouva", "nero", "nox"],
    config: {
      // Off, so the *default* posture is what decides whether an untagged message is answered — which
      // is the thing membership narrows.
      agents: { mentions_enabled: true, mention_max_hops: 5, groups_require_mention: false },
      daemon: { orchestrator: "nouva" },
    },
    gateways: [local],
    deps: ({ db }) => ({
      rooms: (rooms = new RoomStore(db)),
      roomMessages: (roomMessages = new RoomMessageStore(db)),
      chatEvents: (chatEvents = new ChatEventStore(db)),
    }),
  });
  cleanup.push(bench.dispose);
  const { pipeline, turns, registry, requests } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();

  return {
    rooms,
    roomMessages,
    chatEvents,
    turns,
    registry,
    local,
    pipeline,
    requests,
    async say(text: string, chatId: string) {
      local.dispatch({ text, chatId, chatType: "group" });
      await pipeline.idle();
    },
    lastPrompt: () => JSON.stringify(requests.at(-1)),
  };
}

describe("what a membership list narrows", () => {
  test("the prompt names the room's members, not every agent on the daemon", async () => {
    /**
     * `turn.ts` built this from `registry.enabled()`, so a room of two told its members they could
     * tag the third. The comment above that line already said why it matters: "Naming one that is
     * disabled, or that no gateway would deliver to, teaches the model to address somebody who never
     * answers." The tag goes out, nothing happens, and it reads as a routing bug.
     */
    const h = await daemon({ turns: [{ text: "ok" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });

    await h.say("@nouva halo", "r1");

    const prompt = h.lastPrompt();
    expect(prompt).toContain("@nero");
    // Nox is enabled and is not in this room.
    expect(prompt).not.toContain("@nox");
  });

  test("a chat with no room still sees every agent", async () => {
    // The fallback, which is every platform conversation. Narrowing here by default would silence
    // agents in channels the operator invited them to.
    const h = await daemon({ turns: [{ text: "ok" }] });

    await h.say("@nouva halo", "no-room-here");

    expect(h.lastPrompt()).toContain("@nero");
    expect(h.lastPrompt()).toContain("@nox");
  });

  test("an untagged message in a one-agent room is answered", async () => {
    /**
     * The guard counts who *could* answer. Before membership it counted every enabled agent, so a
     * room of one behaved like a room of three and said nothing — the fallback to `default_agent` is
     * withheld once more than one agent is reachable, and the whole point of a one-agent room is
     * that there is no ambiguity to protect against.
     */
    const h = await daemon({ turns: [{ text: "ok" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "solo", agentIds: ["nouva"] });

    await h.say("halo tanpa tag", "solo");

    expect(h.requests).toHaveLength(1);
  });

  test("an untagged message in a room of two is answered once, by the orchestrator when it is a member", async () => {
    // Two candidates and no name: answering with both is noise and picking one is arbitrary — so the orchestrator,
    // the one agent named for exactly this (0.7.18), answers it, and only in a room it belongs to.
    const h = await daemon({ turns: [{ text: "front desk" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "pair", agentIds: ["nouva", "nero"] });
    await h.say("halo tanpa tag", "pair");
    expect(h.requests).toHaveLength(1);
    expect(h.turns.forChat("web:dashboard", "pair").map((turn) => turn.agentId)).toEqual(["nouva"]);
  });

  test("an untagged message in a room of two the orchestrator is not in is answered by nobody", async () => {
    const h = await daemon({ turns: [{ text: "should not run" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "pair", agentIds: ["nero", "nox"] });
    await h.say("halo tanpa tag", "pair");
    expect(h.requests).toHaveLength(0);
  });

  test("a member that has been disabled is not offered", async () => {
    // A name in the table records a decision; whether it can answer today is the registry's
    // business, and offering a paused or deleted agent is offering a tag that reaches nobody.
    const h = await daemon({ turns: [{ text: "ok" }] });
    h.rooms.create({
      gatewayId: "web:dashboard",
      chatId: "r2",
      agentIds: ["nouva", "nero", "ghost-agent"],
    });

    await h.say("@nouva halo", "r2");

    expect(h.lastPrompt()).toContain("@nero");
    expect(h.lastPrompt()).not.toContain("ghost-agent");
  });
});

// ── The send route's decision ───────────────────────────────────────────────

/**
 * Room or one-to-one, decided by the membership list and not by a flag.
 *
 * These drive the route rather than the pipeline, because the thing under test is the *decision*:
 * a DM pins one agent and hands the gateway a mention the message cannot override, and a room pins
 * nobody and lets the tag choose. The pipeline tests above cannot see that — by the time an envelope
 * reaches them the choice has been made.
 */
async function mountSend(input: {
  members?: string[];
  /** Agents the registry reports as paused. */
  paused?: string[];
}) {
  const { Hono } = await import("hono");
  const { registerChatRoutes } = await import("@/modules/web/control/routes/chat.ts");

  const dataDir = tempDir("send");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());

  const rooms = new RoomStore(db);
  const chatEvents = new ChatEventStore(db);
  if (input.members) {
    rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: input.members });
  }

  /** Every dispatch the route made, which is the whole observation. */
  const dispatched: Record<string, unknown>[] = [];
  const paused = new Set(input.paused ?? []);

  const deps = {
    local: {
      id: "web:dashboard",
      dispatch: (request: Record<string, unknown>) => {
        dispatched.push(request);
        return { messageId: "msg_1", chatId: String(request.chatId) };
      },
    },
    rooms,
    chatEvents,
    sessions: { find: () => null },
    // Present because the send route refuses without it — a client whose message produced no record
    // would poll for a turn that never appears.
    turns: {},
    registry: {
      get: (id: string) => ({ config: { id, enabled: true, displayName: id } }),
      enabled: () => ["nouva", "nero", "nox"].map((id) => ({ config: { id, displayName: id } })),
      isPaused: (id: string) => paused.has(id),
    },
    audit: { record: () => undefined },
    ctx: { config: { daemon: { defaultAgent: "nouva" }, people: [] } },
  };

  /**
   * Typed with the one variable the routes read, so the middleware below can set it.
   *
   * The real app gets `principal` from the auth middleware, which is not mounted here — this is the
   * send route under test, not the login.
   */
  const app = new Hono<{ Variables: { principal: unknown } }>();
  app.use("*", async (c, next) => {
    // An admin, who opens every room: which rooms an account opens is `whose-doors.test.ts`.
    c.set("principal", {
      kind: "user",
      actor: "gading",
      role: "admin",
      user: { id: "u1", username: "gading", displayName: "Gading" },
    });
    await next();
  });
  registerChatRoutes(app as never, deps as never);

  const send = (body: Record<string, unknown>) =>
    app.request("/chat/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return { send, dispatched, chatEvents };
}

describe("sending into a room", () => {
  test("nobody is pinned, and the message is a group message", async () => {
    /**
     * The DM path hands `agent:` to the gateway, which `envelopeFor` turns into `mentions: [agent]` —
     * a mention the message's own text cannot override. In a room that would make every message go
     * to the same agent however it was addressed, which is the opposite of what a tag is for.
     */
    const h = await mountSend({ members: ["nouva", "nero"] });

    const res = await h.send({ chatId: "r1", text: "@nero tolong cek" });

    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.agent).toBeUndefined();
    // The flag everything about a room hangs off: the mention gate, the shared history, the handover.
    expect(h.dispatched[0]?.chatType).toBe("group");
    expect(h.dispatched[0]?.text).toBe("@nero tolong cek");
  });

  test("a chat with no membership list still pins one agent", async () => {
    // The DM path, untouched. In a one-to-one chat a tag reaches nobody — each bot has its own
    // private conversation — so the handover goes over `ask_agent` and the pinned agent stays the
    // only voice. Turning that off is what `voice.ts` records the cost of.
    const h = await mountSend({});

    const res = await h.send({ chatId: "not-a-room", text: "halo", agent: "nouva" });

    expect(res.status).toBe(200);
    expect(h.dispatched[0]?.agent).toBe("nouva");
    // Absent, so `envelopeFor` defaults it to a DM.
    expect(h.dispatched[0]?.chatType).toBeUndefined();
  });

  test("two agents tagged at once goes through as one message", async () => {
    // The fan-out is the pipeline's, not this route's: one message has to stay one message through
    // room-memory observation and the queue, and only then run more than one agent.
    const h = await mountSend({ members: ["nouva", "nero", "nox"] });

    const res = await h.send({ chatId: "r1", text: "@nero @nox tolong review" });

    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]?.text).toBe("@nero @nox tolong review");
  });

  test("one agent tagged goes through untouched", async () => {
    const h = await mountSend({ members: ["nouva", "nero"] });

    const res = await h.send({ chatId: "r1", text: "@nero cek ini" });

    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
  });

  test("a name that is not a member is still just a message", async () => {
    const h = await mountSend({ members: ["nouva", "nero"] });

    const res = await h.send({ chatId: "r1", text: "@nero minta @nexa nanti kalau perlu" });

    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
  });

  test("a room where nothing can answer is refused, not silently accepted", async () => {
    // A 200 here would leave the client waiting for a turn record that is never written, and
    // eventually deciding the daemon is broken — the same reason a paused agent is refused up front
    // on the DM path.
    const h = await mountSend({ members: ["nouva", "nero"], paused: ["nouva", "nero"] });

    const res = await h.send({ chatId: "r1", text: "@nero halo" });

    expect(res.status).toBe(409);
    expect(h.dispatched).toHaveLength(0);
  });
});

describe("a message that addresses more than one agent", () => {
  test("both run, from one message", async () => {
    /**
     * What a platform does for free and a shared connection cannot. On Discord `@nero @nox cek ini`
     * is delivered to both bots, each resolves the tag to itself, and both run. Behind one connection
     * there is one copy and one routing decision, so the second name used to reach nobody.
     */
    const h = await daemon({ turns: [{ text: "satu" }, { text: "dua" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero", "nox"] });

    await h.say("@nero @nox tolong review", "r1");

    expect(h.requests).toHaveLength(2);
  });

  test("neither is handed a message that points at the other", async () => {
    /**
     * The failure this was found by, on a live box. `stripAddressPrefix` removes the agent's own
     * leading tag — right when it is the only addressee, and actively misleading when it is not:
     * Nero received `@nox cek ini` and its first reasoning step read "Ignoring unaddressed message",
     * which was the correct reading of what it had been given.
     *
     * With several addressees the text is left as written, so each agent can see it was one of two.
     */
    const h = await daemon({ turns: [{ text: "satu" }, { text: "dua" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero", "nox"] });

    await h.say("@nero @nox tolong review", "r1");

    for (const request of h.requests) {
      const body = request as { messages: { role: string; content: string }[] };
      const asked = conversationOf(body.messages).at(-1)?.content ?? "";
      expect(asked).toContain("@nero");
      expect(asked).toContain("@nox");
    }
  });

  test("one addressee still gets its own tag stripped", async () => {
    // The reason stripping exists: without it the model sees its own name as the first token of
    // every message and starts echoing the pattern back — and `nouva: /new` has to reach the command
    // parser as `/new`.
    const h = await daemon({ turns: [{ text: "ok" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero", "nox"] });

    await h.say("@nero tolong review", "r1");

    const body = h.requests.at(-1) as { messages: { role: string; content: string }[] };
    expect(conversationOf(body.messages).at(-1)?.content).toMatch(/^Terminal: tolong review\n\n\(Sent [^)]+\)$/);
  });

  test("a name that is not in the room is a word, not an address", async () => {
    // Nox is enabled and not a member here, so tagging it must not run it — the membership list is
    // what decides who is reachable, and the prompt does not offer it either.
    const h = await daemon({ turns: [{ text: "ok" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r2", agentIds: ["nero"] });

    await h.say("@nero minta @nox kalau perlu", "r2");

    expect(h.requests).toHaveLength(1);
  });
});

describe("what a room records of what was said", () => {
  test("a message nobody was tagged in is still part of the conversation", async () => {
    /**
     * The bug that showed this model was wrong. A room's transcript was made of turn records, and a
     * turn exists only when an agent runs — so an untagged message had no home at all. It went into
     * the in-memory group buffer, reached the next agent tagged as background, and was nowhere a
     * transcript could read it. On screen it vanished: pending forever, a stop button that never
     * stopped, and "no turn started" thirty seconds later.
     *
     * In a group chat every message is part of the conversation. Being answered is a separate
     * question, and most of what gets typed in a busy room is not addressed to anybody.
     */
    const h = await daemon({ turns: [{ text: "should not run" }] });
    // A room without the orchestrator, so nobody is asked to answer (0.7.18).
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero", "nox"] });

    await h.say("halo semua, ini tanpa tag", "r1");

    // Nobody answered — that is correct.
    expect(h.requests).toHaveLength(0);
    // And the message is still there.
    const said = h.roomMessages.forChat("web:dashboard", "r1");
    expect(said.map((message) => message.text)).toEqual(["halo semua, ini tanpa tag"]);
  });

  test("a message two agents answered is recorded once", async () => {
    /**
     * The mirror image. Fan-out produces one turn record per agent, and a client drawing each turn's
     * prompt drew the same message twice — two identical bubbles for one thing somebody typed.
     *
     * The bubble comes from here now and a turn carries only its reply, joined back by `messageId`.
     */
    const h = await daemon({ turns: [{ text: "satu" }, { text: "dua" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero", "nox"] });

    await h.say("@nero @nox tolong review", "r1");

    expect(h.requests).toHaveLength(2);
    expect(h.roomMessages.forChat("web:dashboard", "r1")).toHaveLength(1);
  });

  test("an agent's reply is not recorded as something a person said", async () => {
    /**
     * A reply is a turn, with its steps, its timings and its model. A second copy here would be two
     * records of one reply that can disagree — and on a shared connection the engine echoes an
     * agent's reply back through the inbound path to build the room's memory, so without the
     * `senderIsBot` filter every answer would also appear as a message from a person.
     */
    const h = await daemon({ turns: [{ text: "jawaban nero" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero", "nox"] });

    await h.say("@nero halo", "r1");

    const said = h.roomMessages.forChat("web:dashboard", "r1");
    expect(said.map((message) => message.text)).toEqual(["@nero halo"]);
  });

  test("an untagged message becomes context for whoever is tagged next", async () => {
    /**
     * The behaviour the whole model exists for, and the one the operator described: type without a
     * tag, then tag somebody, and they read what was said in between.
     *
     * Carried by the room's overheard block rather than by this table — the block is what reaches a
     * prompt — so this asserts the two halves are connected rather than merely both present.
     */
    const h = await daemon({ turns: [{ text: "ok" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero"] });

    await h.say("build-nya gagal di step tiga", "r1");
    await sleep(5);
    await h.say("@nero tolong lihat", "r1");

    const prompt = JSON.stringify(h.requests.at(-1));
    expect(prompt).toContain("build-nya gagal di step tiga");
    expect(h.roomMessages.forChat("web:dashboard", "r1")).toHaveLength(2);
  });

  test("a one-to-one chat records nothing here", async () => {
    // `chatType: "dm"` is the gate. A DM's transcript is its turns, and a second record of the
    // question would be one more thing to keep in step with them.
    const h = await daemon({ turns: [{ text: "ok" }] });

    h.local.dispatch({ text: "halo", chatId: "just-a-dm", agent: "nouva" });
    await h.pipeline.idle();

    expect(h.roomMessages.forChat("web:dashboard", "just-a-dm")).toHaveLength(0);
  });
});

describe("opening a room", () => {
  /**
   * A room that nobody has spoken in yet, which is every room for the first few seconds of its life.
   *
   * It has no session — those are created per agent, on their first turn — and the transcript route
   * reached for `session!.gatewayId` anyway. Opening a freshly created room returned a 500, and the
   * assertion was the same lie `ids[0]!` had already cost this repo once. Nothing had ever opened a
   * room before its first message, which is why nothing caught it.
   */
  async function mountTranscript(
    withMessage: boolean,
    seedEvents?: (store: ChatEventStore) => void,
  ) {
    const { Hono } = await import("hono");
    const { registerChatRoutes } = await import("@/modules/web/control/routes/chat.ts");

    const dataDir = tempDir("open");
    cleanup.push(() => removePath(dataDir));
    const db = await openAndMigrate(join(dataDir, "test.db"));
    cleanup.push(() => db.close());

    const rooms = new RoomStore(db);
    const roomMessages = new RoomMessageStore(db);
    rooms.create({ gatewayId: "web:dashboard", chatId: "fresh", agentIds: ["nero", "nox"] });
    if (withMessage) {
      roomMessages.record({
        id: "m1",
        gatewayId: "web:dashboard",
        chatId: "fresh",
        senderId: "gading",
        senderName: "Gading",
        text: "halo tanpa tag",
        at: 1_000,
      });
    }

    const chatEvents = new ChatEventStore(db);
    seedEvents?.(chatEvents);

    const app = new Hono<{ Variables: { principal: unknown } }>();
    app.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: "gading", role: "admin" });
      await next();
    });
    registerChatRoutes(app as never, {
      local: { id: "web:dashboard" },
      rooms,
      roomMessages,
      turns: turnStore(db),
      sessions: new SessionStore(db),
      chatEvents,
      registry: { get: () => undefined, enabled: () => [], isPaused: () => false },
      audit: { record: () => undefined },
      ctx: { config: { daemon: {} } },
    } as never);

    return app.request("/rooms/fresh/turns");
  }

  test("a room with no session and no messages opens", async () => {
    const res = await mountTranscript(false);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { turns: unknown[]; messages: unknown[]; room: unknown };
    expect(body.turns).toEqual([]);
    expect(body.messages).toEqual([]);
    // The room itself is still described, which is the whole reason the page can draw a header.
    expect(body.room).not.toBeNull();
  });

  test("its events come back before any agent has taken a turn", async () => {
    /**
     * The same mistake a third time, and this is the assertion that pins it: `events` was keyed on
     * the session too, so a freshly created room reported nothing — not even the members joining,
     * which is written the moment the room is created and is the one thing a new room *does* have.
     *
     * On the box that read as a room whose history was silently empty, and it hid a second thing: an
     * untagged command's hint was being written and never returned.
     */
    const res = await mountTranscript(false, (chatEvents) =>
      chatEvents.record({
        gatewayId: "web:dashboard",
        chatId: "fresh",
        audience: "agents",
        kind: "joined",
        text: "gading started this room with nero, nox.",
      }),
    );

    const body = (await res.json()) as { events: { kind: string }[] };
    expect(body.events.map((event) => event.kind)).toEqual(["joined"]);
  });

  test("a room whose only content is an unanswered message opens, and shows it", async () => {
    const res = await mountTranscript(true);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      turns: unknown[];
      messages: { text: string }[];
      earlier: unknown[];
    };
    expect(body.turns).toEqual([]);
    expect(body.messages.map((m) => m.text)).toEqual(["halo tanpa tag"]);
    // Never in a room: `earlier` is one member's private view, complete with harness blocks.
    expect(body.earlier).toEqual([]);
  });
});

describe("an agent that is already working", () => {
  test("a second message to it is refused, and the room is told", async () => {
    /**
     * A room runs several turns at once — that is the point of a room, and the reason the chat queue
     * no longer serialises one. So what keeps an agent from answering two questions at the same time
     * has to be a real check rather than the queue's ordering, which used to do it by accident.
     *
     * Refused rather than queued: a message that waits behind a two-minute turn is one the person has
     * forgotten writing by the time it runs, answered against a conversation that has moved on.
     */
    const h = await daemon({ turns: [{ text: "satu" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero"] });

    // `activeTurns` is what the guard reads, so holding an entry is exactly the state being tested —
    // and far more deterministic than racing a real turn.
    const key = "nero:r1:web:dashboard";
    (h.pipeline as unknown as { turnContext: { activeTurns: Map<string, unknown> } }).turnContext.activeTurns.set(
      key,
      new AbortController(),
    );

    await h.say("@nero halo", "r1");

    expect(h.requests).toHaveLength(0);
    const notices = h.chatEvents
      .forChat("web:dashboard", "r1")
      .filter((event) => event.details?.reason === "agent_busy");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.audience).toBe("ui");
    expect(notices[0]?.agentId).toBe("nero");
    expect(notices[0]?.text).toContain("still working");
  });

  test("and another agent in the same room still answers", async () => {
    // The whole reason the guard is per agent rather than per chat.
    const h = await daemon({ turns: [{ text: "nox jawab" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nero", "nox"] });
    (h.pipeline as unknown as { turnContext: { activeTurns: Map<string, unknown> } }).turnContext.activeTurns.set(
      "nero:r1:web:dashboard",
      new AbortController(),
    );

    await h.say("@nox halo", "r1");

    expect(h.requests).toHaveLength(1);
  });
});

describe("two agents working at once", () => {
  test("a message to a free agent does not wait for a busy one", async () => {
    /**
     * The queue keys on the *chat*, and one turn at a time per chat is right for a one-to-one
     * conversation — two at once is one agent answering two things while interleaving writes to one
     * session. A room's conversations are per agent, so the same rule made every member wait for
     * whichever one was asked first: on a live box a question for Nero sat behind Nouva reading a web
     * page, in a room whose whole point is that the others are free.
     *
     * Testable only against a provider that can be held open. With an instant one every turn is over
     * before the next message arrives, and a serialised queue looks exactly like a parallel one.
     */
    let releaseNouva = () => {};
    const nouvaHeld = new Promise<void>((resolve) => {
      releaseNouva = resolve;
    });
    const started: string[] = [];

    const h = await daemon({
      turns: [{ text: "jawab" }],
      hold: (agentId) => {
        started.push(agentId);
        return agentId === "nouva" ? nouvaHeld : undefined;
      },
    });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });

    /**
     * Dispatched rather than `say`n, because `say` awaits `pipeline.idle()` — which waits for the
     * held turn and deadlocks the test against the very thing it is holding open.
     */
    h.local.dispatch({ text: "@nouva mulai yang lama", chatId: "r1", chatType: "group" });
    // Let the first turn reach the provider and park there.
    await sleep(50);
    h.local.dispatch({ text: "@nero satu baris", chatId: "r1", chatType: "group" });

    // Polled rather than slept on: the assertion is "nero started while nouva is parked", and a
    // fixed sleep either flakes or is slower than it needs to be.
    for (let waited = 0; waited < 2_000 && !started.includes("nero"); waited += 25) {
      await sleep(25);
    }

    expect(started).toContain("nouva");
    // The point: nero reached the provider while nouva was still inside it.
    expect(started).toContain("nero");

    releaseNouva();
    await h.pipeline.idle();
  });
});

describe("a slash command in a room", () => {
  /**
   * Commands are not chatter, and the rule that keeps chatter from waking people should not apply to
   * them. `groups_require_mention` exists so an untagged sentence does not start a turn; a command is
   * addressed to the *harness* about an agent, answered with no model call, and `/stop` is how
   * somebody ends a turn that is running too long. On the box an untagged `/status` in a room reached
   * nobody and said nothing at all.
   */
  test("untagged in a room of one, it is answered", async () => {
    const h = await daemon({ turns: [{ text: "unused" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "solo", agentIds: ["nouva"] });

    await h.say("/status", "solo");

    // Answered by the harness, so no provider call — that is the point of a command.
    expect(h.requests).toHaveLength(0);
    const noted = h.turns.forChat("web:dashboard", "solo");
    expect(noted).toHaveLength(1);
    expect(noted[0]?.agentId).toBe("nouva");
    expect(noted[0]?.reply).toContain("Nouva");
  });

  test("untagged in a room of two, it says which names would work", async () => {
    /**
     * Not picked for them. Every one of these acts on one agent's conversation — `/new` clears a
     * history, `/model` changes a model — so choosing on their behalf is choosing whose history to
     * clear.
     */
    const h = await daemon({ turns: [{ text: "unused" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "pair", agentIds: ["nouva", "nero"] });

    await h.say("/status", "pair");

    expect(h.turns.forChat("web:dashboard", "pair")).toHaveLength(0);
    const hint = h.chatEvents
      .forChat("web:dashboard", "pair")
      .find((event) => event.details?.command === "/status");
    expect(hint?.audience).toBe("ui");
    expect(hint?.text).toContain("@nouva /status");
    expect(hint?.text).toContain("@nero /status");
  });

  test("tagged, it works even while that agent is mid-turn", async () => {
    /**
     * The reason the busy guard sits *after* the command block. Put before it, the guard refused
     * `/status` and `/stop` — the one command anybody reaches for when a turn is running too long.
     */
    const h = await daemon({ turns: [{ text: "unused" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva"] });
    (h.pipeline as unknown as { turnContext: { activeTurns: Map<string, unknown> } }).turnContext.activeTurns.set(
      "nouva:r1:web:dashboard",
      new AbortController(),
    );

    await h.say("@nouva /status", "r1");

    const noted = h.turns.forChat("web:dashboard", "r1");
    expect(noted).toHaveLength(1);
    expect(noted[0]?.reply).toContain("Nouva");
    // And it was not mistaken for a message the busy agent should answer.
    expect(h.requests).toHaveLength(0);
  });
});

describe("the shape the live box actually has", () => {
  /**
   * Every agent owns a connection on another platform, and the tag is not the first word.
   *
   * Reproduced from a failure the unit tests missed: `halo @nouva @nero` in a room of two ran only
   * Nouva. The earlier test used a bare config with no gateways at all and put the tags first, which
   * is not what anybody types and not what the box looks like.
   */
  async function boxShaped(options: { turns: { text?: string }[] }) {
    const local = new LocalGateway();
    let rooms!: RoomStore;
    const bench = await pipelineBench({
      turns: options.turns,
      agents: ["nouva", "nero"],
      config: {
        // One Discord bot per agent, as the box has — so `voiceGatewayId` has real connections to
        // consider rather than an empty list.
        gateways: {
          discord: {
            nouva: { enabled: false, token: "d-nouva", agent: "nouva" },
            nero: { enabled: false, token: "d-nero", agent: "nero" },
          },
        },
        agents: { mentions_enabled: true, mention_max_hops: 5, groups_require_mention: true },
        daemon: { orchestrator: "nouva" },
      },
      gateways: [local],
      deps: ({ db }) => ({
        chatEvents: new ChatEventStore(db),
        roomMessages: new RoomMessageStore(db),
        rooms: (rooms = new RoomStore(db)),
      }),
    });
    cleanup.push(bench.dispose);
    const { pipeline, turns, requests } = bench;
    pipeline.setTools(new Map());
    pipeline.attach();
    rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });

    return {
      turns,
      requests,
      async say(text: string) {
        local.dispatch({ text, chatId: "r1", chatType: "group" });
        await pipeline.idle();
      },
    };
  }

  test("halo @nouva @nero runs both", async () => {
    const h = await boxShaped({ turns: [{ text: "satu" }, { text: "dua" }] });

    await h.say("halo @nouva @nero");

    const ran = h.turns.forChat("web:dashboard", "r1").map((turn) => turn.agentId).sort();
    expect(ran).toEqual(["nero", "nouva"]);
  });
});

describe("a paused agent in a room", () => {
  test("says so instead of ignoring the message in silence", async () => {
    /**
     * The failure this was found by, and it cost several rounds. `/stop` pauses the *agent* rather
     * than stopping a turn, one of my own tests had left Nero paused, and every later message tagging
     * Nero in a room did nothing at all — no turn, no reply, nothing above `debug`. The report was
     * "only Nouva answered", and a restart cleared it, which made it look like a code bug that had
     * already been fixed.
     *
     * A DM never had this problem: the send route refuses a paused agent up front. A room cannot,
     * because its other members are answerable — so the refusal has to arrive in the conversation.
     */
    const h = await daemon({ turns: [{ text: "nouva jawab" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });
    h.registry.pause("nero");

    await h.say("halo @nouva @nero", "r1");

    // Nouva answered; Nero did not, and the room says why.
    expect(h.turns.forChat("web:dashboard", "r1").map((turn) => turn.agentId)).toEqual(["nouva"]);
    const notice = h.chatEvents
      .forChat("web:dashboard", "r1")
      .find((event) => event.details?.reason === "agent_paused");
    expect(notice?.audience).toBe("ui");
    expect(notice?.agentId).toBe("nero");
    expect(notice?.text).toContain("/wake");
  });
});

describe("a file an agent sent in a room", () => {
  /**
   * The route treats the session in a file's path as a permission: it refuses a turn that belongs to
   * another session, deliberately, so that one session id cannot serve any turn's files.
   *
   * The client built those URLs from the conversation it had open, which is *one* session — right in
   * a one-to-one chat and wrong in a room, where it is whichever member's session happened to be the
   * addressable one. Every attachment from any other member came back 404 and drew a broken image.
   * It looked like a race between two agents fetching pictures at once and was nothing of the kind:
   * whichever agent was not the addressable one lost every file it sent, every time.
   *
   * So the turn carries the session that owns it, and this pins that it does.
   */
  test("each turn reports the session that owns it", async () => {
    const h = await daemon({ turns: [{ text: "satu" }, { text: "dua" }] });
    h.rooms.create({ gatewayId: "web:dashboard", chatId: "r1", agentIds: ["nouva", "nero"] });

    await h.say("@nouva @nero halo", "r1");

    const { toTurnPayload } = await import("@/modules/turns/transcript.ts");
    const payloads = h.turns.forChat("web:dashboard", "r1").map(toTurnPayload);

    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      // Its own agent's session, not the room's or a neighbour's.
      expect(payload.sessionId).toBe(`ses_${payload.agentId}:web:dashboard:r1`);
    }
    // And the two differ, which is the whole point — one shared value would have served neither.
    expect(new Set(payloads.map((p) => p.sessionId)).size).toBe(2);
  });
});
