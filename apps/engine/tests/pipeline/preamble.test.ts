/**
 * The opening line before long work — the words a model writes beside its tool calls, said to the chat at once.
 *
 * Live: a WhatsApp group waited eight minutes through a fifteen-step turn with no message at all. Through a real turn
 * here: the line is sent before the work is done, once per turn unless the work runs long, never repeated in the
 * answer, never for a system event, and on a connection that cannot edit a message.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { GatewayName } from "@nouride/shared";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { Preamble, PREAMBLE_GAP_MS } from "@/modules/pipeline/preamble.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench, type BenchOptions } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

const OPENING = "Oke Kak, aku cek 52 dokumennya dulu ya.";
const STATUS = "Udah 30 dari 52.";
const ANSWER = "Semua 52 dokumen sudah dicek, tiga yang belum ditandatangani.";
const step = (id: string, text?: string) => ({ ...(text ? { text } : {}), toolCalls: [{ id, name: "probe", args: { n: id } }] });

/** A platform with no way to edit a message — WhatsApp's shape, where the progress line cannot run. */
class PlainGateway extends FakeGateway {
  constructor(id = "whatsapp:main", platform: GatewayName = "whatsapp") {
    super(id, platform);
  }
}
Object.defineProperty(PlainGateway.prototype, "editMessage", { value: undefined });

async function run(turns: BenchOptions["turns"], options: { gateway?: FakeGateway; gapMs?: number; from?: Partial<ReturnType<typeof envelope>>; progress?: boolean; seen?: string[][] } = {}) {
  const gateway = options.gateway ?? new FakeGateway();
  const bench = await pipelineBench({
    turns,
    gateway,
    ...(options.progress === false ? { config: { llm: { streaming: { progress_in_chat: false } } } } : {}),
    // What the chat held when each request reached the model — the line is in it before the work is done.
    ...(options.seen ? { fetch: (scripted: typeof fetch) => (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      options.seen!.push(gateway.sent.map((m) => m.text));
      return await scripted(url, init);
    }) as typeof fetch } : {}),
    deps: { progressIntervalMs: 1, ...(options.gapMs === undefined ? {} : { preambleGapMs: options.gapMs }) },
  });
  benches.push(bench);
  bench.pipeline.attach();
  gateway.receive(envelope({ text: "cek semua dokumennya", timestamp: Date.now(), gateway: gateway.platform, gatewayId: gateway.id, ...options.from }));
  await bench.pipeline.idle();
  return { bench, gateway, texts: gateway.sent.map((m) => m.text) };
}

describe("the opening line before long work", () => {
  test("is in the chat before the work is done, ahead of the progress line", async () => {
    const seen: string[][] = [];
    const { texts } = await run([step("c1", OPENING), { text: ANSWER }], { seen });
    // The second request is the model reading its tool's result: the line was already sent by then.
    expect(seen[1]?.[0]).toBe(OPENING);
    // First in the chat — the progress line the first tool posts comes after it — and the answer last.
    expect(texts[0]).toBe(OPENING);
    expect(texts).toContain(ANSWER);
    expect(texts.filter((t) => t === OPENING)).toHaveLength(1);
  });

  test("a second one soon after the first stays in the conversation and out of the chat", async () => {
    const { bench, texts } = await run([step("c1", OPENING), step("c2", STATUS), { text: ANSWER }]);
    expect(texts).toContain(OPENING);
    expect(texts).not.toContain(STATUS);
    // Not lost: the session has both lines, once each, in order, with the answer after them.
    const stored = JSON.stringify(bench.sessions.load({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" }).messages);
    expect(stored.indexOf(OPENING)).toBeGreaterThan(-1);
    expect(stored.indexOf(STATUS)).toBeGreaterThan(stored.indexOf(OPENING));
    expect(stored.indexOf(ANSWER)).toBeGreaterThan(stored.indexOf(STATUS));
    expect(stored.split(OPENING)).toHaveLength(2);
  });

  // On a live box, in thirty days, every one of 155 lines held back was a status under 200 characters, and one text of
  // 3,149 was held with them: a whole answer written beside a `notes` call, in the conversation and in no chat.
  test("more than a line written beside a call is no status: it goes out whatever the gap, and the short one after it is still held", async () => {
    const REPORT = "Gw udah baca README-nya. Menurut gw ada 4 poin:\n\n1. Yang pertama.\n2. Yang kedua.";
    const { texts } = await run([step("c1", OPENING), step("c2", REPORT), step("c3", STATUS), { text: ANSWER }]);
    expect(texts).toContain(OPENING);
    expect(texts).toContain(REPORT);
    expect(texts).not.toContain(STATUS);
    expect(texts.indexOf(REPORT)).toBeLessThan(texts.indexOf(ANSWER));
  });

  // A person's turn that ends on a dot: what it wrote beside its last call is its answer, sent once.
  test("a turn that ends on no word at all sends what it wrote beside a call and nobody was sent", async () => {
    const { texts } = await run([step("c1", OPENING), step("c2", STATUS), { text: "." }]);
    expect(texts.filter((text) => text === OPENING)).toHaveLength(1);
    expect(texts).toContain(STATUS);
    expect(texts).not.toContain(".");
  });

  test("a later one goes out once the gap has passed", async () => {
    const { texts } = await run([step("c1", OPENING), step("c2", STATUS), { text: ANSWER }], { gapMs: 0 });
    expect(texts.indexOf(STATUS)).toBeGreaterThan(texts.indexOf(OPENING));
    expect(texts.indexOf(ANSWER)).toBeGreaterThan(texts.indexOf(STATUS));
  });

  test("a later one closes the bubble above it, and the steps after it start one below (0.8.5)", async () => {
    // Left open, the bubble went on being edited above the words — where nobody was looking — and counted both steps.
    const { texts } = await run([step("c1", OPENING), step("c2", STATUS), { text: ANSWER }], { gapMs: 0 });
    const read = texts.map((t) => t.replace(/ · \d+s$/, ""));
    expect(read.slice(0, 3)).toEqual([OPENING, "[nouva] ✓ 1 step", STATUS]);
    expect(read.at(-1)).toBe(ANSWER);
    // The second step's bubble — there when the turn lasted long enough to post it — counts its own step alone.
    expect(read.filter((t) => t.startsWith("[nouva]")).every((t) => t === "[nouva] ✓ 1 step")).toBe(true);
  });

  test("an answer with no tool call is one message, as it always was", async () => {
    const { texts } = await run([{ text: ANSWER }]);
    expect(texts).toEqual([ANSWER]);
  });

  test("the answer does not repeat the opening line", async () => {
    // A turn whose model writes the same words again at the end: the person has them already.
    const { texts } = await run([step("c1", OPENING), { text: OPENING }], { gateway: new PlainGateway() });
    expect(texts).toEqual([OPENING]);
  });

  test("works on a platform that cannot edit a message", async () => {
    const { texts } = await run([step("c1", OPENING), { text: ANSWER }], { gateway: new PlainGateway() });
    // No progress line there — the opening line and the answer are all the chat gets.
    expect(texts).toEqual([OPENING, ANSWER]);
  });

  test("quotes the message it answers in a group, as the answer does", async () => {
    const { gateway } = await run([step("c1", OPENING), { text: ANSWER }], { gateway: new PlainGateway(), from: { chatType: "group", id: "m-42", text: "nouva: cek semua dokumennya" } });
    expect(gateway.sent[0]).toMatchObject({ text: OPENING, replyTo: "m-42" });
  });

  test("is not sent for a system event, which nobody is waiting on", async () => {
    const { texts } = await run([step("c1", OPENING), { text: ANSWER }], {
      gateway: new PlainGateway(),
      from: { senderId: SYSTEM_SENDER, text: "Background job job_7 finished", raw: { via: "job completion", job: "job_7", outcome: "ok" } },
    });
    expect(texts).not.toContain(OPENING);
    expect(texts).toContain(ANSWER);
  });

  // Live, in a WhatsApp chat: a helper came back having failed. The agent wrote its whole report and a question for the
  // person in the same step as a `notes` call, then ended on "." ("already reported"). The daemon sent nothing: the
  // person waited nine minutes on a promise of news, and the agent on an answer to a question nobody had been sent.
  test("a system event's turn that wrote its report beside a call and ended on a full stop: the report is the answer, sent once and recorded", async () => {
    const REPORT = "Belum ada yang berubah di file-nya.\n\nSebelum aku tulis, ada satu hal yang mau aku pastiin: bener gitu?";
    const { bench, texts } = await run([step("c1", REPORT), { text: "." }], {
      gateway: new PlainGateway(),
      from: { senderId: SYSTEM_SENDER, text: "Background helper job_7 finished", raw: { via: "job completion", job: "job_7", outcome: "finished", helper: true } },
    });
    expect(texts).toEqual([REPORT]);
    // What the record says the person was told: the dashboard shows it, and nothing is owed again after a restart.
    expect(bench.turns.forChat("whatsapp:main", "chat-1").at(-1)?.reply).toBe(REPORT);
  });

  test("a system event's turn that ends on a full stop having written nothing says nothing, as it may", async () => {
    const { texts } = await run([step("c1"), { text: "." }], {
      gateway: new PlainGateway(),
      from: { senderId: SYSTEM_SENDER, text: "Background job job_7 finished", raw: { via: "job completion", job: "job_7", outcome: "ok" } },
    });
    expect(texts).toEqual([]);
  });

  test("is not sent when the chat is told nothing of the work", async () => {
    const { texts } = await run([step("c1", OPENING), { text: ANSWER }], { gateway: new PlainGateway(), progress: false });
    expect(texts).toEqual([ANSWER]);
  });
});

describe("when a later line may go out", () => {
  test("the first goes at once, the next only two minutes after the last one sent", async () => {
    let now = 1_000_000;
    const sent: string[] = [];
    const preamble = new Preamble(async (words) => void sent.push(words), { now: () => now });
    expect(await preamble.offer(OPENING)).toBe(true);
    now += PREAMBLE_GAP_MS - 1;
    expect(await preamble.offer("held back")).toBe(false);
    now += 1;
    expect(await preamble.offer(STATUS)).toBe(true);
    // Measured from the last one sent, not the last one offered.
    now += PREAMBLE_GAP_MS / 2;
    expect(await preamble.offer("held too")).toBe(false);
    expect(sent).toEqual([OPENING, STATUS]);
    expect(preamble.alreadySaid(` ${STATUS}\n`)).toBe(true);
    expect(preamble.alreadySaid("held back")).toBe(false);
  });

  test("inside the gap one line is held and more than a line is not", async () => {
    let now = 1_000_000;
    const sent: string[] = [];
    const preamble = new Preamble(async (words) => void sent.push(words), { now: () => now });
    expect(await preamble.offer(OPENING)).toBe(true);
    now += 1_000;
    expect(await preamble.offer("one line, held")).toBe(false);
    expect(await preamble.offer("two lines:\nthe second")).toBe(true);
    // And it counts as the last one sent: the status after it waits its two minutes from here.
    now += PREAMBLE_GAP_MS - 1;
    expect(await preamble.offer("held again")).toBe(false);
    expect(sent).toEqual([OPENING, "two lines:\nthe second"]);
  });

  test("a message of its own goes whatever the gap — a coding CLI's words between its steps (0.8.5)", async () => {
    let now = 1_000_000;
    const sent: string[] = [];
    const preamble = new Preamble(async (words) => void sent.push(words), { now: () => now });
    expect(await preamble.offer(OPENING, { own: true })).toBe(true);
    now += 1;
    expect(await preamble.offer(STATUS, { own: true })).toBe(true);
    // A model's words beside its next step are still a status, and wait their two minutes.
    expect(await preamble.offer("held back")).toBe(false);
    expect(sent).toEqual([OPENING, STATUS]);
  });

  test("blank words are never a line", async () => {
    const sent: string[] = [];
    const preamble = new Preamble(async (words) => void sent.push(words));
    expect(await preamble.offer("  \n")).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a line that calls another agent is kept for the answer — the other bot would start on it, then again", async () => {
    const sent: string[] = [];
    const preamble = new Preamble(async (words) => void sent.push(words), { callsAnotherAgent: (text) => /@nero\b/i.test(text) });
    expect(await preamble.offer("Oke, @Nero tolong cek ya")).toBe(false);
    expect(await preamble.offer("Oke, aku cek dulu")).toBe(true);
    expect(sent).toEqual(["Oke, aku cek dulu"]);
  });

  test("a platform that hangs on the send does not hold the work", async () => {
    const preamble = new Preamble(() => new Promise(() => {}), { sendWaitMs: 20 });
    const started = Date.now();
    expect(await preamble.offer("Oke, aku cek dulu")).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
