/**
 * A reply to what an agent said reaches it, in a room that answers only when addressed — after a `/reset`, and after a
 * restart.
 *
 * Live (2026-10-21, a WhatsApp group): Nouva answered, somebody sent `/reset`, then replied to her answer with a
 * question. Nothing came back until she was tagged. Ending the conversation had forgotten who wrote her answer, and the
 * record of who wrote what is in memory, so a restart forgets it too. Now the end of a conversation keeps it, and the
 * platform's own word — `repliesToSelf`, the quoted message is this bot's — answers when the record has nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { envelope as envelopeAt, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

/** Our bots in one group that requires a mention, each its own connection, and a person who talks to them. */
async function room(bots: string[] = ["nouva"]) {
  const connections = Object.fromEntries(bots.map((id) => [id, new FakeGateway(`telegram:${id}`, "telegram")]));
  const bench = await pipelineBench({
    turns: Array.from({ length: 6 }, (_, i) => ({ text: `answer ${i + 1}` })),
    agents: bots,
    config: {
      agents: { mentions_enabled: true, groups_require_mention: true },
      gateways: { telegram: Object.fromEntries(bots.map((id) => [id, { enabled: true, token: `t-${id}`, agent: id }])) },
    },
    gateways: Object.values(connections),
  });
  cleanup.push(bench.dispose);
  return start(bench, bots, connections);
}

function start(bench: Bench, bots: string[], connections: Record<string, FakeGateway>) {
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  let n = 0;
  return {
    bench,
    /** One message, a copy to every bot; `perBot` is what one bot's platform says of its own copy. */
    async say(over: Partial<MessageEnvelope> & { perBot?: (bot: string) => Partial<MessageEnvelope> }) {
      const { perBot, ...rest } = over;
      const message = envelopeAt({ id: `m-${++n}`, timestamp: Date.now(), chatType: "group", chatId: "room-1", senderId: "operator", ...rest });
      for (const id of bots) connections[id]!.receive({ ...message, gatewayId: `telegram:${id}`, ...perBot?.(id) });
      await bench.pipeline.idle();
    },
    /** What each bot said since the last call, by bot. */
    said(): Record<string, string[]> {
      const spoken = bots.map((id) => [id, connections[id]!.sent.splice(0).map((m) => m.text)] as const);
      return Object.fromEntries(spoken.filter(([, texts]) => texts.length > 0));
    },
    connections,
  };
}

describe("a reply to what an agent said, in a room that needs a mention", () => {
  test("reaches her, though a `/reset` came between her answer and the reply", async () => {
    const h = await room();
    await h.say({ text: "apa itu exhibition?", mentionsSelf: true });
    expect(h.said()).toEqual({ nouva: ["answer 1"] });
    const herAnswer = "telegram:nouva#1";

    await h.say({ text: "/reset", mentionsSelf: true });
    expect(h.said().nouva?.[0]).toStartWith("Reset.");

    await h.say({ text: "secara virtual maksudnya apa", replyTo: herAnswer, quotedText: "answer 1" });
    expect(h.said()).toEqual({ nouva: ["answer 2"] });
  });

  test("an unaddressed message is still not answered — the reply is what addressed her", async () => {
    const h = await room();
    await h.say({ text: "ngobrol biasa" });
    expect(h.said()).toEqual({});
  });

  test("after a restart, by the platform's word that the quoted message is her bot's", async () => {
    const h = await room();
    await h.say({ text: "apa itu exhibition?", mentionsSelf: true });
    h.said();

    // The next process: the same install, nothing in memory — the record of who wrote her answer is gone.
    const connection = new FakeGateway("telegram:nouva", "telegram");
    const next = await h.bench.reboot({ turns: [{ text: "after the restart" }], gateways: [connection] });
    const after = start(next, ["nouva"], { nouva: connection });

    await after.say({ text: "maksudnya?", replyTo: "telegram:nouva#1" });
    expect(after.said()).toEqual({});

    await after.say({ text: "maksudnya?", replyTo: "telegram:nouva#1", repliesToSelf: true });
    expect(after.said()).toEqual({ nouva: ["after the restart"] });
  });

  test("with several of our bots in the room, only the bot whose message was quoted answers", async () => {
    const h = await room(["nouva", "nox"]);
    await h.say({ text: "nox: hidup?", replyTo: "old-1", perBot: (bot) => (bot === "nox" ? { repliesToSelf: true } : {}) });
    // Named and replied to: Nox either way. The point is the other copy.
    expect(Object.keys(h.said())).toEqual(["nox"]);

    await h.say({ text: "terus?", replyTo: "old-1", perBot: (bot) => (bot === "nox" ? { repliesToSelf: true } : {}) });
    expect(Object.keys(h.said())).toEqual(["nox"]);
  });
});
