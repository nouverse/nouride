/**
 * A reply to an agent in a room where nobody need be tagged and the orchestrator is the front desk (0.7.26).
 *
 * Live (2026-10-21, a Telegram group of six of our bots, mention off, Nouva the front desk): a reply to Nix's message
 * was answered by Nouva, and Nix said nothing. Telegram shows a reply to another bot's message to that bot alone, so
 * Nouva's copy read it as addressed to nobody; and Nix's copy read its own message number in a record keyed across
 * bots, found Nouva's message of the same number, and left the reply to her. The owner's rule, on every platform: a
 * reply runs the agent replied to and the front desk stays quiet — unless the reply also tags another agent, and then
 * both answer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import { envelope as envelopeAt, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const BOTS = ["nouva", "nix", "nestor"];

async function room(options: { idsPerConnection: boolean }) {
  const connections = Object.fromEntries(BOTS.map((id) => [id, new FakeGateway(`telegram:${id}`, "telegram")]));
  const bench = await pipelineBench({
    turns: Array.from({ length: 8 }, (_, i) => ({ text: `answer ${i + 1}` })),
    agents: BOTS,
    config: {
      agents: { mentions_enabled: true, groups_require_mention: false },
      daemon: { orchestrator: "nouva" },
      gateways: { telegram: Object.fromEntries(BOTS.map((id) => [id, { enabled: true, token: `t-${id}`, agent: id }])) },
    },
    gateways: Object.values(connections),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  let n = 0;
  /** One message, a copy to every bot as the platform hands it: `perBot` is what one bot's copy says of itself. */
  const say = async (text: string, perBot: (bot: string) => Partial<MessageEnvelope> = () => ({})) => {
    n += 1;
    const base = envelopeAt({ id: `m${n}`, timestamp: Date.now() + n * 1000, chatType: "group", chatId: "-5550007777", senderId: "operator", text, ...(options.idsPerConnection ? { idsPerConnection: true } : {}) });
    for (const id of BOTS) {
      const own = options.idsPerConnection ? { id: `${id}-${n}` } : {};
      connections[id]!.receive({ ...base, gatewayId: `telegram:${id}`, ...own, ...perBot(id) });
    }
    await bench.pipeline.idle();
  };
  /** Which bots said anything since the last call. */
  const speakers = () => BOTS.filter((id) => connections[id]!.sent.splice(0).length > 0);
  return { bench, say, speakers };
}

describe("in a room with a front desk and no mention needed", () => {
  test("a reply to Nix runs Nix, and the front desk stays quiet — though only Nix's copy knows it is a reply", async () => {
    const h = await room({ idsPerConnection: true });
    await h.say("di telegram ini bisa bikin threads ga sih?", (bot) => (bot === "nix" ? { replyTo: "14", repliesToSelf: true, quotedText: "…", quotedSender: "Nix (Dev)" } : {}));
    expect(h.speakers()).toEqual(["nix"]);
  });

  test("Nix's own number is his, whatever another bot's message of the same number was", async () => {
    const h = await room({ idsPerConnection: true });
    // Nouva's bot sent a message it numbers 14; Nix's message is 14 to Nix's bot.
    (h.bench.pipeline as unknown as { voice: { outbound: { record(e: { platform: string; chatId: string; messageId: string; agentId: string }): void } } }).voice.outbound.record({ platform: "telegram", chatId: "-5550007777", messageId: "14", agentId: "nouva" });
    await h.say("lanjut", (bot) => (bot === "nix" ? { replyTo: "14", repliesToSelf: true } : {}));
    expect(h.speakers()).toEqual(["nix"]);
  });

  test("a reply to Nix that tags Nouva runs both", async () => {
    const h = await room({ idsPerConnection: true });
    await h.say("@NouvaNourideBot cek juga ya", (bot) =>
      bot === "nouva" ? { mentionsSelf: true, mentions: [] } : bot === "nix" ? { replyTo: "14", repliesToSelf: true, mentions: ["NouvaNourideBot"] } : { mentions: ["NouvaNourideBot"] },
    );
    expect(h.speakers().sort()).toEqual(["nix", "nouva"]);
  });

  test("a message addressed to nobody is still the front desk's", async () => {
    const h = await room({ idsPerConnection: true });
    await h.say("ada yang tau jam berapa meeting?");
    expect(h.speakers()).toEqual(["nouva"]);
  });

  test("where every copy carries the reply but nothing recorded who wrote it — after a restart — Nix answers, alone", async () => {
    // Discord shows a reply to every bot; after a restart only the replied bot's copy knows the message was its own.
    const h = await room({ idsPerConnection: false });
    await h.say("terus?", (bot) => ({ replyTo: "d-77", ...(bot === "nix" ? { repliesToSelf: true } : {}) }));
    expect(h.speakers()).toEqual(["nix"]);
  });
});
