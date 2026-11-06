/**
 * A group's own `groups_require_mention`, set from the group with `/mention`.
 *
 * The store keys it by the room as the platform sees it, so every one of our bots in a group reads one value; the
 * precedence is the group's own, then the connection's, then the daemon's, and a group with nothing of its own is
 * decided as before. The command is driven through the real pipeline with a copy per bot, because "one change, one
 * answer" is a property of every copy together and not of one hook call.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDatabase, removePath, type SqliteDb } from "@nouride/runtime";
import type { MessageEnvelope } from "@nouride/shared";
import { migrate } from "@/db/index.ts";
import { parseCommand } from "@/modules/hooks/parse.ts";
import { requireMentionHere } from "@/modules/pipeline/room-mention.ts";
import { RoomMentionStore, type RoomMentionPort } from "@/modules/pipeline/room-mention.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { telegramMentions } from "../../../../packages/gateways/src/channels/telegram/envelope.ts";
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
    s.set("telegram", "-100", false, "telegram:main:operator");
    expect(s.get("telegram", "-100")).toEqual({ requireMention: false, setBy: "telegram:main:operator", setAt: 1_000 });
    s.set("telegram", "-100", true, "telegram:main:rani");
    expect(s.get("telegram", "-100")).toEqual({ requireMention: true, setBy: "telegram:main:rani", setAt: 1_000 });
    expect(s.clear("telegram", "-100")).toBe(true);
    expect(s.get("telegram", "-100")).toBeUndefined();
    expect(s.clear("telegram", "-100")).toBe(false);
  });

  test("keyed by platform and chat — the same chat id on another platform is another room", () => {
    const { store: s, db } = store();
    s.set("telegram", "42", false, "a");
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

/** A `/command@bot` message as the bot `self`'s own adapter hands it over (`telegramMentions`). */
function asTelegramDelivers(text: string, self: string): Pick<MessageEnvelope, "text" | "mentions" | "mentionsSelf"> {
  const end = text.indexOf(" ");
  const entities = [{ type: "bot_command" as const, offset: 0, length: end > 0 ? end : text.length }];
  const read = telegramMentions({ text, entities }, { id: 1, username: `${self}_bot` });
  return { text: read.text, mentions: read.mentions, ...(read.mentionsSelf ? { mentionsSelf: true } : {}) };
}

/**
 * Agents with a Telegram bot each, all in one group, and people: `operator` an admin, `colleague` paired but not one.
 * `writes` counts what reached the store, so "one change" is asserted on the store and not on the replies.
 */
async function group(options: { bots?: string[]; daemonRequires?: boolean; instanceRequires?: boolean; turns?: number; orchestrator?: string } = {}) {
  const bots = options.bots ?? ["nouva", "nox", "nero"];
  const connections = Object.fromEntries(bots.map((id) => [id, new FakeGateway(`telegram:${id}`, "telegram")]));
  let users: UserStore | undefined;
  const writes: string[] = [];
  const bench = await pipelineBench({
    turns: Array.from({ length: options.turns ?? 3 }, (_, i) => ({ text: `answer ${i + 1}` })),
    agents: bots,
    config: {
      agents: { mentions_enabled: true, groups_require_mention: options.daemonRequires ?? false },
      ...(options.orchestrator ? { daemon: { orchestrator: options.orchestrator } } : {}),
      gateways: {
        telegram: Object.fromEntries(
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
        { key: "gading", ids: ["telegram:operator", await account("gading", "admin")], name: "Gading" },
        { key: "budi", ids: ["telegram:colleague", await account("budi", "operator")], name: "Budi" },
      ];
    },
    deps: (made) => {
      const real = new RoomMentionStore(made.db);
      const counted: RoomMentionPort = {
        get: (platform, chatId) => real.get(platform, chatId),
        set: (platform, chatId, requireMention, setBy) => {
          writes.push(`set ${platform}:${chatId} ${requireMention}`);
          real.set(platform, chatId, requireMention, setBy);
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
  return harness(bench, bots, connections, writes);
}

function harness(bench: Bench, bots: string[], connections: Record<string, FakeGateway>, writes: string[]) {
  let n = 0;
  return {
    ...bench,
    writes,
    /** One message as Telegram delivers it to a group: a copy to every bot, the same id and time on each. */
    async say(over: Partial<MessageEnvelope> & { perBot?: (bot: string) => Partial<MessageEnvelope> }) {
      const { perBot, ...rest } = over;
      const message = envelopeAt({ id: `m-${++n}`, timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", ...rest });
      for (const id of bots) connections[id]!.receive({ ...message, gatewayId: `telegram:${id}`, ...perBot?.(id) });
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

describe("/mention in a group several of our bots share", () => {
  test("an untagged `/mention off` changes the setting once and is answered once", async () => {
    const h = await group({ daemonRequires: true });
    await h.say({ text: "/mention off" });

    expect(h.said()).toEqual(["Done. In this group no mention is needed."]);
    expect(h.writes).toEqual(["set telegram:room-1 false"]);
  });

  test("where each bot numbers the message its own way, still once", async () => {
    // A Telegram basic group: every copy has its own id, so the copies share only who sent it and when.
    const h = await group({ daemonRequires: true });
    let i = 0;
    await h.say({ text: "/mention off", idsPerConnection: true, perBot: () => ({ id: String(100 + i++) }) });

    expect(h.said()).toHaveLength(1);
    expect(h.writes).toEqual(["set telegram:room-1 false"]);
  });

  test("`/mention@nox_bot off` is answered by Nox's bot, once", async () => {
    const h = await group({ daemonRequires: true });
    await h.say({ text: "", perBot: (bot) => asTelegramDelivers("/mention@nox_bot off", bot) });

    expect(h.speakers()).toEqual(["nox"]);
    expect(h.writes).toEqual(["set telegram:room-1 false"]);
    expect(parseCommand("/mention@nox_bot off")).toEqual({ command: "/mention", args: ["off"] });
  });

  test("answered by the orchestrator's bot, though another bot's copy came first", async () => {
    // Live, `/mention` was answered by Nouva's bot and `/mention off` by Nestor's: whichever copy came first.
    const h = await group({ daemonRequires: true, orchestrator: "nero" });
    await h.say({ text: "/mention off" });

    expect(h.speakers()).toEqual(["nero"]);
    expect(h.writes).toEqual(["set telegram:room-1 false"]);
  });

  test("where each bot numbers the message its own way, it quotes the copy its own bot saw", async () => {
    // A Telegram basic group: Nouva's bot calls the message 100 and Nero's 102. Answering on Nouva's copy through
    // Nero's bot would quote a message Nero's bot has never seen — so Nero's own copy is the one that answers.
    const h = await group({ daemonRequires: true, orchestrator: "nero" });
    const ids: Record<string, string> = { nouva: "100", nox: "101", nero: "102" };
    await h.say({ text: "/mention off", idsPerConnection: true, perBot: (bot) => ({ id: ids[bot]! }) });

    expect(h.connections.nero!.sent.map((message) => message.replyTo)).toEqual(["102"]);
    expect(h.writes).toEqual(["set telegram:room-1 false"]);
  });

  test("when the orchestrator's copy never comes, another bot's copy is answered in the orchestrator's voice", async () => {
    // Its bot is in the group and can send; the platform simply did not hand it this message.
    const h = await group({ daemonRequires: true, orchestrator: "nero" });
    const message = envelopeAt({ id: "m-missed", timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", text: "/mention off" });
    for (const id of ["nouva", "nox"]) h.connections[id]!.receive({ ...message, gatewayId: `telegram:${id}` });
    await h.pipeline.idle();

    expect(h.speakers()).toEqual(["nero"]);
    expect(h.writes).toEqual(["set telegram:room-1 false"]);
  });

  test("and where the orchestrator's bot is not in the group, the first copy still answers, once", async () => {
    const h = await group({ daemonRequires: true, orchestrator: "nero" });
    // Nero's bot is connected but was never invited: it gets no copy, and cannot send here.
    h.connections.nero!.send = async () => {
      throw new Error("Forbidden: bot is not a member of the group chat");
    };
    const message = envelopeAt({ id: "m-alone", timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", text: "/mention off" });
    for (const id of ["nouva", "nox"]) h.connections[id]!.receive({ ...message, gatewayId: `telegram:${id}` });
    await h.pipeline.idle();

    expect(h.speakers()).toHaveLength(1);
    expect(h.writes).toEqual(["set telegram:room-1 false"]);
  });
});

describe("/mention says, sets and clears", () => {
  test("query names the source: the daemon, then the group, then the gateway after `default`", async () => {
    const h = await group({ bots: ["nouva"], daemonRequires: true });
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith("In this group a mention is required. (from the daemon's `[agents] groups_require_mention`)");

    await h.say({ text: "/mention off" });
    expect(h.said()).toEqual(["Done. In this group no mention is needed."]);
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith("In this group no mention is needed. (set for this group with /mention)");

    await h.say({ text: "/mention on" });
    expect(h.said()).toEqual(["Done. In this group a mention is required."]);

    await h.say({ text: "/mention default" });
    expect(h.said()).toEqual(["Done. This group follows the daemon again. In this group a mention is required."]);
    await h.say({ text: "/mention default" });
    expect(h.said()).toEqual(["This group had no setting of its own; it follows the daemon. In this group a mention is required."]);
    expect(h.writes).toEqual(["set telegram:room-1 false", "set telegram:room-1 true", "clear telegram:room-1", "clear telegram:room-1"]);
  });

  test("the connection's own setting is named as the gateway's", async () => {
    const h = await group({ bots: ["nouva"], daemonRequires: false, instanceRequires: true });
    await h.say({ text: "/mention" });
    expect(h.said()[0]).toStartWith("In this group a mention is required. (from the gateway's `groups_require_mention`)");
  });

  test("a word it does not know gets the usage, and nothing changes", async () => {
    const h = await group({ bots: ["nouva"] });
    await h.say({ text: "/mention maybe" });
    expect(h.said()[0]).toStartWith("`/mention` shows this group's setting");
    expect(h.writes).toEqual([]);
  });

  test("someone who is not an admin is told so in one line, and nothing changes", async () => {
    const h = await group({ daemonRequires: true });
    await h.say({ text: "/mention off", senderId: "colleague" });
    expect(h.said()).toEqual(["Only an admin can change this for the group."]);
    // A stranger the access gate let in, too: being in the room proves nothing.
    await h.say({ text: "/mention off", senderId: "stranger" });
    expect(h.said()).toEqual(["Only an admin can change this for the group."]);
    expect(h.writes).toEqual([]);
  });

  test("in a DM it is refused in one line and nothing is stored", async () => {
    const h = await group({ bots: ["nouva"] });
    h.connections.nouva!.receive(envelopeAt({ id: "dm-1", timestamp: Date.now(), chatType: "dm", chatId: "dm-1", gatewayId: "telegram:nouva", senderId: "operator", text: "/mention off" }));
    await h.pipeline.idle();
    expect(h.said()).toEqual(["/mention only works in a group. A DM always gets an answer, no mention needed."]);
    expect(h.writes).toEqual([]);
    expect(h.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM room_mention").get()?.n).toBe(0);
  });
});

describe("what the setting does", () => {
  test("off lets an untagged message be answered where the daemon requires a tag; on stops it again", async () => {
    const h = await group({ bots: ["nouva"], daemonRequires: true });
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.requests).toHaveLength(0);

    await h.say({ text: "/mention off" });
    h.said();
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.requests).toHaveLength(1);
    expect(h.said()).toEqual(["answer 1"]);

    await h.say({ text: "/mention on" });
    h.said();
    await h.say({ text: "masih ada?" });
    expect(h.requests).toHaveLength(1);
  });

  test("on beats a connection that does not require one", async () => {
    const h = await group({ bots: ["nouva"], instanceRequires: false });
    await h.say({ text: "/mention on" });
    h.said();
    await h.say({ text: "ada yang bisa bantu?" });
    expect(h.requests).toHaveLength(0);
  });

  test("it survives a restart", async () => {
    const h = await group({ bots: ["nouva"], daemonRequires: true });
    await h.say({ text: "/mention off" });

    const nouva = new FakeGateway("telegram:nouva", "telegram");
    const next = await h.reboot({ gateways: [nouva], turns: [{ text: "after the restart" }] });
    next.pipeline.setTools(new Map());
    next.pipeline.attach();
    nouva.receive(envelopeAt({ id: "m-after", timestamp: Date.now(), chatType: "group", chatId: "room-1", gatewayId: "telegram:nouva", senderId: "operator", text: "ada yang bisa bantu?" }));
    await next.pipeline.idle();
    expect(nouva.sent.map((m) => m.text)).toEqual(["after the restart"]);
  });
});
