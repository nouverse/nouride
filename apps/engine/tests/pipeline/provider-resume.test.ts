/**
 * A turn its model provider ended is tried again once, a few minutes on (`modules/pipeline/provider-resume.ts`).
 *
 * The request is retried for half a minute first; a provider down for longer used to end the turn for good,
 * kept, until somebody said "continue". Each case here is a condition that keeps the second try from being
 * a surprise: only a failure that waiting can fix, only once, and not after the person moved on.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { resumeAfterBoot } from "@/boot/durable.ts";
import { providerResumesOwed, scheduleProviderResume, type ResumableTurn } from "@/modules/pipeline/provider-resume.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually, sleep } from "../wait.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const made of benches.splice(0)) made.dispose();
});

const TURN: ResumableTurn = { id: "turn_1", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814", prompt: "deploy the site", messageId: "m1" };

describe("scheduling", () => {
  test("takes the turn up once the delay is over", async () => {
    const resumed: string[] = [];
    expect(scheduleProviderResume(TURN, { resume: (turn) => (resumed.push(turn.id), true), movedOn: () => false, stopping: () => false, delayMs: 20 })).toBe(true);
    await sleep(80);
    expect(resumed).toEqual(["turn_1"]);
  });

  test("leaves it to a person who said something since, and to a daemon going down", async () => {
    const resumed: string[] = [];
    scheduleProviderResume(TURN, { resume: (turn) => (resumed.push(turn.id), true), movedOn: () => true, stopping: () => false, delayMs: 20 });
    scheduleProviderResume(TURN, { resume: (turn) => (resumed.push(turn.id), true), movedOn: () => false, stopping: () => true, delayMs: 20 });
    await sleep(80);
    expect(resumed).toEqual([]);
  });

  test("a check that throws is logged where it fails, not thrown out of the timer", async () => {
    // Out of a timer a throw is an uncaught exception — the daemon shuts down on one, and a test run blames whatever
    // test is running minutes later: a database a finished test had closed failed an update test this way.
    const resumed: string[] = [];
    const closed = () => {
      throw new RangeError("Cannot use a closed database");
    };
    expect(scheduleProviderResume(TURN, { resume: (turn) => (resumed.push(turn.id), true), movedOn: closed, stopping: () => false, delayMs: 20 })).toBe(true);
    await sleep(80);
    expect(resumed).toEqual([]);
  });

  test("is not for a cron run, nor for a turn that was itself a second try", () => {
    const deps = { resume: () => true, movedOn: () => false, stopping: () => false, delayMs: 20 };
    expect(scheduleProviderResume({ ...TURN, chatId: "cron:job_1" }, deps)).toBe(false);
    expect(scheduleProviderResume({ ...TURN, messageId: "resume:turn_0" }, deps)).toBe(false);
  });
});

/** A daemon whose provider answers every request with `status`, and `headers` beside it. */
async function bench(status: number, headers: Record<string, string> = {}) {
  let calls = 0;
  const failing = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
  const made = await pipelineBench({
    fetch: () => failing,
    maxAttempts: 1,
    gateway: new FakeGateway("telegram:nouva"),
    deps: { providerResumeMs: 40 },
  });
  benches.push(made);
  const { pipeline, gateway, turns, db } = made;
  pipeline.attach();
  return { pipeline, gateway, turns, db, calls: () => calls };
}

describe("a turn its provider ended", () => {
  test("says it will try again, does — once — and the second try is marked as one", async () => {
    const b = await bench(503);
    b.gateway.receive(envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", text: "deploy the site", timestamp: Date.now() }));
    await b.pipeline.idle();
    expect(b.gateway.sent.at(-1)?.text).toContain("I'll try again in a few minutes");
    // Its own "try again" is not said beside the daemon's — that read as two instructions at once.
    expect(b.gateway.sent.at(-1)?.text).not.toContain("Try again shortly");

    await sleep(150);
    await b.pipeline.idle();
    await sleep(150);
    await b.pipeline.idle();

    const rows = b.db.prepare<{ message_id: string; status: string }>("SELECT message_id, status FROM turn_records ORDER BY started_at").all();
    expect(rows.map((row) => row.message_id)).toEqual(["m1", expect.stringMatching(/^resume:turn_/)]);
    expect(rows.map((row) => row.status)).toEqual(["failed", "failed"]);
    // The second try failed too, and said so without promising a third.
    expect(b.gateway.sent.at(-1)?.text).not.toContain("I'll try again");
  });

  /**
   * "Every provider failed" behind Nougate: its error response names the providers it tried, in `x-nougate-tried`, and
   * the turn's failure — the record an operator reads, and its end on the event stream — says them. The chat does not.
   */
  test("through a gateway that tried several providers, its failure names them — for the operator, not the chat", async () => {
    const b = await bench(502, { "x-nougate-tried": "antigravity,claudecode", "x-nougate-attempts": "2" });
    b.gateway.receive(envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", text: "deploy the site", timestamp: Date.now() }));
    await b.pipeline.idle();

    const turn = b.db.prepare<{ status: string; error: string }>("SELECT status, error FROM turn_records WHERE message_id = 'm1'").get();
    expect(turn?.status).toBe("failed");
    expect(turn?.error).toContain("(through nougate, tried antigravity, claudecode)");
    expect(b.gateway.sent.map((message) => message.text).join("\n")).not.toContain("antigravity");
    // The second try a 502 schedules runs here rather than after this test's database is closed.
    await eventually(() => b.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM turn_records").get()?.n === 2, 2_000, "the second try");
    await b.pipeline.idle();
  });

  test("is left alone when waiting cannot fix it — a refused key is the operator's to fix", async () => {
    const b = await bench(401);
    b.gateway.receive(envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", text: "deploy the site", timestamp: Date.now() }));
    await b.pipeline.idle();
    expect(b.gateway.sent.at(-1)?.text ?? "").not.toContain("try again");

    await sleep(150);
    await b.pipeline.idle();
    expect(b.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM turn_records").get()?.n).toBe(1);
  });

  test("is left to the person once they have said something since", async () => {
    const b = await bench(503);
    b.gateway.receive(envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", text: "deploy the site", timestamp: Date.now() }));
    await b.pipeline.idle();
    b.gateway.receive(envelope({ id: "m2", gatewayId: "telegram:nouva", chatId: "814", text: "never mind", timestamp: Date.now() }));
    await b.pipeline.idle();

    await sleep(150);
    await b.pipeline.idle();
    const ids = b.db.prepare<{ message_id: string }>("SELECT message_id FROM turn_records ORDER BY started_at").all().map((row) => row.message_id);
    // m2's own failure schedules its own second try; m1's is dropped, because m2 came after it.
    expect(ids.filter((id) => id.startsWith("resume:"))).toHaveLength(1);
    expect(ids.slice(0, 2)).toEqual(["m1", "m2"]);
  });
});

/**
 * The promise outlives the process. The timer lived in memory, and the turn was closed `failed`, where the boot's own
 * resume looks only at `interrupted` ones: a restart inside those minutes — an update, a crash — left a person told
 * "I'll try again in a few minutes" with nothing coming.
 */
describe("a turn its provider ended, across a restart", () => {
  const MINUTE = 60_000;
  /** Turns that took another up, by their message id. */
  const resumptions = (made: Bench): string[] =>
    made.db.prepare<{ message_id: string }>("SELECT message_id FROM turn_records WHERE message_id LIKE 'resume:%'").all().map((row) => row.message_id);

  /** The next process over the same install, booted as `index.ts` boots one: gateways up, then what the restart owes. */
  async function restart(previous: Bench): Promise<Bench> {
    // The shutdown's first step, which stops the last process's timers from taking anything up.
    previous.pipeline.pause();
    const next = await previous.reboot({ turns: [{ text: "deployed" }], maxAttempts: 1, gateway: new FakeGateway("telegram:nouva"), deps: { providerResumeMs: 40 } });
    next.pipeline.attach();
    await resumeAfterBoot({
      recovered: [], orphaned: [], stores: next.durable, startedAt: Date.now(), pipeline: next.pipeline, turns: next.turns,
      notifier: { toChat: async () => true }, chatEvents: { record: () => null },
    });
    return next;
  }

  test("is taken up by the next process, once, however many restarts follow", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    // The first process would wait a minute: it is restarted long before its own timer fires.
    const first = await pipelineBench({ fetch: () => failing, maxAttempts: 1, gateway: new FakeGateway("telegram:nouva"), deps: { providerResumeMs: MINUTE } });
    benches.push(first);
    first.pipeline.attach();
    first.gateway.receive(envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", text: "deploy the site", timestamp: Date.now() }));
    await first.pipeline.idle();
    expect(first.gateway.sent.at(-1)?.text).toContain("I'll try again in a few minutes");
    const failed = first.db.prepare<{ id: string }>("SELECT id FROM turn_records WHERE message_id = 'm1'").get()!.id;

    const second = await restart(first);
    await eventually(() => resumptions(second).length === 1, 2_000, "the turn taken up after the restart");
    await second.pipeline.idle();
    expect(resumptions(second)).toEqual([`resume:${failed}`]);
    expect(second.gateway.sent.at(-1)?.text).toBe("deployed");

    // And a restart after that does not take it up again.
    const third = await restart(second);
    await sleep(150);
    await third.pipeline.idle();
    expect(resumptions(third)).toEqual([`resume:${failed}`]);
  });

  test("only within the timer's window, only a reply that promised it, and only once", async () => {
    const made = await pipelineBench({ gateway: new FakeGateway("telegram:nouva") });
    benches.push(made);
    const { turns } = made;
    const ended = (reply: string, chatId = "814"): string => {
      const id = turns.begin({ sessionId: `ses_nouva:telegram:nouva:${chatId}`, agentId: "nouva", gatewayId: "telegram:nouva", chatId, prompt: "deploy the site" });
      turns.finish(id, { status: "failed", reply, error: "503" });
      return id;
    };
    const promised = ended(`The model is not responding right now. I'll try again in a few minutes, or say "continue".`);
    ended("The model's provider refused my key. Ask whoever runs me to check it.", "815");

    expect(providerResumesOwed(turns, Date.now()).map((turn) => turn.id)).toEqual([promised]);
    // Past the most the timer waits (three minutes and up to one more), it is not taken up.
    expect(providerResumesOwed(turns, Date.now() + 5 * MINUTE)).toEqual([]);
    // Taken up already, by the last process's timer or a boot before this one.
    turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814", prompt: "[system] carry on", messageId: `resume:${promised}` });
    expect(providerResumesOwed(turns, Date.now())).toEqual([]);
  });
});
