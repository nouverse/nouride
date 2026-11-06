/**
 * Several agents in one dashboard conversation, driven through the real local gateway.
 *
 * `agent-chain.test.ts` proves the same feature over a platform gateway, where every agent has its
 * own bot and the platform hands each of them a copy of every message. The local gateway is the
 * *other* arrangement and the one the dashboard uses: **one connection, every agent behind it**, no
 * message ids, and no platform to echo anything back.
 *
 * Nothing in this repo covered it, and four things were broken — each of them invisible, because none
 * produced an error:
 *
 *   - a second handover in one room was dropped as a duplicate, because every synthetic envelope
 *     borrowed a message id from a `send` that returns none, so they all had the same one
 *   - an agent's reply never entered the room's history, because that history is built from inbound
 *     messages and nothing here delivers one — so a second agent was handed a room it had missed
 *   - the notice that says a chain hit its hop budget was spoken into a transport with nobody
 *     listening and written down nowhere, so the room went quiet exactly as the notice exists to
 *     prevent
 *   - an untagged message fell through to `default_agent`, because the guard against that counts
 *     connections and a shared connection counts one
 */

import { afterEach, describe, expect, test } from "bun:test";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { ChatEventStore } from "@/modules/chat-events/chat-events.store.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { sleep } from "../wait.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

async function room(options: {
  turns: { text?: string }[];
  maxHops?: number;
  /** Left unset to test the shipped default. */
  requireMention?: boolean;
  orchestrator?: string;
}) {
  const local = new LocalGateway();
  let chatEvents!: ChatEventStore;
  bench = await pipelineBench({
    turns: options.turns,
    agents: ["nouva", "nox", "nero"],
    config: {
      ...(options.orchestrator ? { daemon: { orchestrator: options.orchestrator } } : {}),
      agents: {
        mentions_enabled: true,
        mention_max_hops: options.maxHops ?? 4,
        groups_require_mention: options.requireMention ?? true,
      },
    },
    gateways: [local],
    deps: ({ db }) => ({ chatEvents: (chatEvents = new ChatEventStore(db)) }),
  });
  const { pipeline, turns, requests } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();

  return {
    local,
    pipeline,
    turns,
    chatEvents,
    requests,
    /** What the dashboard does: dispatch into a room and let the turn record itself. */
    async say(text: string) {
      local.dispatch({ text, chatId: "room-1", chatType: "group" });
      await pipeline.idle();
    },
    /** Who actually ran, in order, read back the way a room transcript is read. */
    whoRan(): string[] {
      return turns.forChat("web:dashboard", "room-1").map((turn) => turn.agentId);
    },
  };
}

describe("a dashboard room", () => {
  test("a tag routes to the agent named in the text", async () => {
    const h = await room({ turns: [{ text: "on it" }] });
    await h.say("@nox tolong cek build");
    expect(h.requests).toHaveLength(1);
  });

  test("an untagged message wakes nobody", async () => {
    const h = await room({ turns: [{ text: "should not run" }] });
    await h.say("halo semua");
    expect(h.requests).toHaveLength(0);
  });

  test("an agent can hand work to another in the same room", async () => {
    const h = await room({
      turns: [{ text: "@nero tolong lanjut" }, { text: "siap, sudah saya kerjakan" }],
    });
    await h.say("@nox mulai");
    expect(h.requests).toHaveLength(2);
  });

  test("the same agent can be handed work twice in one room", async () => {
    // The claim table keys on `${gateway}:${chatId}:${envelope.id}:${agentId}` with a 60s TTL, and
    // the local gateway has no message ids — so two handovers to one agent inside a minute collide
    // on an identical key and the second is dropped in silence. The ping-pong the feature exists
    // for hits this on the third leg.
    const h = await room({
      turns: [
        { text: "@nero cek dulu" },
        { text: "sudah, @nox lanjut" },
        { text: "@nero sekali lagi" },
        { text: "beres" },
      ],
    });
    await h.say("@nox mulai");
    expect(h.requests).toHaveLength(4);
  });
});

describe("what the room remembers", () => {
  test("an agent tagged later sees what the others said", async () => {
    const h = await room({
      turns: [{ text: "build-nya hijau" }, { text: "oke saya lanjut" }],
    });
    await h.say("@nox status build?");
    /**
     * Past one tick of the clock, deliberately.
     *
     * `GroupContext.since` replays what is strictly older than the triggering message, and these two
     * sends are otherwise the same millisecond apart — a test artifact rather than a real ordering,
     * since a turn that calls a provider takes seconds. Without this the assertion below fails for a
     * reason that has nothing to do with what it is testing.
     */
    await sleep(5);
    await h.say("@nero lanjut dari situ");

    // Nox's answer, in the room block of Nero's request. It reaches there only because the engine
    // echoes an agent's own reply into room memory on a gateway that will not do it for us.
    const seen = JSON.stringify(h.requests.at(-1));
    expect(seen).toContain("status build?");
    expect(seen).toContain("build-nya hijau");
  });

  test("both agents' turns read back as one transcript", async () => {
    const h = await room({ turns: [{ text: "satu" }, { text: "dua" }] });
    await h.say("@nox mulai");
    await h.say("@nero lanjut");

    // What a room view reads. Per-session queries return two monologues; this is the conversation.
    expect(h.whoRan()).toEqual(["nox", "nero"]);
  });
});

describe("what the daemon says for itself", () => {
  test("the hop budget running out is written down, not only spoken", async () => {
    /**
     * The local gateway hands a reply to a waiting HTTP caller and there is none here, so a notice
     * sent outside a turn used to vanish completely — and this is the one notice whose whole purpose
     * is to stop a room going quiet without explanation.
     *
     * It was first recorded as a note on one agent's turn, which is where this test used to look. It
     * is a room event now: what happened happened *between two agents*, and a shared fact written
     * into one agent's session leaves the other's transcript without it.
     */
    const h = await room({
      turns: [
        { text: "@nero satu" },
        { text: "@nox dua" },
        { text: "@nero tiga" },
        { text: "@nox empat" },
        { text: "@nero lima" },
      ],
      maxHops: 2,
    });
    await h.say("@nox mulai");

    /**
     * Recorded for the room, in the third person, where both agents can read it.
     *
     * The first-person line is still *spoken* — `voice.reply` under the name of the agent that would
     * have answered — and that is for the platforms where a person is reading the chat. Here it goes
     * to a waiting HTTP caller that does not exist, which is the whole reason the record has to be
     * somewhere else.
     */
    const budget = h.chatEvents
      .forChat("web:dashboard", "room-1")
      .find((event) => event.kind === "hop_budget");
    expect(budget?.audience).toBe("agents");
    expect(budget?.text).toContain("exchanged");
    // Not attributed to one agent, which is what a note on a turn would have done.
    expect(budget?.agentId).toBeUndefined();
  });
});

describe("the default posture of a shared connection", () => {
  test("an untagged message is answered once, by the orchestrator — never once per agent", async () => {
    /**
     * `groups_require_mention` off, and the guard that makes a shared room safe counts *connections*: "no unaddressed
     * answers where several of our bots are in the room". Behind one shared connection it counts one, so the guard does
     * not fire and the message falls to the orchestrator (0.7.18; the default agent before): one reply, from the agent
     * named for exactly that, to a message addressed to the room.
     */
    const h = await room({
      turns: [{ text: "front desk" }],
      requireMention: false,
      orchestrator: "nouva",
    });
    await h.say("halo semua");
    expect(h.requests).toHaveLength(1);
  });
});

describe("a dashboard conversation with one agent", () => {
  test("a slash command goes bare, so it takes the urgent lane instead of queueing behind the turn", () => {
    // Rehearsed on a copy of a live box: `nouva: /approve` waited behind the turn that was waiting on it.
    const local = new LocalGateway();
    const seen: { text: string; mentions?: string[] }[] = [];
    local.onMessage((envelope) => seen.push({ text: envelope.text, ...(envelope.mentions ? { mentions: envelope.mentions } : {}) }));

    local.dispatch({ agent: "nouva", chatId: "c1", text: "/approve" });
    local.dispatch({ agent: "nouva", chatId: "c1", text: "what is up" });

    expect(seen).toEqual([
      { text: "/approve", mentions: ["nouva"] },
      { text: "nouva: what is up", mentions: ["nouva"] },
    ]);
  });
});
