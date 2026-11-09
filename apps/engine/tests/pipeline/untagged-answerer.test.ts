/**
 * Who answers a dashboard room's message that tags nobody (`InboundRouter.untaggedAnswerer`): what the chat page says
 * under a room's members. Each case asks the router, then sends such a message through the real pipeline and checks
 * that the agent named is the one that answered, or that nobody did — so the page's sentence is the room's behaviour,
 * not a description of it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const LOCAL = "web:dashboard";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.reverse()) dispose();
  cleanup = [];
});

async function daemon(options: { orchestrator?: string; groupsRequireMention?: boolean } = {}) {
  const local = new LocalGateway();
  let rooms!: RoomStore;
  const bench = await pipelineBench({
    turns: [{ text: "an answer" }, { text: "another answer" }],
    agents: ["nouva", "nero", "nox"],
    config: {
      agents: { mentions_enabled: true, mention_max_hops: 5, groups_require_mention: options.groupsRequireMention ?? false },
      daemon: options.orchestrator ? { orchestrator: options.orchestrator } : {},
    },
    gateways: [local],
    deps: ({ db }) => ({ rooms: (rooms = new RoomStore(db)), roomMessages: new RoomMessageStore(db) }),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  return {
    room(chatId: string, agentIds: string[]) {
      rooms.create({ gatewayId: LOCAL, chatId, agentIds });
    },
    said: (chatId: string) => bench.pipeline.untaggedAnswerer({ gateway: "web", gatewayId: LOCAL, chatId }),
    /** Who actually answered an untagged message there. */
    async answered(chatId: string) {
      local.dispatch({ text: "hello everyone", chatId, chatType: "group" });
      await bench.pipeline.idle();
      return bench.turns.forChat(LOCAL, chatId).map((turn) => turn.agentId);
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

  test("a room that requires a tag: nobody, even with the orchestrator in it", async () => {
    const h = await daemon({ orchestrator: "nouva", groupsRequireMention: true });
    h.room("strict", ["nouva", "nero"]);
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
