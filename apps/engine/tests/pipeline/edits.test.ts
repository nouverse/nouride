/**
 * A person's edit of a message they sent (`modules/pipeline/edits.ts`): where the message is decides what the edit
 * does. Still waiting — answered once, as corrected. Its turn running — read by that turn as a correction. Its turn
 * ended — a turn of its own, framed as an edit, only while recent. Never for an edit that changes nothing visible, never
 * as a command, and in a room only where routing says the edit is for an agent: otherwise it changes what the room
 * remembers, and starts nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { MessageEnvelope, Tool } from "@nouride/shared";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { EDIT_WINDOW_MS, recentEdit, sameWords } from "@/modules/pipeline/edit-rules.ts";
import { mergeEnvelopes } from "@/modules/pipeline/messages.ts";
import { STEER_ACK_EDIT } from "@/modules/pipeline/steering.ts";
import { envelope, eventually, FakeGateway, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench, type BenchOptions } from "../pipeline-bench.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** A tool that holds its step until the test lets it go — the moment a message or an edit arrives in the middle of. */
function holding(): { tool: [string, Tool]; started: () => Promise<void>; release: () => void } {
  let began = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  return {
    tool: [
      "hold",
      {
        requiresApproval: false,
        definition: { name: "hold", description: "takes a while", parameters: { type: "object", properties: {} } },
        async execute() {
          began = true;
          await held;
          return { content: "done", isError: false };
        },
      },
    ],
    started: () => eventually(() => began, 4_000, "the held step"),
    release: () => release(),
  };
}

async function bench(
  turns: Parameters<typeof scriptedOpenAI>[0],
  o: { steer?: boolean; agents?: string[]; chatType?: MessageEnvelope["chatType"]; deps?: BenchOptions["deps"] } = {},
) {
  const gateway = new FakeGateway("telegram:nouva");
  const made = await pipelineBench({
    turns,
    maxAttempts: 1,
    agents: o.agents ?? ["nouva"],
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["hold"]\n',
    configure: (config) => {
      config.queue.steer = o.steer ?? true;
      // The steering reply is a model call of its own; these tests are about what the turn reads.
      config.queue.steerReply = false;
    },
    gateway,
    ...(o.deps ? { deps: o.deps } : {}),
  });
  cleanup.push(made.dispose);
  const hold = holding();
  made.pipeline.setTools(new Map([hold.tool]));
  made.pipeline.attach();
  const chatType = o.chatType ?? "dm";
  const base = { gatewayId: "telegram:nouva", chatId: "814", chatType, senderId: "u1", senderName: "Gading" } as const;
  const say = (id: string, text: string, over: Partial<MessageEnvelope> = {}) =>
    gateway.receive(envelope({ ...base, id, text, timestamp: Date.now(), ...over }));
  /** An edit of message `of`, as an adapter reports one: an id of its own, the message it changes, what it says now. */
  const edit = (of: string, text: string, over: Partial<MessageEnvelope> = {}) =>
    gateway.receive(envelope({ ...base, id: `${of}:edited:${Date.now()}`, text, timestamp: Date.now(), edit: { of, sentAt: Date.now() }, ...over }));
  const records = () => made.turns.forChat("telegram:nouva", "814");
  const prompts = () => records().map((turn) => turn.prompt);
  const rows = (kind: string) => made.events.list({ limit: 1_000 }).filter((row) => row.kind === kind);
  const sent = (index: number) => JSON.stringify(made.requests[index]?.messages ?? []);
  return { ...made, gateway, hold, say, edit, records, prompts, rows, sent };
}

describe("an edit of a message still waiting for its turn", () => {
  test("replaces what it says: the agent answers the corrected message, once — and its turn says it was edited", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "hold", args: {} }] }, { text: "done" }, { text: "Paris." }], { steer: false });
    b.say("m1", "deploy it");
    await b.hold.started();
    // The chat's one turn is held, so this waits in the queue behind it.
    b.say("m2", "what is teh capital of france");
    await eventually(() => b.pipeline.stats().waiting === 1, 4_000, "the second message queued");
    b.edit("m2", "what is the capital of France?");
    // Written down corrected too: a restart now answers what the person meant.
    expect(b.inbox.find("telegram:nouva:814:m2")?.envelope.text).toBe("what is the capital of France?");
    b.hold.release();
    await b.pipeline.idle();

    expect(b.prompts()).toEqual(["deploy it", "what is the capital of France?"]);
    expect(b.sent(2)).toContain("what is the capital of France?");
    expect(b.sent(2)).not.toContain("teh capital");
    // Answered once: no turn for the edit itself.
    expect(b.requests).toHaveLength(3);
    const second = b.records()[1]!;
    expect(second.cause).toEqual({ via: "edit", of: "m2" });
    const start = b.rows("turn").find((row) => row.turnId === second.id && row.data.phase === "start");
    expect(start?.data).toMatchObject({ messageId: "m2", editOf: "m2" });
  });

  test("an edit that changes nothing visible leaves it as it was — and its turn says no edit", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "hold", args: {} }] }, { text: "done" }, { text: "ok" }], { steer: false });
    b.say("m1", "deploy it");
    await b.hold.started();
    b.say("m2", "check  the logs");
    await eventually(() => b.pipeline.stats().waiting === 1, 4_000, "the second message queued");
    // Telegram sends a message again when its link preview loads; a run of spaces is not a change either.
    b.edit("m2", "check the logs ");
    b.hold.release();
    await b.pipeline.idle();

    expect(b.prompts()).toEqual(["deploy it", "check  the logs"]);
    expect(b.records()[1]!.cause).toBeUndefined();
  });

  test("one handed to the running turn and not yet read is read as corrected, and its line on the turn is drawn again", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "hold", args: {} }] }, { text: "staging it is" }]);
    b.say("m1", "migrate the database");
    await b.hold.started();
    b.say("m2", "use the stagign DB");
    await eventually(() => b.records()[0]?.steps.some((step) => step.kind === "steer") ?? false, 4_000, "the message drawn on the turn");
    b.edit("m2", "use the staging DB");
    b.hold.release();
    await b.pipeline.idle();

    expect(b.prompts()).toEqual(["migrate the database"]);
    expect(b.sent(1)).toContain("use the staging DB");
    expect(b.sent(1)).not.toContain("stagign");
    const lines = b.records()[0]!.steps.filter((step) => step.kind === "steer");
    expect(lines.map((step) => step.text)).toEqual(["✎ use the staging DB"]);
    expect(lines[0]!.editOf).toBe("m2");
  });
});

describe("an edit of a message a turn is at work on", () => {
  test("reaches that turn at its next step, framed as the person's correction — one turn, and the record says so", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "hold", args: {} }] }, { text: "deploying to staging" }]);
    b.say("m1", "deploy to prod");
    await b.hold.started();
    b.edit("m1", "deploy to staging");
    await eventually(() => b.gateway.sent.some((message) => message.text === STEER_ACK_EDIT), 4_000, "the edit acknowledged");
    b.hold.release();
    await b.pipeline.idle();

    // One turn: the edit was read by it, not answered after it.
    expect(b.prompts()).toEqual(["deploy to prod"]);
    expect(b.requests).toHaveLength(2);
    expect(b.sent(0)).not.toContain("deploy to staging");
    expect(b.sent(1)).toContain("edited the message you are working on");
    expect(b.sent(1)).toContain('it said: \\"deploy to prod\\"');
    expect(b.sent(1)).toContain("deploy to staging");
    const steer = b.rows("steer").at(-1);
    expect(steer?.data).toMatchObject({ text: "✎ deploy to staging", editOf: "m1" });
    expect(b.records()[0]!.steps.find((step) => step.kind === "steer")?.editOf).toBe("m1");
  });

  test("it reaches the turn however long ago the message was sent — the window is for an edit nobody is working on", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "hold", args: {} }] }, { text: "on it" }]);
    b.say("m1", "deploy to prod");
    await b.hold.started();
    // An hour-long turn: the message it answers was sent long before this edit.
    b.edit("m1", "deploy to staging", { edit: { of: "m1", sentAt: Date.now() - EDIT_WINDOW_MS - 60_000 } });
    await eventually(() => b.gateway.sent.some((message) => message.text === STEER_ACK_EDIT), 4_000, "the edit acknowledged");
    b.hold.release();
    await b.pipeline.idle();
    expect(b.sent(1)).toContain("deploy to staging");
  });

  test("an edit that changes nothing visible is not read as a correction", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "hold", args: {} }] }, { text: "done" }]);
    b.say("m1", "deploy to prod");
    await b.hold.started();
    b.edit("m1", "deploy  to prod");
    b.hold.release();
    await b.pipeline.idle();

    expect(b.prompts()).toEqual(["deploy to prod"]);
    expect(b.sent(1)).not.toContain("edited");
    expect(b.gateway.sent.map((message) => message.text)).not.toContain(STEER_ACK_EDIT);
  });
});

describe("an edit of a message whose turn has ended", () => {
  test("starts a turn of its own, framed as an edit, with what the message said before — its record names the message", async () => {
    const b = await bench([{ text: "It is sunny in Jakrta?" }, { text: "Jakarta: sunny, 31°." }]);
    b.say("m1", "weather in Jakrta");
    await b.pipeline.idle();
    b.edit("m1", "weather in Jakarta");
    await b.pipeline.idle();

    expect(b.prompts()).toEqual(["weather in Jakrta", "weather in Jakarta"]);
    expect(b.sent(1)).toContain("This is an edit");
    expect(b.sent(1)).toContain('it said: \\"weather in Jakrta\\"');
    const edited = b.records()[1]!;
    expect(edited.cause).toEqual({ via: "edit", of: "m1" });
    const start = b.rows("turn").find((row) => row.turnId === edited.id && row.data.phase === "start");
    expect(start?.data.editOf).toBe("m1");
    expect(start?.data.messageId).not.toBe("m1");
  });

  test("is answered only while recent: sent more than the window before the edit, it starts nothing", async () => {
    const b = await bench([{ text: "first" }, { text: "again" }]);
    b.say("m1", "weather in Jakrta");
    await b.pipeline.idle();
    // The platform says when the message was sent: past the window, an edit is tidying up, not asking again.
    b.edit("m1", "weather in Jakarta", { edit: { of: "m1", sentAt: Date.now() - EDIT_WINDOW_MS - 60_000 } });
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["weather in Jakrta"]);

    // Inside it, the same edit is answered.
    b.edit("m1", "weather in Jakarta", { id: "m1:edited:again", edit: { of: "m1", sentAt: Date.now() - EDIT_WINDOW_MS + 60_000 } });
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["weather in Jakrta", "weather in Jakarta"]);
  });

  test("where the platform does not say when it was sent, the inbox's record of the message does", async () => {
    const b = await bench([{ text: "first" }, { text: "again" }]);
    // Sent fourteen minutes ago: answered — the inbox answers what is fresh — and written down with when.
    b.say("m1", "weather in Jakrta", { timestamp: Date.now() - 14 * 60_000 });
    await b.pipeline.idle();
    // Edited three minutes later than the window allows from then.
    const late = Date.now() + 2 * 60_000;
    b.gateway.receive(envelope({ gatewayId: "telegram:nouva", chatId: "814", senderId: "u1", id: "m1:e", text: "weather in Jakarta", timestamp: late, edit: { of: "m1" } }));
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["weather in Jakrta"]);
  });

  test("an edit that changes nothing visible starts nothing — and one sent twice is answered once", async () => {
    const b = await bench([{ text: "first" }, { text: "again" }]);
    b.say("m1", "weather in Jakrta");
    await b.pipeline.idle();
    b.edit("m1", "weather in  Jakrta");
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["weather in Jakrta"]);

    const once = envelope({ gatewayId: "telegram:nouva", chatId: "814", senderId: "u1", id: "m1:edited:7", text: "weather in Jakarta", timestamp: Date.now(), edit: { of: "m1", sentAt: Date.now() } });
    b.gateway.receive(once);
    await b.pipeline.idle();
    // The same edit again — the preview loading after it.
    b.gateway.receive({ ...once, edit: { of: "m1", sentAt: Date.now() } });
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["weather in Jakrta", "weather in Jakarta"]);
  });

  test("an edit that now reads as a command is not run, and starts nothing", async () => {
    const b = await bench([{ text: "first" }, { text: "again" }]);
    b.say("m1", "hello there");
    await b.pipeline.idle();
    b.edit("m1", "/new");
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["hello there"]);
    // `/new` would have ended the conversation: it is still the one the first message started.
    expect(b.sessions.load({ agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814" }).messages.length).toBeGreaterThan(0);
    expect(b.gateway.sent.map((message) => message.text).join("\n")).not.toContain("fresh");
  });
});

describe("an edit in a room", () => {
  async function room() {
    const b = await bench([{ text: "4" }, { text: "they asked about 2+3" }, { text: "lunch, sure" }], {
      agents: ["nouva", "nero"],
      chatType: "group",
      deps: ({ db }) => ({ roomMessages: new RoomMessageStore(db) }),
    });
    return { ...b, roomLog: new RoomMessageStore(b.db) };
  }

  test("an edit that no longer addresses anyone starts nothing — and what the room heard says what it says now", async () => {
    const b = await room();
    b.say("r1", "@nouva what is 2+2");
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["what is 2+2"]);

    b.edit("r1", "what is 2+3");
    await b.pipeline.idle();
    expect(b.prompts()).toEqual(["what is 2+2"]);
    // The room's record of the message, for the dashboard.
    expect(b.roomLog.forChat("telegram:nouva", "814").find((message) => message.id === "r1")?.text).toBe("what is 2+3");

    // And what an agent who was not asked overhears: the message as edited.
    b.say("r2", "@nero what did they ask?");
    await b.pipeline.idle();
    expect(b.sent(1)).toContain("what is 2+3");
    expect(b.sent(1)).not.toContain("what is 2+2");
  });

  test("the person whose message a turn is at work on corrects it there — routing decides, as for any message", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "hold", args: {} }] }, { text: "staging, then" }], { agents: ["nouva", "nero"], chatType: "group" });
    b.say("r1", "@nouva deploy to prod");
    await b.hold.started();
    b.edit("r1", "@nouva deploy to staging");
    await eventually(() => b.gateway.sent.some((message) => message.text === STEER_ACK_EDIT), 4_000, "the edit acknowledged in the room");
    b.hold.release();
    await b.pipeline.idle();

    expect(b.prompts()).toEqual(["deploy to prod"]);
    expect(b.sent(1)).toContain("edited the message you are working on");
    expect(b.sent(1)).toContain("deploy to staging");
  });

  test("an edit that now addresses an agent reaches it, as an edit, quoting the message edited", async () => {
    const b = await room();
    b.say("r3", "lunch?");
    await b.pipeline.idle();
    expect(b.prompts()).toEqual([]);

    b.edit("r3", "@nero lunch?");
    await b.pipeline.idle();
    expect(b.records().map((turn) => turn.agentId)).toEqual(["nero"]);
    expect(b.sent(0)).toContain("This is an edit");
    // The reply quotes what the person sees — their message, as edited — not the edit, which has no message.
    expect(b.gateway.sent.at(-1)?.replyTo).toBe("r3");
  });
});

describe("the rules, on their own", () => {
  test("recent is inside the window from when the message was sent; unsaid, the platform's word", () => {
    const at = 1_000_000_000;
    expect(recentEdit(at - EDIT_WINDOW_MS, at)).toBe(true);
    expect(recentEdit(at - EDIT_WINDOW_MS - 1, at)).toBe(false);
    expect(recentEdit(undefined, at)).toBe(true);
  });

  test("the same words, whatever the spaces between them", () => {
    expect(sameWords("a  b\n c ", "a b c")).toBe(true);
    expect(sameWords("a b c", "a b d")).toBe(false);
  });

  test("several messages folded into one are not an edit of one of them", () => {
    const merged = mergeEnvelopes(envelope({ id: "p1", text: "fixed caption", edit: { of: "p0" } }), envelope({ id: "p2", text: "and this" }));
    expect(merged.edit).toBeUndefined();
    expect(merged.text).toBe("fixed caption\n\nand this");
  });
});
