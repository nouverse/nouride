/**
 * Who answers a dashboard room's message that tags nobody (`InboundRouter.untaggedAnswerer`): what the chat page says
 * under a room's members. Each case asks the router, then sends such a message through the real pipeline and checks
 * that the agent named is the one that answered, or that nobody did — so the page's sentence is the room's behaviour,
 * not a description of it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { RoomMentionStore } from "@/modules/pipeline/room-mention.store.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const LOCAL = "web:dashboard";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.reverse()) dispose();
  cleanup = [];
});

async function daemon(options: { orchestrator?: string; groupsRequireMention?: boolean } = {}) {
  const local = new LocalGateway();
  // A Telegram group the same agents' bots share, beside the dashboard's rooms: the daemon's setting is about these.
  const ids = ["nouva", "nero", "nox"];
  const bots = ids.map((id) => new FakeGateway(`telegram:${id}`, "telegram"));
  let rooms!: RoomStore;
  let mention!: RoomMentionStore;
  const bench = await pipelineBench({
    turns: [{ text: "an answer" }, { text: "another answer" }],
    agents: ids,
    config: {
      agents: { mentions_enabled: true, mention_max_hops: 5, groups_require_mention: options.groupsRequireMention ?? false },
      daemon: options.orchestrator ? { orchestrator: options.orchestrator } : {},
      gateways: { telegram: Object.fromEntries(ids.map((id) => [id, { enabled: true, token: `t-${id}`, agent: id }])) },
    },
    gateways: [local, ...bots],
    deps: ({ db }) => ({
      rooms: (rooms = new RoomStore(db)),
      roomMessages: new RoomMessageStore(db),
      roomMention: (mention = new RoomMentionStore(db)),
    }),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  let n = 0;
  return {
    room(chatId: string, agentIds: string[]) {
      rooms.create({ gatewayId: LOCAL, chatId, agentIds });
    },
    /** The room's own `/mention on`, as the command stores it: keyed by the platform, `web`. */
    requireTag(chatId: string) {
      mention.set("web", chatId, true, "web:admin");
    },
    said: (chatId: string) => bench.pipeline.untaggedAnswerer({ gateway: "web", gatewayId: LOCAL, chatId }),
    /** Who actually answered an untagged message there. */
    async answered(chatId: string) {
      local.dispatch({ text: "hello everyone", chatId, chatType: "group" });
      await bench.pipeline.idle();
      return bench.turns.forChat(LOCAL, chatId).map((turn) => turn.agentId);
    },
    /** What `/mention` answers in a room, asked as the dashboard sends it. */
    async mentionSays(chatId: string) {
      return (await local.ask({ text: "/mention", chatId, chatType: "group" }, () => bench.pipeline.idle())).replies;
    },
    /** An untagged message in a Telegram group all three bots are in, a copy to each as Telegram hands it over. */
    async answeredOnTelegram() {
      const message = envelope({ id: `tg-${++n}`, timestamp: Date.now(), chatType: "group", chatId: "-100", senderId: "user-1", text: "hello everyone" });
      for (const bot of bots) bot.receive({ ...message, gatewayId: bot.id });
      await bench.pipeline.idle();
      return {
        said: bench.pipeline.untaggedAnswerer({ gateway: "telegram", gatewayId: "telegram:nouva", chatId: "-100" }),
        turns: bots.flatMap((bot) => bench.turns.forChat(bot.id, "-100").map((turn) => turn.agentId)),
        requests: bench.requests.length,
      };
    },
  };
}

describe("who answers an untagged message in a room", () => {
  test("a room of several with the orchestrator in it: the orchestrator, and it is the one that answers", async () => {
    const h = await daemon({ orchestrator: "nouva" });
    h.room("trio", ["nouva", "nero", "nox"]);
    expect(h.said("trio")).toBe("nouva");
    expect(await h.answered("trio")).toEqual(["nouva"]);
  });

  test("a room of several the orchestrator is not in: nobody, and nobody answers", async () => {
    const h = await daemon({ orchestrator: "nouva" });
    h.room("pair", ["nero", "nox"]);
    expect(h.said("pair")).toBeNull();
    expect(await h.answered("pair")).toEqual([]);
  });

  test("a room whose own `/mention` requires a tag: nobody, even with the orchestrator in it", async () => {
    const h = await daemon({ orchestrator: "nouva" });
    h.room("strict", ["nouva", "nero"]);
    h.requireTag("strict");
    expect(h.said("strict")).toBeNull();
    expect(await h.answered("strict")).toEqual([]);
  });

  test("a room of one the orchestrator is not in: its member answers, never the orchestrator", async () => {
    const h = await daemon({ orchestrator: "nouva" });
    h.room("solo", ["nero"]);
    expect(h.said("solo")).toBe("nero");
    expect(await h.answered("solo")).toEqual(["nero"]);
  });

  test("a room of one that is the orchestrator: the orchestrator", async () => {
    const h = await daemon({ orchestrator: "nouva" });
    h.room("desk", ["nouva"]);
    expect(h.said("desk")).toBe("nouva");
    expect(await h.answered("desk")).toEqual(["nouva"]);
  });

  test("a room of one with no orchestrator named: its member", async () => {
    const h = await daemon();
    h.room("alone", ["nox"]);
    expect(h.said("alone")).toBe("nox");
    expect(await h.answered("alone")).toEqual(["nox"]);
  });

  test("no orchestrator named and several agents: nobody", async () => {
    const h = await daemon();
    h.room("open", ["nouva", "nero"]);
    expect(h.said("open")).toBeNull();
    expect(await h.answered("open")).toEqual([]);
  });
});

/**
 * `[agents] groups_require_mention = true`, as a new install writes it: about groups on the chat apps. A room made in
 * the dashboard answers as its members say — on the owner's box every one of theirs had fallen silent under it.
 */
describe("where the daemon requires a tag in groups", () => {
  test("a dashboard room with the orchestrator among three: the orchestrator answers, and the page says so", async () => {
    const h = await daemon({ orchestrator: "nouva", groupsRequireMention: true });
    h.room("trio", ["nouva", "nero", "nox"]);
    expect(h.said("trio")).toBe("nouva");
    expect(await h.answered("trio")).toEqual(["nouva"]);
  });

  test("a dashboard room of one: its member", async () => {
    const h = await daemon({ orchestrator: "nouva", groupsRequireMention: true });
    h.room("solo", ["nero"]);
    expect(h.said("solo")).toBe("nero");
    expect(await h.answered("solo")).toEqual(["nero"]);
  });

  test("a dashboard room of two without the orchestrator: nobody", async () => {
    const h = await daemon({ orchestrator: "nouva", groupsRequireMention: true });
    h.room("pair", ["nero", "nox"]);
    expect(h.said("pair")).toBeNull();
    expect(await h.answered("pair")).toEqual([]);
  });

  test("`/mention` in a dashboard room says the room's own rule decides, not the daemon's setting", async () => {
    const h = await daemon({ orchestrator: "nouva", groupsRequireMention: true });
    h.room("trio", ["nouva", "nero", "nox"]);
    const [said] = await h.mentionSays("trio");
    expect(said).toStartWith(
      "In this group no mention is needed. (a room made in the dashboard: the orchestrator answers when it is in the room, or the room's only agent)",
    );
  });

  test("a dashboard room whose own `/mention` requires a tag: silent", async () => {
    const h = await daemon({ orchestrator: "nouva", groupsRequireMention: true });
    h.room("strict", ["nouva", "nero", "nox"]);
    h.requireTag("strict");
    expect(h.said("strict")).toBeNull();
    expect(await h.answered("strict")).toEqual([]);
  });

  test("a Telegram group: still silent, and no model is asked", async () => {
    const h = await daemon({ orchestrator: "nouva", groupsRequireMention: true });
    // A dashboard room exists, so the lookup runs, and finds no room for the group.
    h.room("trio", ["nouva", "nero", "nox"]);
    expect(await h.answeredOnTelegram()).toEqual({ said: null, turns: [], requests: 0 });
  });

  test("without the setting, the same Telegram group is answered once, by the orchestrator", async () => {
    // The contrast: the silence above is the setting's, not the harness's.
    const h = await daemon({ orchestrator: "nouva" });
    expect(await h.answeredOnTelegram()).toEqual({ said: "nouva", turns: ["nouva"], requests: 1 });
  });
});
