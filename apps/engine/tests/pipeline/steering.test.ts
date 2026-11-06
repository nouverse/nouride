/**
 * Steering (`modules/pipeline/steering.ts`): a message sent while the agent works is read by that turn at its
 * next step — never mid-step — instead of waiting for the turn to end.
 *
 * With turns that can run an hour, "use the staging DB" waiting behind the turn it was about is the turn
 * finishing on the wrong database. Each case is a way a message must not be lost or misplaced: read at the
 * next step, a new turn when the running one has no next step, words only — and in a room, only from the
 * person who started the turn, with everybody else told the agent is busy rather than met with silence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { GlobalConfig, LoadedAgent, MessageEnvelope, Tool } from "@nouride/shared";
import {
  busyNotice,
  STEER_ACK,
  STEER_ACK_PARKED,
  STEER_ACK_PARKED_ROOM,
  STEER_CAP,
  steerTarget,
  unaddressed,
  whileBusy,
} from "@/modules/pipeline/steering.ts";
import { mentionedAgents } from "@/modules/router/index.ts";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import type { ActiveTurn } from "@/modules/pipeline/turn-context.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { AutoApprovalGate, envelope, eventually, FakeGateway, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { sleep } from "../wait.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});


/** A tool that takes `ms` — the step a message arrives in the middle of. `onStart` is told as it begins. */
function slow(ms: number, onStart: () => void = () => {}): [string, Tool] {
  return [
    "slow",
    {
      requiresApproval: false,
      definition: { name: "slow", description: "takes a while", parameters: { type: "object", properties: {} } },
      async execute() {
        onStart();
        await sleep(ms);
        return { content: "done", isError: false };
      },
    },
  ];
}

/** A gate that says an approval is waiting in the chat — the turn's next step is after the answer. */
class Parked extends AutoApprovalGate {
  override pending() {
    return [{ id: "apr_1", agentId: "nouva", gateway: "telegram:nouva", chatId: "814" }] as unknown as ReturnType<AutoApprovalGate["pending"]>;
  }
}

/** A platform slow to take one message — the answer, while the turn that wrote it is still registered. */
class SlowToSend extends FakeGateway {
  sending = false;
  constructor(id: string, private readonly slow: string) {
    super(id);
  }
  override async send(msg: Parameters<FakeGateway["send"]>[0]): Promise<string[]> {
    if (msg.text === this.slow) {
      this.sending = true;
      await sleep(300);
    }
    return super.send(msg);
  }
}

/** A platform that will not rewrite a message it sent — `Gateway.editMessage` refused, as WhatsApp's always is. */
class NoEdits extends FakeGateway {
  override async editMessage(): Promise<boolean> {
    return false;
  }
}

async function bench(
  turns: Parameters<typeof scriptedOpenAI>[0],
  options: {
    providerDelayMs?: number;
    parked?: boolean;
    orchestrator?: string;
    slowSend?: string;
    /** A connection that cannot rewrite a message (`NoEdits`). */
    noEdits?: boolean;
    /** What the model says when asked for a steering reply; `null` for a call that fails. */
    steerReply?: string | null;
    /** How long that call takes. */
    steerReplyMs?: number;
    /** `[queue] steer_reply`. */
    steerReplyOn?: boolean;
    /** `[queue] steer_reply_model`. */
    steerReplyModel?: string;
    /** `[llm.defaults] small_model` — the tier `steer_reply_model = "small"` names. */
    smallModel?: string;
    /** `[queue] steer_reply_timeout_ms`. */
    steerReplyTimeoutMs?: number;
    people?: GlobalConfig["people"];
  } = {},
) {
  // The steering reply is its own small call (`steer-reply.ts`), answered here rather than from the turn's script.
  const replyRequests: { system: string; asked: string; model: string; aborted?: boolean }[] = [];
  /** The turn's own model calls begun — counted as each starts, before its delay. */
  let modelCalls = 0;
  const delayed = (scripted: typeof fetch) =>
    (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(body.messages?.[0]?.content ?? "").includes("in the middle of a task")) {
        const request: (typeof replyRequests)[number] = { system: body.messages[0].content, asked: body.messages[1]?.content ?? "", model: body.model };
        replyRequests.push(request);
        init?.signal?.addEventListener("abort", () => (request.aborted = true));
        // As a real fetch would: given up on when the call is aborted.
        if (options.steerReplyMs) {
          await Promise.race([sleep(options.steerReplyMs), new Promise((resolve) => init?.signal?.addEventListener("abort", resolve))]);
          if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        }
        if (options.steerReply === null) return new Response("upstream down", { status: 400 });
        const content = options.steerReply ?? "Siap, abis step ini gw pindah ke staging.";
        return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 9 } }), {
          headers: { "content-type": "application/json" },
        });
      }
      modelCalls += 1;
      if (options.providerDelayMs) await sleep(options.providerDelayMs);
      return scripted(url, init);
    }) as unknown as typeof fetch;
  const made = await pipelineBench({
    turns,
    fetch: delayed,
    maxAttempts: 1,
    agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["slow"]\n',
    configure: (config) => {
      if (options.orchestrator) config.daemon.orchestrator = options.orchestrator;
      config.queue.steerReply = options.steerReplyOn ?? true;
      if (options.steerReplyModel !== undefined) config.queue.steerReplyModel = options.steerReplyModel;
      if (options.smallModel !== undefined) config.llm.defaults.smallModel = options.smallModel;
      if (options.steerReplyTimeoutMs !== undefined) config.queue.steerReplyTimeoutMs = options.steerReplyTimeoutMs;
      if (options.people) config.people = options.people;
    },
    gateway: options.slowSend
      ? new SlowToSend("telegram:nouva", options.slowSend)
      : options.noEdits
        ? new NoEdits("telegram:nouva")
        : new FakeGateway("telegram:nouva"),
    deps: ({ db }) => ({
      approvals: options.parked ? new Parked() : new AutoApprovalGate(),
      usage: new UsageStore(db),
    }),
  });
  cleanup.push(made.dispose);
  const { pipeline, gateway, sessions, db, requests } = made;
  const records = made.turns;
  let stepBegan = false;
  pipeline.setTools(new Map([slow(300, () => void (stepBegan = true))]));
  /**
   * The tool's step has begun — so a message said now arrives in the middle of it. Waited for, where the tests used to
   * sleep 120 ms and bet that the model had been asked and the tool started by then.
   */
  const stepStarted = () => eventually(() => stepBegan, 4_000, "the slow step");
  /** The model has been asked for the answer and is still writing it — `providerDelayMs` is the time it takes. */
  const answering = () => eventually(() => modelCalls > 0, 4_000, "the model being asked");
  pipeline.attach();
  const say = (id: string, text: string, overrides: Partial<MessageEnvelope> = {}) =>
    gateway.receive(envelope({ id, gatewayId: "telegram:nouva", chatId: "814", senderName: "Gading", text, timestamp: Date.now(), ...overrides }));
  const prompts = () => db.prepare<{ prompt: string }>("SELECT prompt FROM turn_records ORDER BY started_at").all().map((row) => row.prompt);
  const history = () => sessions.load({ agentId: "nouva", gatewayId: "telegram:nouva", chatId: "814" }).messages;
  // Read the way the dashboard reads a transcript: through the store, which leaves out what was taken back.
  const transcript = () => records.forChat("telegram:nouva", "814");
  const steps = () => transcript().flatMap((turn) => turn.steps.map((step) => step.text));
  /** What the dashboard draws as said while a turn worked, with the question of the turn it was drawn on. */
  const said = () =>
    transcript().flatMap((turn) =>
      turn.steps.filter((step) => step.kind === "steer" || step.kind === "steer_reply").map((step) => ({ prompt: turn.prompt, kind: step.kind, text: step.text })),
    );
  /** Each model call recorded, with the turn it was charged to and that turn's question. */
  const charged = () =>
    db
      .prepare<{ prompt: string | null; input: number }>(
        "SELECT r.prompt, u.input_tokens AS input FROM llm_usage u LEFT JOIN turn_records r ON r.id = u.turn_id ORDER BY u.timestamp",
      )
      .all()
      .map((row) => ({ ...row }));
  const inboxStatus = (id: string) => db.prepare<{ status: string }>("SELECT status FROM inbox WHERE id = ?").get(`telegram:nouva:814:${id}`)?.status;
  return { pipeline, gateway, say, requests, replyRequests, prompts, history, steps, said, charged, inboxStatus, stepStarted, answering };
}

/** Everything the model was sent in request `index`, as one string. */
const sent = (requests: readonly { messages?: unknown }[], index: number) => JSON.stringify(requests[index]?.messages ?? []);

/** Every text the chat showed at some moment: each message as it was sent, and each edit of one. */
const shown = (gateway: FakeGateway) => [...gateway.posted, ...gateway.edits.map((edit) => edit.text)];

describe("a message sent while the agent works", () => {
  test("is read at its next step — after the step it arrived in, inside the same turn", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    expect(b.gateway.posted).toContain(STEER_ACK);
    // The model's second call carried it, after the slow step's result.
    expect(sent(b.requests, 1)).toContain("use the staging DB");
    expect(sent(b.requests, 1)).toContain("sent this while you were working");
    expect(sent(b.requests, 0)).not.toContain("use the staging DB");
    // One turn: it was read, not queued behind it.
    expect(b.prompts()).toEqual(["migrate the database"]);
    // Kept with the conversation, so the next turn — or one taken up after a restart — still has it.
    expect(JSON.stringify(b.history())).toContain("use the staging DB");
    // And the turn's steps say what it read, for the dashboard.
    expect(b.steps().some((text) => text.includes('read a message sent while working: "use the staging DB"'))).toBe(true);
  });

  test("a question in it is to be answered in the reply, not only acted on — said with it, and in the harness", async () => {
    // Live (Nix, 2026-10-31): "btw, is it pushed?" was looked into mid-turn, and the reply never said.
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "not yet — 3 of 7 steps" }]);
    b.say("m1", "why may an orchestrator not be external?");
    await b.stepStarted();
    b.say("m2", "btw, is the artifacts work pushed?");
    await b.pipeline.idle();

    const rule = "If it asks you something, answer it in your reply.";
    // The message's own header — the harness says the same, so the rule alone would be found in the system prompt.
    expect(sent(b.requests, 1)).toContain(`[Gading sent this while you were working. Read it before your next step: it may add to, change or stop what you are doing. ${rule}`);
    const harness = renderTools({ ctx: { harness: { maxToolIterations: 8, maxTurnDurationMs: 60_000, approvalAvailable: true } }, toolNames: ["slow"], gated: [], free: ["slow"] } as never).join("\n");
    expect(harness).toContain(`marked as sent while you were working. Read it and adjust: it may add to, change or stop what you are doing. ${rule}`);
  });

  test("several before one step are read together, and the step names them on one line", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    b.say("m3", "and the replica too");
    await b.pipeline.idle();

    expect(b.gateway.posted.filter((text) => text === STEER_ACK)).toHaveLength(2);
    expect(sent(b.requests, 1)).toContain("use the staging DB\\n\\nand the replica too");
    // One line, one space: the two were kept apart by a blank line, which the step is not the place for.
    expect(b.steps()).toContain('read a message sent while working: "use the staging DB and the replica too"');
  });

  test("one sent once the answer is written starts the next turn — no 'Got it' from a turn with no step left", async () => {
    // Found live: the reply had gone out, the turn was compacting the conversation for twenty seconds, and
    // "gas lanjut" was told it would be read before a next step that the idle-looking agent never had.
    const b = await bench([{ text: "migrated" }, { text: "will do" }], { slowSend: "migrated" });
    b.say("m1", "migrate the database");
    while (!(b.gateway as SlowToSend).sending) await sleep(10);
    b.say("m2", "go on");
    await b.pipeline.idle();
    await sleep(50);
    await b.pipeline.idle();

    expect(b.gateway.posted).not.toContain(STEER_ACK);
    expect(b.prompts()).toEqual(["migrate the database", "go on"]);
  });

  test("while an approval waits, is told how to answer it — a 'yes' typed as a message is not one", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }], { parked: true });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "yes");
    await b.pipeline.idle();

    expect(b.gateway.posted).toContain(STEER_ACK_PARKED);
    expect(b.gateway.posted).not.toContain(STEER_ACK);
  });

  test("is still a command when it is one — answered at once, not read by the turn", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "/status");
    await b.pipeline.idle();

    expect(b.gateway.posted).not.toContain(STEER_ACK);
    expect(sent(b.requests, 1)).not.toContain("sent this while you were working");
    // Answered by the harness, beside the turn.
    expect(b.gateway.sent.some((m) => /model|uptime/i.test(m.text))).toBe(true);
  });

});

/**
 * Past what one turn reads (`STEER_CAP`), a message in a one-to-one chat waits for the turn to end — and waited in
 * silence, up to `queue_timeout_ms`, with no sign it had arrived at all (P9). Its sender is told once a turn now.
 */
describe("past what one turn reads", () => {
  test("the sender is told once that the message waits, and it is answered when the turn ends", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "migrated" }, { text: "and the rest" }, { text: "ok" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    for (let n = 2; n <= 6; n++) b.say(`m${n}`, `also step ${n}`);
    b.say("m7", "and one more thing");
    b.say("m8", "and another");
    await b.pipeline.idle();
    await sleep(50);
    await b.pipeline.idle();

    const texts = b.gateway.posted;
    expect(texts.filter((text) => text === STEER_ACK)).toHaveLength(STEER_CAP);
    const told = texts.filter((text) => text.includes("this message waits for it"));
    expect(told).toEqual([expect.stringMatching(/^⏳ nouva is still working on "migrate the database" \(\d+s so far\): this message waits for it, and is answered next\.$/i)]);
    // Not dropped: what the turn could not read became the next turn.
    expect(b.prompts().join("\n")).toContain("and one more thing");
  });

  test("drawn on the turn for the dashboard while it waits, and taken back when it is the next turn's question", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "migrated" }, { text: "and the rest" }, { text: "ok" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    for (let n = 2; n <= 6; n++) b.say(`m${n}`, `also step ${n}`);
    b.say("m7", "nouva: and one more thing");
    b.say("m8", "and another");

    // The dashboard's connection keeps nothing it is sent: without these lines it showed nothing at all. Each message
    // is drawn; the notice, once.
    const waiting = b.said().slice(-3);
    expect(waiting[0]).toEqual({ prompt: "migrate the database", kind: "steer", text: "and one more thing" });
    expect(waiting[1]).toMatchObject({ prompt: "migrate the database", kind: "steer_reply", text: expect.stringContaining("this message waits for it") });
    expect(waiting[2]).toEqual({ prompt: "migrate the database", kind: "steer", text: "and another" });

    await b.pipeline.idle();
    await sleep(50);
    await b.pipeline.idle();
    expect(b.said().some((row) => row.text.includes("one more thing") || row.text.includes("another") || row.text.includes("waits for it"))).toBe(false);
    expect(b.said().filter((row) => row.kind === "steer")).toHaveLength(STEER_CAP);
  });
});

describe("in a room", () => {
  const group = (overrides: Partial<MessageEnvelope> = {}): Partial<MessageEnvelope> => ({ chatType: "group", ...overrides });
  const mira = group({ senderId: "user-2", senderName: "Mira" });
  /** As each was sent: "Got it" becomes the agent's line once one comes. */
  const texts = (b: { gateway: FakeGateway }) => b.gateway.posted;

  test("the person who started the turn steers it, once they address the agent — after routing, not before", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "nouva: migrate the database", group());
    await b.stepStarted();
    b.say("m2", "nouva: use the staging DB", group());
    await b.pipeline.idle();

    expect(texts(b)).toContain(STEER_ACK);
    // Quoting their message, so a busy room shows what the acknowledgement is about.
    expect(b.gateway.sent[b.gateway.posted.indexOf(STEER_ACK)]?.replyTo).toBe("m2");
    expect(sent(b.requests, 1)).toContain("sent this while you were working");
    // Read without the address the room needed to route it.
    expect(sent(b.requests, 1)).toContain("\\nuse the staging DB");
    expect(sent(b.requests, 1)).not.toContain("nouva: use the staging DB");
    expect(b.prompts()).toEqual(["migrate the database"]);
  });

  test("a reply to its progress line is addressed to it — while it works, that line is the newest thing it said", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "nouva: migrate the database", group());
    await b.stepStarted();
    // The fake numbers what it sends `<gateway>#<n>`; the bubble is the first thing the turn posted. Waited for: it goes
    // out from a timer, and on a loaded machine the step began before it did — read at once, there was none.
    await eventually(() => b.gateway.sent.some((m) => m.text.startsWith("[nouva]")), 4_000, "the progress line");
    const bubble = b.gateway.sent.findIndex((m) => m.text.startsWith("[nouva]"));
    b.say("m2", "use the staging DB", group({ replyTo: `telegram:nouva#${bubble + 1}` }));
    await b.pipeline.idle();

    expect(texts(b)).toContain(STEER_ACK);
    expect(sent(b.requests, 1)).toContain("use the staging DB");
    expect(b.prompts()).toEqual(["migrate the database"]);
  });

  test("anybody else who addresses it is told it is busy, on what and for how long — once a turn", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "migrated" }]);
    b.say("m1", "nouva: migrate the database", group());
    await b.stepStarted();
    b.say("m2", "nouva: are you free?", mira);
    await sleep(30);
    b.say("m3", "nouva: hello?", mira);
    await b.pipeline.idle();

    const told = texts(b).filter((text) => text.includes("is still working"));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^⏳ nouva is still working on "migrate the database" \(\d+s so far\): ask again once it's done\.$/i);
    expect(b.gateway.sent.find((m) => m.text === told[0])?.replyTo).toBe("m2");
    // Refused, not read: neither reached the model, and the turn was not steered by somebody else.
    expect(texts(b)).not.toContain(STEER_ACK);
    expect(JSON.stringify(b.requests)).not.toContain("are you free");
    expect(b.prompts()).toEqual(["migrate the database"]);
  });

  test("a message that did not address it is left alone — a room with one bot hands it everything said there", async () => {
    // Routed to it all the same, as the one agent here — so the busy agent is asked, and has to say nothing.
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "migrated" }, { text: "ok" }], { orchestrator: "nouva" });
    b.say("m1", "nouva: migrate the database", group());
    await b.stepStarted();
    b.say("m2", "lunch, anyone?", mira);
    await sleep(20);
    // Not even from the person who started it: talking to the room is not talking to the agent.
    b.say("m3", "brb", group());
    await sleep(20);
    await b.pipeline.idle();

    expect(texts(b).some((text) => text.includes("is still working"))).toBe(false);
    expect(texts(b)).not.toContain(STEER_ACK);
    expect(JSON.stringify(b.requests)).not.toContain("lunch");
    expect(JSON.stringify(b.requests)).not.toContain("brb");
    expect(b.prompts()).toEqual(["migrate the database"]);
  });

  test("while an approval waits there, the acknowledgement names no command — a bare /approve may reach another agent", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }], { parked: true });
    b.say("m1", "nouva: migrate the database", group());
    await b.stepStarted();
    b.say("m2", "nouva: and the replicas too", group());
    await b.pipeline.idle();

    expect(texts(b)).toContain(STEER_ACK_PARKED_ROOM);
    expect(texts(b)).not.toContain(STEER_ACK_PARKED);
  });

  test("one that came while the turn wrote its answer starts the next turn — the queue does not take it for a repeat", async () => {
    const b = await bench([{ text: "migrated" }, { text: "about a minute" }], { providerDelayMs: 250 });
    b.say("m1", "nouva: migrate the database", group());
    await b.answering();
    b.say("m2", "nouva: then tell me how long it took", group());
    await b.pipeline.idle();
    await sleep(50);
    await b.pipeline.idle();

    expect(texts(b)).toContain(STEER_ACK);
    // Routed again by its address and answered: it passed through the queue a moment before, and the
    // queue's one-second dedup would otherwise have dropped it as a platform redelivery.
    expect(b.prompts()).toEqual(["migrate the database", "then tell me how long it took"]);
  });

  test("stays owed in the inbox until the turn reads it, so a restart before then still answers it", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched" }]);
    b.say("m1", "nouva: migrate the database", group());
    await b.stepStarted();
    b.say("m2", "nouva: use the staging DB", group());
    // Steered from inside the queue's handler, which marks what it handled as done on the way out: owed — queued, not
    // done — while the step it arrived in still runs.
    await eventually(() => b.inboxStatus("m2") === "queued", 4_000, "m2 owed in the inbox");
    await b.pipeline.idle();
    expect(b.inboxStatus("m2")).toBe("done");
    expect(b.inboxStatus("m1")).toBe("done");
  });
});

describe("a reply in the agent's own words, in place of 'Got it'", () => {
  const REPLY = "Siap, abis step ini gw pindah ke staging.";

  test("'Got it' becomes it — one bubble, not two — and the step that reads the message is told it was a guess", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    // "Got it" went at once, and was rewritten into the line: no message of its own (0.8.7, live — two under each).
    const ack = b.gateway.posted.indexOf(STEER_ACK);
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(b.gateway.posted).not.toContain(REPLY);
    expect(b.gateway.edits).toContainEqual({ messageId: `telegram:nouva#${ack + 1}`, text: `↪ ${REPLY}` });
    expect(b.gateway.sent[ack]?.text).toBe(`↪ ${REPLY}`);
    // Handed to the turn as a guess to correct, never as a promise to keep: "do what you said" sent Nix after a mission
    // nobody asked about, on a line that had misread "I mean you yourself".
    const read = sent(b.requests, 1);
    expect(read).toContain(`A quick reply went to them in your name before you read this: \\"${REPLY}\\".`);
    expect(read).toContain("It was a guess at what they meant, written in a second or two from the conversation, your last few steps and this message, not a promise.");
    expect(read).toContain("Go by their words: if the guess misread them, say so and do what they actually asked.");
    expect(read).not.toContain("do what you said");
    // Still the person's words alone in the step the dashboard shows.
    expect(b.steps()).toContain('read a message sent while working: "use the staging DB"');
  });

  test("follows 'Got it' as a message of its own where the connection cannot rewrite one", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }], { noEdits: true });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    expect(b.gateway.posted.indexOf(REPLY)).toBeGreaterThan(b.gateway.posted.indexOf(STEER_ACK));
    expect(b.gateway.posted.indexOf(STEER_ACK)).toBeGreaterThanOrEqual(0);
  });

  test("is asked with what their message replies to — the progress line they answered, not a guess at it", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    // Live (0.8.7): "I mean you yourself", a reply to Nix's progress line, was answered as if it were about a mission.
    b.say("m2", "ini mksd gw diri lu sendiri", { quotedText: "[nix] 🔧 exec … 166s", quotedSender: "Nix" });
    await b.pipeline.idle();

    const { system, asked } = b.replyRequests[0]!;
    expect(asked).toContain('Their message replies to this one from Nix: "[nix] 🔧 exec … 166s"\n\nTheir message: ini mksd gw diri lu sendiri');
    expect(system).toContain("Read their message in the light of the conversation and the task. If what they mean is still not clear, do not guess at it: say you will look at it properly at your next step.");
    // And the turn reads it with the message it answers, as its own question would be.
    expect(sent(b.requests, 1)).toContain("> [Nix]: [nix] 🔧 exec … 166s\\n\\nini mksd gw diri lu sendiri");
  });

  test("is asked with the conversation, the request, the steps so far and the message", async () => {
    // Without the conversation it read a question about a TV box as one about Nouride's own OS (live, 2026-11-05).
    const b = await bench([{ text: "earlier answer" }, { toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }]);
    b.say("m0", "remember the codeword pineapple");
    await b.pipeline.idle();
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    expect(b.replyRequests).toHaveLength(1);
    const { system, asked } = b.replyRequests[0]!;
    expect(asked).toMatch(/The conversation before this task:\nThey said: remember the codeword pineapple[^\n]*\nYou said: earlier answer\n/);
    expect(asked.indexOf("The conversation before this task:")).toBeLessThan(asked.indexOf("Working on: migrate the database"));
    expect(asked).toContain("Their message: use the staging DB");
    expect(asked).toContain("- ");
    expect(system).toContain("ONE short sentence");
  });

  test("speaks for the steps the turn recorded — not the sixty rows a long generation's thinking lines fill", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    // The steps the turn recorded — thinking, which once filled a sixty-line window, is no step at all.
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();
    expect(b.replyRequests).toHaveLength(1);
    expect(b.replyRequests[0]!.asked).toMatch(/Latest steps:\n- slow/);
  });

  test("one at a time: messages while it is being written get 'Got it' alone", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }], { steerReplyMs: 100 });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    b.say("m3", "and the replica too");
    await b.pipeline.idle();

    expect(b.gateway.posted.filter((text) => text === STEER_ACK)).toHaveLength(2);
    expect(b.replyRequests).toHaveLength(1);
    expect(b.gateway.sent.filter((m) => m.text === `↪ ${REPLY}`)).toHaveLength(1);
    expect(b.gateway.sent.filter((m) => m.text === STEER_ACK)).toHaveLength(1);
  });

  test("not sent when it comes after the turn read the message — it would promise for a step already taken", async () => {
    // Read after the first step, and the reply lands during the second — the turn still at work.
    const twoSteps = [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { toolCalls: [{ id: "c2", name: "slow", args: {} }] }, { text: "done" }];
    const b = await bench(twoSteps, { steerReplyMs: 450 });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    expect(b.gateway.posted).toContain(STEER_ACK);
    expect(shown(b.gateway).some((text) => text.includes(REPLY))).toBe(false);
    expect(sent(b.requests, 1)).not.toContain("A quick reply went to them");
  });

  test("a call that fails sends nothing more, and the turn goes on as before", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }], { steerReply: null });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    expect(b.gateway.posted).toEqual(expect.arrayContaining([STEER_ACK, "switched to staging"]));
    expect(shown(b.gateway).some((text) => text.includes(REPLY))).toBe(false);
    expect(sent(b.requests, 1)).toContain("use the staging DB");
  });

  test("off with `[queue] steer_reply = false`, and never while an approval decides what comes next", async () => {
    for (const options of [{ steerReplyOn: false }, { parked: true }]) {
      const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }], options);
      b.say("m1", "migrate the database");
      await b.stepStarted();
      b.say("m2", "use the staging DB");
      await b.pipeline.idle();

      expect(b.replyRequests).toHaveLength(0);
      expect(shown(b.gateway).some((text) => text.includes(REPLY))).toBe(false);
    }
  });

  test("asked of `steer_reply_model` when one is set, of the agent's own model otherwise — and of a tier's model when it names one", async () => {
    for (const [option, model] of [[undefined, "test-model"], ["fast-model", "fast-model"], ["small", "fast-small"]] as const) {
      const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }], option ? { steerReplyModel: option, smallModel: "fast-small" } : {});
      b.say("m1", "migrate the database");
      await b.stepStarted();
      b.say("m2", "use the staging DB");
      await b.pipeline.idle();

      expect(b.replyRequests[0]?.model).toBe(model);
      // The turn itself is untouched by it.
      expect(b.requests.every((request) => request.model === "test-model")).toBe(true);
    }
  });

  test("past `steer_reply_timeout_ms`, 'Got it' stands alone", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }], { steerReplyMs: 100, steerReplyTimeoutMs: 50 });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();
    await sleep(200);

    expect(b.replyRequests).toHaveLength(1);
    expect(b.gateway.posted).toContain(STEER_ACK);
    expect(shown(b.gateway).some((text) => text.includes(REPLY))).toBe(false);
  });

  test("speaks as the agent, to the person People knows: its persona and their notes go with the request", async () => {
    const people = [{ key: "alex", name: "Alex", ids: ["telegram:user-1"], notes: "Call him Al. Casual Indonesian, gw/lu." }];
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "done" }], { people });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    const { system } = b.replyRequests[0]!;
    expect(system).toContain("Be brief.");
    expect(system).toContain("Alex just sent you a message");
    expect(system).toContain("About Alex, from your notes:\nCall him Al. Casual Indonesian, gw/lu.");
  });

  test("a turn quicker than its reply: the call is stopped when the turn reads the message, and nothing follows", async () => {
    const twoSteps = [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { toolCalls: [{ id: "c2", name: "slow", args: {} }] }, { text: "switched to staging" }];
    const b = await bench(twoSteps, { steerReplyMs: 2000 });
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    // Read after the first step; the second step runs after it. Stopped at the read, not at the end: when the call is
    // seen stopped, the model has been asked twice — the read went with the second — and not yet the third time.
    await eventually(() => b.replyRequests[0]?.aborted === true, 4_000, "the reply call stopped");
    expect(b.requests).toHaveLength(2);
    await b.pipeline.idle();
    expect(b.gateway.posted).toEqual(expect.arrayContaining([STEER_ACK, "switched to staging"]));
    expect(shown(b.gateway).some((text) => text.includes(REPLY))).toBe(false);
  });

  test("in a room too, for the person who started the turn — in the 'Got it' that quotes their message", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "nouva: migrate the database", { chatType: "group", chatId: "814" });
    await b.stepStarted();
    b.say("m2", "nouva: use the staging DB", { chatType: "group", chatId: "814" });
    await b.pipeline.idle();

    const reply = b.gateway.sent.find((m) => m.text === `↪ ${REPLY}`);
    expect(reply?.replyTo).toBe("m2");
    expect(b.gateway.posted).not.toContain(REPLY);
    expect(b.replyRequests[0]?.asked).toContain("Their message: use the staging DB");
  });
});

/**
 * The dashboard reads a conversation from the turns' records, and the local connection hands a reply only to a
 * request waiting for one — the dashboard's never does. So a message steering a turn from there seemed to vanish:
 * no bubble until the turn read it (then a step quoting 120 characters of it), and "Got it" and the line under it
 * never. Found live, steering Ren from the dashboard: "agentnya sih baca, tapi begini".
 */
describe("drawn on the turn's record, for the dashboard", () => {
  const REPLY = "Siap, abis step ini gw pindah ke staging.";

  test("the message at once, in the person's words, then what they were told — on the turn it steers", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    // With the address the dashboard's connection puts in front, which is for routing and not what was said.
    b.say("m2", "nouva: use the staging DB");

    // Before the turn has read it: mid-step, which is when the person is looking for it.
    expect(b.said()).toEqual([
      { prompt: "migrate the database", kind: "steer", text: "use the staging DB" },
      { prompt: "migrate the database", kind: "steer_reply", text: STEER_ACK },
    ]);
    await b.pipeline.idle();

    expect(b.said()).toEqual([
      { prompt: "migrate the database", kind: "steer", text: "use the staging DB" },
      { prompt: "migrate the database", kind: "steer_reply", text: STEER_ACK },
      { prompt: "migrate the database", kind: "steer_reply", text: REPLY },
    ]);
    // Read by that turn, so drawn there and nowhere else.
    expect(b.prompts()).toEqual(["migrate the database"]);
  });

  test("taken back off a turn that never read it — the next turn's question, which drawn twice reads as sent twice", async () => {
    const b = await bench([{ text: "migrated" }, { text: "will do" }], { providerDelayMs: 250 });
    b.say("m1", "migrate the database");
    await b.answering();
    b.say("m2", "then tell me how long it took");
    // Drawn while it waits, as any steer is: whether a step comes to read it is not known yet.
    expect(b.said().map((row) => row.kind)).toEqual(["steer", "steer_reply"]);
    await b.pipeline.idle();
    await sleep(50);
    await b.pipeline.idle();

    expect(b.prompts()).toEqual(["migrate the database", "then tell me how long it took"]);
    expect(b.said()).toEqual([]);
  });

  test("nothing on a turn that has ended — a line held up behind a slow 'Got it' lands after it", async () => {
    // The line is ready at once; "Got it" takes 300ms to send, the turn ends at ~250ms, and the line goes after it.
    const b = await bench([{ text: "migrated" }, { text: "will do" }], { providerDelayMs: 250, slowSend: STEER_ACK });
    b.say("m1", "migrate the database");
    await b.answering();
    b.say("m2", "then tell me how long it took");
    await sleep(450);
    await b.pipeline.idle();
    await sleep(50);
    await b.pipeline.idle();

    expect(b.gateway.sent.map((m) => m.text)).toContain(`↪ ${REPLY}`);
    expect(b.prompts()).toEqual(["migrate the database", "then tell me how long it took"]);
    expect(b.said()).toEqual([]);
  });

  test("nothing for a turn past its last step, and no line the turn was quicker than", async () => {
    const finishing = await bench([{ text: "migrated" }, { text: "will do" }], { slowSend: "migrated" });
    finishing.say("m1", "migrate the database");
    while (!(finishing.gateway as SlowToSend).sending) await sleep(10);
    finishing.say("m2", "go on");
    await finishing.pipeline.idle();
    await sleep(50);
    await finishing.pipeline.idle();
    expect(finishing.said()).toEqual([]);

    // Read after the first step; the line is ready during the second, when it would promise for a step taken.
    const twoSteps = [{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { toolCalls: [{ id: "c2", name: "slow", args: {} }] }, { text: "done" }];
    const quick = await bench(twoSteps, { steerReplyMs: 450 });
    quick.say("m1", "migrate the database");
    await quick.stepStarted();
    quick.say("m2", "use the staging DB");
    await quick.pipeline.idle();
    expect(quick.said().map((row) => row.text)).toEqual(["use the staging DB", STEER_ACK]);
  });

  test("the line in the agent's words is charged to the turn it spoke for (D2)", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "migrate the database");
    await b.stepStarted();
    b.say("m2", "use the staging DB");
    await b.pipeline.idle();

    // The turn's two calls, and between them the steering reply's — its 50 input tokens — on the same turn.
    expect(b.charged().map((call) => call.prompt)).toEqual(["migrate the database", "migrate the database", "migrate the database"]);
    expect(b.charged().some((call) => call.input === 50)).toBe(true);
  });

  test("in a room too, where the local connection drops the lines just the same", async () => {
    const b = await bench([{ toolCalls: [{ id: "c1", name: "slow", args: {} }] }, { text: "switched to staging" }]);
    b.say("m1", "nouva: migrate the database", { chatType: "group" });
    await b.stepStarted();
    b.say("m2", "@nouva use the staging DB", { chatType: "group" });
    await b.pipeline.idle();

    expect(b.said()).toEqual([
      { prompt: "migrate the database", kind: "steer", text: "use the staging DB" },
      { prompt: "migrate the database", kind: "steer_reply", text: STEER_ACK },
      { prompt: "migrate the database", kind: "steer_reply", text: REPLY },
    ]);
  });
});

describe("which turn a message steers", () => {
  const turn = (overrides: Partial<ActiveTurn> = {}): ActiveTurn => ({
    controller: new AbortController(),
    agentId: "nouva",
    gatewayId: "telegram:nouva",
    chatId: "814",
    steers: [],
    steered: 0,
    ...overrides,
  });
  const message = (overrides: Partial<MessageEnvelope> = {}) =>
    envelope({ gatewayId: "telegram:nouva", chatId: "814", text: "use staging", ...overrides });
  const noCommands = () => false;

  test("the one at work in its one-to-one chat", () => {
    const working = turn();
    expect(steerTarget([working], message(), noCommands)).toBe(working);
  });

  test("none for words that are not only words, nor for anyone but a person", () => {
    const working = turn();
    expect(steerTarget([working], message({ attachments: [{ kind: "image", path: "/tmp/x.png", mimeType: "image/png" }] as never }), noCommands)).toBeNull();
    expect(steerTarget([working], message({ senderIsBot: true }), noCommands)).toBeNull();
    expect(steerTarget([working], message({ senderId: "nouride:system" }), noCommands)).toBeNull();
    expect(steerTarget([working], message({ text: "   " }), noCommands)).toBeNull();
  });

  test("none for a turn that cannot be steered, or past the cap — then it waits for the turn instead", () => {
    expect(steerTarget([turn({ steers: undefined })], message(), noCommands)).toBeNull();
    expect(steerTarget([turn({ steered: STEER_CAP })], message(), noCommands)).toBeNull();
    expect(steerTarget([turn({ steered: STEER_CAP - 1 })], message(), noCommands)).not.toBeNull();
  });
});

describe("what a busy agent does with a message for it", () => {
  const started = envelope({ id: "m1", gatewayId: "telegram:nouva", chatId: "814", chatType: "group", text: "nouva: migrate the database" });
  const turn = (overrides: Partial<ActiveTurn> = {}): ActiveTurn => ({
    controller: new AbortController(),
    agentId: "nouva",
    gatewayId: "telegram:nouva",
    chatId: "814",
    steers: [],
    steered: 0,
    trigger: started,
    startedAt: Date.now(),
    ...overrides,
  });
  const from = (overrides: Partial<MessageEnvelope> = {}) => ({ ...started, id: "m2", text: "use staging", ...overrides });
  const ways = { addressed: true, fromPerson: true, steer: true };

  test("steers for the person who started it, in words, addressed to it", () => {
    expect(whileBusy(turn(), from(), ways)).toBe("steer");
  });

  test("tells anybody else — and the starter too, when it cannot read this one", () => {
    expect(whileBusy(turn(), from({ senderId: "user-2" }), ways)).toBe("tell");
    expect(whileBusy(turn(), from(), { ...ways, steer: false })).toBe("tell");
    expect(whileBusy(turn(), from({ attachments: [{ type: "image", mimeType: "image/png" }] as never }), ways)).toBe("tell");
    expect(whileBusy(turn({ steered: STEER_CAP }), from(), ways)).toBe("tell");
    // A turn nothing may steer, and an agent that handed over: an agent does not rewrite another's turn.
    expect(whileBusy(turn({ steers: undefined }), from(), ways)).toBe("tell");
    expect(whileBusy(turn(), from(), { ...ways, fromPerson: false })).toBe("tell");
    // A turn the daemon started has nobody who started it.
    expect(whileBusy(turn({ trigger: { ...started, senderId: "nouride:system" } }), from(), ways)).toBe("tell");
  });

  test("says nothing to a message that did not address it, to somebody already told, or to its own events", () => {
    expect(whileBusy(turn(), from({ senderId: "user-2" }), { ...ways, addressed: false })).toBe("quiet");
    expect(whileBusy(turn({ told: new Set(["user-2"]) }), from({ senderId: "user-2" }), ways)).toBe("quiet");
    expect(whileBusy(turn(), from({ senderId: "nouride:system" }), ways)).toBe("quiet");
    expect(whileBusy(undefined, from(), ways)).toBe("quiet");
  });

  const nouva = { id: "nouva", displayName: "Nouva" };
  const agents = ["nouva", "nero", "nox"].map((id) => ({ config: { id, displayName: id[0]!.toUpperCase() + id.slice(1) } }) as LoadedAgent);

  test("the notice says who, on what, for how long — and whether an approval is what it waits on", () => {
    const now = Date.now();
    const busy = turn({ startedAt: now - 240_000 });
    expect(busyNotice(nouva, busy, { parked: false, now })).toBe(`⏳ Nouva is still working on "migrate the database" (4m so far): ask again once it's done.`);
    expect(busyNotice(nouva, busy, { parked: true, now })).toBe(
      `⏳ Nouva is still working on "migrate the database" (4m so far), and is waiting for an approval here: ask again once it's done.`,
    );
  });

  test("never quotes the daemon's own words: a turn it started says only how long", () => {
    const now = Date.now();
    const resumed = turn({ trigger: { ...started, senderId: "nouride:system", text: "[system] The daemon restarted while you were working…" }, startedAt: now - 42_000 });
    expect(busyNotice(nouva, resumed, { parked: false, now })).toBe("⏳ Nouva is still working (42s so far): ask again once it's done.");
  });

  test("wakes nobody: the quote has no mention left in it for the router or the platform to act on", () => {
    const loud = turn({ trigger: { ...started, text: "@nouva ask @nero and <@1234567> to check\nthe @nox logs, @everyone" } });
    const notice = busyNotice(nouva, loud, { parked: false });
    expect(notice).toContain(`on "ask nero and to check the nox logs, everyone"`);
    expect(mentionedAgents(envelope({ text: notice, senderIsBot: true }), agents)).toEqual([]);
    expect(notice).not.toContain("/stop");
  });

  test("a long request is cut to one short line", () => {
    const long = turn({ trigger: { ...started, text: `nouva: ${"rebuild every image ".repeat(10)}` } });
    const about = /on "([^"]*)"/.exec(busyNotice(nouva, long, { parked: false }))?.[1] ?? "";
    expect(about.length).toBeLessThanOrEqual(80);
    expect(about.endsWith("…")).toBe(true);
  });
});

describe("around it", () => {
  test("the agent's name the dashboard and the CLI put in front is not part of what the model reads", () => {
    expect(unaddressed("nouva: use the staging DB", "nouva")).toBe("use the staging DB");
    expect(unaddressed("@Nouva, use staging", "nouva")).toBe("use staging");
    expect(unaddressed("@nouva use staging", "nouva")).toBe("use staging");
    expect(unaddressed("Nouva Prime: hi", "nouva", "Nouva Prime")).toBe("hi");
    expect(unaddressed("use staging", "nouva")).toBe("use staging");
    // Only the name itself: another word that starts with it is the message, and so is a sentence about it.
    expect(unaddressed("nouvax: hi", "nouva")).toBe("nouvax: hi");
    expect(unaddressed("@nouvabot hi", "nouva")).toBe("@nouvabot hi");
    expect(unaddressed("Nouva is right", "nouva")).toBe("Nouva is right");
  });

  test("two callers waiting on one chat both hear what is said there — the second no longer takes the first's replies", async () => {
    const local = new LocalGateway();
    let release: () => void = () => {};
    const idle = new Promise<void>((resolve) => (release = resolve));
    local.onMessage(() => {});
    const first = local.ask({ chatId: "dev-1", text: "start" }, () => idle);
    const second = local.ask({ chatId: "dev-1", text: "use staging" }, () => idle);
    await local.send({ gatewayId: local.id, chatId: "dev-1", text: "on it, with staging" });
    release();

    expect(await first).toEqual({ replies: ["on it, with staging"], answered: true });
    expect(await second).toEqual({ replies: ["on it, with staging"], answered: true });
  });
});
