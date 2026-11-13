/**
 * A way on for work that stopped in a room (`modules/pipeline/way-on.ts`): Continue under a chain at its hop budget,
 * Continue and Hand to under handed-over work that ended early, and Continue under a person's own turn that ended
 * early with work kept (`resume-ask.ts`).
 *
 * Each case is a way a button must not behave: delivering to an agent that can no longer take it, taking a press
 * from somebody who may not talk to the agent, working twice, working from another chat, giving the work on as an
 * agent's rather than as the person's who chose, telling the agent a restart happened when none did, or offering to
 * hand a person's own question to another agent.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { messageText, type ButtonPress, type LoadedAgent, type MessageEnvelope, type Tool } from "@nouride/shared";
import { routePresses } from "@/modules/gateways/presses.ts";
import type { HandedOver } from "@/modules/pipeline/active-turns.ts";
import { continueEndedButton, continuePresses } from "@/modules/pipeline/resume-ask.ts";
import { restartResumeEnvelope } from "@/modules/pipeline/restart-resume.ts";
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
      resume: (one, why) => (resumed.push(`${one.id} ${why}`), true),
      isAdmin: () => false,
      handedOver: { waits: () => overrides.waits ?? true, mayAsk: () => overrides.mayAsk ?? true, settle: (id) => void settled.push(id) },
    });
    return { presses, resumed, settled };
  };

  test("the same agent takes it up for anyone who may talk to it there, and the line says who chose", async () => {
    const { presses, resumed, settled } = carryOn();
    const answer = await presses.press(press(`carry-on:${failed.id}`));
    // As work that ended, which is what its agent is told: no restart cut it off.
    expect(resumed).toEqual([`${failed.id} ended`]);
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
    expect(cut.resumed).toEqual([`${failed.id} asked`]);
    const others = carryOn({ turn: { status: "interrupted", senderId: "someone-else" } });
    expect((await others.presses.press(press(`carry-on:${failed.id}`))).notice).toContain("Only the person who asked for it");
    expect(others.settled).toEqual([]);
  });
});

describe("Continue under a person's own turn that ended early", () => {
  const own = (overrides: { turn?: Partial<TurnRecord>; admin?: boolean; taken?: boolean; resumes?: boolean; waits?: boolean } = {}) => {
    const resumed: string[] = [];
    const settled: string[] = [];
    const turn = { ...failed, senderId: "100", startedAt: 1, reply: `The model refused the request. What I did so far is kept: say "continue" and I will pick up from there.`, ...overrides.turn } as TurnRecord;
    const presses = continuePresses({
      turns: { get: (id) => (id === turn.id ? turn : null), startedFor: (messageId) => messageId === `resume:${turn.id}` && overrides.taken === true },
      resume: (one, why) => (resumed.push(`${one.id} ${why}`), overrides.resumes ?? true),
      isAdmin: () => overrides.admin ?? false,
      // Another agent's work is another line's: its rule is never asked here.
      handedOver: { waits: () => overrides.waits ?? false, mayAsk: () => true, settle: (id) => void settled.push(id) },
    });
    return { presses, resumed, settled, button: continueEndedButton(turn.id) };
  };

  test("its button is Continue, with data of its own that names the turn", () => {
    const { presses, button } = own();
    expect(button).toEqual({ label: "Continue", data: `go-on:${failed.id}`, style: "positive" });
    expect(presses.owns(button.data)).toBe(true);
    expect(presses.owns("hand:to:turn_1:nouva")).toBe(false);
  });

  test("the person whose turn it was has the agent take it up, as work that ended, and the line says who chose", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      const { presses, resumed, button } = own({ turn: { status } });
      expect(await presses.press(press(button.data))).toEqual({
        notice: "Carrying on.",
        settled: `The model refused the request. What I did so far is kept: say "continue" and I will pick up from there.\n\nContinued by Gading.`,
      });
      expect(resumed).toEqual([`${failed.id} ended`]);
    }
  });

  test("somebody else in the room may not, and an admin may", async () => {
    const other = own({ turn: { senderId: "someone-else" } });
    expect(await other.presses.press(press(other.button.data))).toEqual({ notice: "Only the person who asked for it, or an admin, can say that here." });
    expect(other.resumed).toEqual([]);
    const admin = own({ turn: { senderId: "someone-else" }, admin: true });
    expect((await admin.presses.press(press(admin.button.data))).notice).toBe("Carrying on.");
  });

  test("once: a turn already taken up is not taken up again, and the line is left as it reads", async () => {
    const { presses, resumed, button } = own({ taken: true });
    expect(await presses.press(press(button.data))).toEqual({ notice: "I have carried on with that already." });
    expect(resumed).toEqual([]);
  });

  test("not from another chat or another connection, and not for a turn that did not end early", async () => {
    for (const elsewhere of [{ chatId: "999" }, { gatewayId: "telegram:main" }]) {
      const { presses, resumed, button } = own();
      expect(await presses.press(press(button.data, elsewhere))).toEqual({ notice: "That is not waiting any more." });
      expect(resumed).toEqual([]);
    }
    for (const status of ["done", "running", "interrupted"] as const) {
      const { presses, resumed, button } = own({ turn: { status } });
      expect(await presses.press(press(button.data))).toEqual({ notice: "That is not waiting any more." });
      expect(resumed).toEqual([]);
    }
    const unknown = own();
    expect(await unknown.presses.press(press("go-on:turn_nobody"))).toEqual({ notice: "That is not waiting any more." });
  });

  test("a connection that is gone is said, with the word that still works", async () => {
    const { presses, button } = own({ resumes: false });
    expect(await presses.press(press(button.data))).toEqual({ notice: `I could not pick that up from here. Say "continue" instead.` });
  });

  test("handed-over work pressed through this button is held to this rule: the room's own is not asked", async () => {
    // A line that waits as handed-over work, pressed with a person's button by somebody who is not its sender.
    const { presses, resumed, settled, button } = own({ turn: { senderId: "nouva-bot" }, waits: true });
    expect(await presses.press(press(button.data))).toEqual({ notice: "Only the person who asked for it, or an admin, can say that here." });
    expect(resumed).toEqual([]);
    expect(settled).toEqual([]);
  });
});

describe("what the agent is told when it is asked to carry on", () => {
  const turn = { id: "turn_1", agentId: "nox", gatewayId: "telegram:second", chatId: "814", prompt: "nox: restart the cache" };

  test("after work that ended by itself: that it ended, and no word of a restart that did not happen", () => {
    const told = restartResumeEnvelope(turn, "telegram", "group", "ended");
    expect(told.text).toStartWith(`[system] Your work on "nox: restart the cache" ended before it was finished, and they have now asked you to carry on.`);
    expect(told.text).toContain("Carry on from where you stopped");
    expect(told.text).not.toContain("restart the daemon");
    expect(told.text).not.toMatch(/daemon restarted|provider failed/);
    expect(told).toMatchObject({ id: "resume:turn_1", mentions: ["nox"], chatType: "group", raw: { via: "ended resumed", turn: "turn_1" } });
  });

  test("after a restart a while ago: that, as before", () => {
    const told = restartResumeEnvelope(turn, "telegram", "group", "asked");
    expect(told.text).toStartWith(`[system] The daemon restarted a while ago while you were working on "nox: restart the cache", and they have now asked you to carry on.`);
    expect(told.raw).toEqual({ via: "restart resumed", turn: "turn_1" });
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
  /** The next model request is answered as a provider that is down for a while answers: a failure tried again later. */
  downNext(): void;
}

async function room(turns: Parameters<typeof scriptedOpenAI>[0], maxHops = 3, buttons = true, tools: [string, Tool][] = []): Promise<Room> {
  const gateway = new FakeGateway("telegram:main");
  const second = new FakeGateway("telegram:second", "telegram");
  gateway.buttons = buttons;
  second.buttons = buttons;
  let refuse = false;
  let down = false;
  // The refused request less its temperature. A provider that will not take a request refuses it again when it is
  // asked once more without one (`TemperatureGuard`): refused once only, the second ask answered and nothing failed.
  let again: string | undefined;
  const lessTemperature = (init: RequestInit) => JSON.stringify({ ...(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>), temperature: undefined });
  const bench = await pipelineBench({
    turns,
    maxAttempts: 1,
    fetch: (scripted) =>
      (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && down) {
          down = false;
          return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503, headers: { "content-type": "application/json" } });
        }
        if (init?.method === "POST") {
          const asked = lessTemperature(init);
          const askedAgain = asked === again;
          again = refuse ? asked : undefined;
          if (refuse || askedAgain) {
            refuse = false;
            return new Response(JSON.stringify({ error: { message: "this request is not allowed" } }), { status: 400, headers: { "content-type": "application/json" } });
          }
        }
        return scripted(url, init);
      }) as unknown as typeof fetch,
    agents: [{ id: "nouva" }, { id: "nox" }],
    ...(tools.length > 0 ? { agentToml: `[llm]\nprovider = "test"\n\n[tools]\nenabled = [${tools.map(([name]) => `"${name}"`).join(", ")}]\napproval_required = []\n` } : {}),
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
    // A failure that is tried again is tried long after a test is over.
    deps: () => ({ approvals: new AutoApprovalGate(), providerResumeMs: 3_600_000 }),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map(tools));
  bench.pipeline.attach();
  // As the boot routes them (`boot/turn-machine.ts`).
  const waysOn = bench.pipeline.waysOn();
  routePresses(bench.gateways.values(), [
    continuePresses({ turns: bench.turns, resume: (turn, why) => bench.pipeline.resumeTurn(turn, why), isAdmin: () => false, handedOver: waysOn.handedOver }),
    waysOn.presses,
  ]);
  return { pipeline: bench.pipeline, gateway, second, requests: bench.requests, refuseNext: () => void (refuse = true), downNext: () => void (down = true) };
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
    // Told what happened: the work ended. No restart did.
    expect(lastAsked(h)).toContain("ended before it was finished, and they have now asked you to carry on");
    expect(lastAsked(h)).not.toContain("restarted");
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

  test("a turn a person started themselves that kept nothing says what it always said: no buttons, no word of handing on", async () => {
    const h = await room([{ text: "never" }]);
    h.refuseNext();
    h.second.receive(inRoom("m1", "nox: restart the cache", "telegram:second"));
    await h.pipeline.idle();
    const line = h.second.sent.at(-1)!;
    expect(line.text).not.toContain("hand it on");
    expect(line.text).not.toContain("continue");
    expect(line.buttons).toBeUndefined();
  });

  /**
   * A room whose agent has one tool, and whose turn ends after the tool ran, with work kept: by default the model
   * refuses the next request. `how`: the provider is down for a while instead, or the daemon is stopping.
   */
  async function endedWithWork(buttons = true, chatType: MessageEnvelope["chatType"] = "group", how: "refused" | "down" | "restart" = "refused") {
    let h: Room | undefined;
    const end = { refused: () => h!.refuseNext(), down: () => h!.downNext(), restart: () => h!.pipeline.pause() }[how];
    const probe: Tool = {
      definition: { name: "probe", description: "Look at the cache.", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      execute: async () => (end(), { content: "the cache is stale", isError: false }),
    } as Tool;
    h = await room([{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "Cache restarted." }], 3, buttons, [["probe", probe]]);
    h.second.receive(inRoom("m1", "nox: restart the cache", "telegram:second", { chatType, senderId: "user-1" }));
    await h.pipeline.idle();
    return h;
  }

  test("a person's own turn that ends early with work kept carries Continue, alone, and a press has the agent take it up", async () => {
    const h = await endedWithWork();
    const at = lineWith(h.second, "go-on:");
    const line = h.second.sent[at]!;
    expect(line.text).toContain(`What I did so far is kept: say "continue" and I will pick up from there.`);
    // Their own question: nobody else's to hand on.
    expect(line.text).not.toContain("hand it on");
    expect(line.buttons!.map((button) => button.label)).toEqual(["Continue"]);
    const [data] = line.buttons!.map((button) => button.data);

    expect((await pressOn(h.second, at, data!)).notice).toBe("Carrying on.");
    await eventually(() => h.second.sent.at(-1)?.text === "Cache restarted.", 4_000, "Nox's answer");
    expect(lastAsked(h)).toContain(`Your work on "restart the cache" ended before it was finished`);
    expect(lastAsked(h)).not.toContain("restarted");
    // What it had done is in what it is sent: the call and its result.
    expect(JSON.stringify(h.requests.at(-1)!.messages)).toContain("the cache is stale");
    expect(h.second.sent[at]?.text).toContain("Continued by Gading.");
    expect(h.second.sent[at]?.buttons).toBeUndefined();
    // Once.
    const before = h.requests.length;
    expect((await pressOn(h.second, at, data!)).notice).toBe("I have carried on with that already.");
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(before);
  });

  test("somebody else in the room is told it is not theirs, and nothing runs", async () => {
    const h = await endedWithWork();
    const at = lineWith(h.second, "go-on:");
    const before = h.requests.length;
    const answer = await h.second.press({ chatId: "814", chatType: "group", messageId: `${h.second.id}#${at + 1}`, data: h.second.sent[at]!.buttons![0]!.data, senderId: "user-2", senderName: "Somebody" });
    expect(answer.notice).toBe("Only the person who asked for it, or an admin, can say that here.");
    await h.pipeline.idle();
    expect(h.requests).toHaveLength(before);
    expect(h.second.sent[at]?.buttons).toHaveLength(1);
  });

  test("a turn the daemon will try again by itself, and one a restart cut off, carry no such button: each has its own way on", async () => {
    const tried = await endedWithWork(true, "group", "down");
    const promise = tried.second.sent.at(-1)!;
    expect(promise.text).toContain("I'll try again in a few minutes");
    expect(promise.buttons).toBeUndefined();

    const cut = await endedWithWork(true, "group", "restart");
    const report = cut.second.sent.at(-1)!;
    expect(report.text).toContain("restart");
    expect(report.buttons).toBeUndefined();
  });

  test("on a connection with no buttons, and in a one-to-one chat, the line says the same in words and carries none", async () => {
    const plain = await endedWithWork(false);
    expect(plain.second.sent.at(-1)!.text).toContain(`say "continue"`);
    expect(plain.second.sent.at(-1)!.buttons).toBeUndefined();
    const alone = await endedWithWork(true, "dm");
    expect(alone.second.sent.at(-1)!.text).toContain(`say "continue"`);
    expect(alone.second.sent.at(-1)!.buttons).toBeUndefined();
  });
});
