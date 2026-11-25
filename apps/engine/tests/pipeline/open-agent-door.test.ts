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
import { emptyTurnMessage } from "@/modules/pipeline/messages.ts";

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
async function install(options: { turns?: string[]; bots?: ("nouva" | "nora")[]; noraOff?: boolean; perMinute?: number; groupsRequireMention?: boolean; maxDailyTokens?: number; maxDailyMessages?: number; closedReply?: string; deps?: BenchDeps } = {}) {
  const bots = options.bots ?? ["nouva", "nora"];
  const connections = Object.fromEntries(bots.map((id) => [id, new FakeGateway(`telegram:${id}`, "telegram")]));
  // As Telegram is: no bot is handed another bot's message, so a tag between agents is the daemon's to hand over.
  for (const connection of Object.values(connections)) connection.echoesOwnMessages = false;
  const bench = await pipelineBench({
    turns: (options.turns ?? ["answer 1", "answer 2", "answer 3"]).map((text) => ({ text })),
    agents: [
      { id: "nouva", configToml: '[agent]\ndisplay_name = "Nouva"\n\n[llm]\nprovider = "test"\n' },
      { id: "nora", configToml: `[agent]\ndisplay_name = "Nora"\n${options.noraOff ? "enabled = false\n" : ""}access = "open"\n\n[open]\nmax_daily_tokens = ${options.maxDailyTokens ?? 1_000_000}\nmax_daily_messages_per_person = ${options.maxDailyMessages ?? 100}\n${options.closedReply ? `closed_reply = "${options.closedReply}"\n` : ""}\n[llm]\nprovider = "test"\n` },
    ],
    config: {
      daemon: { orchestrator: "nouva" },
      agents: { mentions_enabled: true, groups_require_mention: options.groupsRequireMention ?? false },
      security: { access: { mode: "pair", allowlist: [OWNER] }, ...(options.perMinute ? { rate_limit: { messages_per_minute: options.perMinute, cooldown_reply: "Slow down, please." } } : {}) },
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

  test("an open agent that is switched off lets nobody new in: no answer, no code, and nothing counted", async () => {
    // What an admin reaches for when the bot is abused: the agent's own switch. Its connection stays up, and the door
    // read the agent whether it was on or off, so strangers went on being answered.
    const h = await install({ noraOff: true });
    await h.dm("nora", { text: "what are your opening hours?" });
    await h.group({ text: "nora, are you there?" }, { bot: "nora" });
    expect(h.requests).toHaveLength(0);
    expect(h.said().nora).toEqual([]);
    expect({ onNora: h.access.get("telegram:nora", STRANGER), conversations: conversationsOf(h.db, "nora") }).toEqual({ onNora: null, conversations: [] });
  });

  test("a file from a sender the door turns away is never fetched: blocked, or in a group untagged", async () => {
    // The platform's copy of a file is fetched for a turn, after the door: a WhatsApp number's bridge now holds it until
    // then, where it used to download every one as it came, whoever sent it.
    const { AttachmentStore } = await import("@/modules/attachments/store.ts");
    const { ChatAttachmentIndex } = await import("@/modules/attachments/chat-attachments.store.ts");
    const fetched: string[] = [];
    const h = await install({
      turns: ["a nice photo"],
      deps: ({ db, dataDir }) => ({ attachmentIndex: new ChatAttachmentIndex(db), attachments: new AttachmentStore({ rootDir: `${dataDir}/attachments`, maxBytes: 1_000_000 }) }),
    });
    for (const bot of Object.values(h.connections)) (bot as unknown as { fetchAttachment: (a: { url?: string }) => Promise<Uint8Array> }).fetchAttachment = async (attachment) => (fetched.push(attachment.url ?? ""), new Uint8Array([0xff, 0xd8, 0xff]));
    const photo = (name: string) => ({ attachments: [{ type: "image" as const, mimeType: "image/jpeg", url: `wa-held:${name}` }] });
    h.access.block("telegram:nora", "blocked-1", "admin");
    await h.dm("nora", { senderId: "blocked-1", text: "look", ...photo("from-the-blocked") });
    await h.group({ text: "look at this", ...photo("in-the-group-untagged") });
    expect({ fetched, requests: h.requests.length }).toEqual({ fetched: [], requests: 0 });
    // Let in, as anyone is by an open agent: fetched for the turn that answers it.
    await h.dm("nora", { text: "what is this?", ...photo("let-in") });
    expect({ fetched, requests: h.requests.length }).toEqual({ fetched: ["wa-held:let-in"], requests: 1 });
  });

  test("a stranger past the per-minute limit is told to slow down once, not for every message", async () => {
    // Read by a second reader of the branch: each message past the limit had its own reply and its own record.
    const h = await install({ perMinute: 1, turns: ["we open at nine"] });
    for (const text of ["hi", "are you there", "hello?", "hello??"]) await h.dm("nora", { text });
    expect({ said: h.said().nora, requests: h.requests.length }).toEqual({ said: ["we open at nine", "Slow down, please."], requests: 1 });
  });

  test("a key a stranger sends in a group is taken out; they are told only where they addressed the open agent, by its bot", async () => {
    // Read by a second reader of the branch: the notice came under every such message, addressed or not, from the
    // room's front desk, the household's bot. The open agent's copy is handed over first here, as the platform may.
    const { TransientSecrets } = await import("@nouride/secrets");
    const h = await install({ turns: ["noted"], deps: () => ({ heldSecrets: new TransientSecrets() }) });
    const inGroup = async (id: string, text: string, tagsNora: boolean) => {
      for (const bot of ["nora", "nouva"] as const) {
        h.connections[bot]!.receive(envelopeAt({ id, timestamp: Date.now(), gatewayId: `telegram:${bot}`, chatType: "group", chatId: GROUP, senderId: STRANGER, senderName: "A stranger", text, ...(tagsNora && bot === "nora" ? { mentionsSelf: true } : {}) }));
      }
      await h.pipeline.idle();
    };
    const key = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
    const another = `ghp_${"Pk4Lm8Nq2Rs6Tv1W".repeat(3).slice(0, 36)}`;
    await inGroup("k-1", `my key is ${key}`, false);
    expect(h.said()).toEqual({ nouva: [], nora: [] });
    await inGroup("k-2", `nora, my key is ${another}`, true);
    expect(h.said().nouva).toEqual([]);
    expect((h.said().nora ?? []).filter((line) => line.startsWith("🔒 Part of your message looked like a password or a key ("))).toHaveLength(1);
    for (const one of [key, another]) expect(JSON.stringify(h.requests)).not.toContain(one);
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

  test("the daemon's own word on the open agent's bot is no stranger's: a job's result for another agent reaches that agent, and nobody is counted", async () => {
    // A person the install knows may ask another agent on this bot, and what that agent's job says when it ends comes
    // back here as the daemon's own message. Taken for a stranger's, it was handed to the open agent, result and all.
    const h = await install({ turns: ["the job is done: 42 lines"] });
    h.connections.nora!.receive(
      envelopeAt({ id: "wake-1", timestamp: Date.now(), gatewayId: "telegram:nora", chatId: `dm-${OWNER}`, senderId: "nouride:system", senderName: "Nouride", mentions: ["nouva"], text: "[System event] the count ended: 42 lines in the ledger", raw: { via: "job", job: "job_1" } }),
    );
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(1);
    expect({ nouva: conversationsOf(h.db, "nouva").length, nora: conversationsOf(h.db, "nora").length }).toEqual({ nouva: 1, nora: 0 });
    expect(JSON.stringify(h.requests[0])).toContain("42 lines in the ledger");
    // Nobody wrote: the day's count of people who did is as it was.
    expect(h.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM open_door WHERE sender_id != ''").get()?.n).toBe(0);
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

  test("in a group, /new is not a stranger's: the conversation is everyone's there, and is kept; /help says where it is theirs", async () => {
    const h = await install({ bots: ["nora"] });
    await h.group({ text: "nora, what are your opening hours?" }, { bot: "nora" });
    const group = { agentId: "nora", gatewayId: "telegram:nora", chatId: GROUP };
    const before = h.sessions.load(group).messages.length;
    await h.group({ senderId: "another-stranger", text: "/new" }, { bot: "nora" });
    await h.group({ senderId: "another-stranger", text: "/help" }, { bot: "nora" });
    expect(h.said().nora!.slice(-2)).toEqual([
      "This conversation is everyone's in this group, so /new is not taken here. In a chat with me alone it is.",
      "Just write to me. In a chat with me alone, /new starts a new conversation.",
    ]);
    expect({ before, after: h.sessions.load(group).messages.length }).toEqual({ before: expect.any(Number), after: before });
    expect(before).toBeGreaterThan(0);
    // A person let in by name may start the group's conversation over, as on any bot.
    await h.group({ senderId: OWNER, senderName: "Gading", text: "/new" }, { bot: "nora" });
    expect(h.said().nora!.at(-1)).toStartWith("New conversation started.");
    expect(h.sessions.load(group).messages).toEqual([]);
  });
});

describe("what the daemon says for an open agent", () => {
  test("an answer it did not manage names no command a stranger does not have; an ordinary agent's still points to /status", async () => {
    const h = await install({ turns: ["", ""] });
    await h.dm("nora", { text: "what are your opening hours?" });
    expect(h.said().nora).toEqual(["I did not manage to produce an answer for that. Try rephrasing."]);
    await h.dm("nouva", { senderId: OWNER, senderName: "Gading", text: "and you?" });
    expect(h.said().nouva).toEqual(["I did not manage to produce an answer for that. Try rephrasing, or `/status` to check my state."]);
    // A turn out of time says the same, with an approval or without.
    for (const refused of [0, 1]) {
      expect(emptyTurnMessage("stop", 3, true, refused, false)).toEndWith("Ask me again and I will pick it up.");
      expect(emptyTurnMessage("stop", 3, true, refused)).toEndWith("Ask me again and I will pick it up, or `/status` to see where I am.");
    }
  });
});

describe("what a stranger's message changes in the room", () => {
  test("not the count of messages the household's agents have traded there: only a person let in by name starts it again", async () => {
    const h = await install();
    // The count is the room's, on the platform, and every agent reads it (`classifyInbound`); held where the voice keeps it.
    const room = (h.pipeline as unknown as { voice: { outbound: { hops(platform: string, chatId: string): number; setHops(platform: string, chatId: string, hops: number): void } } }).voice.outbound;
    room.setHops("telegram", GROUP, 3);
    await h.group({ text: "hello, anyone?" });
    await h.group({ text: "nora, what are your opening hours?" }, { bot: "nora" });
    expect(room.hops("telegram", GROUP)).toBe(3);
    await h.group({ senderId: OWNER, senderName: "Gading", text: "carry on" });
    expect(room.hops("telegram", GROUP)).toBe(0);
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
