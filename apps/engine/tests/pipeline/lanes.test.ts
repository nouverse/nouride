/**
 * A turn's helpers and peers inside the ceiling, and its peers at work in the chat they run in.
 *
 * `delegate` ran four helpers and `ask_agent` a peer per call, none of them counted: eight turns each delegating four
 * was forty provider streams with `max_concurrent_turns` reading eight. And a peer was invisible to `isBusy`, so a
 * person addressing it in the room started a second turn of the same agent beside it. The property that matters most
 * is the one a naive fix breaks — eight turns at a ceiling of eight, each waiting on its helpers, still finish.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { KeyedQueue } from "@nouride/queue";
import type { ToolContext } from "@nouride/shared";
import { TurnLanes } from "@/modules/pipeline/lanes.ts";
import { busyNotice, whileBusy } from "@/modules/pipeline/steering.ts";
import { TurnContext } from "@/modules/pipeline/turn-context.ts";
import { envelope, sleep } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

/** A brief with nothing in it but its goal — what these helpers do is not the question here. */
const brief = (goal: string) => ({ goal, context: "a lane test", deliverable: "done" });

/** Runs `work` while counting how many are inside at once. */
function meter() {
  let now = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async inside(ms: number): Promise<void> {
      now += 1;
      peak = Math.max(peak, now);
      await sleep(ms);
      now -= 1;
    },
  };
}

describe("a turn's lanes", () => {
  test("its own first, more only where the ceiling has room", async () => {
    let room = 2;
    const lanes = new TurnLanes(() => (room > 0 ? (room--, () => void room++) : null));
    const m = meter();
    await Promise.all([1, 2, 3, 4].map(() => lanes.run(() => m.inside(20))));
    // Its own lane and the two the ceiling had: three at once, the fourth after.
    expect(m.peak).toBe(3);
    expect(room).toBe(2);
    expect(lanes.idle).toBe(true);
  });

  test("at the ceiling, one after another on its own — every one done, none failed for want of a slot", async () => {
    const lanes = new TurnLanes(() => null);
    const m = meter();
    const done = await Promise.all([1, 2, 3, 4].map((n) => lanes.run(async () => (await m.inside(5), n))));
    expect(done).toEqual([1, 2, 3, 4]);
    expect(m.peak).toBe(1);
  });

  test("eight turns each delegating four, at a ceiling of eight: all finish, and never more than eight at once", async () => {
    const m = meter();
    let finished = 0;
    const queue: KeyedQueue<{ chat: string }> = new KeyedQueue({
      key: (item) => item.chat,
      maxConcurrentTotal: 8,
      handler: async () => {
        const lanes = new TurnLanes(() => queue.borrow());
        // The turn waits on its helpers, holding its slot — the case that stops a daemon whose helpers wait on one.
        await Promise.all([1, 2, 3, 4].map(() => lanes.run(() => m.inside(10))));
        finished += 1;
      },
    });
    for (let i = 0; i < 8; i++) queue.push({ chat: `chat-${i}` });
    await Promise.race([queue.idle(), sleep(5_000).then(() => Promise.reject(new Error("the turns never finished")))]);
    expect(finished).toBe(8);
    expect(m.peak).toBeLessThanOrEqual(8);
    expect(queue.stats().running).toBe(0);
  });
});

/** A `TurnContext` with nothing behind it: what is tested here touches none of its collaborators. */
const bare = () => new TurnContext({ tools: new Map() } as never, {} as never, {} as never);

describe("a peer turn, at work in the chat it runs in", () => {
  test("its agent is busy there for as long as it runs, and a second hold is refused", () => {
    const ctx = bare();
    const release = ctx.holdPeer("nox", "c1", "telegram:main");
    expect(release).not.toBeNull();
    expect(ctx.isBusy("nox", "c1", "telegram:main")).toBe(true);
    expect(ctx.isBusy("nox", "c2", "telegram:main")).toBe(false);
    expect(ctx.holdPeer("nox", "c1", "telegram:main")).toBeNull();
    release!();
    release!();
    expect(ctx.isBusy("nox", "c1", "telegram:main")).toBe(false);
  });

  test("a person addressing it is told it is busy — quoting nothing the room never saw, offering nothing to steer", () => {
    const ctx = bare();
    ctx.holdPeer("nox", "c1", "telegram:main");
    const turn = ctx.turnIn("nox", "c1", "telegram:main");
    const asked = envelope({ chatId: "c1", chatType: "group", senderId: "ana", text: "@nox what's the status?" });
    expect(whileBusy(turn, asked, { addressed: true, fromPerson: true, steer: true })).toBe("tell");
    expect(busyNotice({ id: "nox", displayName: "Nox" }, turn, { parked: false, now: turn!.startedAt! + 12_000 })).toBe(
      "⏳ Nox is still working (12s so far): ask again once it's done.",
    );
  });

  test("a job's wake-up waits for it to end, as it waits for the agent's own turn — not dropped as busy", async () => {
    const ctx = bare();
    const release = ctx.holdPeer("nox", "c1", "telegram:main")!;
    let woke = false;
    const wake = ctx.waitUntilFree("nox", "c1", "telegram:main").then(() => void (woke = true));
    await sleep(5);
    expect(woke).toBe(false);
    release();
    await wake;
    expect(woke).toBe(true);
  });

  test("a turn's lanes are forgotten once nothing it started runs or waits", async () => {
    const ctx = bare();
    await Promise.all([ctx.inLane("turn_1", () => sleep(5)), ctx.inLane("turn_1", () => sleep(5))]);
    expect((ctx as unknown as { lanes: Map<string, unknown> }).lanes.size).toBe(0);
  });
});

describe("through the pipeline", () => {
  const benches: Bench[] = [];
  afterEach(() => {
    for (const bench of benches.splice(0)) bench.dispose();
  });

  /** Two agents behind one bot, a provider whose answers are held until let go, and the ceiling given. */
  async function daemon(maxConcurrentTurns: number) {
    let held: Promise<void> = Promise.resolve();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      await sleep(5);
      await held;
      if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return Response.json({ model: "test-model", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as unknown as typeof fetch;
    let inFlight = 0;
    let peak = 0;
    const counted = (async (url: string, init: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await fetchImpl(url, init);
      } finally {
        inFlight -= 1;
      }
    }) as unknown as typeof fetch;

    const bench = await pipelineBench({
      agents: ["nouva", "nox"],
      config: {
        llm: { defaults: { provider: "test", model: "test-model" }, streaming: { enabled: false } },
        gateways: { telegram: { main: { enabled: false, token: "telegram-main" } } },
        queue: { max_concurrent_turns: maxConcurrentTurns },
      },
      fetch: () => counted,
    });
    benches.push(bench);
    const { pipeline, gateway, dataDir } = bench;
    pipeline.setTools(new Map());
    const asking = (signal = new AbortController().signal): ToolContext =>
      ({ agentId: "nouva", sessionId: "ses_nouva:c1", turnId: "turn_1", chatId: "c1", chatType: "group", gateway: "telegram", gatewayId: gateway.id, senderId: "ana", workspaceDir: dataDir, agentDir: dataDir, workspaceRoots: [dataDir], signal }) as ToolContext;
    return {
      pipeline,
      asking,
      peak: () => peak,
      hold(): () => void {
        let open!: () => void;
        held = new Promise<void>((resolve) => (open = resolve));
        return open;
      },
    };
  }

  test("a delegated batch takes the turn's own lane and what the ceiling has free — the wiring to the queue", async () => {
    const one = await daemon(1);
    // Nothing else running: the ceiling of one has one slot free, the turn's own lane is the other.
    const results = await Promise.all(["a", "b", "c"].map((goal) => one.pipeline.subagentRunner()({ brief: brief(goal), ctx: one.asking() })));
    expect(results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(one.peak()).toBe(2);

    const roomy = await daemon(8);
    await Promise.all(["a", "b", "c"].map((goal) => roomy.pipeline.subagentRunner()({ brief: brief(goal), ctx: roomy.asking() })));
    expect(roomy.peak()).toBe(3);
  });

  test("an agent at work for another is not asked again in that chat until it is done", async () => {
    const d = await daemon(8);
    const open = d.hold();
    const first = d.pipeline.peerTurnRunner()({ to: "nox", from: "nouva", task: "check the build", ctx: d.asking() });
    await sleep(10);

    const second = await d.pipeline.peerTurnRunner()({ to: "nox", from: "nouva", task: "and the tests", ctx: d.asking() });
    expect(second.status).toBe("failed");
    expect(second.reason).toContain("nox is already working in this chat");

    open();
    expect((await first).status).toBe("success");
    const third = await d.pipeline.peerTurnRunner()({ to: "nox", from: "nouva", task: "and the tests", ctx: d.asking() });
    expect(third.status).toBe("success");
  });
});
