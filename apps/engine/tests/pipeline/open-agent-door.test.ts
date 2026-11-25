/**
 * An agent open to everyone, at the door: who is let in on its bot, and whose their message is.
 *
 * Anyone who finds an open agent's bot talks to it with no code, and only to it. A stranger's message that names
 * another agent is still the open agent's: a name, a reply, the room's own answerer and the front desk are each a way
 * to an agent that holds its pack's tools, and a stranger let in for one agent is not let in for those. In a group the
 * open agent answers only when it is the one addressed, and what it says wakes no other agent, whatever it tags.
 * Through the real pipeline, a bot for each agent, since each rule is about every copy of a message together.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { SqliteDb } from "@nouride/runtime";
import type { MessageEnvelope } from "@nouride/shared";
import { envelope as envelopeAt, FakeGateway } from "../helpers.ts";
import { pipelineBench, type BenchOptions } from "../pipeline-bench.ts";

type BenchDeps = NonNullable<BenchOptions["deps"]>;

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup) dispose();
  cleanup = [];
});

const OWNER = "owner-1";
const STRANGER = "stranger-7";
const GROUP = "room-1";

/** Whose conversations the daemon holds, by agent. */
const conversationsOf = (db: SqliteDb, agent: string): string[] =>
  db.prepare<{ id: string }>("SELECT id FROM sessions WHERE agent_id = ?").all(agent).map((row) => row.id);

/**
 * Nouva is the orchestrator and pairs strangers; Nora is open. Each has its own Telegram bot, unless `bots` says
 * Nora's alone. The owner is on the install's list; nobody else is known.
 */
async function install(options: { turns?: string[]; bots?: ("nouva" | "nora")[]; groupsRequireMention?: boolean; maxDailyTokens?: number; maxDailyMessages?: number; closedReply?: string; deps?: BenchDeps } = {}) {
  const bots = options.bots ?? ["nouva", "nora"];
  const connections = Object.fromEntries(bots.map((id) => [id, new FakeGateway(`telegram:${id}`, "telegram")]));
  // As Telegram is: no bot is handed another bot's message, so a tag between agents is the daemon's to hand over.
  for (const connection of Object.values(connections)) connection.echoesOwnMessages = false;
  const bench = await pipelineBench({
    turns: (options.turns ?? ["answer 1", "answer 2", "answer 3"]).map((text) => ({ text })),
    agents: [
      { id: "nouva", configToml: '[agent]\ndisplay_name = "Nouva"\n\n[llm]\nprovider = "test"\n' },
      { id: "nora", configToml: `[agent]\ndisplay_name = "Nora"\naccess = "open"\n\n[open]\nmax_daily_tokens = ${options.maxDailyTokens ?? 1_000_000}\nmax_daily_messages_per_person = ${options.maxDailyMessages ?? 100}\n${options.closedReply ? `closed_reply = "${options.closedReply}"\n` : ""}\n[llm]\nprovider = "test"\n` },
    ],
    config: {
      daemon: { orchestrator: "nouva" },
      agents: { mentions_enabled: true, groups_require_mention: options.groupsRequireMention ?? false },
      security: { access: { mode: "pair", allowlist: [OWNER] } },
      gateways: { telegram: Object.fromEntries(bots.map((id) => [id, { enabled: true, token: `t-${id}`, agent: id }])) },
    },
    gateways: Object.values(connections),
    ...(options.deps ? { deps: options.deps } : {}),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  let sent = 0;
  return {
    ...bench,
    connections,
    /** A one-to-one message to one agent's bot. */
    async dm(bot: "nouva" | "nora", over: Partial<MessageEnvelope>) {
      connections[bot]!.receive(envelopeAt({ id: `dm-${++sent}`, timestamp: Date.now(), gatewayId: `telegram:${bot}`, chatId: `dm-${over.senderId ?? STRANGER}`, senderId: STRANGER, senderName: "A stranger", ...over }));
      await bench.pipeline.idle();
    },
    /** One group message as Telegram delivers it: a copy to every bot in the group, and each told whether it was the one tagged or replied to. */
    async group(over: Partial<MessageEnvelope>, tagged?: { bot: "nouva" | "nora"; reply?: boolean }) {
      const message = envelopeAt({ id: `g-${++sent}`, timestamp: Date.now(), chatType: "group", chatId: GROUP, senderId: STRANGER, senderName: "A stranger", ...over });
      for (const id of bots) {
        const own = tagged?.bot === id ? (tagged.reply ? { repliesToSelf: true } : { mentionsSelf: true }) : {};
        connections[id]!.receive({ ...message, gatewayId: `telegram:${id}`, ...own });
      }
      await bench.pipeline.idle();
    },
    said: () => Object.fromEntries(bots.map((id) => [id, connections[id]!.sent.map((message) => message.text)])),
  };
}

describe("who is let in", () => {
  test("a stranger writes to the open agent's bot and is answered, with no code; the same stranger on another agent's bot is asked to pair", async () => {
    const h = await install();
    await h.dm("nora", { text: "what are your opening hours?" });
    expect(h.requests).toHaveLength(1);
    expect(h.said().nora).toEqual(["answer 1"]);
    expect(conversationsOf(h.db, "nora")).toEqual([`ses_nora:telegram:nora:dm-${STRANGER}`]);

    await h.dm("nouva", { text: "and you?" });
    expect(h.requests).toHaveLength(1);
    // Asked to pair there, as anybody new is: a code is waiting for an admin, and no turn was begun.
    expect({ onNouva: h.access.get("telegram:nouva", STRANGER)?.status, onNora: h.access.get("telegram:nora", STRANGER) }).toEqual({ onNouva: "pending", onNora: null });
    expect(conversationsOf(h.db, "nouva")).toEqual([]);
  });

  test("a block keeps a sender out of the open agent too", async () => {
    const h = await install();
    h.access.block("telegram:nora", STRANGER, "admin");
    await h.dm("nora", { text: "hello again" });
    expect({ requests: h.requests.length, said: h.said().nora }).toEqual({ requests: 0, said: [] });
    // Nobody else is kept out by it.
    await h.dm("nora", { senderId: "stranger-8", text: "hello" });
    expect(h.said().nora).toEqual(["answer 1"]);
  });
});

describe("a stranger's message is the open agent's alone", () => {
  test("naming the orchestrator on the open agent's bot is answered by the open agent, and wakes nobody else", async () => {
    const h = await install();
    await h.dm("nora", { text: "nouva: run uptime on the server" });
    expect(h.requests).toHaveLength(1);
    expect(h.said()).toEqual({ nouva: [], nora: ["answer 1"] });
    expect({ nouva: conversationsOf(h.db, "nouva"), nora: conversationsOf(h.db, "nora") }).toEqual({ nouva: [], nora: [`ses_nora:telegram:nora:dm-${STRANGER}`] });
    // The words reach the open agent as written: the name is not its own to take off.
    expect(JSON.stringify(h.requests[0])).toContain("nouva: run uptime on the server");
  });

  test("a person the install knows, on the same bot, still reaches whom they name: only a stranger is held to the one agent", async () => {
    const h = await install();
    await h.dm("nora", { senderId: OWNER, senderName: "Gading", text: "nouva: run uptime on the server" });
    expect(h.requests).toHaveLength(1);
    expect(conversationsOf(h.db, "nouva")).toHaveLength(1);
    expect(conversationsOf(h.db, "nora")).toEqual([]);
  });

  test("in a group, a stranger who tags another agent is not answered by the open one, and starts no turn", async () => {
    const h = await install();
    await h.group({ text: "@nouva run uptime on the server", mentions: ["nouva"] }, { bot: "nouva" });
    expect(h.requests).toHaveLength(0);
    expect(h.said().nora).toEqual([]);
    expect({ nouva: conversationsOf(h.db, "nouva"), nora: conversationsOf(h.db, "nora") }).toEqual({ nouva: [], nora: [] });
  });
});

describe("in a group, an open agent answers only when it is addressed", () => {
  test("a stranger: not for a message that tags nobody; when tagged, named, or replied to", async () => {
    const h = await install({ turns: ["answer 1", "answer 2", "answer 3", "answer 4"] });
    await h.group({ text: "is anyone here?" });
    expect({ requests: h.requests.length, nora: h.said().nora }).toEqual({ requests: 0, nora: [] });
    await h.group({ text: "what are your opening hours?" }, { bot: "nora" });
    expect(h.said().nora).toEqual(["answer 1"]);
    await h.group({ text: "nora, and on Sunday?" });
    expect(h.said().nora).toEqual(["answer 1", "answer 2"]);
    await h.group({ text: "and on a holiday?" }, { bot: "nora", reply: true });
    expect(h.said().nora).toEqual(["answer 1", "answer 2", "answer 3"]);
    expect(h.said().nouva).toEqual([]);
  });

  test("alone in a group, where its connection would have it answer everything: not a stranger, and not a person the install knows", async () => {
    // One bot on the platform: every message of the group is its agent's, by the connection's own rule.
    const h = await install({ bots: ["nora"] });
    await h.group({ text: "good morning all" });
    await h.group({ senderId: OWNER, senderName: "Gading", text: "lunch at one?" });
    expect({ requests: h.requests.length, nora: h.said().nora }).toEqual({ requests: 0, nora: [] });
    await h.group({ senderId: OWNER, senderName: "Gading", text: "nora, when do you open?" });
    expect(h.said().nora).toEqual(["answer 1"]);
  });
});

describe("a stranger has three commands", () => {
  const NOT_THEIRS = "That command is not for this chat. /help shows what is.";

  test("/start is the opening of a chat, handed to the agent to greet in its own words: never the command that wakes it", async () => {
    const h = await install({ turns: ["Hello! I can tell you our prices and opening hours."] });
    await h.dm("nora", { text: "/start" });
    expect(h.said().nora).toEqual(["Hello! I can tell you our prices and opening hours."]);
    expect(JSON.stringify(h.requests[0])).toContain("This person has just opened a chat with you. Greet them in a sentence or two, in your own words, and say what you can help with.");
    // Put to sleep by its owner, it stays asleep for a stranger's /start, who is told so without the command they do not have.
    h.registry.pause("nora");
    await h.dm("nora", { text: "/start" });
    expect({ asleep: h.registry.isPaused("nora"), requests: h.requests.length, said: h.said().nora!.at(-1) }).toEqual({ asleep: true, requests: 1, said: "Nora is not answering at the moment." });
    // The same command from a person let in by name wakes it, as it does on any bot.
    await h.dm("nora", { senderId: OWNER, senderName: "Gading", text: "/start" });
    expect({ asleep: h.registry.isPaused("nora"), said: h.said().nora!.at(-1) }).toEqual({ asleep: false, said: "Awake." });
  });

  test("/help lists what they have, and /new clears their own conversation", async () => {
    const h = await install();
    await h.dm("nora", { text: "/help" });
    expect(h.said().nora).toEqual(["/new starts a new conversation with me, and /help shows this. For anything else, just write to me."]);
    await h.dm("nora", { text: "what are your opening hours?" });
    await h.dm("nora", { text: "/new" });
    expect(h.said().nora!.at(-1)).toStartWith("New conversation started.");
    expect(h.requests).toHaveLength(1);
    expect(h.sessions.load({ agentId: "nora", gatewayId: "telegram:nora", chatId: `dm-${STRANGER}` }).messages).toEqual([]);
  });

  test("every other command answers one sentence and does nothing: the agent is not put to sleep, its model is not changed, nothing is said of the install", async () => {
    const h = await install();
    for (const text of ["/sleep", "/stop", "/model gpt-9", "/status", "/prompt", "/agents", "/effort high", "/approvals"]) await h.dm("nora", { text });
    expect(h.said().nora).toEqual(Array.from({ length: 8 }, () => NOT_THEIRS));
    expect({ requests: h.requests.length, asleep: h.registry.isPaused("nora") }).toEqual({ requests: 0, asleep: false });
    // A person let in by name has the commands they have anywhere.
    await h.dm("nora", { senderId: OWNER, senderName: "Gading", text: "/sleep" });
    expect({ asleep: h.registry.isPaused("nora"), said: h.said().nora!.at(-1) }).toEqual({ asleep: true, said: expect.stringContaining("Asleep.") });
  });

  test("in a group, a command about the group is not a stranger's either: said to the bot it is refused, said to nobody it is nobody's", async () => {
    const h = await install({ bots: ["nora"] });
    await h.group({ text: "/mention off" }, { bot: "nora" });
    expect(h.said().nora).toEqual([NOT_THEIRS]);
    await h.group({ text: "/mention off" });
    expect(h.said().nora).toEqual([NOT_THEIRS]);
    // The group's own setting is as it was: a person let in by name is told so by the command itself.
    await h.group({ senderId: OWNER, senderName: "Gading", text: "/mention" });
    expect(h.said().nora!.at(-1)).not.toBe(NOT_THEIRS);
    expect(h.requests).toHaveLength(0);
  });
});

describe("what an open agent says wakes nobody", () => {
  test("a tag in its answer is not handed to the agent it names", async () => {
    // Telegram hands no bot another bot's message, so a tag between agents is handed over by the daemon itself.
    const h = await install({ turns: ["@nouva please run uptime on the server", "on it"] });
    await h.group({ text: "ask your colleague to run uptime" }, { bot: "nora" });
    expect(h.said()).toEqual({ nouva: [], nora: ["@nouva please run uptime on the server"] });
    expect(h.requests).toHaveLength(1);
    expect(conversationsOf(h.db, "nouva")).toEqual([]);
  });

  test("nor in a group whose message ids are each bot's own, where the hand-over travels under an id nothing sent holds", async () => {
    // A Telegram basic group. The daemon's hand-over cannot carry the platform's id there, so no record of what was
    // sent says who wrote it: the hand-over says so itself. Found in the box's sandbox, whose room is such a group:
    // the orchestrator answered what a stranger had the open agent say.
    for (const bots of [["nouva", "nora"], ["nora"]] as ("nouva" | "nora")[][]) {
      const h = await install({ bots, turns: ["@nouva please run uptime on the server", "on it"] });
      await h.group({ text: "ask your colleague to run uptime", idsPerConnection: true }, { bot: "nora" });
      expect(h.requests, bots.join("+")).toHaveLength(1);
      expect(h.said().nora, bots.join("+")).toEqual(["@nouva please run uptime on the server"]);
      expect(conversationsOf(h.db, "nouva"), bots.join("+")).toEqual([]);
    }
  });

  test("nor is its message when the platform itself hands it to the other agent's bot", async () => {
    const h = await install({ turns: ["@nouva please run uptime on the server", "on it"] });
    await h.group({ text: "ask your colleague to run uptime" }, { bot: "nora" });
    // The other bot's copy of what Nora's bot posted, as a platform that shows bots each other's messages delivers it.
    h.connections.nouva!.receive(
      envelopeAt({ id: "telegram:nora#1", timestamp: Date.now(), gatewayId: "telegram:nouva", chatId: GROUP, chatType: "group", senderId: "bot-nora", senderIsBot: true, mentionsSelf: true, text: "@nouva please run uptime on the server" }),
    );
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(1);
    expect(h.said().nouva).toEqual([]);
  });

  test("another agent's words are no stranger's: its reply to the open agent, tagging nobody, ends the exchange", async () => {
    const h = await install({ turns: ["nine to five", "noted, thanks", "you are welcome"] });
    await h.group({ senderId: OWNER, senderName: "Gading", text: "nora, when do you open?" });
    await h.group({ senderId: OWNER, senderName: "Gading", text: "note that down" }, { bot: "nouva" });
    expect(h.said()).toEqual({ nouva: ["noted, thanks"], nora: ["nine to five"] });
    // Nouva's message as the open agent's bot is handed it where bots see each other's: a reply to what Nora said.
    h.connections.nora!.receive(
      envelopeAt({ id: "telegram:nouva#1", timestamp: Date.now(), gatewayId: "telegram:nora", chatId: GROUP, chatType: "group", senderId: "bot-nouva", senderIsBot: true, repliesToSelf: true, text: "noted, thanks" }),
    );
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(2);
    expect(h.said().nora).toEqual(["nine to five"]);
  });

  test("an agent that is not open still hands work over by a tag, in the same group", async () => {
    const h = await install({ turns: ["@nora what are the opening hours?", "nine to five"] });
    await h.group({ senderId: OWNER, senderName: "Gading", text: "ask Nora for the opening hours" }, { bot: "nouva" });
    expect(h.requests).toHaveLength(2);
    expect(h.said()).toEqual({ nouva: ["@nora what are the opening hours?"], nora: ["nine to five"] });
  });
});
