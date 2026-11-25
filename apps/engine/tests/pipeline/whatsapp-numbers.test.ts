/**
 * A WhatsApp number is its agent's, as a Telegram bot is.
 *
 * A daemon holds a number for each agent. A message to a number goes to the agent that owns it, people are let in
 * for that number and no other, and a group two of the install's numbers are in is each number's own to answer, by
 * the rule a room of two bots already follows. Each case is run twice through the real pipeline, with a connection
 * for each agent on WhatsApp and on Telegram, and what happened is compared: nothing here is WhatsApp's own rule.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SqliteDb } from "@nouride/runtime";
import type { MessageEnvelope } from "@nouride/shared";
import { envelope as envelopeAt, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup) dispose();
  cleanup = [];
});

const OWNER = "owner-1";
const CUSTOMER = "customer-7";
const GROUP = "room-1";
type Platform = "whatsapp" | "telegram";
type Agent = "nouva" | "nora";

const conversationsOf = (db: SqliteDb, agent: string): string[] =>
  db.prepare<{ id: string }>("SELECT id FROM sessions WHERE agent_id = ? ORDER BY id").all(agent).map((row) => row.id);

/**
 * Nouva holds the install and pairs new senders; Nora is the shop's, and open to everyone unless `nora` says
 * otherwise. A connection each on `platform`: Nouva's is `home`, Nora's is `shop`. The owner is on the install's list.
 */
async function install(platform: Platform, options: { nora?: "open" | "pair"; requireMention?: boolean } = {}) {
  const owned: Record<Agent, string> = { nouva: `${platform}:home`, nora: `${platform}:shop` };
  const connections = Object.fromEntries((Object.keys(owned) as Agent[]).map((agent) => [agent, new FakeGateway(owned[agent], platform)])) as Record<Agent, FakeGateway>;
  // Neither platform hands a number or a bot its own messages, or another's: a tag between agents is the daemon's.
  for (const connection of Object.values(connections)) connection.echoesOwnMessages = false;
  const open = (options.nora ?? "open") === "open";
  const bench = await pipelineBench({
    turns: ["answer 1", "answer 2", "answer 3", "answer 4"].map((text) => ({ text })),
    agents: [
      { id: "nouva", configToml: '[agent]\ndisplay_name = "Nouva"\n\n[llm]\nprovider = "test"\n' },
      { id: "nora", configToml: `[agent]\ndisplay_name = "Nora"\n${open ? 'access = "open"\n\n[open]\nmax_daily_tokens = 1000000\nmax_daily_messages_per_person = 100\n' : ""}\n[llm]\nprovider = "test"\n` },
    ],
    config: {
      daemon: { orchestrator: "nouva" },
      agents: { mentions_enabled: true, groups_require_mention: options.requireMention ?? false },
      security: { access: { mode: "pair", allowlist: [OWNER] } },
      gateways: { [platform]: { home: { enabled: true, ...(platform === "whatsapp" ? { encryption_key: "k-home" } : { token: "t-home" }), agent: "nouva" }, shop: { enabled: true, ...(platform === "whatsapp" ? { encryption_key: "k-shop" } : { token: "t-shop" }), agent: "nora" } } },
    },
    gateways: Object.values(connections),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  let sent = 0;
  return {
    ...bench,
    owned,
    /** A one-to-one message to one agent's own number or bot. */
    async dm(to: Agent, over: Partial<MessageEnvelope>) {
      connections[to].receive(envelopeAt({ id: `dm-${++sent}`, timestamp: Date.now(), gateway: platform, gatewayId: owned[to], chatId: `dm-${over.senderId ?? CUSTOMER}`, senderId: CUSTOMER, senderName: "Budi", ...over }));
      await bench.pipeline.idle();
    },
    /** One group message as the platform delivers it: a copy to each of the install's connections in the group. */
    async group(over: Partial<MessageEnvelope>, tagged?: Agent) {
      const message = envelopeAt({ id: `g-${++sent}`, timestamp: Date.now(), gateway: platform, chatType: "group", chatId: GROUP, senderId: OWNER, senderName: "Gading", ...over });
      for (const agent of Object.keys(owned) as Agent[]) connections[agent].receive({ ...message, gatewayId: owned[agent], ...(tagged === agent ? { mentionsSelf: true } : {}) });
      await bench.pipeline.idle();
    },
    /** What each connection sent, by the agent that owns it. */
    said: () => ({ nouva: connections.nouva.sent.map((message) => message.text), nora: connections.nora.sent.map((message) => message.text) }),
  };
}

/** The same case on both platforms: what a WhatsApp number does, a Telegram bot does. */
async function onBoth<Seen>(run: (platform: Platform) => Promise<Seen>): Promise<Seen> {
  const [whatsapp, telegram] = [await run("whatsapp"), await run("telegram")];
  // The ids differ by the platform's name and nothing else.
  expect(JSON.parse(JSON.stringify(whatsapp).replaceAll("whatsapp", "telegram"))).toEqual(telegram);
  return whatsapp;
}

describe("a message to a number goes to the agent that owns it", () => {
  test("each agent answers on its own number, in a conversation of its own, and neither on the other's", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform, { nora: "pair" });
      await h.dm("nora", { senderId: OWNER, senderName: "Gading", text: "when does the shop open?" });
      await h.dm("nouva", { senderId: OWNER, senderName: "Gading", text: "and what is on today?" });
      return { said: h.said(), nouva: conversationsOf(h.db, "nouva"), nora: conversationsOf(h.db, "nora"), requests: h.requests.length };
    });
    expect(seen).toEqual({
      said: { nouva: ["answer 2"], nora: ["answer 1"] },
      nouva: [`ses_nouva:whatsapp:home:dm-${OWNER}`],
      nora: [`ses_nora:whatsapp:shop:dm-${OWNER}`],
      requests: 2,
    });
  });

  test("a person who names the other agent on a number still reaches it there, as on a bot: the number is where they wrote, not all they may reach", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform, { nora: "pair" });
      await h.dm("nora", { senderId: OWNER, senderName: "Gading", text: "nouva: what is on today?" });
      return { nouva: conversationsOf(h.db, "nouva"), nora: conversationsOf(h.db, "nora") };
    });
    expect(seen).toEqual({ nouva: [`ses_nouva:whatsapp:shop:dm-${OWNER}`], nora: [] });
  });
});

describe("people are let in for a number, by its agent's access", () => {
  test("the shop's number is open and answers a new customer with no code; the same person on the other number is asked to pair", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform);
      await h.dm("nora", { text: "do you have a city bike?" });
      await h.dm("nouva", { text: "hello?" });
      return { said: h.said(), requests: h.requests.length, onShop: h.access.get(h.owned.nora, CUSTOMER)?.status ?? null, onHome: h.access.get(h.owned.nouva, CUSTOMER)?.status ?? null, nouva: conversationsOf(h.db, "nouva") };
    });
    // One turn, the open agent's. On the other number a code waits for an admin and nothing was begun.
    expect(seen).toEqual({ said: { nouva: [], nora: ["answer 1"] }, requests: 1, onShop: null, onHome: "pending", nouva: [] });
  });

  test("a new customer who names the other agent on the shop's open number is answered by the shop's agent alone", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform);
      await h.dm("nora", { text: "nouva: run uptime on the server" });
      return { said: h.said(), requests: h.requests.length, nouva: conversationsOf(h.db, "nouva"), nora: conversationsOf(h.db, "nora") };
    });
    expect(seen).toEqual({ said: { nouva: [], nora: ["answer 1"] }, requests: 1, nouva: [], nora: [`ses_nora:whatsapp:shop:dm-${CUSTOMER}`] });
  });

  test("let in on one number is not let in on the other: each number has its own list", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform, { nora: "pair" });
      h.access.allow(h.owned.nouva, CUSTOMER, "admin");
      await h.dm("nouva", { text: "hello" });
      await h.dm("nora", { text: "hello" });
      return { requests: h.requests.length, said: h.said(), onHome: h.access.get(h.owned.nouva, CUSTOMER)?.status ?? null, onShop: h.access.get(h.owned.nora, CUSTOMER)?.status ?? null };
    });
    // Answered on the number they were let in on; on the other a code waits, and no turn was begun.
    expect(seen).toEqual({ requests: 1, said: { nouva: ["answer 1"], nora: [] }, onHome: "approved", onShop: "pending" });
  });

  test("a block on one number keeps that sender out of it, and not out of the other", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform);
      h.access.block(h.owned.nora, CUSTOMER, "admin");
      h.access.allow(h.owned.nouva, CUSTOMER, "admin");
      await h.dm("nora", { text: "hello again" });
      await h.dm("nouva", { text: "hello" });
      return { said: h.said(), requests: h.requests.length };
    });
    expect(seen).toEqual({ said: { nouva: ["answer 1"], nora: [] }, requests: 1 });
  });
});

/** A room's untagged copy waits a moment for the tagged one's agent to take the message: each case below waits that out, twice over. */
const ROOM = 30_000;

describe("a group two of the install's numbers are in", () => {
  test("a message that tags one number is that number's agent's to answer, once", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform, { nora: "pair" });
      await h.group({ text: "when does the shop open?" }, "nora");
      await h.group({ text: "and what is on today?" }, "nouva");
      return { said: h.said(), requests: h.requests.length };
    });
    expect(seen).toEqual({ said: { nouva: ["answer 2"], nora: ["answer 1"] }, requests: 2 });
  }, ROOM);

  test("one that tags nobody is answered once and not by each number: by the room's front desk, the agent that holds the install", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform, { nora: "pair" });
      await h.group({ text: "good morning all" });
      return { said: h.said(), requests: h.requests.length };
    });
    expect(seen).toEqual({ said: { nouva: ["answer 1"], nora: [] }, requests: 1 });
  }, ROOM);

  test("where a tag is asked for, one that tags nobody is nobody's", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform, { nora: "pair", requireMention: true });
      await h.group({ text: "good morning all" });
      return { said: h.said(), requests: h.requests.length };
    });
    expect(seen).toEqual({ said: { nouva: [], nora: [] }, requests: 0 });
  }, ROOM);

  test("an open agent's number answers there only when it is the one tagged", async () => {
    const seen = await onBoth(async (platform) => {
      const h = await install(platform);
      await h.group({ senderId: CUSTOMER, senderName: "Budi", text: "is anyone here?" });
      const untagged = h.requests.length;
      await h.group({ senderId: CUSTOMER, senderName: "Budi", text: "what are your opening hours?" }, "nora");
      return { untagged, said: h.said(), requests: h.requests.length };
    });
    expect(seen).toEqual({ untagged: 0, said: { nouva: [], nora: ["answer 1"] }, requests: 1 });
  }, ROOM);
});
