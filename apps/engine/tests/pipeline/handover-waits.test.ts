/**
 * A hand-over to an agent at work in the room waits for it (`steering.ts`, `active-turns.ts`).
 *
 * An agent's tag used to meet a busy agent as a person's message does: refused, the room told to ask again, and the
 * agent that handed the work over never woken, so the work stopped with nobody. Each case is a way the wait must not
 * go wrong: a person's message kept in line with it, a second tag starting a second turn, the hand-over taken up as a
 * person's when its turn comes, one lost when a second joins it, or one left owed to nobody across a restart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { messageText, type MessageEnvelope, type Tool } from "@nouride/shared";
import { ActiveTurns, type ActiveTurn } from "@/modules/pipeline/active-turns.ts";
import { lapsedHandoverNotice, whileBusy } from "@/modules/pipeline/steering.ts";
import { AutoApprovalGate, conversationOf, envelope, eventually, FakeGateway, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

const started = envelope({ id: "m1", gatewayId: "telegram:second", chatId: "814", chatType: "group", text: "nox: deploy the shop" });
const turn = (overrides: Partial<ActiveTurn> = {}): ActiveTurn => ({
  controller: new AbortController(),
  agentId: "nox",
  gatewayId: "telegram:second",
  chatId: "814",
  steers: [],
  steered: 0,
  trigger: started,
  startedAt: Date.now(),
  ...overrides,
});
const tagged = (id: string, text: string, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope =>
  envelope({ id, gatewayId: "telegram:second", chatId: "814", chatType: "group", senderIsBot: true, fromAgent: "nouva", text, ...overrides });

describe("what a busy agent does with a hand-over", () => {
  const handed = { addressed: true, fromPerson: false, steer: true, handedOver: true };

  test("one of our agents' waits; a person's is refused as before, whatever else is said of it", () => {
    expect(whileBusy(turn(), tagged("m2", "nox: restart the cache"), handed)).toBe("wait");
    expect(whileBusy(turn(), tagged("m2", "nox: status?", { senderIsBot: false, senderId: "user-2" }), { ...handed, fromPerson: true })).toBe("tell");
    // A bot's message that is not a hand-over of ours (the chain's budget spent, a stranger's bot) is refused too.
    expect(whileBusy(turn(), tagged("m2", "nox: restart the cache"), { ...handed, handedOver: false })).toBe("tell");
  });

  test("nothing waits that did not address the agent, or that the daemon wrote", () => {
    expect(whileBusy(turn(), tagged("m2", "restart the cache"), { ...handed, addressed: false })).toBe("quiet");
    expect(whileBusy(turn(), tagged("m2", "[System event] done", { senderId: "nouride:system" }), handed)).toBe("quiet");
    expect(whileBusy(undefined, tagged("m2", "nox: restart the cache"), handed)).toBe("quiet");
  });
});

describe("where a hand-over waits", () => {
  const bench = () => {
    const turns = new ActiveTurns({} as never);
    const back: MessageEnvelope[] = [];
    turns.requeue = (one) => void back.push(one);
    const busy = turn();
    turns.activeTurns.set(ActiveTurns.turnKey("nox", "814", "telegram:second"), busy);
    return { turns, back, busy };
  };

  test("it is kept on the turn, owed until its own turn, and put back when the turn ends: an agent's message still", () => {
    const { turns, back, busy } = bench();
    const first = tagged("m2", "nox: restart the cache");
    expect(turns.holdHandover(busy, first, { from: "nouva", hops: 2 }, 1_000)).toBe(false);
    expect(turns.holds(first)).toBe(true);
    expect(back).toEqual([]);

    turns.releaseTurn(ActiveTurns.turnKey("nox", "814", "telegram:second"));
    expect(back).toEqual([first]);
    // Its agent's, routed once already; and an agent's message at its depth in the chain, not a person's.
    expect(turns.returned.get(first)).toBe("nox");
    expect(turns.verdictOf(first)).toEqual({ kind: "agent", from: "nouva", hops: 2 });
    expect(turns.handed.get(first)?.since).toBe(1_000);
    expect(turns.holds(first)).toBe(false);
    // A person's message put back the same way is a person's.
    expect(turns.verdictOf(tagged("m9", "use staging", { senderIsBot: false }))).toEqual({ kind: "human" });
  });

  test("a second from the same agent joins the first: one turn, both asked, the first's wait, the deeper count", () => {
    const { turns, back, busy } = bench();
    const first = tagged("m2", "nox: restart the cache");
    const second = tagged("m3", "nox: and clear the CDN");
    turns.holdHandover(busy, first, { from: "nouva", hops: 1 }, 1_000);
    expect(turns.holdHandover(busy, second, { from: "nouva", hops: 3 }, 5_000)).toBe(true);
    expect(busy.handovers).toHaveLength(1);
    // Both are owed: a restart answers either.
    expect(turns.holds(first)).toBe(true);
    expect(turns.holds(second)).toBe(true);

    turns.releaseTurn(ActiveTurns.turnKey("nox", "814", "telegram:second"));
    expect(back).toHaveLength(1);
    expect(back[0]!.text).toContain("restart the cache");
    expect(back[0]!.text).toContain("clear the CDN");
    expect(turns.handed.get(back[0]!)).toEqual({ from: "nouva", hops: 3, since: 1_000 });
  });

  test("each handing agent has its own, taken in the order they came", () => {
    const { turns, back, busy } = bench();
    const fromNouva = tagged("m2", "nox: restart the cache");
    const fromNero = tagged("m3", "nox: rotate the logs", { fromAgent: "nero" });
    turns.holdHandover(busy, fromNouva, { from: "nouva", hops: 1 });
    expect(turns.holdHandover(busy, fromNero, { from: "nero", hops: 1 })).toBe(false);
    turns.releaseTurn(ActiveTurns.turnKey("nox", "814", "telegram:second"));
    expect(back).toEqual([fromNouva, fromNero]);
  });

  test("one put back behind a turn that started first waits again from when it first waited", () => {
    const { turns, back, busy } = bench();
    const first = tagged("m2", "nox: restart the cache");
    turns.holdHandover(busy, first, { from: "nouva", hops: 1 }, 1_000);
    turns.releaseTurn(ActiveTurns.turnKey("nox", "814", "telegram:second"));
    const next = turn();
    turns.activeTurns.set(ActiveTurns.turnKey("nox", "814", "telegram:second"), next);
    expect(turns.holdHandover(next, back[0]!, { from: "nouva", hops: 1 }, 9_000)).toBe(false);
    expect(turns.handed.get(back[0]!)?.since).toBe(1_000);
  });

  test("a peer's turn hands back what waited for it too", () => {
    const turns = new ActiveTurns({} as never);
    const back: MessageEnvelope[] = [];
    turns.requeue = (one) => void back.push(one);
    const done = turns.holdPeer("nox", "814", "telegram:second")!;
    const peer = turns.turnIn("nox", "814", "telegram:second")!;
    const first = tagged("m2", "nox: restart the cache");
    turns.holdHandover(peer, first, { from: "nouva", hops: 1 });
    expect(turns.holds(first)).toBe(true);
    done();
    expect(back).toEqual([first]);
  });
});

describe("what the room is told of one that waited too long", () => {
  test("who handed it over and for how long, with no tag in it", () => {
    const notice = lapsedHandoverNotice("@nouva", 3_660_000);
    expect(notice).toContain("nouva handed me work that waited 1h 1m");
    expect(notice).toContain("Hand it over again");
    expect(notice).not.toContain("@");
  });
});

// ── through the real pipeline: two bots in one room ───────────────────────────────────────────────────────────────

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
  /** What the daemon still owes an answer, as a restart would read it. */
  owed: () => { id: string; status: string; text: string }[];
}

/** A room two of our bots share on one platform, each agent answering through its own connection. */
async function room(options: { turns: Parameters<typeof scriptedOpenAI>[0] }, tools: Map<string, Tool>, queue: Record<string, unknown> = {}): Promise<Room> {
  const gateway = new FakeGateway("telegram:main");
  const second = new FakeGateway("telegram:second", "telegram");
  const bench = await pipelineBench({
    turns: options.turns,
    maxAttempts: 1,
    agents: [{ id: "nouva" }, { id: "nox", configToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n' }],
    config: {
      agents: { mentions_enabled: true, mention_max_hops: 3 },
      ...(Object.keys(queue).length > 0 ? { queue } : {}),
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
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  const owed = () => bench.inbox.open(Date.now() + 1).map((row) => ({ id: row.id, status: row.status, text: row.envelope.text }));
  return { pipeline: bench.pipeline, gateway, second, requests: bench.requests, owed };
}

/** What a person said in the room, as the connection it reached hands it over. */
const inRoom = (id: string, text: string, gatewayId = "telegram:main", overrides: Partial<MessageEnvelope> = {}) =>
  envelope({ id, gatewayId, chatType: "group", text, timestamp: Date.now(), ...overrides });

describe("a hand-over to an agent at work in the room", () => {
  /** A step of Nox's that lasts until the test lets it go. */
  function heldStep() {
    let began = false;
    let finish = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const tool: Tool = {
      requiresApproval: false,
      definition: { name: "slow", description: "takes a while", parameters: { type: "object", properties: {} } },
      async execute() {
        began = true;
        await held;
        return { content: "done", isError: false };
      },
    };
    return { tools: new Map([["slow", tool]]), began: () => began, finish: () => finish() };
  }

  /**
   * The copy of what one bot said that the other bot's connection is handed: the one that answers as Nox, so the one
   * whose conversation its turn is in. Not waited for: Nox is held.
   */
  const echo = (h: Room, from: FakeGateway) =>
    h.second.receive(inRoom(`${from.id}#${from.sent.length}`, from.sent.at(-1)!.text, "telegram:second", { senderIsBot: true }));
  const said = (h: Room) => [...h.gateway.sent, ...h.second.sent].map((message) => message.text);
  /** What waits on the turns at work, as the pipeline holds it. */
  const waiting = (h: Room) =>
    [...(h.pipeline as unknown as { turnContext: { activeTurns: Map<string, { handovers?: { text: string }[] }> } }).turnContext.activeTurns.values()].flatMap((turn) => turn.handovers ?? []);
  const lastAsked = (h: Room) => messageText((conversationOf(h.requests.at(-1)!.messages).filter((message) => message.role === "user").at(-1)?.content ?? "") as never);

  test("waits for it, said once, and is its next turn; a person's message to it is still refused", async () => {
    const step = heldStep();
    // In the order asked: Nox's long step, Nouva handing work over beside it, Nox's answer, Nox taking the hand-over.
    const h = await room({
      turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "nox: also restart the cache" }, { text: "Deployed." }, { text: "Cache restarted." }],
    }, step.tools);
    h.second.receive(inRoom("m1", "nox: deploy the shop", "telegram:second"));
    await eventually(step.began, 4_000, "Nox's long step");

    h.gateway.receive(inRoom("m2", "nouva: have nox restart the cache too"));
    await eventually(() => h.gateway.sent.some((message) => message.text.includes("also restart the cache")), 4_000, "Nouva's hand-over");
    echo(h, h.gateway);
    await eventually(() => said(h).some((text) => text.includes("this message waits for it")), 4_000, "the room told that it waits");

    // Somebody else asks Nox meanwhile: told to ask again, as before.
    h.second.receive(inRoom("m3", "nox: status?", "telegram:second", { senderId: "someone-else" }));
    await eventually(() => said(h).some((text) => text.includes("ask again once it's done")), 4_000, "the person told Nox is busy");
    // Nothing ran for either while Nox was held: its step, and Nouva's turn.
    expect(h.requests).toHaveLength(2);

    step.finish();
    await h.pipeline.idle();

    expect(h.second.sent.map((message) => message.text).filter((text) => text === "Deployed." || text === "Cache restarted.")).toEqual(["Deployed.", "Cache restarted."]);
    // The hand-over's turn read Nouva's words; the person's message was never run.
    expect(h.requests).toHaveLength(4);
    expect(lastAsked(h)).toContain("also restart the cache");
    expect(JSON.stringify(h.requests)).not.toContain("status?");
    // Said once, in Nox's voice, and never as a refusal.
    expect(said(h).filter((text) => text.includes("this message waits for it"))).toHaveLength(1);
    expect(h.second.sent.some((message) => message.text.includes("Nox is still working") || message.text.includes("nox is still working"))).toBe(true);
  });

  test("while it waits it is still owed, so a restart puts it back; once its turn ran, nothing is", async () => {
    const step = heldStep();
    const h = await room({
      turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "nox: also restart the cache" }, { text: "Deployed." }, { text: "Cache restarted." }],
    }, step.tools);
    h.second.receive(inRoom("m1", "nox: deploy the shop", "telegram:second"));
    await eventually(step.began, 4_000, "Nox's long step");
    h.gateway.receive(inRoom("m2", "nouva: have nox restart the cache too"));
    await eventually(() => h.gateway.sent.some((message) => message.text.includes("also restart the cache")), 4_000, "Nouva's hand-over");
    echo(h, h.gateway);
    await eventually(() => said(h).some((text) => text.includes("this message waits for it")), 4_000, "the room told that it waits");

    // Its handler has returned, and it is neither handled nor a dead turn's: a restart reads it as waiting and
    // delivers it again, where one marked handled would be owed to nobody.
    const handover = () => h.owed().filter((row) => row.text.includes("also restart the cache"));
    await eventually(() => handover().some((row) => row.status === "queued"), 4_000, "the hand-over left waiting in the inbox");
    expect(handover().map((row) => row.status)).toEqual(["queued"]);

    step.finish();
    await h.pipeline.idle();
    expect(h.second.sent.map((message) => message.text)).toContain("Cache restarted.");
    await eventually(() => h.owed().length === 0, 4_000, "nothing owed once its turn ran");
  });

  test("a second hand-over from the same agent joins the first: said once, one turn, both asked", async () => {
    const step = heldStep();
    const h = await room({
      turns: [
        { toolCalls: [{ id: "c1", name: "slow", args: {} }] },
        { text: "nox: also restart the cache" },
        { text: "nox: and clear the CDN" },
        { text: "Deployed." },
        { text: "Cache restarted, CDN cleared." },
      ],
    }, step.tools);
    h.second.receive(inRoom("m1", "nox: deploy the shop", "telegram:second"));
    await eventually(step.began, 4_000, "Nox's long step");
    for (const [id, asks, handsOver] of [["m2", "have nox restart the cache too", "also restart the cache"], ["m3", "and the CDN", "and clear the CDN"]] as const) {
      h.gateway.receive(inRoom(id, `nouva: ${asks}`));
      await eventually(() => h.gateway.sent.some((message) => message.text.includes(handsOver)), 4_000, "Nouva's hand-over");
      echo(h, h.gateway);
      await eventually(() => waiting(h).some((one) => one.text.includes(handsOver)), 4_000, "the hand-over kept on Nox's turn");
    }
    step.finish();
    await h.pipeline.idle();

    expect(said(h).filter((text) => text.includes("this message waits for it"))).toHaveLength(1);
    expect(h.requests).toHaveLength(5);
    expect(lastAsked(h)).toContain("also restart the cache");
    expect(lastAsked(h)).toContain("and clear the CDN");
    expect(h.second.sent.at(-1)?.text).toBe("Cache restarted, CDN cleared.");
  });

  test("one that waited longer than a message may wait in the queue is left, and the room is told", async () => {
    const step = heldStep();
    const h = await room({
      turns: [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "nox: also restart the cache" }, { text: "Deployed." }, { text: "never asked" }],
    }, step.tools, { queue_timeout_ms: 1 });
    h.second.receive(inRoom("m1", "nox: deploy the shop", "telegram:second"));
    await eventually(step.began, 4_000, "Nox's long step");
    h.gateway.receive(inRoom("m2", "nouva: have nox restart the cache too"));
    await eventually(() => h.gateway.sent.some((message) => message.text.includes("also restart the cache")), 4_000, "Nouva's hand-over");
    echo(h, h.gateway);
    await eventually(() => said(h).some((text) => text.includes("this message waits for it")), 4_000, "the room told that it waits");

    step.finish();
    await h.pipeline.idle();

    expect(said(h).some((text) => text.includes("nouva handed me work that waited") && text.includes("Hand it over again"))).toBe(true);
    expect(h.requests).toHaveLength(3);
    expect(said(h)).not.toContain("never asked");
  });
});
