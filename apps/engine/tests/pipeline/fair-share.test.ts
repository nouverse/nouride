/**
 * A room's share of the queue (P12): as many turns at once as it has agents, never more than half the ceiling.
 *
 * The decision is `conversationSlots`; the test that matters is the wiring, against a provider that can be held open —
 * with an instant one every turn is over before the next message arrives, and a room holding every slot looks exactly
 * like one holding its share.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "@/modules/config/global/index.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { conversationSlots, roomSlots } from "@/modules/pipeline/fair-share.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

describe("the decision", () => {
  test("a room holds its agents' turns and one message on its way to a busy one, never more than half the ceiling", () => {
    expect(roomSlots(1, 8)).toBe(2);
    expect(roomSlots(2, 8)).toBe(3);
    expect(roomSlots(6, 8)).toBe(4);
    expect(roomSlots(2, 5)).toBe(3);
    expect(roomSlots(5, 5)).toBe(3);
    // A ceiling of one or two still leaves a room one slot — it is never shut out.
    expect(roomSlots(4, 1)).toBe(1);
    expect(roomSlots(4, 2)).toBe(1);
    // No ceiling: only the agents bound it.
    expect(roomSlots(7, 0)).toBe(8);
  });

  test("a one-to-one chat keeps its own cap; a room with no list counts every enabled agent", () => {
    const config = parseConfig({ queue: { max_concurrent_turns: 8 } });
    const enabled = (n: number) => ({ enabled: () => Array.from({ length: n }) }) as never;
    const noList = { membersOf: () => [] } as never;
    const listed = { membersOf: () => ["nouva", "nero"] } as never;

    expect(conversationSlots({ chatType: "dm", gatewayId: "t", chatId: "1" }, { config, rooms: listed, registry: enabled(9) })).toBe(1);
    expect(conversationSlots({ chatType: "group", gatewayId: "t", chatId: "1" }, { config, rooms: listed, registry: enabled(9) })).toBe(3);
    expect(conversationSlots({ chatType: "group", gatewayId: "t", chatId: "1" }, { config, rooms: noList, registry: enabled(9) })).toBe(4);
    expect(conversationSlots({ chatType: "channel", gatewayId: "t", chatId: "1" }, { config, registry: enabled(1) })).toBe(2);
  });
});

describe("through the pipeline", () => {
  const benches: Bench[] = [];
  afterEach(() => {
    for (const bench of benches.splice(0)) bench.dispose();
  });

  /** Three agents on the dashboard's connection, a ceiling of two, and a provider each agent's turn can be held in. */
  async function daemon(held: Set<string>) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const started: string[] = [];
    const local = new LocalGateway();
    let rooms!: RoomStore;
    const bench = await pipelineBench({
      turns: [{ text: "ok" }],
      // Which agent a request is for is only on the wire in its system prompt.
      fetch: (scripted) =>
        (async (url: string | URL | Request, init?: RequestInit) => {
          const agentId = /- Name: ([a-z0-9_-]+)/.exec(String(init?.body ?? ""))?.[1] ?? "";
          started.push(agentId);
          if (held.has(agentId)) await gate;
          return scripted(url, init);
        }) as typeof fetch,
      agents: ["nouva", "nero", "nox"],
      config: {
        agents: { mentions_enabled: true, mention_max_hops: 5, groups_require_mention: false },
        daemon: { orchestrator: "nouva" },
        queue: { max_concurrent_turns: 2 },
      },
      gateways: [local],
      deps: ({ db }) => ({ rooms: (rooms = new RoomStore(db)) }),
    });
    benches.push(bench);
    const { pipeline } = bench;
    pipeline.setTools(new Map());
    pipeline.attach();
    return { pipeline, local, rooms, started, release };
  }

  test("a busy room leaves a slot for somebody else's chat", async () => {
    // Before: a room's cap was the ceiling, so its two turns took both slots and the one-to-one chat waited behind it.
    const h = await daemon(new Set(["nero", "nox"]));
    h.rooms.create({ gatewayId: h.local.id, chatId: "r1", agentIds: ["nero", "nox"] });

    h.local.dispatch({ text: "first", chatId: "r1", chatType: "group", agent: "nero" });
    await eventually(() => h.started.includes("nero"), 2_000);
    h.local.dispatch({ text: "second", chatId: "r1", chatType: "group", agent: "nox" });
    h.local.dispatch({ text: "halo", chatId: "dm1", chatType: "dm" });
    await eventually(() => h.started.includes("nouva"), 2_000);

    expect(h.started).toContain("nouva");
    // Half the ceiling is one: the room's second turn waits for its first.
    expect(h.started).not.toContain("nox");

    h.release();
    await h.pipeline.idle();
    expect(h.started).toContain("nox");
  });
});
