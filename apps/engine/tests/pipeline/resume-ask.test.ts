/**
 * A turn cut off longer ago than one is taken up unasked is asked about, once (`modules/pipeline/resume-ask.ts`).
 *
 * A turn a restart cut off told its person "I'll carry on once I'm back", and was taken up by itself only when the
 * daemon was back within a quarter of an hour. Past that nothing happened, ever: on a box in a shop a power cut of an
 * hour is ordinary, and whoever was waiting does not know to say "continue". Each case here is a process stopped or
 * lost and the next one booted the way `index.ts` boots it: the journals closed, the gateways up, then what the restart
 * owes (`boot/durable.ts`), with the words a chat reads asserted whole.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "@nouride/runtime";
import type { ChatMessage, Tool } from "@nouride/shared";
import { recoverTurns, resumeAfterBoot } from "@/boot/durable.ts";
import { Notifier } from "@/commons/notify.ts";
import { migrate } from "@/db/index.ts";
import { MIGRATIONS } from "@/db/migrations.ts";
import { routePresses } from "@/modules/gateways/presses.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { ASK_WITHIN_MS, continuePresses } from "@/modules/pipeline/resume-ask.ts";
import { closeTurn, interruptionReport } from "@/modules/turns/close.ts";
import { SCHEDULED } from "@/modules/turns/turns.store.ts";
import { envelope, FakeGateway, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BOT = "telegram:nouva";
const CHAT = "814";

const benches: Bench[] = [];
afterEach(() => {
  for (const made of benches.splice(0)) made.dispose();
});

const QUESTION = `I have not carried on by myself, since it was a while ago. Say "continue" and I will pick it up.`;

/** The first process of an install: one agent with a tool, on a Telegram bot. */
async function install(options: { turns?: Parameters<typeof scriptedOpenAI>[0]; duringTool?: (bench: Bench) => void } = {}): Promise<Bench> {
  const bench = await pipelineBench({
    turns: options.turns ?? [],
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\n',
    gateway: new FakeGateway(BOT),
    maxAttempts: 1,
  });
  benches.push(bench);
  let runs = 0;
  const probe: Tool = {
    requiresApproval: false,
    definition: { name: "probe", description: "checks a thing", parameters: { type: "object", properties: {} } },
    async execute() {
      runs += 1;
      options.duringTool?.(bench);
      return { content: `probe ${runs} ok`, isError: false };
    },
  };
  bench.pipeline.setTools(new Map([["probe", probe]]));
  bench.pipeline.attach();
  return bench;
}

/** A person's message in the bot's one-to-one chat, answered or cut off before this returns. */
async function says(bench: Bench, text: string, id = "m1"): Promise<void> {
  bench.gateway.receive(envelope({ id, gatewayId: BOT, chatId: CHAT, senderId: CHAT, text, timestamp: Date.now() }));
  await bench.pipeline.idle();
}

/** A turn the shutdown stopped after its first step, as the daemon stops one: asked to stop, closed, its chat told. */
async function stoppedMidWork(): Promise<{ bench: Bench; turnId: string }> {
  const bench = await install({ turns: [{ toolCalls: [{ id: "c1", name: "probe", args: {} }] }, { text: "never asked for" }], duringTool: (made) => made.pipeline.pause() });
  await says(bench, "deploy the site");
  const turnId = bench.db.prepare<{ id: string }>("SELECT id FROM turn_records WHERE message_id = 'm1'").get()!.id;
  return { bench, turnId };
}

/** Move a turn into the past: it began and ended `ms` earlier than it did. */
function aged(bench: Bench, turnId: string, ms: number): void {
  bench.db.prepare("UPDATE turn_records SET started_at = started_at - ?, ended_at = ended_at - ? WHERE id = ?").run(ms, ms, turnId);
}

/** What the last boot put on its chats' timelines, as the dashboard reads them. */
let timeline: { chatId: string; text: string }[] = [];

/** The next process over the same install, booted as `index.ts` boots one. Its gateway carries buttons unless told not to. */
async function restart(previous: Bench, options: { answers?: string[]; buttons?: boolean; gateways?: FakeGateway[] } = {}): Promise<Bench> {
  previous.pipeline.pause();
  timeline = [];
  const gateway = new FakeGateway(BOT);
  if (options.buttons !== false) gateway.buttons = true;
  const next = await previous.reboot({
    turns: (options.answers ?? ["deployed"]).map((text) => ({ text })),
    maxAttempts: 1,
    ...(options.gateways ? { gateways: [gateway, ...options.gateways] } : { gateway }),
  });
  // Before anything listens: what the last process left unfinished is closed (`boot/stores.ts`).
  const recovered = recoverTurns({ ...next.durable, sessions: next.sessions, turns: next.turns, maxTurns: 200 });
  next.pipeline.setTools(new Map());
  next.pipeline.attach();
  routePresses(next.gateways.values(), [continuePresses({ turns: next.turns, resume: (turn, why) => next.pipeline.resumeTurn(turn, why), isAdmin: () => false })]);
  await resumeAfterBoot({
    recovered, orphaned: [], stores: next.durable, startedAt: Date.now(), pipeline: next.pipeline, turns: next.turns,
    notifier: new Notifier({ gateways: next.gateways }), chatEvents: { record: (event) => (timeline.push({ chatId: event.chatId, text: event.text }), null) },
  });
  await next.pipeline.idle();
  // The gateway the bench made is the one the test reads, whichever list it went in by.
  return { ...next, gateway };
}

const resumptions = (bench: Bench): string[] =>
  bench.db.prepare<{ message_id: string }>("SELECT message_id FROM turn_records WHERE message_id LIKE 'resume:%' ORDER BY started_at").all().map((row) => row.message_id);
const askedAt = (bench: Bench, turnId: string): number | null =>
  bench.db.prepare<{ resume_asked_at: number | null }>("SELECT resume_asked_at FROM turn_records WHERE id = ?").get(turnId)?.resume_asked_at ?? null;
const said = (bench: Bench): string[] => bench.gateway.sent.map((message) => message.text);

/** A turn the last process's shutdown closed, written as its record holds it — for the turns no chat would start. */
function closedByShutdown(bench: Bench, over: { gatewayId?: string; chatId?: string; cause?: { via: string; job: string }; messageId?: string } = {}): string {
  const gatewayId = over.gatewayId ?? BOT;
  const chatId = over.chatId ?? CHAT;
  const id = bench.turns.begin({
    sessionId: `ses_nouva:${gatewayId}:${chatId}`, agentId: "nouva", gatewayId, chatId, prompt: "deploy the site", senderId: CHAT,
    ...(over.messageId ? { messageId: over.messageId } : {}),
    ...(over.cause ? { cause: over.cause } : {}),
  });
  bench.turns.finish(id, { status: "interrupted", reply: "⚠️ I was interrupted by a restart…", error: "the daemon restarted while this turn was running" });
  return id;
}

/** A turn lost in a crash `ago` before now: its record still running, its journal open with a call that was running. */
function lostInCrash(bench: Bench, ago: number, over: { chatId?: string } = {}): string {
  const at = Date.now() - ago;
  const chatId = over.chatId ?? CHAT;
  const turnId = bench.turns.begin({ sessionId: `ses_nouva:${BOT}:${chatId}`, agentId: "nouva", gatewayId: BOT, chatId, prompt: "deploy the site", senderId: CHAT, messageId: "m1" });
  bench.db.prepare("UPDATE turn_records SET started_at = ? WHERE id = ?").run(at, turnId);
  const question: ChatMessage = { role: "user", content: "deploy the site", timestamp: at };
  const journal = bench.journal.open(turnId, { agentId: "nouva", gatewayId: BOT, chatId, kind: "chat", startedAt: at }, question);
  journal.record({ role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read", arguments: { path: "site.toml" } }], timestamp: at });
  journal.started(["r1"]);
  journal.record({ role: "tool", toolCallId: "r1", content: "[site] name = x", timestamp: at });
  journal.record({ role: "assistant", content: "", toolCalls: [{ id: "e1", name: "exec", arguments: { command: "./deploy.sh" } }], timestamp: at });
  journal.started(["e1"]);
  return turnId;
}

describe("as the daemon stops", () => {
  test("the notice says what each case brings, and promises neither", async () => {
    const { bench } = await stoppedMidWork();
    expect(said(bench).at(-1)).toBe(
      '⚠️ I was interrupted by a restart while working on "deploy the site". Done: `probe`. Everything I did is kept. ' +
        "If I'm back within 15 minutes I'll carry on by myself; after that I'll ask you first.",
    );
  });

  test("a turn stopped before it did anything says the same of its answer", () => {
    const closed = closeTurn([{ message: { role: "user", content: "what is this?" } }], { kind: "restart" });
    expect(interruptionReport(closed, "what is this?", { kind: "if-soon", withinMs: 15 * MINUTE })).toBe(
      `⚠️ I was interrupted by a restart before I could answer "what is this?". Your message is kept. If I'm back within 15 minutes I'll answer it by myself; after that I'll ask you first.`,
    );
  });
});

describe("a turn the shutdown stopped, at the next boot", () => {
  test("five minutes on: carried on by itself, and nobody is asked", async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, 5 * MINUTE);
    const next = await restart(bench);

    expect(resumptions(next)).toEqual([`resume:${turnId}`]);
    expect(said(next)).toEqual(["deployed"]);
    expect(askedAt(next, turnId)).toBeNull();
  });

  test("an hour on: its chat is asked, with Continue under the question, and nothing is carried on", async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, HOUR);
    const next = await restart(bench);

    expect(said(next)).toEqual([`I was cut off 1 hour ago while working on "deploy the site". ${QUESTION}`]);
    expect(next.gateway.sent[0]?.buttons).toEqual([{ label: "Continue", data: `carry-on:${turnId}`, style: "positive" }]);
    expect(next.gateway.sent[0]?.chatId).toBe(CHAT);
    // And on the chat's timeline, which is where the dashboard reads what no turn said.
    expect(timeline).toEqual([{ chatId: CHAT, text: `I was cut off 1 hour ago while working on "deploy the site". ${QUESTION}` }]);
    // Asked, not done: no turn took it up, and the model was asked nothing.
    expect(resumptions(next)).toEqual([]);
    expect(next.requests).toEqual([]);
    expect(askedAt(next, turnId)).toBeGreaterThan(0);
  });

  test("asked once: a second boot, and a third, say nothing more and take nothing up", async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, HOUR);
    const second = await restart(bench);
    expect(said(second)).toHaveLength(1);

    const third = await restart(second);
    expect(said(third)).toEqual([]);
    const fourth = await restart(third);
    expect(said(fourth)).toEqual([]);
    expect(resumptions(fourth)).toEqual([]);
  });

  test("where the connection carries no buttons, the same words alone", async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, 20 * MINUTE);
    const next = await restart(bench, { buttons: false });
    expect(said(next)).toEqual([`I was cut off 20 minutes ago while working on "deploy the site". ${QUESTION}`]);
    expect(next.gateway.sent[0]?.buttons).toBeUndefined();
  });

  test("a question that could not be said is asked at the next boot, not marked as asked", async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, HOUR);
    bench.pipeline.pause();
    const down = new FakeGateway(BOT);
    down.failSend = new Error("the platform is unreachable");
    const second = await bench.reboot({ gateway: down, maxAttempts: 1 });
    second.pipeline.attach();
    await resumeAfterBoot({
      recovered: [], orphaned: [], stores: second.durable, startedAt: Date.now(), pipeline: second.pipeline, turns: second.turns,
      notifier: new Notifier({ gateways: second.gateways }), chatEvents: { record: () => null },
    });
    expect(askedAt(second, turnId)).toBeNull();

    const third = await restart(second);
    expect(said(third)).toEqual([`I was cut off 1 hour ago while working on "deploy the site". ${QUESTION}`]);
  });
});

describe("after the question", () => {
  test('"continue" carries on from what was kept: the model is sent the step that ran and the note that it was cut off', async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, HOUR);
    const next = await restart(bench, { answers: ["deployed"] });
    expect(said(next)).toHaveLength(1);

    await says(next, "continue", "m2");
    expect(said(next).at(-1)).toBe("deployed");
    const sent = JSON.stringify(next.requests.at(-1));
    expect(sent).toContain("deploy the site");
    expect(sent).toContain("probe 1 ok");
    expect(sent).toContain("I was interrupted here by a restart, before I finished");
    // Their own word, their own turn: not a turn the daemon began.
    expect(resumptions(next)).toEqual([]);
  });

  test("a press on Continue takes the turn up, once, and the question reads as settled", async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, HOUR);
    const next = await restart(bench, { answers: ["deployed"] });
    const press = { chatId: CHAT, chatType: "dm" as const, messageId: `${BOT}#1`, data: `carry-on:${turnId}`, senderId: CHAT, senderName: "Gading" };

    expect(await next.gateway.press(press)).toEqual({ notice: "Carrying on.", settled: 'I was cut off while working on "deploy the site". Carrying on now, as asked.' });
    await next.pipeline.idle();
    expect(resumptions(next)).toEqual([`resume:${turnId}`]);
    expect(said(next).at(-1)).toBe("deployed");
    // The question's message says what became of it, and its button is gone.
    expect(next.gateway.sent[0]).toMatchObject({ text: 'I was cut off while working on "deploy the site". Carrying on now, as asked.' });
    expect(next.gateway.sent[0]?.buttons).toBeUndefined();
    // What the agent is told names the work, says who asked, and to check what was cut off.
    const told = next.db.prepare<{ prompt: string }>("SELECT prompt FROM turn_records WHERE message_id = ?").get(`resume:${turnId}`)!.prompt;
    expect(told).toContain('The daemon restarted a while ago while you were working on "deploy the site", and they have now asked you to carry on.');
    expect(told).toContain("check what a cut-off step did before you repeat it");
    expect(JSON.stringify(next.requests.at(-1))).toContain("probe 1 ok");

    // A second press, on a copy of the message somewhere else: nothing more is taken up.
    expect((await next.gateway.press(press)).notice).toBe("I have carried on with that already.");
    await next.pipeline.idle();
    expect(resumptions(next)).toHaveLength(1);
  });

  test("in a room, only the person whose turn it was may press it; a button for a turn that is gone says so", async () => {
    const { bench, turnId } = await stoppedMidWork();
    aged(bench, turnId, HOUR);
    const next = await restart(bench);
    const press = { chatId: CHAT, chatType: "group" as const, messageId: `${BOT}#1`, data: `carry-on:${turnId}`, senderName: "Rani" };

    expect(await next.gateway.press({ ...press, senderId: "902" })).toEqual({ notice: "Only the person who asked for it, or an admin, can say that here." });
    expect(resumptions(next)).toEqual([]);
    expect((await next.gateway.press({ ...press, senderId: CHAT })).notice).toBe("Carrying on.");
    await next.pipeline.idle();
    expect(resumptions(next)).toEqual([`resume:${turnId}`]);

    expect(await next.gateway.press({ ...press, senderId: CHAT, data: "carry-on:turn_gone" })).toEqual({ notice: "That is not waiting any more." });
    // Pressed from another chat than the turn's: not that chat's to take up.
    expect(await next.gateway.press({ ...press, senderId: CHAT, chatId: "999" })).toEqual({ notice: "That is not waiting any more." });
  });
});

describe("who is not asked", () => {
  /** An install with one turn the shutdown closed, aged, and the next boot's messages. */
  async function bootedWith(make: (bench: Bench) => string, ago: number, before?: (bench: Bench, turnId: string) => void | Promise<void>, gateways?: FakeGateway[]) {
    const bench = await install();
    const turnId = make(bench);
    aged(bench, turnId, ago);
    await before?.(bench, turnId);
    const next = await restart(bench, gateways ? { gateways } : {});
    return { next, turnId };
  }

  test("the same turn in a person's chat is asked about: what the cases below take away", async () => {
    const { next, turnId } = await bootedWith((bench) => closedByShutdown(bench), HOUR);
    expect(said(next)).toEqual([`I was cut off 1 hour ago while working on "deploy the site". ${QUESTION}`]);
    expect(askedAt(next, turnId)).toBeGreaterThan(0);
  });

  test("a scheduled run in the chat whose history it keeps, and a schedule's own session", async () => {
    const inChat = await bootedWith((bench) => closedByShutdown(bench, { cause: { via: SCHEDULED, job: "job_1" } }), HOUR);
    expect(said(inChat.next)).toEqual([]);
    expect(askedAt(inChat.next, inChat.turnId)).toBeNull();

    const own = await bootedWith((bench) => closedByShutdown(bench, { chatId: "cron:job_1" }), HOUR);
    expect(said(own.next)).toEqual([]);
  });

  test("a turn cut off longer ago than the upper age: two days, as long as the inbox remembers a chat", async () => {
    expect(ASK_WITHIN_MS).toBe(2 * 24 * HOUR);
    const old = await bootedWith((bench) => closedByShutdown(bench), ASK_WITHIN_MS + HOUR);
    expect(said(old.next)).toEqual([]);
    // Just inside it, it is: the age is the only difference.
    const inside = await bootedWith((bench) => closedByShutdown(bench), ASK_WITHIN_MS - HOUR);
    expect(said(inside.next)).toEqual([`I was cut off 2 days ago while working on "deploy the site". ${QUESTION}`]);
  });

  test("a chat where the person wrote again after the cut: they have moved on", async () => {
    const moved = await bootedWith((bench) => closedByShutdown(bench), HOUR, (bench) => {
      const later = bench.turns.begin({ sessionId: `ses_nouva:${BOT}:${CHAT}`, agentId: "nouva", gatewayId: BOT, chatId: CHAT, prompt: "never mind, what time is it?", senderId: CHAT, messageId: "m2" });
      bench.turns.finish(later, { status: "done", reply: "Nine." });
      aged(bench, later, 30 * MINUTE);
    });
    expect(said(moved.next)).toEqual([]);
    expect(resumptions(moved.next)).toEqual([]);
  });

  test("a chat with a message waiting from before the restart: that is answered, and the turn before it is left", async () => {
    const waiting = await bootedWith((bench) => closedByShutdown(bench), HOUR, (bench) => {
      bench.inbox.receive(envelope({ id: "m9", gatewayId: BOT, chatId: CHAT, senderId: CHAT, text: "are you there?", timestamp: Date.now() }), Date.now() - 1_000);
    });
    expect(said(waiting.next).join("\n")).not.toContain("I was cut off");
    expect(askedAt(waiting.next, waiting.turnId)).toBeNull();
  });

  test("a turn already taken up, and a turn that was itself taking one up", async () => {
    const taken = await bootedWith((bench) => closedByShutdown(bench), HOUR, (bench, turnId) => {
      // Taken up by the boot before this one, in a chat of its own so only the mark says so.
      const resumed = bench.turns.begin({ sessionId: "ses_x", agentId: "nouva", gatewayId: BOT, chatId: "elsewhere", prompt: "[system] carry on", messageId: `resume:${turnId}` });
      bench.turns.finish(resumed, { status: "done", reply: "deployed" });
    });
    expect(said(taken.next)).toEqual([]);

    const second = await bootedWith((bench) => closedByShutdown(bench, { messageId: "resume:turn_earlier" }), HOUR);
    expect(said(second.next)).toEqual([]);
  });

  test("a mission's turn: it goes on from its page", async () => {
    const page = new FakeGateway(MISSION_GATEWAY_ID, "web");
    page.buttons = true;
    const mission = await bootedWith((bench) => closedByShutdown(bench, { gatewayId: MISSION_GATEWAY_ID, chatId: "mission_1" }), HOUR, undefined, [page]);
    expect(page.sent).toEqual([]);
    expect(said(mission.next)).toEqual([]);
    expect(askedAt(mission.next, mission.turnId)).toBeNull();
  });

  test("a helper's own turn, which its job reports to the agent that started it", async () => {
    const helper = await bootedWith((bench) => closedByShutdown(bench, { cause: { via: "delegate", job: "job_2" } }), HOUR);
    expect(said(helper.next)).toEqual([]);
  });
});

describe("a turn lost without a shutdown: a power cut, a kill", () => {
  test("an hour on: its report is the question, with what it had done, and it is not taken up, at this boot or the next", async () => {
    const bench = await install();
    const turnId = lostInCrash(bench, HOUR);
    const next = await restart(bench);

    expect(said(next)).toEqual([
      '⚠️ I was cut off 1 hour ago while working on "deploy the site". Done: `read site.toml`. Cut off: `exec ./deploy.sh` (it may have partly run). ' +
        `Everything I did is kept. ${QUESTION}`,
    ]);
    expect(next.gateway.sent[0]?.buttons).toEqual([{ label: "Continue", data: `carry-on:${turnId}`, style: "positive" }]);
    expect(resumptions(next)).toEqual([]);
    expect(askedAt(next, turnId)).toBeGreaterThan(0);

    // A boot minutes later finds the turn closed minutes ago. Closed is not cut off: it stays its person's to take up.
    const again = await restart(next);
    expect(said(again)).toEqual([]);
    expect(resumptions(again)).toEqual([]);
  });

  test("five minutes on: taken up by itself, and its report says so", async () => {
    const bench = await install();
    const turnId = lostInCrash(bench, 5 * MINUTE);
    const next = await restart(bench);

    expect(said(next)[0]).toBe(
      '⚠️ I was interrupted by a restart while working on "deploy the site". Done: `read site.toml`. Cut off: `exec ./deploy.sh` (it may have partly run). ' +
        `Everything I did is kept, and I'm carrying on now. If I don't, say "continue".`,
    );
    expect(next.gateway.sent[0]?.buttons).toBeUndefined();
    expect(resumptions(next)).toEqual([`resume:${turnId}`]);
    expect(askedAt(next, turnId)).toBeNull();
  });

  test("three days on: told what happened and that it is kept, with no question", async () => {
    const bench = await install();
    const turnId = lostInCrash(bench, 3 * 24 * HOUR);
    const next = await restart(bench);

    expect(said(next)).toEqual([
      '⚠️ I was cut off 3 days ago while working on "deploy the site". Done: `read site.toml`. Cut off: `exec ./deploy.sh` (it may have partly run). Everything I did is kept.',
    ]);
    expect(next.gateway.sent[0]?.buttons).toBeUndefined();
    expect(askedAt(next, turnId)).toBeNull();
    expect(resumptions(await restart(next))).toEqual([]);
  });

  test("an hour on, with a message of theirs waiting from before it: told what happened, not asked", async () => {
    const bench = await install();
    const turnId = lostInCrash(bench, HOUR);
    bench.inbox.receive(envelope({ id: "m9", gatewayId: BOT, chatId: CHAT, senderId: CHAT, text: "are you there?", timestamp: Date.now() - HOUR }), Date.now() - HOUR);
    const next = await restart(bench);

    const report = said(next).find((text) => text.includes("deploy the site"));
    expect(report).toEndWith("Everything I did is kept.");
    expect(askedAt(next, turnId)).toBeNull();
  });

  test("cut off in a call the gate asks about, minutes ago: left for its person once, and no later boot asks again", async () => {
    const bench = await install();
    const at = Date.now() - 2 * MINUTE;
    const turnId = bench.turns.begin({ sessionId: `ses_nouva:${BOT}:${CHAT}`, agentId: "nouva", gatewayId: BOT, chatId: CHAT, prompt: "clean the old site", senderId: CHAT, messageId: "m1" });
    const journal = bench.journal.open(turnId, { agentId: "nouva", gatewayId: BOT, chatId: CHAT, kind: "chat", startedAt: at }, { role: "user", content: "clean the old site", timestamp: at });
    journal.record({ role: "assistant", content: "", toolCalls: [{ id: "e1", name: "exec", arguments: { command: "rm -rf /srv/site-old" } }], timestamp: at });
    journal.started(["e1"]);
    const next = await restart(bench);

    expect(said(next)).toHaveLength(2);
    expect(said(next)[0]).toEndWith("Everything I did is kept.");
    expect(said(next)[1]).toContain("I have not taken it up by myself. Check, then say continue if it should go on.");
    expect(askedAt(next, turnId)).toBeGreaterThan(0);

    // Twenty minutes later it is past the window, and has been asked about already.
    aged(next, turnId, 20 * MINUTE);
    const later = await restart(next);
    expect(said(later)).toEqual([]);
    expect(resumptions(later)).toEqual([]);
  });
});

describe("the words, by how long ago", () => {
  const closed = closeTurn([{ message: { role: "user", content: "what is this?" } }], { kind: "restart" });

  test("minutes, hours and days as a person says them", () => {
    const opens = (agoMs: number) => interruptionReport(closed, "what is this?", { kind: "kept", agoMs }).split(" before")[0];
    expect(opens(30_000)).toBe("⚠️ I was cut off 1 minute ago");
    expect(opens(16 * MINUTE)).toBe("⚠️ I was cut off 16 minutes ago");
    expect(opens(59 * MINUTE)).toBe("⚠️ I was cut off 59 minutes ago");
    expect(opens(90 * MINUTE)).toBe("⚠️ I was cut off 2 hours ago");
    expect(opens(23 * HOUR)).toBe("⚠️ I was cut off 23 hours ago");
    expect(opens(24 * HOUR)).toBe("⚠️ I was cut off 1 day ago");
    expect(opens(47 * HOUR)).toBe("⚠️ I was cut off 2 days ago");
  });

  test("a turn that had done nothing is asked about its answer", () => {
    expect(interruptionReport(closed, "what is this?", { kind: "asked", agoMs: HOUR })).toBe(
      `⚠️ I was cut off 1 hour ago before I could answer "what is this?". Your message is kept. I have not answered it by myself, since it was a while ago. Say "continue" and I will.`,
    );
    expect(interruptionReport(closed, "what is this?", { kind: "now" })).toBe(
      `⚠️ I was interrupted by a restart before I could answer "what is this?". Your message is kept, and I'm answering it now. If I don't, say "continue".`,
    );
  });
});

/** The mark's column (`082_resume_asked.sql`), on a database the schema before it left. */
describe("a database at the schema before the question", () => {
  test("gains the column with every turn as it was, and a turn cut off an hour ago in it is asked about", async () => {
    const db = openDatabase(":memory:");
    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 81));
    const now = Date.now();
    db.prepare(
      `INSERT INTO turn_records (id, session_id, agent_id, gateway_id, chat_id, message_id, status, prompt, reply, error, started_at, ended_at)
       VALUES ('turn_cut', 'ses_nouva:telegram:nouva:814', 'nouva', 'telegram:nouva', '814', 'm1', 'interrupted', 'deploy the site', '⚠️ I was interrupted by a restart…', 'restart', ?, ?)`,
    ).run(now - HOUR - MINUTE, now - HOUR);
    const before = db.prepare<Record<string, unknown>>("SELECT * FROM turn_records").all();

    await migrate(db, {}, MIGRATIONS.filter((one) => one.version <= 82));
    expect(db.userVersion()).toBe(82);
    expect(db.prepare<Record<string, unknown>>("SELECT * FROM turn_records").all()).toEqual(before.map((row) => ({ ...row, resume_asked_at: null })));
    db.close();
  });
});
