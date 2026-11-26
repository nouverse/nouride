/**
 * An agent asked in a room answers there too (`pipeline/peer-shown.ts`), through the real pipeline: a person's message
 * in a room, the asking agent's turn, the agent it asks, and a model that answers each request by who is asking.
 *
 * `ask_agent` ran the agent asked behind the chat everywhere, so in a room one agent spoke for another that was right
 * there. What each test holds: asked in a room it is a member of, its answer is said there as its own message, kept as
 * its turn, and told to both agents in the words that carry the rule; in a room it is not in, and in a one-to-one chat,
 * nothing changes; a tag in the answer wakes nobody; an ask behind the asking turn is said when it ends; several asked
 * in one call are each said once; on a chat app it is said through the asked agent's own bot or not at all, and the
 * copy the platform hands the other bots is routed to nobody.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { GlobalConfig } from "@nouride/shared";
import { AuditLog } from "@/commons/audit.store.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { OutboundRegistry } from "@nouride/persona";
import { worthSaying } from "@/modules/pipeline/peer-shown.ts";
import { ROOM_LANGUAGE, SHOWN_IN_THE_ROOM } from "@/modules/pipeline/peer-turn.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { RoomStore } from "@/modules/rooms/rooms.store.ts";
import { peersFrom } from "@/modules/tools/builtins/ask-agent.ts";
import { SHOWN_TO_THE_ROOM } from "@/modules/tools/handoff.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { conversationOf, envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually, sleep } from "../wait.ts";

// ── a model that answers by who is asking ─────────────────────────────────────────────────────────────────────────

interface Said {
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}
interface Body {
  messages: { role: string; content: unknown }[];
  stream?: boolean;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";
const whoAsks = (body: Body): string => /\(agent id: ([^)]+)\)/.exec(textOf(body.messages[0]?.content))?.[1] ?? "?";
const lastUser = (body: Body): string => textOf(conversationOf(body.messages).filter((message) => message.role === "user").at(-1)?.content);
const toolResults = (body: Body): string[] => body.messages.filter((message) => message.role === "tool").map((message) => textOf(message.content));

function provider(answer: (who: string, body: Body) => Said | Promise<Said>) {
  const asked: { who: string; body: Body }[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const who = whoAsks(body);
    asked.push({ who, body });
    const said = await answer(who, body);
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    if (!body.stream) return Response.json({ model: "test-model", choices: [{ message: { content: said.text ?? "" }, finish_reason: "stop" }], usage });
    const events: string[] = [];
    if (said.text) events.push(`data: ${JSON.stringify({ choices: [{ delta: { content: said.text } }] })}\n\n`);
    for (const [index, call] of (said.toolCalls ?? []).entries()) {
      events.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })}\n\n`);
    }
    events.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: said.toolCalls?.length ? "tool_calls" : "stop" }], usage })}\n\n`, "data: [DONE]\n\n");
    return new Response(new ReadableStream({ start: (controller) => { for (const event of events) controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

// ── the daemon, as boot wires it ──────────────────────────────────────────────────────────────────────────────────

const benches: Bench[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  for (const jobs of stores.splice(0)) await jobs.killAll();
  for (const bench of benches) for (const turn of bench.pipeline.runningTurns()) turn.controller.abort();
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["ask_agent"]\napproval_required = []\n';
const WEB = "web:dashboard";
const ROOM = "room-1";
const TASK = "Check why the build failed and say which step it was.";
/** What the agent asked answers: in the room's language, not the brief's. */
const ANSWER = "Build-nya gagal di langkah lint: ada import yang tidak dipakai.";

async function daemon(options: { answer: (who: string, body: Body) => Said | Promise<Said>; gateways?: (LocalGateway | FakeGateway)[]; config?: Record<string, unknown>; members?: string[] | null; waitMs?: number; pack?: string; progressMs?: number }) {
  const { fetchImpl, asked } = provider(options.answer);
  const local = new LocalGateway();
  let jobs!: JobStore;
  let rooms!: RoomStore;
  const bench = await pipelineBench({
    fetch: () => fetchImpl,
    gateways: options.gateways ?? [local],
    agents: ["nouva", "nox", "nera"].map((id) => ({ id, configToml: options.pack ?? PACK })),
    config: { daemon: { orchestrator: "nouva" }, agents: { mentions_enabled: true }, ...options.config },
    configure: (config: GlobalConfig) => {
      config.queue.steerReply = false;
    },
    deps: ({ db, dataDir, config }) => {
      jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4, maxMs: () => config.security.jobMaxMs });
      rooms = new RoomStore(db);
      // A step line written as soon as there is a step, for the tests that read one while its turn works.
      return { jobs, rooms, roomMessages: new RoomMessageStore(db), ...(options.progressMs ? { progressIntervalMs: options.progressMs } : {}) };
    },
  });
  benches.push(bench);
  stores.push(jobs);
  if (options.members !== null) rooms.create({ gatewayId: WEB, chatId: ROOM, agentIds: options.members ?? ["nouva", "nox"], title: "Build" });
  bench.pipeline.setTools(
    createBuiltinTools({
      security: bench.config.security,
      // As `boot/tools.ts` wires it, with a wait a test can sit through.
      askAgent: { run: bench.pipeline.peerTurnRunner(), start: bench.pipeline.askRunner(), waitMs: options.waitMs ?? 2_000, ...peersFrom(bench.registry, () => true) },
      audit: new AuditLog(bench.db),
    }),
  );
  bench.pipeline.attach();
  jobs.setOnComplete((completion) => bench.pipeline.wakeForJob(completion));
  const inRoom = () => bench.turns.forChat(WEB, ROOM);
  return {
    bench,
    local,
    asked,
    /** A person in the room. */
    say: async (text: string) => {
      local.dispatch({ text, chatId: ROOM, chatType: "group" });
      await bench.pipeline.idle();
    },
    /** The room's turns as its transcript reads them: who, what was said, and why the turn is there. */
    said: () => inRoom().map((turn) => ({ by: turn.agentId, reply: turn.reply, via: turn.cause?.via })),
    inRoom,
    requestsOf: (who: string) => asked.filter((request) => request.who === who),
  };
}

const ask = (agent: string, more: Record<string, unknown> = {}): Said => ({ toolCalls: [{ id: `a-${agent}`, name: "ask_agent", args: { agent, task: TASK, ...more } }] });
/** Nouva asks once, then says its own line; everyone else answers `ANSWER`. */
const asksThenSays = (first: Said, others: (who: string) => Said = () => ({ text: ANSWER })) => (who: string, body: Body): Said =>
  who !== "nouva" ? others(who) : toolResults(body).length === 0 ? first : { text: "Itu dari Nox. Saya perbaiki importnya sekarang." };

// ── the tests ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("an agent asked in a room it is a member of", () => {
  test("answers there too: its answer is its own turn in the room, before the asking agent's, and each agent is told so", async () => {
    const d = await daemon({ answer: asksThenSays(ask("nox")) });
    await d.say("@nouva kenapa build-nya gagal?");

    // Said once, as Nox, and kept as a turn of the conversation: a reload of the room still has it.
    expect(d.said()).toEqual([
      { by: "nouva", reply: "Itu dari Nox. Saya perbaiki importnya sekarang.", via: undefined },
      { by: "nox", reply: ANSWER, via: "shown answer" },
    ].sort((a, b) => a.by.localeCompare(b.by)));
    const shown = d.inRoom().find((turn) => turn.agentId === "nox")!;
    expect(shown).toMatchObject({ status: "done", cause: { via: "shown answer", asked: "nouva" } });
    expect(shown.cause?.parent).toBe(d.inRoom().find((turn) => turn.agentId === "nouva")!.id);
    expect(shown.endedAt).toBeLessThanOrEqual(d.inRoom().find((turn) => turn.agentId === "nouva")!.endedAt!);

    // The agent asked is told the room reads its answer, in place of "Nobody else reads it".
    const brief = lastUser(d.requestsOf("nox")[0]!.body);
    expect(brief).toContain(SHOWN_IN_THE_ROOM);
    expect(brief).toContain("in the language they\nare speaking there, not the language of this brief");
    // The brief is in English, and the agent asked reads nothing else of the room: the words of the person this is for,
    // as they said them there, show which language its answer is in.
    expect(brief).toContain(`${ROOM_LANGUAGE} "`);
    expect(brief).toContain("kenapa build-nya gagal?\"");
    // Quoted for their language alone: a follow-up meant for the agent that asked is not a request to the one asked.
    expect(brief).toContain("kenapa build-nya gagal?\"\nThose words are quoted only for their language, and they are not a request to you: do only what the brief above asks.");
    expect(brief).toContain("tag nobody");
    expect(brief).not.toContain("Nobody else reads it");
    expect(brief).toContain(TASK);
    // And the agent that asked, that the room has read it: it adds what is its own.
    const result = toolResults(d.requestsOf("nouva")[1]!.body)[0]!;
    expect(result).toContain(ANSWER);
    expect(result).toContain(SHOWN_TO_THE_ROOM("nox"));
    expect(SHOWN_TO_THE_ROOM("nox")).toContain("Do not repeat or summarize it.");
    // One model request each for the answer: nobody was asked again to write it for the room.
    expect(d.requestsOf("nox")).toHaveLength(1);
  });

  test("a tag in its answer wakes nobody: it is said, not handed on", async () => {
    const d = await daemon({ members: ["nouva", "nox", "nera"], answer: asksThenSays(ask("nox"), (who) => ({ text: who === "nox" ? "@nera tolong cek lint-nya juga. @nouva sudah saya cek." : "should not run" })) });
    await d.say("@nouva kenapa build-nya gagal?");
    expect(d.said().map((turn) => turn.by).sort()).toEqual(["nouva", "nox"]);
    expect(d.requestsOf("nera")).toEqual([]);
    // The asking agent ran its one turn: the tag of it in the answer started no second.
    expect(d.requestsOf("nouva")).toHaveLength(2);
  });

  test("several asked in one call are each said once, in the room they are both in", async () => {
    const d = await daemon({
      members: ["nouva", "nox", "nera"],
      answer: asksThenSays({ toolCalls: [{ id: "a1", name: "ask_agent", args: { asks: [{ agent: "nox", task: TASK }, { agent: "nera", task: TASK }] } }] }, (who) => ({ text: `${who}: ${ANSWER}` })),
    });
    await d.say("@nouva kenapa build-nya gagal?");
    expect(d.said().filter((turn) => turn.via === "shown answer").map((turn) => turn.reply).sort()).toEqual([`nera: ${ANSWER}`, `nox: ${ANSWER}`]);
    const result = toolResults(d.requestsOf("nouva")[1]!.body)[0]!;
    expect(result).toContain(SHOWN_TO_THE_ROOM("nox"));
    expect(result).toContain(SHOWN_TO_THE_ROOM("nera"));
  });

  test("an ask behind the asking turn is said when it ends, and the wake-up says the room has read it", async () => {
    let finish: () => void = () => {};
    const held = new Promise<void>((resolve) => (finish = resolve));
    const d = await daemon({
      answer: async (who, body) => {
        if (who === "nox") return (await held, { text: ANSWER });
        if (lastUser(body).includes("[System event")) return { text: "Nox sudah jawab di atas." };
        return toolResults(body).length === 0 ? ask("nox", { background: true }) : { text: "Nox sedang cek, nanti dia jawab." };
      },
    });
    await d.say("@nouva kenapa build-nya gagal?");
    // The asking turn is over, the agent asked still at work: nothing of its is in the room yet.
    expect(d.said()).toEqual([{ by: "nouva", reply: "Nox sedang cek, nanti dia jawab.", via: undefined }]);
    finish();
    await eventually(() => d.said().some((turn) => turn.via === "shown answer"), 6_000, "the answer said in the room");
    await eventually(() => d.requestsOf("nouva").some((request) => lastUser(request.body).includes("[System event")), 6_000, "the wake-up");
    await d.bench.pipeline.idle();
    expect(d.said().filter((turn) => turn.via === "shown answer")).toEqual([{ by: "nox", reply: ANSWER, via: "shown answer" }]);
    const wake = lastUser(d.requestsOf("nouva").find((request) => lastUser(request.body).includes("[System event"))!.body);
    expect(wake).toContain(SHOWN_TO_THE_ROOM("nox"));
  });

  test("an ask that failed, or was stopped short with nothing said, is not shown", async () => {
    const d = await daemon({ answer: asksThenSays(ask("nox"), () => ({ text: "   " })) });
    await d.say("@nouva kenapa build-nya gagal?");
    expect(d.said().map((turn) => turn.by)).toEqual(["nouva"]);
    expect(toolResults(d.requestsOf("nouva")[1]!.body)[0]).not.toContain(SHOWN_TO_THE_ROOM("nox"));
  });
});

describe("where it is not the room's to read", () => {
  test("an agent that is not a member answers behind the chat, as before: nothing is said, and both are told as before", async () => {
    const d = await daemon({ answer: asksThenSays(ask("nera")) });
    await d.say("@nouva kenapa build-nya gagal?");
    expect(d.said().map((turn) => turn.by)).toEqual(["nouva"]);
    const brief = lastUser(d.requestsOf("nera")[0]!.body);
    expect(brief).toContain("Nobody else reads it");
    expect(brief).not.toContain(SHOWN_IN_THE_ROOM);
    // Its answer goes back to the agent that asked, which speaks to the people: nothing of theirs is quoted to it.
    expect(brief).not.toContain(ROOM_LANGUAGE);
    expect(toolResults(d.requestsOf("nouva")[1]!.body)[0]).not.toContain("already read this");
  });

  test("a one-to-one chat is as it was", async () => {
    const d = await daemon({ members: null, answer: asksThenSays(ask("nox")) });
    d.local.dispatch({ text: "kenapa build-nya gagal?", chatId: "web-1", chatType: "dm", agentId: "nouva" } as never);
    await d.bench.pipeline.idle();
    expect(d.bench.turns.forChat(WEB, "web-1").map((turn) => turn.agentId)).toEqual(["nouva"]);
    expect(lastUser(d.requestsOf("nox")[0]!.body)).toContain("Nobody else reads it");
    expect(toolResults(d.requestsOf("nouva")[1]!.body)[0]).not.toContain("already read this");
  });
});

describe("in a group on a chat app, where each agent has a bot of its own", () => {
  const GROUP = "-100200";
  const twoBots = async (answer: (who: string, body: Body) => Said | Promise<Said>, noxBot?: (bot: FakeGateway, other: FakeGateway) => void, more: { pack?: string; progressMs?: number } = {}) => {
    const nouvaBot = new FakeGateway("telegram:nouva");
    const noxBot_ = new FakeGateway("telegram:nox");
    noxBot?.(noxBot_, nouvaBot);
    const d = await daemon({
      members: null,
      gateways: [nouvaBot, noxBot_],
      config: { gateways: { telegram: { nouva: { enabled: true, token: "t-nouva", agent: "nouva" }, nox: { enabled: true, token: "t-nox", agent: "nox" } } } },
      answer,
      ...more,
    });
    const person = async (text: string) => {
      nouvaBot.receive(envelope({ id: "m1", text, gatewayId: "telegram:nouva", chatId: GROUP, chatType: "group", mentionsSelf: true, timestamp: Date.now() }));
      await d.bench.pipeline.idle();
    };
    const answers = (bot: FakeGateway) => bot.sent.map((message) => message.text).filter((text) => !text.startsWith("["));
    return { ...d, nouvaBot, noxBot: noxBot_, person, answers };
  };

  test("the answer goes out through the asked agent's own bot, and the asking agent's bot says only its own line", async () => {
    const h = await twoBots(asksThenSays(ask("nox")));
    await h.person("kenapa build-nya gagal?");
    expect(h.answers(h.noxBot)).toEqual([ANSWER]);
    expect(h.answers(h.nouvaBot)).toEqual(["Itu dari Nox. Saya perbaiki importnya sekarang."]);
    expect(toolResults(h.requestsOf("nouva")[1]!.body)[0]).toContain(SHOWN_TO_THE_ROOM("nox"));
    // Kept as Nox's turn in that group, on its own connection.
    expect(h.bench.turns.forChat("telegram:nox", GROUP).map((turn) => ({ by: turn.agentId, reply: turn.reply, via: turn.cause?.via }))).toEqual([{ by: "nox", reply: ANSWER, via: "shown answer" }]);
  });

  /** The step lines one bot sent for one agent: "[nox] ✓ 0 steps · 1s". */
  const stepLines = (bot: FakeGateway, agent: string) => bot.sent.map((message) => message.text).filter((text) => text.startsWith(`[${agent}] `));
  const OWN_REPLY = "Itu dari Nox. Saya perbaiki importnya sekarang.";
  /** Where a line of the asked agent's stands among what the asking agent's bot sent, against that agent's own reply. */
  const lineThenReply = (bot: FakeGateway, agent: string) => {
    const texts = bot.sent.map((message) => message.text);
    return { line: texts.findIndex((text) => text.startsWith(`[${agent}] `)), reply: texts.indexOf(OWN_REPLY) };
  };

  test("its own answer is the sign that it ran: where it is said, no step line of the asked agent is sent, by either bot", async () => {
    const h = await twoBots(asksThenSays(ask("nox")));
    await h.person("kenapa build-nya gagal?");
    // The asking agent's reply is out: a line of the asked agent's, where one is written, is out before it (the next test).
    await eventually(() => h.answers(h.nouvaBot).length === 1, 2_000, "the asking agent's reply");
    expect(h.answers(h.noxBot)).toEqual([ANSWER]);
    expect(stepLines(h.nouvaBot, "nox")).toEqual([]);
    expect(stepLines(h.noxBot, "nox")).toEqual([]);
  });

  /**
   * Nouva asks Nox, and Nox looks into its folder before it answers: a turn with a step to show. Its answer waits for
   * `held`, so the step has its time in the chat before the turn is over.
   */
  const noxWorksFirst = (held: () => Promise<void>) => async (who: string, body: Body): Promise<Said> => {
    if (who === "nouva") return toolResults(body).length === 0 ? ask("nox") : { text: OWN_REPLY };
    if (toolResults(body).length === 0) return { toolCalls: [{ id: "g-1", name: "glob", args: { pattern: "*.md" } }] };
    await held();
    return { text: ANSWER };
  };
  const WORKS = { pack: PACK.replace('["ask_agent"]', '["ask_agent", "glob"]'), progressMs: 1 };

  test("an asked agent that worked before it answered: in the group its steps are not written while it works either; in a one-to-one chat they are, live, and closed", async () => {
    // Past the step line's own timer, set a millisecond out before this wait began: a line written while the agent
    // works would be out by now. Nothing marks a line that is not written, so there is no condition to wait for.
    const group = await twoBots(noxWorksFirst(() => sleep(20)), undefined, WORKS);
    await group.person("kenapa build-nya gagal?");
    await eventually(() => group.answers(group.nouvaBot).length === 1, 2_000, "the asking agent's reply");
    expect(group.answers(group.noxBot)).toEqual([ANSWER]);
    expect(stepLines(group.nouvaBot, "nox")).toEqual([]);
    expect(group.nouvaBot.edits.filter((edit) => edit.text.startsWith("[nox] "))).toEqual([]);

    // In a one-to-one chat the answer waits until the line is there, as a person sees it while the agent works.
    const bots: { nouva?: FakeGateway } = {};
    const dm = await twoBots(noxWorksFirst(() => eventually(() => bots.nouva !== undefined && stepLines(bots.nouva, "nox").length === 1, 2_000, "the asked agent's line while it works")), undefined, WORKS);
    bots.nouva = dm.nouvaBot;
    dm.nouvaBot.receive(envelope({ id: "m1", text: "kenapa build-nya gagal?", gatewayId: "telegram:nouva", chatId: "8142", chatType: "dm", timestamp: Date.now() }));
    await dm.bench.pipeline.idle();
    await eventually(() => dm.nouvaBot.edits.some((edit) => /^\[nox\] ✓ 1 step · \d+s$/.test(edit.text)), 2_000, "the asked agent's line, closed");
    // One bubble, written while it worked and closed where it stood: not a line added once it was over.
    expect(stepLines(dm.nouvaBot, "nox")).toEqual([expect.stringMatching(/^\[nox\] ✓ 1 step · \d+s$/)]);
  });

  test("where its answer is not said after all, its line is written as before: under the asking agent's bot, ahead of that agent's reply", async () => {
    // Its own bot cannot deliver there.
    const refused = await twoBots(asksThenSays(ask("nox")), (bot) => {
      (bot as unknown as { failSend: Error }).failSend = new Error("403: bot is not a member of the group chat");
    });
    await refused.person("kenapa build-nya gagal?");
    await eventually(() => stepLines(refused.nouvaBot, "nox").length === 1 && refused.answers(refused.nouvaBot).length === 1, 2_000, "the asked agent's line");
    expect(stepLines(refused.nouvaBot, "nox")[0]).toMatch(/^\[nox\] ✓ 0 steps · \d+s$/);
    expect(lineThenReply(refused.nouvaBot, "nox").line).toBeLessThan(lineThenReply(refused.nouvaBot, "nox").reply);
    // It answered with no words.
    const wordless = await twoBots(asksThenSays(ask("nox"), () => ({ text: "   " })));
    await wordless.person("kenapa build-nya gagal?");
    await eventually(() => stepLines(wordless.nouvaBot, "nox").length === 1, 2_000, "the asked agent's line");
    expect(wordless.answers(wordless.noxBot)).toEqual([]);
    expect(stepLines(wordless.nouvaBot, "nox")[0]).toMatch(/^\[nox\] ✓ 0 steps · \d+s$/);
  });

  test("where it does not answer for itself, its line is the only sign that it ran, and stays: a one-to-one chat, and an agent with no bot there", async () => {
    const dm = await twoBots(asksThenSays(ask("nox")));
    dm.nouvaBot.receive(envelope({ id: "m1", text: "kenapa build-nya gagal?", gatewayId: "telegram:nouva", chatId: "8142", chatType: "dm", timestamp: Date.now() }));
    await dm.bench.pipeline.idle();
    await eventually(() => stepLines(dm.nouvaBot, "nox").length === 1 && dm.answers(dm.nouvaBot).length === 1, 2_000, "the asked agent's line in a one-to-one chat");
    expect(stepLines(dm.nouvaBot, "nox")[0]).toMatch(/^\[nox\] ✓ 0 steps · \d+s$/);
    expect(lineThenReply(dm.nouvaBot, "nox").line).toBeLessThan(lineThenReply(dm.nouvaBot, "nox").reply);
    expect(dm.noxBot.sent).toEqual([]);

    const noBot = await twoBots(asksThenSays(ask("nera")));
    await noBot.person("kenapa build-nya gagal?");
    await eventually(() => stepLines(noBot.nouvaBot, "nera").length === 1, 2_000, "the line of an agent with no bot there");
    expect(stepLines(noBot.nouvaBot, "nera")[0]).toMatch(/^\[nera\] ✓ 0 steps · \d+s$/);
  });

  test("where its own bot cannot deliver there it is not said at all: never under the asking agent's bot", async () => {
    const h = await twoBots(asksThenSays(ask("nox")), (bot) => {
      (bot as unknown as { failSend: Error }).failSend = new Error("403: bot is not a member of the group chat");
    });
    await h.person("kenapa build-nya gagal?");
    expect(h.answers(h.nouvaBot)).toEqual(["Itu dari Nox. Saya perbaiki importnya sekarang."]);
    expect(toolResults(h.requestsOf("nouva")[1]!.body)[0]).not.toContain("already read this");
    expect(h.bench.turns.forChat("telegram:nox", GROUP)).toEqual([]);
  });

  test("a bot that says it cannot read the group is not a member: its agent answers behind the chat", async () => {
    const h = await twoBots(asksThenSays(ask("nox")), (bot) => {
      bot.sees = () => false;
    });
    await h.person("kenapa build-nya gagal?");
    expect(h.answers(h.noxBot)).toEqual([]);
    expect(lastUser(h.requestsOf("nox")[0]!.body)).toContain("Nobody else reads it");
  });

  test("handed over before the platform has said the message's id, the copy is still known for what it is", async () => {
    const SAID = "@nouva sudah saya cek, lint-nya yang gagal.";
    const h = await twoBots(asksThenSays(ask("nox"), () => ({ text: SAID })), (bot, other) => {
      // The account Nox's bot speaks as: what tells the others whose message it is before its id is on record.
      bot.selfId = "bot-nox";
      const send = bot.send.bind(bot);
      bot.send = async (message) => {
        // As a platform can: Nouva's bot has its copy, under an id nothing has recorded, before the send returns.
        if (message.text === SAID) other.receive(envelope({ id: "early-777", text: SAID, gatewayId: "telegram:nouva", chatId: GROUP, chatType: "group", senderId: "bot-nox", senderIsBot: true, mentionsSelf: true, timestamp: Date.now() }));
        return await send(message);
      };
    });
    await h.person("kenapa build-nya gagal?");
    await h.bench.pipeline.idle();
    expect(h.answers(h.noxBot)).toEqual([SAID]);
    // The asking agent ran its one turn: the tag of it in the copy started no second, and steered nothing into the first.
    expect(h.requestsOf("nouva")).toHaveLength(2);
    expect(h.requestsOf("nouva").map((request) => lastUser(request.body)).join(" ")).not.toContain("sudah saya cek");
  });

  test("an agent with no bot of its own there is not shown under another agent's", async () => {
    const h = await twoBots(asksThenSays(ask("nera")));
    await h.person("kenapa build-nya gagal?");
    expect(h.answers(h.nouvaBot)).toEqual(["Itu dari Nox. Saya perbaiki importnya sekarang."]);
    expect(h.answers(h.noxBot)).toEqual([]);
    expect(lastUser(h.requestsOf("nera")[0]!.body)).toContain("Nobody else reads it");
  });

  test("a one-to-one chat with the asking agent's bot is that agent's: the asked agent's bot says nothing into it", async () => {
    const h = await twoBots(asksThenSays(ask("nox")));
    h.nouvaBot.receive(envelope({ id: "m1", text: "kenapa build-nya gagal?", gatewayId: "telegram:nouva", chatId: "8142", chatType: "dm", timestamp: Date.now() }));
    await h.bench.pipeline.idle();
    expect(h.answers(h.noxBot)).toEqual([]);
    expect(h.answers(h.nouvaBot)).toEqual(["Itu dari Nox. Saya perbaiki importnya sekarang."]);
    expect(lastUser(h.requestsOf("nox")[0]!.body)).toContain("Nobody else reads it");
  });

  test("the copy the platform hands the other bots is part of what was said, and routed to nobody whatever it tags", async () => {
    const h = await twoBots(asksThenSays(ask("nox"), () => ({ text: "@nouva sudah saya cek, lint-nya yang gagal." })));
    await h.person("kenapa build-nya gagal?");
    const before = h.asked.length;
    // As Discord does: Nouva's bot is handed Nox's message, by the id the platform gave it, tagging Nouva.
    h.nouvaBot.receive(envelope({ id: "telegram:nox#1", text: "@nouva sudah saya cek, lint-nya yang gagal.", gatewayId: "telegram:nouva", chatId: GROUP, chatType: "group", senderId: "bot-nox", senderIsBot: true, mentionsSelf: true, timestamp: Date.now() }));
    await h.bench.pipeline.idle();
    expect(h.asked.length).toBe(before);
  });
});

describe("what is worth saying, and what the registry knows was only said", () => {
  test("an answer it finished: not one that failed, was stopped, or has no words", () => {
    expect(worthSaying({ status: "success", summary: ANSWER }, false)).toBe(true);
    // Short of done, with words: what it got to is still its answer to the room.
    expect(worthSaying({ status: "incomplete", summary: "Sampai sini dulu: lint-nya gagal." }, false)).toBe(true);
    expect(worthSaying({ status: "requires_human", summary: "Butuh izin untuk menjalankan deploy." }, false)).toBe(true);
    expect(worthSaying({ status: "failed", summary: "Build-nya gag" }, false)).toBe(false);
    expect(worthSaying({ status: "success", summary: ANSWER }, true)).toBe(false);
    expect(worthSaying({ status: "success", summary: " \n " }, false)).toBe(false);
  });

  test("a message recorded as said is said; one recorded as an answer is not, even while its agent is saying another", () => {
    const sent = new OutboundRegistry();
    sent.record({ platform: "discord", chatId: "c", messageId: "1", agentId: "nox" });
    sent.record({ platform: "discord", chatId: "c", messageId: "2", agentId: "nox", said: true });
    expect(sent.isSaid("discord", "c", "2", "nox", 0)).toBe(true);
    expect(sent.isSaid("discord", "c", "1", "nox", 0)).toBe(false);
    sent.beginSaying("discord", "c", "nox", 1_000);
    expect(sent.isSaid("discord", "c", "1", "nox", 1_001)).toBe(false);
    // Its author is still the agent that wrote it: a person's reply to it goes to that agent.
    expect(sent.authorOf("discord", "c", "2")).toBe("nox");
  });

  test("while a said message is on its way its copy can arrive before its id is known: that agent's, in that chat, until the send ends", () => {
    const sent = new OutboundRegistry();
    expect(sent.isSaid("discord", "c", "9", "nox", 1_000)).toBe(false);
    sent.beginSaying("discord", "c", "nox", 1_000);
    expect(sent.isSaid("discord", "c", "9", "nox", 1_500)).toBe(true);
    // Another agent's, another chat's and another platform's are not it.
    expect(sent.isSaid("discord", "c", "9", "nera", 1_500)).toBe(false);
    expect(sent.isSaid("discord", "d", "9", "nox", 1_500)).toBe(false);
    expect(sent.isSaid("telegram", "c", "9", "nox", 1_500)).toBe(false);
    sent.endSaying("discord", "c", "nox");
    expect(sent.isSaid("discord", "c", "9", "nox", 1_600)).toBe(false);
    // A send that never came back does not hold the agent's later messages: thirty seconds, then it is over.
    sent.beginSaying("discord", "c", "nox", 2_000);
    expect(sent.isSaid("discord", "c", "9", "nox", 31_999)).toBe(true);
    expect(sent.isSaid("discord", "c", "9", "nox", 32_000)).toBe(false);
  });
});
