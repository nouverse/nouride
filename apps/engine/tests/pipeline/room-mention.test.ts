/**
 * A group's own answer to "a message here that tags nobody, who answers it?", set from the group with `/mention`: a
 * tag is needed, or none is and the agent the group named answers, or none is and nobody is named.
 *
 * The store keys it by the room as the platform sees it, so every one of our bots in a group reads one value; whether
 * a tag is needed is the group's own, then the connection's, then the daemon's, and a group with nothing of its own is
 * decided as before. The command is driven through the real pipeline with a copy per bot, because "one change, one
 * answer" is a property of every copy together and not of one hook call, and so is "one agent answers".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import type { MessageEnvelope } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { parseCommand } from "@/modules/hooks/parse.ts";
import { requireMentionHere } from "@/modules/pipeline/room-mention.ts";
import { RoomMentionStore, type RoomMentionPort } from "@/modules/pipeline/room-mention.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { stripLeadingSelfMention, writtenMentions } from "../../../../packages/gateways/src/channels/discord/envelope.ts";
import { foldChatId, telegramMentions } from "../../../../packages/gateways/src/channels/telegram/envelope.ts";
import { cheapPasswords, envelope as envelopeAt, FakeGateway, tempDir } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe("the store", () => {
  function store(): { store: RoomMentionStore; db: SqliteDb } {
    const dir = tempDir("room-mention");
    const db = openDatabase(join(dir, "t.db"));
    migrate(db);
    cleanup.push(() => {
      db.close();
      removePath(dir);
    });
    return { store: new RoomMentionStore(db, () => 1_000), db };
  }

  test("set, read back, replace, clear", () => {
    const { store: s } = store();
    expect(s.get("telegram", "-100")).toBeUndefined();
    s.set("telegram", "-100", { requireMention: false }, "telegram:main:operator");
    expect(s.get("telegram", "-100")).toEqual({ requireMention: false, setBy: "telegram:main:operator", setAt: 1_000 });
    s.set("telegram", "-100", { requireMention: true }, "telegram:main:rani");
    expect(s.get("telegram", "-100")).toEqual({ requireMention: true, setBy: "telegram:main:rani", setAt: 1_000 });
    // The agent the group named, kept with it; a tag needed after that leaves none, and so does naming nobody.
    s.set("telegram", "-100", { requireMention: false, answerer: "novelist" }, "telegram:main:rani");
    expect(s.get("telegram", "-100")).toEqual({ requireMention: false, answerer: "novelist", setBy: "telegram:main:rani", setAt: 1_000 });
    s.set("telegram", "-100", { requireMention: true }, "telegram:main:rani");
    expect(s.get("telegram", "-100")).toEqual({ requireMention: true, setBy: "telegram:main:rani", setAt: 1_000 });
    s.set("telegram", "-100", { requireMention: false, answerer: "novelist" }, "telegram:main:rani");
    s.set("telegram", "-100", { requireMention: false }, "telegram:main:rani");
    expect(s.get("telegram", "-100")).toEqual({ requireMention: false, setBy: "telegram:main:rani", setAt: 1_000 });
    expect(s.clear("telegram", "-100")).toBe(true);
    expect(s.get("telegram", "-100")).toBeUndefined();
    expect(s.clear("telegram", "-100")).toBe(false);
  });

  test("a database from before the column reads as it did: a tag needed, or none and nobody named", async () => {
    const dir = tempDir("room-mention-old");
    const db = openDatabase(join(dir, "t.db"));
    cleanup.push(() => {
      db.close();
      removePath(dir);
    });
    // As the release before left it: every migration but the one that adds the agent, and a row of each kind.
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 84));
    expect(db.prepare<{ name: string }>("SELECT name FROM pragma_table_info('room_mention')").all().map((column) => column.name)).not.toContain("agent_id");
    db.prepare("INSERT INTO room_mention (platform, chat_id, require_mention, set_by, set_at) VALUES ('telegram', 'needs', 1, 'x', 5), ('telegram', 'free', 0, 'y', 6)").run();
    await migrate(db);
    const s = new RoomMentionStore(db);
    expect(s.get("telegram", "needs")).toEqual({ requireMention: true, setBy: "x", setAt: 5 });
    expect(s.get("telegram", "free")).toEqual({ requireMention: false, setBy: "y", setAt: 6 });
    // And a group named an agent since, in the same table.
    s.set("telegram", "free", { requireMention: false, answerer: "novelist" }, "z");
    expect(s.get("telegram", "free")?.answerer).toBe("novelist");
  });

  test("keyed by platform and chat — the same chat id on another platform is another room", () => {
    const { store: s, db } = store();
    s.set("telegram", "42", { requireMention: false }, "a");
    expect(s.get("discord", "42")).toBeUndefined();
    expect(s.get("telegram", "43")).toBeUndefined();
    expect(db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM room_mention").get()?.n).toBe(1);
  });
});

describe("which setting decides", () => {
  const where = { gateway: "telegram" as const, gatewayId: "telegram:nero", chatId: "room-1" };
  const config = (instance: boolean | undefined, daemon: boolean) => ({
    agents: { groupsRequireMention: daemon } as never,
    gateways: [{ id: "telegram:nero", platform: "telegram", enabled: true, ...(instance === undefined ? {} : { groupsRequireMention: instance }) }] as never,
  });
  const own = (requireMention: boolean): Pick<RoomMentionPort, "get"> => ({
    get: (platform, chatId) => (platform === "telegram" && chatId === "room-1" ? { requireMention, setBy: "x", setAt: 1 } : undefined),
  });

  test("the group's own beats the connection's, which beats the daemon's", () => {
    expect(requireMentionHere({ config: config(true, true), roomMention: own(false) }, where)).toEqual({ requireMention: false, source: "group" });
    expect(requireMentionHere({ config: config(false, false), roomMention: own(true) }, where)).toEqual({ requireMention: true, source: "group" });
    expect(requireMentionHere({ config: config(false, true), roomMention: { get: () => undefined } }, where)).toEqual({ requireMention: false, source: "gateway" });
    expect(requireMentionHere({ config: config(undefined, true), roomMention: { get: () => undefined } }, where)).toEqual({ requireMention: true, source: "daemon" });
  });

  test("a room made in the dashboard is not held to the daemon's setting; its own `/mention` still wins", () => {
    const dashboard = { gateway: "web" as const, gatewayId: "web:dashboard", chatId: "web-1" };
    const daemonRequires = { agents: { groupsRequireMention: true } as never, gateways: [] as never };
    const rooms = { get: (gatewayId: string, chatId: string) => (gatewayId === "web:dashboard" && chatId === "web-1" ? ({ gatewayId, chatId, createdAt: 1, members: [] }) : null) };
    expect(requireMentionHere({ config: daemonRequires, rooms }, dashboard)).toEqual({ requireMention: false, source: "room" });
    const ownOn: Pick<RoomMentionPort, "get"> = { get: (platform, chatId) => (platform === "web" && chatId === "web-1" ? { requireMention: true, setBy: "x", setAt: 1 } : undefined) };
    expect(requireMentionHere({ config: daemonRequires, rooms, roomMention: ownOn }, dashboard)).toEqual({ requireMention: true, source: "group" });
    // A chat the rooms do not know — every chat-app group — reads the daemon's, as before.
    expect(requireMentionHere({ config: daemonRequires, rooms }, { ...dashboard, chatId: "web-2" })).toEqual({ requireMention: true, source: "daemon" });
    expect(requireMentionHere({ config: config(undefined, true), rooms }, where)).toEqual({ requireMention: true, source: "daemon" });
  });

  test("no override, and no store at all, are both exactly what config says", () => {
    for (const instance of [undefined, true, false]) {
      for (const daemon of [true, false]) {
        const expected = instance ?? daemon;
        expect(requireMentionHere({ config: config(instance, daemon) }, where).requireMention).toBe(expected);
        expect(requireMentionHere({ config: config(instance, daemon), roomMention: { get: () => undefined } }, where).requireMention).toBe(expected);
      }
    }
  });
});

/** A command, with a bot's name stuck to it or a tag among its words, as the bot `self`'s own adapter hands it over (`telegramMentions`). */
function asTelegramDelivers(text: string, self: string): Pick<MessageEnvelope, "text" | "mentions" | "mentionsSelf"> {
  const end = text.indexOf(" ");
  const entities = [
    { type: "bot_command" as const, offset: 0, length: end > 0 ? end : text.length },
    ...[...text.matchAll(/(?<=\s)@\w+/g)].map((tag) => ({ type: "mention" as const, offset: tag.index, length: tag[0].length })),
  ];
  const read = telegramMentions({ text, entities }, { id: 1, username: `${self}_bot` });
  return { text: read.text, mentions: read.mentions, ...(read.mentionsSelf ? { mentionsSelf: true } : {}) };
}

/** Each bot's id on Discord, where a tag is written `<@id>`. */
const SNOWFLAKE: Record<string, string> = { nouva: "111", nox: "222", nero: "333" };

/** A message as the Discord bot `self`'s own adapter hands it over: its own tag off the front, the tags read off the text. */
function asDiscordDelivers(content: string, self: string): Pick<MessageEnvelope, "text" | "mentions" | "mentionsSelf"> {
  const selfId = SNOWFLAKE[self]!;
  const read = writtenMentions({ content, users: Object.entries(SNOWFLAKE).map(([username, id]) => ({ id, username })), selfId });
  return { text: stripLeadingSelfMention(content, selfId).trim(), mentions: read.mentions, ...(read.mentionsSelf ? { mentionsSelf: true } : {}) };
}

/**
 * Agents with a Telegram bot each, all in one group, and people: `operator` an admin, `colleague` paired but not one.
 * With `platform: "discord"`, a Discord bot each, in one server channel.
 * `writes` counts what reached the store, so "one change" is asserted on the store and not on the replies.
 */
async function group(
  options: { bots?: string[]; daemonRequires?: boolean; instanceRequires?: boolean; turns?: number; orchestrator?: string; platform?: "telegram" | "discord" } = {},
) {
  const bots = options.bots ?? ["nouva", "nox", "nero"];
  const platform = options.platform ?? "telegram";
  const connections = Object.fromEntries(
    bots.map((id) => {
      const connection = new FakeGateway(`${platform}:${id}`, platform);
      // What a person writes to tag this bot, as its adapter says it.
      connection.selfMention = platform === "discord" ? `<@${SNOWFLAKE[id]}>` : `@${id}_bot`;
      if (platform === "discord") connection.selfId = SNOWFLAKE[id]!;
      return [id, connection];
    }),
  );
  let users: UserStore | undefined;
  const writes: string[] = [];
  const bench = await pipelineBench({
    turns: Array.from({ length: options.turns ?? 3 }, (_, i) => ({ text: `answer ${i + 1}` })),
    agents: bots,
    config: {
      agents: { mentions_enabled: true, groups_require_mention: options.daemonRequires ?? false },
      ...(options.orchestrator ? { daemon: { orchestrator: options.orchestrator } } : {}),
      gateways: {
        [platform]: Object.fromEntries(
          bots.map((id) => [id, { enabled: true, token: `t-${id}`, agent: id, ...(options.instanceRequires === undefined ? {} : { groups_require_mention: options.instanceRequires }) }]),
        ),
      },
    },
    configure: async (config, db) => {
      config.security.access.allowlist = ["operator", "colleague"];
      const store = new UserStore({ db, passwords: cheapPasswords });
      users = store;
      const account = async (username: string, role: "admin" | "operator") => `web:${(await store.create({ username, role, createdBy: "test" })).id}`;
      config.people = [
        { key: "gading", ids: ["telegram:operator", "discord:operator", await account("gading", "admin")], name: "Gading" },
        { key: "budi", ids: ["telegram:colleague", await account("budi", "operator")], name: "Budi" },
      ];
    },
    deps: (made) => {
      const real = new RoomMentionStore(made.db);
      const counted: RoomMentionPort = {
        get: (platform, chatId) => real.get(platform, chatId),
        set: (platform, chatId, choice, setBy) => {
          writes.push(`set ${platform}:${chatId} ${choice.requireMention ? "required" : (choice.answerer ?? "nobody named")}`);
          real.set(platform, chatId, choice, setBy);
        },
        clear: (platform, chatId) => {
          writes.push(`clear ${platform}:${chatId}`);
          return real.clear(platform, chatId);
        },
      };
      return { users: users!, roomMention: counted };
    },
    gateways: Object.values(connections),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  return harness(bench, bots, connections, writes, platform);
}

function harness(bench: Bench, bots: string[], connections: Record<string, FakeGateway>, writes: string[], platform: "telegram" | "discord") {
  let n = 0;
  return {
    ...bench,
    writes,
    /** One message as Telegram delivers it to a group: a copy to every bot, the same id and time on each. */
    async say(over: Partial<MessageEnvelope> & { perBot?: (bot: string) => Partial<MessageEnvelope> }) {
      const { perBot, ...rest } = over;
      const message = envelopeAt({ id: `m-${++n}`, timestamp: Date.now(), gateway: platform, chatType: platform === "discord" ? "channel" : "group", chatId: "room-1", senderId: "operator", ...rest });
      for (const id of bots) connections[id]!.receive({ ...message, gatewayId: `${platform}:${id}`, ...perBot?.(id) });
      await bench.pipeline.idle();
    },
    /** What every bot said, flattened, since the last call. */
    said(): string[] {
      const out = bots.flatMap((id) => connections[id]!.sent.splice(0).map((m) => m.text));
      return out;
    },
    /** Which bots said anything since the last call. */
    speakers(): string[] {
      return bots.filter((id) => connections[id]!.sent.splice(0).length > 0);
    },
    connections,
  };
}

const NEEDED = "Here a tag is needed: a message that tags nobody is answered by nobody.";
const NOBODY = "Here no tag is needed, and nobody answers a message that tags nobody: name an agent with `/mention <agent>`.";
/** The bench names each agent by its id with a capital: Nouva, Nox, Nero. */
const answers = (agent: string) => `Here no tag is needed; ${agent} answers.`;

describe("/mention in a group several of our bots share", () => {
  test("an untagged `/mention required` changes the setting once and is answered once", async () => {
    const h = await group({ daemonRequires: false });
    await h.say({ text: "/mention required" });

    expect(h.said()).toEqual([`Done. ${NEEDED}`]);
    expect(h.writes).toEqual(["set telegram:room-1 required"]);
  });

  test("where each bot numbers the message its own way, still once", async () => {
    // A Telegram basic group: every copy has its own id, so the copies share only who sent it and when.
    const h = await group({ daemonRequires: false });
    let i = 0;
    await h.say({ text: "/mention required", idsPerConnection: true, perBot: () => ({ id: String(100 + i++) }) });

    expect(h.said()).toHaveLength(1);
    expect(h.writes).toEqual(["set telegram:room-1 required"]);
  });

  test("`/mention@nox_bot required` is answered by Nox's bot, once, though another agent is the orchestrator", async () => {
    // The bot's name stuck to the command addresses that bot: it answers, not the orchestrator's.
    const h = await group({ daemonRequires: false, orchestrator: "nero" });
    await h.say({ text: "", perBot: (bot) => asTelegramDelivers("/mention@nox_bot required", bot) });

    expect(h.speakers()).toEqual(["nox"]);
    expect(h.writes).toEqual(["set telegram:room-1 required"]);
    expect(parseCommand("/mention@nox_bot required")).toEqual({ command: "/mention", args: ["required"] });
  });

  test("answered by the orchestrator's bot, though another bot's copy came first", async () => {
    // Live, `/mention` was answered by Nouva's bot and `/mention off` by Nestor's: whichever copy came first.
    const h = await group({ daemonRequires: false, orchestrator: "nero" });
    await h.say({ text: "/mention required" });

    expect(h.speakers()).toEqual(["nero"]);
    expect(h.writes).toEqual(["set telegram:room-1 required"]);
  });

  test("where each bot numbers the message its own way, it quotes the copy its own bot saw", async () => {
    // A Telegram basic group: Nouva's bot calls the message 100 and Nero's 102. Answering on Nouva's copy through
    // Nero's bot would quote a message Nero's bot has never seen — so Nero's own copy is the one that answers.
    const h = await group({ daemonRequires: false, orchestrator: "nero" });
    const ids: Record<string, string> = { nouva: "100", nox: "101", nero: "102" };
    await h.say({ text: "/mention required", idsPerConnection: true, perBot: (bot) => ({ id: ids[bot]! }) });

    expect(h.connections.nero!.sent.map((message) => message.replyTo)).toEqual(["102"]);
    expect(h.writes).toEqual(["set telegram:room-1 required"]);
  });

  test("when the orchestrator's copy never comes, another bot's copy is answered in the orchestrator's voice", async () => {
    // Its bot is in the group and can send; the platform simply did not hand it this message.
    const h = await group({ daemonRequires: false, orchestrator: "nero" });
    const message = envelopeAt({ id: "m-missed", timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", text: "/mention required" });
    for (const id of ["nouva", "nox"]) h.connections[id]!.receive({ ...message, gatewayId: `telegram:${id}` });
    await h.pipeline.idle();

    expect(h.speakers()).toEqual(["nero"]);
    expect(h.writes).toEqual(["set telegram:room-1 required"]);
  });

  test("and where the orchestrator's bot is not in the group, the first copy still answers, once", async () => {
    const h = await group({ daemonRequires: false, orchestrator: "nero" });
    // Nero's bot is connected but was never invited: it gets no copy, and cannot send here.
    h.connections.nero!.send = async () => {
      throw new Error("Forbidden: bot is not a member of the group chat");
    };
    const message = envelopeAt({ id: "m-alone", timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", text: "/mention required" });
    for (const id of ["nouva", "nox"]) h.connections[id]!.receive({ ...message, gatewayId: `telegram:${id}` });
    await h.pipeline.idle();

    expect(h.speakers()).toHaveLength(1);
    expect(h.writes).toEqual(["set telegram:room-1 required"]);
  });
});

describe("/mention says, sets and clears", () => {
  test("alone it says both halves and where the setting is from: the daemon, then the group, then the daemon again after `default`", async () => {
    const h = await group({ bots: ["nouva"], daemonRequires: true });
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith(`${NEEDED} (from the daemon's \`[agents] groups_require_mention\`)`);

    await h.say({ text: "/mention nouva" });
    expect(h.said()).toEqual([`Done. ${answers("Nouva")}`]);
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith(`${answers("Nouva")} (set for this group with /mention)`);

    await h.say({ text: "/mention required" });
    expect(h.said()).toEqual([`Done. ${NEEDED}`]);

    await h.say({ text: "/mention default" });
    expect(h.said()).toEqual([`Done. This group follows the daemon again. ${NEEDED}`]);
    await h.say({ text: "/mention default" });
    expect(h.said()).toEqual([`This group had no setting of its own; it follows the daemon. ${NEEDED}`]);
    expect(h.writes).toEqual(["set telegram:room-1 nouva", "set telegram:room-1 required", "clear telegram:room-1", "clear telegram:room-1"]);
  });

  test("the words it teaches are the new ones: no `on`, no `off`", async () => {
    const h = await group({ bots: ["nouva"] });
    await h.say({ text: "/mention" });
    const said = h.said()[0]!;
    expect(said).toContain("`/mention <agent>` that agent answers every message that tags nobody");
    expect(said).toContain("`/mention required` a tag is needed");
    expect(said).toContain("`/mention default` follow the gateway or daemon again");
    expect(said).not.toMatch(/\/mention (on|off)\b/);
    const listed = h.pipeline.commands().find((command) => command.command === "mention" || command.command === "/mention");
    expect(listed?.description).toBe("Who answers without a tag here: `/mention <agent>`, `/mention required`, `/mention default`");
  });

  test("the connection's own setting is named as the gateway's", async () => {
    const h = await group({ bots: ["nouva"], daemonRequires: false, instanceRequires: true });
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith(`${NEEDED} (from the gateway's \`groups_require_mention\`)`);
  });

  test("a name that is no agent's is answered with the agents there are, and nothing changes", async () => {
    const h = await group({ orchestrator: "nouva" });
    await h.say({ text: "/mention maybe" });
    expect(h.said()[0]).toStartWith('No agent here is called "maybe". The agents: Nero (@nero_bot), Nouva (@nouva_bot), Nox (@nox_bot).');
    expect(h.writes).toEqual([]);
  });

  test("someone who is not an admin is told so in one line, and nothing changes; reading it is anyone's", async () => {
    const h = await group({ daemonRequires: true });
    for (const text of ["/mention nox", "/mention required", "/mention default", "/mention off"]) {
      await h.say({ text, senderId: "colleague" });
      expect(h.said(), text).toEqual(["Only an admin can change this for the group."]);
    }
    // A stranger the access gate let in, too: being in the room proves nothing.
    await h.say({ text: "/mention nox", senderId: "stranger" });
    expect(h.said()).toEqual(["Only an admin can change this for the group."]);
    expect(h.writes).toEqual([]);
    await h.say({ text: "/mention", senderId: "colleague" });
    expect(h.said()[0]).toStartWith(NEEDED);
  });

  test("in a DM it is refused in one line and nothing is stored", async () => {
    const h = await group({ bots: ["nouva"] });
    h.connections.nouva!.receive(envelopeAt({ id: "dm-1", timestamp: Date.now(), chatType: "dm", chatId: "dm-1", gatewayId: "telegram:nouva", senderId: "operator", text: "/mention required" }));
    await h.pipeline.idle();
    expect(h.said()).toEqual(["/mention only works in a group. A DM always gets an answer, no tag needed."]);
    expect(h.writes).toEqual([]);
    expect(h.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM room_mention").get()?.n).toBe(0);
  });
});

describe("/mention <agent>: the room given to one agent", () => {
  /** An untagged message, a copy to every bot: who answered it, by the bot that spoke. */
  async function untagged(h: Awaited<ReturnType<typeof group>>, over: Partial<MessageEnvelope> = {}): Promise<string[]> {
    h.said();
    await h.say({ text: "ada yang bisa bantu?", ...over });
    return h.speakers();
  }

  // An untagged message in a room several of our bots share waits a moment for the other copies (`FRONT_DESK_WAIT_MS`,
  // the reply rule below), so each of these tests has room for the ones it sends.
  const ROOM = 30_000;

  test("that agent answers every message that tags nobody, and it alone; before, the orchestrator did", async () => {
    const h = await group({ orchestrator: "nouva", turns: 4 });
    expect(await untagged(h)).toEqual(["nouva"]);
    await h.say({ text: "/mention nox" });
    expect(h.said()).toEqual([`Done. ${answers("Nox")}`]);
    expect(h.writes).toEqual(["set telegram:room-1 nox"]);
    expect(await untagged(h)).toEqual(["nox"]);
    // Again: it is the room's, not the next message's.
    expect(await untagged(h)).toEqual(["nox"]);
  }, ROOM);

  test("named by its bot's tag, its id or its name, in any case: each is the same agent", async () => {
    for (const name of ["@nox_bot", "NOX", "@Nox_Bot", "Nox"]) {
      const h = await group({ orchestrator: "nouva" });
      // A tag as Telegram reports one: resolved on every copy, to the bot it names.
      await h.say({ text: `/mention ${name}`, perBot: (bot) => (name.startsWith("@") ? (bot === "nox" ? { mentionsSelf: true } : { mentions: [name.slice(1)] }) : {}) });
      // The tag is the agent's name here, not whom the command was sent to: the orchestrator answers it, as any
      // command about the group, through its own bot.
      expect(h.connections.nouva!.sent.map((message) => message.text), name).toEqual([`Done. ${answers("Nox")}`]);
      expect(h.said(), name).toHaveLength(1);
      expect(h.writes, name).toEqual(["set telegram:room-1 nox"]);
    }
  }, ROOM);

  test("a tag among the words names the agent, on the copy of the bot it tags too: the orchestrator's bot answers", async () => {
    // Nox's bot reads `@nox_bot` as its own tag, and its copy comes before the orchestrator's. Read as a command
    // addressed to Nox's bot, Nox would answer a command about the group; it is the orchestrator's, as any other.
    const h = await group({ orchestrator: "nero" });
    await h.say({ text: "", perBot: (bot) => asTelegramDelivers("/mention @nox_bot", bot) });

    expect(h.connections.nero!.sent.map((message) => message.text)).toEqual([`Done. ${answers("Nox")}`]);
    expect(h.connections.nox!.sent).toEqual([]);
    expect(h.connections.nouva!.sent).toEqual([]);
    expect(h.writes).toEqual(["set telegram:room-1 nox"]);
  }, ROOM);

  test("where each bot numbers the message its own way, still one answer, from the agent named", async () => {
    const h = await group({ orchestrator: "nouva" });
    await h.say({ text: "/mention nox" });
    let i = 0;
    expect(await untagged(h, { idsPerConnection: true, perBot: () => ({ id: String(500 + i++) }) } as never)).toEqual(["nox"]);
  }, ROOM);

  test("a tag and a reply still win: the room's agent answers only what names nobody", async () => {
    const h = await group({ orchestrator: "nouva", turns: 5 });
    await h.say({ text: "/mention nox" });
    h.said();
    // Tagged as Telegram tags: the tagged bot's copy says it is for it, the others that somebody else was named.
    await h.say({ text: "@nero_bot cek ini", perBot: (bot) => (bot === "nero" ? { mentionsSelf: true, text: "cek ini" } : { mentions: ["nero_bot"] }) });
    expect(h.speakers()).toEqual(["nero"]);
    // By name in the words, where the platform resolved no tag.
    await h.say({ text: "nouva, cek ini" });
    expect(h.speakers()).toEqual(["nouva"]);
    // A reply to another agent's line, which Telegram shows to that agent's bot alone: every other copy, the room's
    // agent's among them, reads a message that names nobody. The agent replied to answers, and the room's stands back.
    await h.say({ text: "terus gimana?", idsPerConnection: true, perBot: (bot) => ({ id: `r-${bot}`, ...(bot === "nero" ? { replyTo: "14", repliesToSelf: true } : {}) }) });
    expect(h.speakers()).toEqual(["nero"]);
  }, ROOM);

  test("it ranks above the connection's owner and the orchestrator, in a group of one bot too", async () => {
    // One bot of ours here: every message is its agent's, until the room names another.
    const h = await group({ bots: ["nouva"], orchestrator: "nouva", turns: 3 });
    expect(await untagged(h)).toEqual(["nouva"]);
    // Nox has no bot in this group; it is an agent of the install all the same, and speaks through the one that is.
    const made = await group({ bots: ["nouva", "nox"], orchestrator: "nouva", turns: 3 });
    await made.say({ text: "/mention nox" });
    expect(await untagged(made)).toEqual(["nox"]);
  }, ROOM);

  test("`required` after it leaves nobody named, and nobody answers; `default` gives the room back to the orchestrator", async () => {
    const h = await group({ orchestrator: "nouva", turns: 4 });
    await h.say({ text: "/mention nox" });
    await h.say({ text: "/mention required" });
    expect(await untagged(h)).toEqual([]);
    expect(h.requests).toHaveLength(0);
    await h.say({ text: "/mention default" });
    expect(h.said()).toEqual([`Done. This group follows the daemon again. ${answers("Nouva")}`]);
    expect(await untagged(h)).toEqual(["nouva"]);
  }, ROOM);

  test("an agent switched off since is not answered for: the orchestrator answers again, and `/mention` says why", async () => {
    const h = await group({ orchestrator: "nouva", turns: 3 });
    await h.say({ text: "/mention nox" });
    expect(await untagged(h)).toEqual(["nox"]);
    h.registry.get("nox")!.config.enabled = false;
    expect(await untagged(h)).toEqual(["nouva"]);
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith("Here no tag is needed; Nouva answers. nox, the agent named for it, is no longer here. (set for this group with /mention)");
  }, ROOM);

  test("its conversation there is one, under its own bot, whichever bot's copy came first: the one a tag reaches too", async () => {
    // Where every bot has the message under one id, the first copy through the claim took it, and the conversation is
    // kept by the connection a message came on: Nero's, under Nouva's bot for one message and Nox's for the next, and
    // never the one a tag to Nero continues. Nero's copy is the last to come here.
    const h = await group({ orchestrator: "nouva", turns: 3 });
    await h.say({ text: "/mention nero" });
    expect(await untagged(h)).toEqual(["nero"]);
    expect(await untagged(h)).toEqual(["nero"]);
    h.said();
    await h.say({ text: "@nero_bot dan ini?", perBot: (bot) => (bot === "nero" ? { mentionsSelf: true } : { mentions: ["nero_bot"] }) });
    expect(h.speakers()).toEqual(["nero"]);

    const conversations = h.db.prepare<{ id: string }>("SELECT id FROM sessions WHERE agent_id = 'nero'").all().map((row) => row.id);
    expect(conversations).toEqual(["ses_nero:telegram:nero:room-1"]);
  }, ROOM);

  test("where its own bot has no copy of the message, another bot's copy still brings it the message", async () => {
    // Nothing says which rooms a bot was invited to: the others wait for its copy only a moment.
    const h = await group({ orchestrator: "nouva", turns: 2 });
    await h.say({ text: "/mention nero" });
    h.said();
    const message = envelopeAt({ id: "m-without", timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", text: "ada yang bisa bantu?" });
    for (const id of ["nouva", "nox"]) h.connections[id]!.receive({ ...message, gatewayId: `telegram:${id}` });
    await h.pipeline.idle();

    expect(h.said()).toEqual(["answer 1"]);
  }, ROOM);

  test("it is the room's own: another room is the orchestrator's as before", async () => {
    const h = await group({ orchestrator: "nouva", turns: 3 });
    await h.say({ text: "/mention nox" });
    expect(await untagged(h, { chatId: "room-2" })).toEqual(["nouva"]);
    expect(await untagged(h)).toEqual(["nox"]);
  }, ROOM);

  test("a Telegram topic is a room: given to one agent, the next topic and the group's own chat stay the orchestrator's", async () => {
    // A topic's number is folded into the chat's id (`foldChatId`), so what is sent in one topic is that topic's.
    const h = await group({ orchestrator: "nouva", turns: 4 });
    const topic = foldChatId(-100123, 45);
    await h.say({ text: "/mention nox", chatId: topic });
    expect(h.writes).toEqual([`set telegram:${topic} nox`]);
    expect(await untagged(h, { chatId: foldChatId(-100123, 46) })).toEqual(["nouva"]);
    expect(await untagged(h, { chatId: foldChatId(-100123, undefined) })).toEqual(["nouva"]);
    expect(await untagged(h, { chatId: topic })).toEqual(["nox"]);
  }, ROOM);

  test("it survives a restart", async () => {
    const h = await group({ bots: ["nouva", "nox"], orchestrator: "nouva" });
    await h.say({ text: "/mention nox" });

    const nouva = new FakeGateway("telegram:nouva", "telegram");
    const nox = new FakeGateway("telegram:nox", "telegram");
    const next = await h.reboot({ gateways: [nouva, nox], turns: [{ text: "after the restart" }] });
    next.pipeline.setTools(new Map());
    next.pipeline.attach();
    const message = envelopeAt({ id: "m-after", timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", text: "ada yang bisa bantu?" });
    for (const id of ["nouva", "nox"]) (id === "nouva" ? nouva : nox).receive({ ...message, gatewayId: `telegram:${id}` });
    await next.pipeline.idle();
    expect(nox.sent.map((m) => m.text)).toEqual(["after the restart"]);
    expect(nouva.sent).toEqual([]);
  });
});

describe("on Discord, where a tag is written `<@id>`", () => {
  const ROOM = 30_000;

  test("`/mention <@id>` names the agent whose bot that is; the orchestrator's bot answers", async () => {
    const h = await group({ platform: "discord", orchestrator: "nouva" });
    await h.say({ text: "", perBot: (bot) => asDiscordDelivers("/mention <@222>", bot) });

    expect(h.connections.nouva!.sent.map((message) => message.text)).toEqual([`Done. ${answers("Nox")}`]);
    expect(h.said()).toHaveLength(1);
    expect(h.writes).toEqual(["set discord:room-1 nox"]);
  }, ROOM);

  test("`@Orchestrator /mention @Nox`, the tag in front as Discord is written: one answer, and Nox does not take it as a message to it", async () => {
    const h = await group({ platform: "discord", orchestrator: "nouva", turns: 2 });
    await h.say({ text: "", perBot: (bot) => asDiscordDelivers("<@111> /mention <@222>", bot) });

    expect(h.connections.nouva!.sent.map((message) => message.text)).toEqual([`Done. ${answers("Nox")}`]);
    expect(h.connections.nox!.sent).toEqual([]);
    expect(h.connections.nero!.sent).toEqual([]);
    expect(h.writes).toEqual(["set discord:room-1 nox"]);
  }, ROOM);

  test("any command written that way is the named bot's: answered once, as a command, though another bot's copy came first", async () => {
    // Nouva's copy comes first and still has Nox's tag in front. It was routed to Nox as a message and took the
    // claim: Nox's model answered `/help` as if it were talk, and Nox's own copy, the command, was dropped.
    const h = await group({ platform: "discord", orchestrator: "nouva" });
    await h.say({ text: "", perBot: (bot) => asDiscordDelivers("<@222> /help", bot) });

    const said = h.connections.nox!.sent.map((message) => message.text);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("/mention");
    expect(said[0]).not.toContain("answer 1");
    expect(h.connections.nouva!.sent).toEqual([]);
    expect(h.connections.nero!.sent).toEqual([]);
  }, ROOM);

  test("`@Nox /mention`: Nox's bot answers, and says how the room is given to it in words a person can type", async () => {
    const h = await group({ platform: "discord", orchestrator: "nouva" });
    await h.say({ text: "", perBot: (bot) => asDiscordDelivers("<@222> /mention", bot) });

    const said = h.connections.nox!.sent.map((message) => message.text);
    expect(said).toHaveLength(1);
    expect(h.connections.nouva!.sent).toEqual([]);
    expect(said[0]).toContain("\nTo have Nox answer everything here: `/mention nox`.\n");
    expect(said[0]).not.toContain("<@");
  }, ROOM);
});

describe("the Groups page's door", () => {
  test("is the chat's own setting: what either sets, the other says", async () => {
    const h = await group({ orchestrator: "nouva" });
    expect(h.pipeline.roomMention("telegram", "room-1")).toBeNull();

    // Set from the page, said in the chat.
    expect(h.pipeline.setRoomMention("telegram", "room-1", { requireMention: false, answerer: "nox" }, "web:gading")).toBe(true);
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith(`${answers("Nox")} (set for this group with /mention)`);

    // Set in the chat, read by the page.
    await h.say({ text: "/mention required" });
    expect(h.pipeline.roomMention("telegram", "room-1")).toMatchObject({ requireMention: true, setBy: "telegram:nouva:operator" });
    expect(h.pipeline.roomMention("telegram", "room-1")).not.toHaveProperty("answerer");

    // The room's own taken away from the page: the chat says the daemon decides again.
    h.said();
    expect(h.pipeline.setRoomMention("telegram", "room-1", null, "web:gading")).toBe(true);
    expect(h.pipeline.roomMention("telegram", "room-1")).toBeNull();
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith(`${answers("Nouva")} (from the daemon's`);
  });
});

describe("/mention@Bot: the command addressed to one bot", () => {
  test("is answered by that bot and only there, as its own agent, and says how the room is given to it", async () => {
    // What Telegram's command menu writes in a group. It was answered by the orchestrator, through the orchestrator's
    // bot, and read as the wrong agent taking over.
    const h = await group({ orchestrator: "nouva" });
    await h.say({ text: "", perBot: (bot) => asTelegramDelivers("/mention@nox_bot", bot) });

    expect(h.connections.nox!.sent.map((message) => message.text)).toHaveLength(1);
    expect(h.connections.nouva!.sent).toEqual([]);
    expect(h.connections.nero!.sent).toEqual([]);
    const said = h.connections.nox!.sent[0]!.text;
    expect(said).toStartWith(`${answers("Nouva")} (from the daemon's \`[agents] groups_require_mention\`)`);
    expect(said).toContain("\nTo have Nox answer everything here: `/mention @nox_bot`.\n");
    expect(h.writes).toEqual([]);
  });

  test("and does not say so of the agent that already answers here", async () => {
    const h = await group({ orchestrator: "nouva" });
    await h.say({ text: "/mention nox" });
    h.said();
    await h.say({ text: "", perBot: (bot) => asTelegramDelivers("/mention@nox_bot", bot) });
    const said = h.said();
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith(answers("Nox"));
    expect(said[0]).not.toContain("To have Nox answer");
  });
});

describe("the old words, still read and never taught", () => {
  test("`on` is `required` and `off` is no tag needed with nobody named, each answered in the new words", async () => {
    const h = await group({ orchestrator: "nouva", daemonRequires: true, turns: 2 });
    await h.say({ text: "/mention off" });
    expect(h.said()).toEqual([`Done. ${answers("Nouva")}`]);
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.speakers()).toEqual(["nouva"]);
    await h.say({ text: "/mention on" });
    expect(h.said()).toEqual([`Done. ${NEEDED}`]);
    expect(h.writes).toEqual(["set telegram:room-1 nobody named", "set telegram:room-1 required"]);
  });

  test("`off` after an agent was named takes the name away: it is the orchestrator's again", async () => {
    const h = await group({ orchestrator: "nouva", turns: 2 });
    await h.say({ text: "/mention nox" });
    await h.say({ text: "/mention off" });
    h.said();
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.speakers()).toEqual(["nouva"]);
  });

  test("with no orchestrator and several bots, `off` says that nobody answers and how to name one", async () => {
    const h = await group({ daemonRequires: true });
    await h.say({ text: "/mention off" });
    expect(h.said()).toEqual([`Done. ${NOBODY}`]);
  });
});

describe("what the setting does", () => {
  test("an agent named lets an untagged message be answered where the daemon requires a tag; `required` stops it again", async () => {
    const h = await group({ bots: ["nouva"], daemonRequires: true });
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.requests).toHaveLength(0);

    await h.say({ text: "/mention nouva" });
    h.said();
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.requests).toHaveLength(1);
    expect(h.said()).toEqual(["answer 1"]);

    await h.say({ text: "/mention required" });
    h.said();
    await h.say({ text: "masih ada?" });
    expect(h.requests).toHaveLength(1);
  });

  test("`required` beats a connection that does not require one", async () => {
    const h = await group({ bots: ["nouva"], instanceRequires: false });
    await h.say({ text: "/mention required" });
    h.said();
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.requests).toHaveLength(0);
  });
});
