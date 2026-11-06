/**
 * A credential sent in a room several of our bots share (0.7.26).
 *
 * Live (2026-10-21, a Telegram group where Nouva leads and Nestor is a member): two bot tokens in one message. Each
 * bot's copy took them again under its own connection — two notices, one from Nestor's bot, and two sets of handles
 * for the same two tokens. Now the room holds them: the first copy takes them, the rest find them held, the notice is
 * said once and by the orchestrator's bot, and the agent that answers is handed the handle the person was told.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { TransientSecrets } from "@nouride/secrets";
import { addLogSink, type MessageEnvelope } from "@nouride/shared";
import { secretScope } from "@/modules/tools/held-secrets.ts";
import { envelope as envelopeAt, FakeGateway } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const TOKEN = "5550005555:AAFAKEtokenFORtestsONLYnotREAL00000";
const HANDLE = /\$TMP_SECRET_[0-9A-F]{12}/g;

const taken: string[] = [];
addLogSink((entry) => {
  if (entry.message === "credentials taken out of a message") taken.push(String(entry.data?.gateway));
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

async function room(order: string[]) {
  const bots = ["nouva", "nestor"];
  const connections = Object.fromEntries(bots.map((id) => [id, new FakeGateway(`telegram:${id}`, "telegram")]));
  const held = new TransientSecrets();
  const bench = await pipelineBench({
    turns: [{ text: "Saved." }],
    agents: bots,
    config: {
      agents: { mentions_enabled: true, groups_require_mention: true },
      daemon: { orchestrator: "nouva" },
      gateways: { telegram: Object.fromEntries(bots.map((id) => [id, { enabled: true, token: `t-${id}`, agent: id }])) },
    },
    deps: () => ({ heldSecrets: held }),
    gateways: Object.values(connections),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  const say = async (over: Partial<MessageEnvelope>, perBot: (bot: string) => Partial<MessageEnvelope> = () => ({})) => {
    const message = envelopeAt({ id: "m-1", timestamp: Date.now(), chatType: "group", chatId: "-5550007777", senderId: "operator", text: `nix ${TOKEN}`, ...over });
    // In the order the platform happened to deliver them — Nestor's copy first, live.
    for (const id of order) connections[id]!.receive({ ...message, gatewayId: `telegram:${id}`, ...perBot(id) });
    await bench.pipeline.idle();
  };
  const notices = (id: string) => connections[id]!.sent.filter((message) => message.text.includes("Taken out of your message"));
  return { bench, held, say, notices, connections };
}

describe("a credential sent in a room of several of our bots", () => {
  test("is taken once and said once, by the orchestrator's bot — though another bot's copy came first", async () => {
    const h = await room(["nestor", "nouva"]);
    await h.say({}, (bot) => (bot === "nouva" ? { mentionsSelf: true } : {}));

    expect(h.notices("nestor")).toEqual([]);
    expect(h.notices("nouva")).toHaveLength(1);
    // One line in the log: the copy that took it — the other found it held, and says nothing.
    expect(taken.splice(0)).toEqual(["telegram:nestor"]);
    const told = h.notices("nouva")[0]!.text.match(HANDLE) ?? [];
    expect(told).toHaveLength(1);
    // The handle the person was told is the one the answering agent's conversation holds.
    expect(h.held.get(told[0]!, secretScope({ gateway: "telegram", gatewayId: "telegram:nouva", chatId: "-5550007777", chatType: "group" }))?.value).toBe(TOKEN);
    // What the model was sent carries that handle, never the token.
    const sent = JSON.stringify(h.bench.requests.map((request) => request.messages));
    expect(sent).toContain(told[0]!);
    expect(sent).not.toContain(TOKEN);
  });

  test("where each bot numbers the message its own way, the orchestrator's notice quotes nothing it cannot see", async () => {
    const h = await room(["nestor", "nouva"]);
    await h.say({ idsPerConnection: true }, (bot) => (bot === "nouva" ? { id: "100", mentionsSelf: true } : { id: "57" }));
    expect(h.notices("nouva")).toHaveLength(1);
    expect(h.notices("nouva")[0]!.replyTo).toBeUndefined();
  });

  test("a one-to-one chat is still the bot's own: a token sent to one bot privately is not another's", async () => {
    const held = new TransientSecrets();
    const handle = held.hold(TOKEN, { scope: secretScope({ gateway: "telegram", gatewayId: "telegram:nouva", chatId: "814", chatType: "dm" }), label: "x", from: "u" });
    expect(held.get(handle, secretScope({ gateway: "telegram", gatewayId: "telegram:nestor", chatId: "814", chatType: "dm" }))).toBeUndefined();
  });
});
