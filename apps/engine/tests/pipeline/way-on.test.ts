/**
 * A way on for work that stopped in a room (`modules/pipeline/way-on.ts`): Continue under a chain at its hop budget,
 * Continue and Hand to under handed-over work that ended early.
 *
 * Each case is a way a button must not behave: delivering to an agent that can no longer take it, taking a press
 * from somebody who may not talk to the agent, working twice, working from another chat, giving the work on as an
 * agent's rather than as the person's who chose, or appearing under a turn a person started themselves.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { messageText, type ButtonPress, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import { routePresses } from "@/modules/gateways/presses.ts";
import type { HandedOver } from "@/modules/pipeline/active-turns.ts";
import { continuePresses } from "@/modules/pipeline/resume-ask.ts";
import { HAND_TO_SHOWN, handedOnText, handToButtons, wayOnPresses, WaysOn } from "@/modules/pipeline/way-on.ts";
import type { TurnRecord } from "@/modules/turns/turns.store.ts";
import { AutoApprovalGate, conversationOf, envelope, eventually, FakeGateway, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const agentOf = (id: string, displayName = id): LoadedAgent => ({ config: { id, displayName } }) as LoadedAgent;
const press = (data: string, overrides: Partial<ButtonPress> = {}): ButtonPress => ({
  gatewayId: "telegram:second",
  chatId: "814",
  chatType: "group",
  messageId: "telegram:second#3",
  data,
  senderId: "100",
  senderName: "Gading",
  ...overrides,
});
const stopped = envelope({ id: "h1", gatewayId: "telegram:main", chatId: "814", chatType: "group", senderIsBot: true, fromAgent: "nox", text: "nouva: done, what next?" });
const failed = { id: "turn_1", agentId: "nox", gatewayId: "telegram:second", chatId: "814", prompt: "nox: restart the cache", reply: "The model refused the request. What I did so far is kept.", status: "failed" } as TurnRecord;

function owner(overrides: { mayAsk?: boolean; agents?: string[] } = {}) {
  const back: MessageEnvelope[] = [];
  const ctx = { waysOn: new WaysOn(), returned: new WeakMap<MessageEnvelope, string>(), handed: new WeakMap<MessageEnvelope, HandedOver>(), requeue: (one: MessageEnvelope) => void back.push(one) };
  const live = overrides.agents ?? ["nouva", "nox"];
  const presses = wayOnPresses({
    ctx,
    turns: { get: (id) => (id === failed.id ? failed : null) },
    agent: (id) => (live.includes(id) ? agentOf(id, id === "nouva" ? "Nouva" : id) : undefined),
    mayAsk: () => overrides.mayAsk ?? true,
    ownGateway: (agentId) => (agentId === "nouva" ? "telegram:main" : "telegram:second"),
    platform: () => "telegram",
    now: () => 5_000,
  });
  return { ctx, back, presses };
}

describe("the buttons", () => {
  test(`Hand to names up to ${HAND_TO_SHOWN} other agents, and leaves out one whose id a button cannot carry`, () => {
    const others = ["nouva", "nero", "nix", "nexa"].map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
    const buttons = handToButtons("turn_dd81a86385f3451ca8b9", others);
    expect(buttons.map((button) => button.label)).toEqual(["Hand to Nouva", "Hand to Nero", "Hand to Nix"]);
    expect(buttons[0]!.data).toBe("hand:to:turn_dd81a86385f3451ca8b9:nouva");
    const long = handToButtons("turn_dd81a86385f3451ca8b9", [{ id: "an-agent-with-a-very-long-identifier-indeed", name: "Long" }, { id: "nouva", name: "Nouva" }]);
    expect(long.map((button) => button.label)).toEqual(["Hand to Nouva"]);
    for (const button of [...buttons, ...long]) expect(new TextEncoder().encode(button.data).length).toBeLessThanOrEqual(64);
  });

  test("what is kept between a line and its press is bounded: the oldest goes", () => {
    const waysOn = new WaysOn();
    const first = waysOn.keepChain({ envelope: stopped, to: "nouva", from: "nox", notice: "stopped" });
    for (let n = 0; n < 100; n += 1) waysOn.keepChain({ envelope: stopped, to: "nouva", from: "nox", notice: "stopped" });
    expect(waysOn.chain(first.data.slice("chain:go:".length))).toBeUndefined();
    expect(first).toMatchObject({ label: "Continue", style: "positive" });
  });
});

describe("Continue under a chain that reached its budget", () => {
  test("delivers what was stopped to the agent it was for: an agent's hand-over, its count begun again, and once", async () => {
    const { ctx, back, presses } = owner();
    const button = ctx.waysOn.keepChain({ envelope: stopped, to: "nouva", from: "nox", notice: "(nox and I have gone back and forth 5 times.)" });
    expect(presses.owns(button.data)).toBe(true);

    const answer = await presses.press(press(button.data, { gatewayId: "telegram:main" }));
    expect(back).toEqual([stopped]);
    expect(ctx.returned.get(stopped)).toBe("nouva");
    expect(ctx.handed.get(stopped)).toEqual({ from: "nox", hops: 1, since: 5_000 });
    expect(answer.notice).toBe("Carrying on.");
    expect(answer.settled).toBe("(nox and I have gone back and forth 5 times.)\n\nContinued by Gading.");

    expect((await presses.press(press(button.data))).notice).toContain("not waiting any more");
    expect(back).toHaveLength(1);
  });

  test("not from somebody who may not talk to that agent, not from another chat, and not to an agent that takes no work", async () => {
    const refused = owner({ mayAsk: false });
    const button = refused.ctx.waysOn.keepChain({ envelope: stopped, to: "nouva", from: "nox", notice: "stopped" });
    expect((await refused.presses.press(press(button.data))).notice).toContain("Only someone who may talk to that agent");
    // Still waiting for somebody who may.
    expect(refused.ctx.waysOn.chain(button.data.slice("chain:go:".length))).toBeDefined();

    const elsewhere = owner();
    const other = elsewhere.ctx.waysOn.keepChain({ envelope: stopped, to: "nouva", from: "nox", notice: "stopped" });
    expect((await elsewhere.presses.press(press(other.data, { chatId: "999" }))).notice).toContain("not waiting any more");

    const asleep = owner({ agents: ["nox"] });
    const third = asleep.ctx.waysOn.keepChain({ envelope: stopped, to: "nouva", from: "nox", notice: "stopped" });
    expect((await asleep.presses.press(press(third.data))).notice).toContain("not waiting any more");
    for (const one of [refused, elsewhere, asleep]) expect(one.back).toEqual([]);
  });
});

describe("Hand to under handed-over work that ended early", () => {
  test("gives the agent picked what the other was asked, as the person's who chose, through its own connection, once", async () => {
    const { ctx, back, presses } = owner();
    ctx.waysOn.offer(failed.id);
    const data = handToButtons(failed.id, [{ id: "nouva", name: "Nouva" }])[0]!.data;

    const answer = await presses.press(press(data));
    expect(back).toHaveLength(1);
    const handed = back[0]!;
    expect(handed).toMatchObject({ gatewayId: "telegram:main", gateway: "telegram", chatId: "814", chatType: "group", senderId: "100", senderName: "Gading" });
    expect(handed.text).toBe(handedOnText("nox", "nox: restart the cache"));
    expect(handed.text).toContain("nox could not finish this");
    expect(ctx.returned.get(handed)).toBe("nouva");
    // A person's word, not an agent's hand-over: the turn is theirs to steer and approve.
    expect(ctx.handed.get(handed)).toBeUndefined();
    expect(answer).toEqual({ notice: "Handed to Nouva.", settled: "The model refused the request. What I did so far is kept.\n\nHanded to Nouva by Gading." });

    expect((await presses.press(press(data))).notice).toContain("not waiting any more");
    expect(ctx.waysOn.waits(failed.id)).toBe(false);
    expect(back).toHaveLength(1);
  });

  test("not under a turn whose line never offered it, from another chat, to an agent gone, or from somebody who may not", async () => {
    const data = handToButtons(failed.id, [{ id: "nouva", name: "Nouva" }])[0]!.data;
    const never = owner();
    expect((await never.presses.press(press(data))).notice).toContain("not waiting any more");

    const elsewhere = owner();
    elsewhere.ctx.waysOn.offer(failed.id);
    expect((await elsewhere.presses.press(press(data, { chatId: "999" }))).notice).toContain("not waiting any more");

    const gone = owner({ agents: ["nox"] });
    gone.ctx.waysOn.offer(failed.id);
    expect((await gone.presses.press(press(data))).notice).toContain("not waiting any more");

    const refused = owner({ mayAsk: false });
    refused.ctx.waysOn.offer(failed.id);
    expect((await refused.presses.press(press(data))).notice).toContain("Only someone who may talk to that agent");
    expect(refused.ctx.waysOn.waits(failed.id)).toBe(true);
    for (const one of [never, elsewhere, gone, refused]) expect(one.back).toEqual([]);
  });
});

describe("Continue under handed-over work that ended early", () => {
  const carryOn = (overrides: { waits?: boolean; mayAsk?: boolean; turn?: Partial<TurnRecord> } = {}) => {
    const resumed: string[] = [];
    const settled: string[] = [];
    const turn = { ...failed, senderId: "nouva-bot", startedAt: 1, ...overrides.turn } as TurnRecord;
    const presses = continuePresses({
      turns: { get: (id) => (id === turn.id ? turn : null), startedFor: () => false },
      resume: (one) => (resumed.push(one.id), true),
      isAdmin: () => false,
      handedOver: { waits: () => overrides.waits ?? true, mayAsk: () => overrides.mayAsk ?? true, settle: (id) => void settled.push(id) },
    });
    return { presses, resumed, settled };
  };

  test("the same agent takes it up for anyone who may talk to it there, and the line says who chose", async () => {
    const { presses, resumed, settled } = carryOn();
    const answer = await presses.press(press(`carry-on:${failed.id}`));
    expect(resumed).toEqual([failed.id]);
    expect(settled).toEqual([failed.id]);
    expect(answer).toEqual({ notice: "Carrying on.", settled: "The model refused the request. What I did so far is kept.\n\nContinued by Gading." });
  });

  test("not for somebody who may not, not once the line is settled, and a person's own failed turn has no such press", async () => {
    const refused = carryOn({ mayAsk: false });
    expect((await refused.presses.press(press(`carry-on:${failed.id}`))).notice).toContain("Only someone who may talk to that agent");
    const settled = carryOn({ waits: false });
    expect((await settled.presses.press(press(`carry-on:${failed.id}`))).notice).toBe("That is not waiting any more.");
    for (const one of [refused, settled]) expect(one.resumed).toEqual([]);
  });

  test("a turn a restart cut off keeps its own rule: the person whose turn it was, or an admin", async () => {
    const cut = carryOn({ turn: { status: "interrupted", senderId: "100" } });
    expect((await cut.presses.press(press(`carry-on:${failed.id}`))).notice).toBe("Carrying on.");
    const others = carryOn({ turn: { status: "interrupted", senderId: "someone-else" } });
    expect((await others.presses.press(press(`carry-on:${failed.id}`))).notice).toContain("Only the person who asked for it");
    expect(others.settled).toEqual([]);
  });
});

// ── through the real pipeline: two bots in one room, on a connection with buttons ─────────────────────────────────

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

interface Room {
  pipeline: Awaited<ReturnType<typeof pipelineBench>>["pipeline"];
  /** Nouva's own connection, and Nox's. */
  gateway: FakeGateway;
  second: FakeGateway;
  requests: { messages: { role: string; content: unknown }[] }[];
  /** The next model request is refused, as a provider refuses a request it will not take. */
  refuseNext(): void;
}

async function room(turns: Parameters<typeof scriptedOpenAI>[0], maxHops = 3, buttons = true): Promise<Room> {
  const gateway = new FakeGateway("telegram:main");
  const second = new FakeGateway("telegram:second", "telegram");
  gateway.buttons = buttons;
  second.buttons = buttons;
  let refuse = false;
  const bench = await pipelineBench({
    turns,
    maxAttempts: 1,
    fetch: (scripted) =>
      (async (url: string, init?: RequestInit) => {
        if (refuse && init?.method === "POST") {
          refuse = false;
          return new Response(JSON.stringify({ error: { message: "this request is not allowed" } }), { status: 400, headers: { "content-type": "application/json" } });
        }
        return scripted(url, init);
      }) as unknown as typeof fetch,
    agents: [{ id: "nouva" }, { id: "nox" }],
    config: {
      agents: { mentions_enabled: true, mention_max_hops: maxHops },
      gateways: {
        telegram: {
          main: { enabled: true, token: "telegram-main", agent: "nouva" },
          second: { enabled: true, token: "telegram-main", agent: "nox" },
        },
      },
    },
    // A steering reply is its own model call, and these scripts answer turns in order.
    configure: (config) => void (config.queue.steerReply = false),
    gateway,
    gateways: [gateway, second],
    deps: () => ({ approvals: new AutoApprovalGate() }),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  // As the boot routes them (`boot/turn-machine.ts`).
  const waysOn = bench.pipeline.waysOn();
  routePresses(bench.gateways.values(), [
    continuePresses({ turns: bench.turns, resume: (turn) => bench.pipeline.resumeTurn(turn, "asked"), isAdmin: () => false, handedOver: waysOn.handedOver }),
    waysOn.presses,
  ]);
  return { pipeline: bench.pipeline, gateway, second, requests: bench.requests, refuseNext: () => void (refuse = true) };
}

const inRoom = (id: string, text: string, gatewayId = "telegram:main", overrides: Partial<MessageEnvelope> = {}) =>
  envelope({ id, gatewayId, chatId: "814", chatType: "group", text, timestamp: Date.now(), ...overrides });
/** The copy of what one bot said that the other bot's connection is handed. */
const echo = (from: FakeGateway, to: FakeGateway) => to.receive(inRoom(`${from.id}#${from.sent.length}`, from.sent.at(-1)!.text, to.id, { senderIsBot: true }));
const lastAsked = (h: Room) => messageText((conversationOf(h.requests.at(-1)!.messages).filter((message) => message.role === "user").at(-1)?.content ?? "") as never);
const pressOn = (gateway: FakeGateway, index: number, data: string) =>
  gateway.press({ chatId: "814", chatType: "group", messageId: `${gateway.id}#${index + 1}`, data, senderId: "user-1", senderName: "Gading" });
const lineWith = (gateway: FakeGateway, prefix: string) => gateway.sent.findIndex((message) => message.buttons?.some((button) => button.data.startsWith(prefix)));

describe("in a room, through the pipeline", () => {
  test("a chain stopped at its budget carries Continue, and a press lets the next agent answer what was stopped", async () => {
    // Nouva hands to Nox, Nox tags back: with a budget of one that second hand-over is stopped.
    const h = await room([{ text: "nox: one" }, { text: "nouva: two" }, { text: "three" }], 1);
    h.gateway.receive(inRoom("m1", "nouva: start"));
    await h.pipeline.idle();
    echo(h.gateway, h.second);
    await h.pipeline.idle();
    echo(h.second, h.gateway);
    await h.pipeline.idle();

    const at = lineWith(h.gateway, "chain:go:");
    expect(h.gateway.sent[at]?.text).toContain("gone back and forth 1 times");
    expect(h.requests).toHaveLength(2);

    const answer = await pressOn(h.gateway, at, h.gateway.sent[at]!.buttons![0]!.data);
    expect(answer.notice).toBe("Carrying on.");
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(3);
    expect(lastAsked(h)).toContain("two");
    expect(h.gateway.sent.at(-1)?.text).toBe("three");
    // Settled: who chose, and no button left to press.
    expect(h.gateway.sent[at]?.text).toContain("Continued by Gading.");
    expect(h.gateway.sent[at]?.buttons).toBeUndefined();
  });

  test("handed-over work that fails offers Continue and Hand to; Hand to gives it to the agent picked", async () => {
    const h = await room([{ text: "nox: restart the cache" }, { text: "Restarted it myself." }]);
    h.gateway.receive(inRoom("m1", "nouva: have nox restart the cache"));
    await h.pipeline.idle();
    h.refuseNext();
    echo(h.gateway, h.second);
    await h.pipeline.idle();

    const at = lineWith(h.second, "hand:to:");
    const line = h.second.sent[at]!;
    expect(line.text).toContain("Or tag another agent to hand it on.");
    expect(line.buttons!.map((button) => button.label)).toEqual(["Continue", "Hand to Nouva"]);
    // Kept before a press: a settled line loses its buttons.
    const [carryOn, handTo] = line.buttons!.map((button) => button.data);

    const answer = await pressOn(h.second, at, handTo!);
    expect(answer.notice).toBe("Handed to Nouva.");
    await h.pipeline.idle();
    expect(lastAsked(h)).toContain("nox could not finish this");
    expect(lastAsked(h)).toContain("restart the cache");
    expect(h.gateway.sent.at(-1)?.text).toBe("Restarted it myself.");
    expect(h.second.sent[at]?.text).toContain("Handed to Nouva by Gading.");
    // The other button of that line does nothing more.
    expect((await pressOn(h.second, at, carryOn!)).notice).toBe("That is not waiting any more.");
    // Nouva's two turns were answered; the one refused never reached the script, and nothing ran after the second press.
    expect(h.requests).toHaveLength(2);
  });

  test("and Continue has the same agent take it up", async () => {
    const h = await room([{ text: "nox: restart the cache" }, { text: "Cache restarted." }]);
    h.gateway.receive(inRoom("m1", "nouva: have nox restart the cache"));
    await h.pipeline.idle();
    h.refuseNext();
    echo(h.gateway, h.second);
    await h.pipeline.idle();

    const at = lineWith(h.second, "hand:to:");
    const [carryOn, handTo] = h.second.sent[at]!.buttons!.map((button) => button.data);
    expect((await pressOn(h.second, at, carryOn!)).notice).toBe("Carrying on.");
    await eventually(() => h.second.sent.at(-1)?.text === "Cache restarted.", 4_000, "Nox's answer");
    expect(h.second.sent[at]?.text).toContain("Continued by Gading.");
    expect((await pressOn(h.second, at, handTo!)).notice).toContain("not waiting any more");
  });

  test("on a connection with no buttons the lines say the same in words, and carry none", async () => {
    const chain = await room([{ text: "nox: one" }, { text: "nouva: two" }], 1, false);
    chain.gateway.receive(inRoom("m1", "nouva: start"));
    await chain.pipeline.idle();
    echo(chain.gateway, chain.second);
    await chain.pipeline.idle();
    echo(chain.second, chain.gateway);
    await chain.pipeline.idle();
    const stoppedLine = chain.gateway.sent.find((message) => message.text.includes("gone back and forth"))!;
    expect(stoppedLine.text).toContain("Say something if you want us to continue");
    expect(stoppedLine.buttons).toBeUndefined();

    const work = await room([{ text: "nox: restart the cache" }], 3, false);
    work.gateway.receive(inRoom("m1", "nouva: have nox restart the cache"));
    await work.pipeline.idle();
    work.refuseNext();
    echo(work.gateway, work.second);
    await work.pipeline.idle();
    const failedLine = work.second.sent.at(-1)!;
    expect(failedLine.text).toContain("Or tag another agent to hand it on.");
    expect(failedLine.buttons).toBeUndefined();
  });

  test("a turn a person started themselves says what it always said: no buttons, no word of handing on", async () => {
    const h = await room([{ text: "never" }]);
    h.refuseNext();
    h.second.receive(inRoom("m1", "nox: restart the cache", "telegram:second"));
    await h.pipeline.idle();
    const line = h.second.sent.at(-1)!;
    expect(line.text).not.toContain("hand it on");
    expect(line.buttons).toBeUndefined();
  });
});
