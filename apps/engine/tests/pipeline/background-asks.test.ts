/**
 * An ask that does not hold the asking turn hostage (0.7.19), through the real pipeline: a person's message, the asking
 * agent's turn, the other agent's turn that outlasts its wait and carries on as a job, the asking turn ending, and the
 * answer waking the asking agent in the chat — with a model that answers each request by who is asking.
 *
 * What each test holds: the ask waits, then moves to the background and the asking turn ends while the other agent works
 * on; `background: true` returns at once; the job is the asking agent's, listed and bounded like a helper; the answer
 * wakes the asking agent — never the asked one — saying what it answers; a failure, the time limit, a stop and a restart
 * wake it too, saying which; a wake waits for the turn the asking agent is in; the one limit counts asks with helpers;
 * a helper's ask, and the asked agent's own turn, never move one behind them; an approval the asked agent needs after
 * the asking turn ended still reaches the chat and works.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTextFileIfExists } from "@nouride/runtime";
import type { ApprovalRequest, GlobalConfig, Tool, ToolContext } from "@nouride/shared";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { ASKED_TO_SAY } from "@/modules/pipeline/peer-turn.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { peersFrom } from "@/modules/tools/builtins/ask-agent.ts";
import type { ApprovalAsk, ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { reportInterruptedJobs } from "@/boot/jobs.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { conversationOf, envelope, FakeGateway } from "../helpers.ts";
import { eventually, sleep } from "../wait.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

// ── a model that answers by who is asking ─────────────────────────────────────────────────────────────────────────

interface Said {
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}

/** A helper — by its goal — or an agent, by the id its prompt names. */
type Who = { kind: "helper"; goal: string } | { kind: "agent"; id: string };

interface Body {
  messages: { role: string; content: unknown }[];
  tools?: { function: { name: string; parameters: unknown } }[];
  stream?: boolean;
}

interface Asked {
  who: Who;
  body: Body;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";

function whoAsks(body: Body): Who {
  const system = textOf(body.messages[0]?.content);
  if (system.includes("You are a helper doing one piece of work")) {
    const brief = textOf(body.messages.find((message) => message.role === "user")?.content);
    return { kind: "helper", goal: /GOAL\n([^\n]+)/.exec(brief)?.[1] ?? "" };
  }
  return { kind: "agent", id: /\(agent id: ([^)]+)\)/.exec(system)?.[1] ?? "?" };
}

const lastUser = (body: Body): string => textOf(conversationOf(body.messages).filter((message) => message.role === "user").at(-1)?.content);
const toolResults = (body: Body): string[] => body.messages.filter((message) => message.role === "tool").map((message) => textOf(message.content));
const offered = (body: Body, tool: string) =>
  Object.keys((body.tools?.find((entry) => entry.function.name === tool)?.function.parameters as { properties?: object } | undefined)?.properties ?? {});

/** A provider answering each request through `answer`, as the OpenAI wire does: streamed, or whole for a wrap-up. */
function provider(answer: (who: Who, body: Body) => Said | Promise<Said>) {
  const asked: Asked[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    const who = whoAsks(body);
    asked.push({ who, body });
    const said = await Promise.race([
      Promise.resolve(answer(who, body)),
      new Promise<never>((_, reject) => {
        const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (init?.signal?.aborted) fail();
        init?.signal?.addEventListener("abort", fail, { once: true });
      }),
    ]);
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

/** A gate a test opens: a model call waits on it, so the test decides when that call answers. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

const never = () => new Promise<Said>(() => {});

// ── the daemon, as boot wires it ──────────────────────────────────────────────────────────────────────────────────

const benches: Bench[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  for (const jobs of stores.splice(0)) await jobs.killAll();
  // A test that failed can leave a turn waiting on a model that never answers: stopped, so the next test starts clean.
  for (const bench of benches) for (const turn of bench.pipeline.runningTurns()) turn.controller.abort();
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

/** A tool that notes what it was asked to check — any agent's — and who had asked the agent calling it, if one had. */
function probe(ran: string[], askers: (string | undefined)[] = []): Tool {
  return {
    requiresApproval: false,
    definition: { name: "probe", description: "checks one thing", parameters: { type: "object", properties: { what: { type: "string" } } } },
    async execute(args, ctx) {
      ran.push(String(args.what ?? ""));
      askers.push(ctx.askedBy);
      // "bg": answers as `exec` does a job it started in the background — the turn wraps up (`exec-started.ts`).
      if (args.what === "bg") return { content: "Started in the background as job_bg.", isError: false, metadata: { control: { finishTurn: "wrap_up", note: "background_started" } } };
      return { content: `checked ${String(args.what ?? "")}`, isError: false };
    },
  };
}

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "ask_agent", "probe"]\napproval_required = []\n';

/** How long an ask waits here before it moves: long enough for a step or two, short enough for a test. */
const WAIT_MS = 300;

async function daemon(options: {
  answer: (who: Who, body: Body) => Said | Promise<Said>;
  approvals?: ApprovalGate;
  /** Each agent's `config.toml`, where it is not `PACK`. */
  packs?: Record<string, string>;
  waitMs?: number;
  configure?: (config: GlobalConfig) => void;
  /** A process over the same install, after a restart. */
  after?: Bench;
}) {
  const { fetchImpl, asked } = provider(options.answer);
  const gateway = new FakeGateway();
  let jobs!: JobStore;
  // What the daemon says in its own voice — the line it posts before a wake-up's turn — recorded rather than sent.
  const notices: string[] = [];
  const notifier = { toChat: async (_target: unknown, text: string) => (notices.push(text), true), alert: async () => true };
  const deps = ({ db, dataDir, config }: { db: Bench["db"]; dataDir: string; config: GlobalConfig }) => {
    jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4, maxMs: () => config.security.jobMaxMs });
    return { jobs, notifier: notifier as never, ...(options.approvals ? { approvals: options.approvals } : {}) };
  };
  const bench = options.after
    ? await options.after.reboot({ fetch: () => fetchImpl, gateway, deps })
    : await pipelineBench({
        fetch: () => fetchImpl,
        gateway,
        agents: ["nouva", "nox", "nera"].map((id) => ({ id, configToml: options.packs?.[id] ?? PACK })),
        config: { daemon: { orchestrator: "nouva" }, agents: { mentions_enabled: true } },
        configure: (config) => {
          // A steering reply is its own model call, and the script here answers by who asks, not by turn.
          config.queue.steerReply = false;
          options.configure?.(config);
        },
        deps,
      });
  benches.push(bench);
  stores.push(jobs);
  const ran: string[] = [];
  const askers: (string | undefined)[] = [];
  const tools = createBuiltinTools({
    security: bench.config.security,
    runSubagent: bench.pipeline.subagentRunner(),
    startHelper: bench.pipeline.backgroundHelpers(),
    // As `boot/tools.ts` wires it, with a wait a test can sit through.
    askAgent: { run: bench.pipeline.peerTurnRunner(), start: bench.pipeline.askRunner(), waitMs: options.waitMs ?? WAIT_MS, ...peersFrom(bench.registry, () => true) },
  });
  tools.set("probe", probe(ran, askers));
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  // As boot joins them (`boot/jobs.ts`): a job's end wakes the pipeline.
  jobs.setOnComplete((completion) => bench.pipeline.wakeForJob(completion));
  return { bench, gateway, asked, jobs, ran, askers, notices };
}

type Daemon = Awaited<ReturnType<typeof daemon>>;

const say = (gateway: FakeGateway, text: string, id: string, over: Partial<ReturnType<typeof envelope>> = {}) =>
  gateway.receive(envelope({ id, text, timestamp: Date.now(), ...over }));
/** What the agents said in the chat — not the asked agent's progress bubble, which is labelled `[nox]`. */
const replies = (gateway: FakeGateway) => gateway.sent.map((message) => message.text).filter((text) => !text.startsWith("["));
const bubbles = (gateway: FakeGateway) => gateway.sent.map((message) => message.text).filter((text) => text.startsWith("[nox]"));

const DEPLOY = "Deploy v2 to staging, then check it answers on /health. The person wants it out before the demo.";
const askNox = (args: Record<string, unknown> = {}): Said => ({ toolCalls: [{ id: "a1", name: "ask_agent", args: { agent: "nox", task: DEPLOY, ...args } }] });

/** The asking agent's requests: its own turns, the wake-ups and wrap-ups among them. */
const nouvas = (d: Daemon) => d.asked.filter((request) => request.who.kind === "agent" && request.who.id === "nouva");
const wakeOf = (d: Daemon) => nouvas(d).find((request) => lastUser(request.body).includes("[System event"));

// ── the tests ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("an ask that runs long", () => {
  test("waits, then moves to the background: the asking turn ends, the person is answered meanwhile, and the answer wakes the asking agent", async () => {
    const noxFinishes = gate();
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") {
          const done = toolResults(body).length;
          // One step before the wait runs out, one after it — then held until the test lets it answer.
          if (done === 0) return { toolCalls: [{ id: "x1", name: "probe", args: { what: "staging before" } }] };
          if (done === 1) {
            await eventually(() => replies(gatewayOf()).length > 0, 4_000, "the asking turn's reply");
            return { toolCalls: [{ id: "x2", name: "probe", args: { what: "staging after" } }] };
          }
          await noxFinishes.opened;
          return { text: "Deployed v2 to staging; /health answers 200." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Nox lagi deploy ke staging — nanti gw kabarin begitu beres." };
        if (asked.includes("[System event")) return { text: `Beres: ${/Deployed [^\n]+/.exec(asked)?.[0] ?? "(no answer)"}` };
        if (asked.includes("jam berapa")) return { text: "Jam 12 siang." };
        return askNox();
      },
    });
    const gatewayOf = () => d.gateway;

    say(d.gateway, "deploy v2 ke staging dong", "m1");
    // The asking turn ends with what is happening — the asked agent is still at work.
    await eventually(() => replies(d.gateway).includes("Nox lagi deploy ke staging — nanti gw kabarin begitu beres."), 4_000, "the asking turn's reply");
    const [job] = d.jobs.backgroundTurns("nouva");
    expect(job).toMatchObject({ kind: "ask", agentId: "nouva", status: "running", chatId: "chat-1", gatewayId: "telegram:main", ask: { agent: "nox", task: DEPLOY } });
    expect(job!.command).toStartWith("ask nox: Deploy v2 to staging");
    const session = d.bench.sessions.load({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" }).id;
    const [asking] = d.bench.turns.forSession(session);
    expect(asking).toMatchObject({ status: "done", id: job!.turnId });
    // What the asking agent was told — and the turn it ended on.
    const wrapUp = nouvas(d).find((request) => !request.body.stream)!;
    expect(toolResults(wrapUp.body).at(-1)).toContain(`nox has not answered after 300ms and is still working on it, now in the background, as ${job!.id}.`);
    expect(toolResults(wrapUp.body).at(-1)).toContain("you have not seen it, so do not say what it will be");
    expect(lastUser(wrapUp.body)).toContain("An agent you asked is still working, now in the background");
    // Its bubble says where it went, and says nothing more.
    expect(bubbles(d.gateway).at(-1)).toContain("(working in the background)");

    // Talked to meanwhile — and told what is still at work for it.
    say(d.gateway, "jam berapa sekarang?", "m2");
    await eventually(() => replies(d.gateway).includes("Jam 12 siang."), 4_000, "the answer meanwhile");
    const meanwhile = nouvas(d).find((request) => lastUser(request.body).includes("jam berapa"))!;
    expect(lastUser(meanwhile.body)).toContain(`(Still working in the background for you: ${job!.id} "ask nox: Deploy v2 to staging`);
    await eventually(() => d.ran.length === 2, 4_000, "the asked agent's step in the background");
    expect(d.jobs.get(job!.id)?.status).toBe("running");

    // The answer arrives by itself, and wakes the asking agent — not the asked one — saying what it answers.
    noxFinishes.open();
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("Beres:")), 4_000, "the answer passed on");
    expect(replies(d.gateway).at(-1)).toBe("Beres: Deployed v2 to staging; /health answers 200.");
    const wake = lastUser(wakeOf(d)!.body);
    expect(wake).toContain("@nouva");
    expect(wake).not.toContain("@nox");
    expect(wake).toMatch(new RegExp(`The answer from nox has arrived, to what you asked at \\d\\d:\\d\\d \\(\\d+(ms|s)( \\d+s)? ago\\), in the background as ${job!.id}:`));
    expect(wake).toContain('"Deploy v2 to staging, then check it answers on /health.');
    expect(wake).toContain("nox's handoff:\n[nox · success]");
    expect(wake).toContain("What it is the answer to: what you asked, and when. They may have moved on to something else since.");
    expect(d.asked.filter((request) => request.who.kind === "agent" && request.who.id === "nox" && lastUser(request.body).includes("[System event"))).toEqual([]);
    expect(d.jobs.get(job!.id)).toMatchObject({ status: "succeeded", report: { agentId: "nox", status: "success" } });

    // Its steps: before the move, rows of the asking turn and the job's log; after it, the job's log alone.
    const log = (await readTextFileIfExists(job!.logPath)) ?? "";
    expect(log).toContain("started: nouva asked nox: Deploy v2 to staging");
    expect(log).toContain('→ probe {"what":"staging before"}');
    expect(log).toContain('→ probe {"what":"staging after"}');
    const steps = d.bench.turns.stepsSince(asking!.id).map((step) => step.text);
    expect(steps.some((text) => text.includes("staging before"))).toBe(true);
    expect(steps.some((text) => text.includes("staging after"))).toBe(false);

    // From the move on, a turn of nox's own (0.7.26), named in the log: what it did there and the answer it handed back.
    const [handed] = new TurnInspector(d.bench.db).inspect(asking!.id)!.delegated ?? [];
    expect(handed).toMatchObject({ agentId: "nox", status: "done", prompt: DEPLOY, cause: { via: "ask_agent", job: job!.id, parent: asking!.id } });
    expect(log).toContain(`its turn is ${handed!.id}`);
    const own = new TurnInspector(d.bench.db).inspect(handed!.id)!;
    expect(own.steps[0]?.text).toBe(`moved to the background as ${job!.id} (its steps before this are turn ${asking!.id}'s)`);
    expect(own.steps.map((step) => step.text).some((text) => text.includes("staging after"))).toBe(true);
    expect(own.steps.map((step) => step.text).some((text) => text.includes("staging before"))).toBe(false);
    expect(own.turn.reply).toBe("Deployed v2 to staging; /health answers 200.");
  });

  test("`background: true` returns at once, and the answer still comes back", async () => {
    const noxFinishes = gate();
    const d = await daemon({
      // A wait it would never sit through here: the turn must not wait at all.
      waitMs: 60_000,
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") {
          await noxFinishes.opened;
          return { text: "Audit done: 2 findings." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Nox lagi audit di belakang." };
        if (asked.includes("[System event")) return { text: "Audit beres: 2 temuan." };
        return askNox({ task: "Audit the staging firewall rules.", background: true });
      },
    });

    say(d.gateway, "audit firewall staging", "m1");
    await eventually(() => replies(d.gateway).includes("Nox lagi audit di belakang."), 4_000, "the asking turn's reply");
    const [job] = d.jobs.backgroundTurns("nouva");
    expect(job).toMatchObject({ kind: "ask", ask: { agent: "nox", task: "Audit the staging firewall rules." } });
    const wrapUp = nouvas(d).find((request) => !request.body.stream)!;
    expect(toolResults(wrapUp.body).at(-1)).toStartWith(`nox is working on it in the background, as ${job!.id}.`);

    noxFinishes.open();
    await eventually(() => replies(d.gateway).includes("Audit beres: 2 temuan."), 4_000, "the answer passed on");
  });

  test("asked again while it works in the background, the same agent is refused — told where the first answer will come from", async () => {
    let turn = 0;
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") return await never();
        if (!body.stream) return { text: "ok" };
        if (conversationOf(body.messages).at(-1)?.role === "tool") return { text: `seen: ${toolResults(body).at(-1)}` };
        turn += 1;
        return askNox({ task: turn === 1 ? DEPLOY : "Also restart the worker.", background: true });
      },
    });
    say(d.gateway, "deploy", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1, 4_000, "the first ask in the background");
    const [first] = d.jobs.backgroundTurns("nouva");
    say(d.gateway, "restart workernya juga", "m2");
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("seen: [nox · failed]")), 4_000, "the refusal");
    expect(replies(d.gateway).at(-1)).toContain(`nox is still working in the background on what you asked earlier (${first!.id}). Its answer comes to you as a message when it is done`);
    expect(d.jobs.backgroundTurns("nouva")).toHaveLength(1);
  });

  test("an ask answered inside the wait is what an ask always was: no job, the answer in the turn", async () => {
    const d = await daemon({
      answer: (who, body) => {
        if (who.kind === "agent" && who.id === "nox") return { text: "Staging runs v1.9." };
        if (toolResults(body).length > 0) return { text: `Kata Nox: ${toolResults(body)[0]!.split("\n")[1]}` };
        return askNox({ task: "Which version runs on staging?" });
      },
    });
    say(d.gateway, "staging versi berapa?", "m1");
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("Kata Nox:")), 4_000, "the answer");
    expect(replies(d.gateway)).toEqual(["Kata Nox: Staging runs v1.9."]);
    expect(d.jobs.list({})).toEqual([]);
  });
});

describe("the brief an ask was given (0.8.7)", () => {
  test("is kept with its job, whole, and read back through `work`; the asked agent is told to say where it went past it", async () => {
    const noxFinishes = gate();
    const brief = "Audit the staging firewall rules.\nOnly read; change nothing.\nReport each open port.";
    let noxWasAsked = "";
    const d = await daemon({
      waitMs: 60_000,
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") {
          noxWasAsked = textOf(body.messages.find((message) => message.role === "user")?.content);
          await noxFinishes.opened;
          return { text: "Audit done." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Nox is on it." };
        if (asked.includes("[System event")) return { text: "Done." };
        return askNox({ task: brief, background: true });
      },
    });
    say(d.gateway, "audit firewall staging", "m1");
    await eventually(() => noxWasAsked !== "", 4_000, "nox asked");
    expect(noxWasAsked).toContain(brief);
    expect(noxWasAsked).toContain(ASKED_TO_SAY);
    const [job] = d.jobs.backgroundTurns("nouva");
    const work = createWorkTool({ missions: { now: () => Date.now() } as never, jobs: d.jobs, approvals: {} as never });
    const shown = await work.execute({ action: "job", id: job!.id }, { agentId: "nouva" } as ToolContext);
    expect(shown.content).toContain(`Asked nox:\n${brief}`);
    expect((await work.execute({ action: "job", id: job!.id }, { agentId: "nox" } as ToolContext)).isError).toBe(true);
    noxFinishes.open();
    await eventually(() => replies(d.gateway).includes("Done."), 4_000, "the answer passed on");
  });
});

describe("how an ask in the background ends", () => {
  test("a failure wakes the asking agent saying so, and the daemon says it first", async () => {
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") {
          // Once the ask has moved — the asking turn has answered — the provider fails it.
          await eventually(() => replies(d.gateway).includes("Nox masih ngerjain."), 4_000, "the asking turn's reply");
          throw new Error("upstream unavailable");
        }
        if (!body.stream) return { text: "Nox masih ngerjain." };
        if (lastUser(body).includes("[System event")) return { text: "Nox gagal." };
        return askNox();
      },
    });
    say(d.gateway, "deploy", "m1");
    await eventually(() => replies(d.gateway).includes("Nox gagal."), 6_000, "the failure passed on");
    const [job] = d.jobs.list({ agentId: "nouva" });
    expect(job).toMatchObject({ kind: "ask", status: "failed", report: { agentId: "nox", status: "failed" } });
    expect(d.notices).toEqual([expect.stringMatching(new RegExp(`^⚠️ nox stopped before finishing ${job!.id}`))]);
    expect(lastUser(wakeOf(d)!.body)).toContain("nox stopped before it finished what you asked at");
    expect(lastUser(wakeOf(d)!.body)).toContain("nox did NOT finish.");
  });

  test("`job_max_ms` stops it like any job, counted from when it was asked — and the asking agent is told it ran out of time", async () => {
    const d = await daemon({
      configure: (config) => void (config.security.jobMaxMs = WAIT_MS * 3),
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") return await never();
        if (!body.stream) return { text: "Nox masih jalan." };
        if (lastUser(body).includes("[System event")) return { text: "Nox kehabisan waktu." };
        return askNox();
      },
    });
    say(d.gateway, "deploy", "m1");
    await eventually(() => replies(d.gateway).includes("Nox kehabisan waktu."), 6_000, "the stop passed on");
    const [job] = d.jobs.list({ agentId: "nouva" });
    expect(job).toMatchObject({ kind: "ask", status: "killed" });
    expect(job!.endedAt! - job!.startedAt).toBeLessThan(WAIT_MS * 3 + 1_500);
    expect(d.notices).toEqual([`⏱️ nox's work in the background on ${job!.id} was stopped after 900ms, this install's limit for a background job (\`[security] job_max_ms\`). It had not finished.`]);
    expect(lastUser(wakeOf(d)!.body)).toContain("nox was stopped by the daemon after 900ms, this install's limit for a background job (`[security] job_max_ms`), before it finished what you asked at");
  });

  test("/stop in the chat stops it, and says so; `nouride jobs kill` stops one too, and the asking agent hears it was stopped", async () => {
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "agent") {
          if (who.id === "nox" || who.id === "nera") return await never();
          if (!body.stream) return { text: "Lagi dikerjain." };
          const asked = lastUser(body);
          if (asked.includes("[System event")) return { text: asked.includes("nera was stopped before it finished") ? "Nera dihentikan." : "?" };
          return asked.includes("nera") ? { toolCalls: [{ id: "a2", name: "ask_agent", args: { agent: "nera", task: "Rotate the staging logs.", background: true } }] } : askNox({ background: true });
        }
        return { text: "?" };
      },
    });

    // `nouride jobs kill <id>`, as the control route does it.
    say(d.gateway, "minta nera rotate logs", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1 && replies(d.gateway).includes("Lagi dikerjain."), 4_000, "nera at work");
    const [nera] = d.jobs.backgroundTurns("nouva");
    expect(d.jobs.getSnapshot(nera!.id)?.processAlive).toBe(true);
    expect(d.jobs.kill(nera!.id, "cli")).toBe(true);
    await eventually(() => replies(d.gateway).includes("Nera dihentikan."), 4_000, "the stop passed on");
    expect(d.jobs.get(nera!.id)?.status).toBe("killed");

    // `/stop` in the chat: the turn, and what the agent has working in the background for it.
    say(d.gateway, "deploy", "m2");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1, 4_000, "nox at work");
    const [nox] = d.jobs.backgroundTurns("nouva");
    say(d.gateway, "/stop", "m3");
    await eventually(() => replies(d.gateway).some((text) => text.includes("Stopped what nox was doing in the background for me too.")), 4_000, "the stop");
    await eventually(() => d.jobs.get(nox!.id)?.status === "killed", 4_000, "nox stopped");
  });

  test("a restart closes it as interrupted, and wakes the asking agent with what it had done and how to ask again", async () => {
    const first = await daemon({
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") {
          if (toolResults(body).length === 0) return { toolCalls: [{ id: "x1", name: "probe", args: { what: "staging" } }] };
          return await never();
        }
        if (!body.stream) return { text: "Nox lagi jalan." };
        return askNox();
      },
    });
    say(first.gateway, "deploy", "m1");
    await eventually(() => first.jobs.backgroundTurns("nouva").length === 1 && first.ran.length === 1, 4_000, "nox in the background");
    const [job] = first.jobs.backgroundTurns("nouva");

    // The daemon goes: the store closes and stops what runs in it, and writes nothing.
    await first.jobs.killAll();
    expect(first.jobs.get(job!.id)?.status).toBe("running");

    const next = await daemon({
      after: first.bench,
      answer: async (_who, body) => ({ text: lastUser(body).includes("was interrupted by a restart") ? "Nox keputus restart; mau gw tanya lagi?" : "?" }),
    });
    const orphaned = next.jobs.interruptOrphaned();
    reportInterruptedJobs({ jobs: next.jobs, orphanedJobs: orphaned, pipeline: next.bench.pipeline });

    await eventually(() => replies(next.gateway).includes("Nox keputus restart; mau gw tanya lagi?"), 4_000, "the asking agent woken");
    const wake = lastUser(wakeOf(next)!.body);
    expect(wake).toContain("@nouva");
    expect(wake).toContain("nox was interrupted by a restart before it finished what you asked at");
    expect(wake).toContain("Its log, to where it stopped:");
    // A step it took while it was still waited on: its job's log begins with those.
    expect(wake).toContain('→ probe {"what":"staging"}');
    expect(wake).toContain("ask nox again with `ask_agent`");
    expect(next.jobs.get(job!.id)?.status).toBe("interrupted");
    expect(next.notices).toEqual([`⚠️ nox's work in the background on ${job!.id} was interrupted by a restart and is not resumed.`]);
  });
});

describe("the one limit", () => {
  test("counts asks with helpers: `background: true` over it is refused naming it, and an ask that runs long stays in the foreground, saying why", async () => {
    const neraFinishes = gate();
    let turn = 0;
    const d = await daemon({
      packs: { nouva: `${PACK}\n[delegate]\nmax_background = 1\n` },
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") return await never();
        if (who.kind === "agent" && who.id === "nera") {
          await neraFinishes.opened;
          return { text: "Logs rotated." };
        }
        if (who.kind === "helper") return { text: "?" };
        if (!body.stream) return { text: "ok" };
        if (conversationOf(body.messages).at(-1)?.role === "tool") return { text: `seen: ${toolResults(body).at(-1)}` };
        turn += 1;
        if (turn === 1) return askNox({ background: true });
        if (turn === 2) return { toolCalls: [{ id: "a2", name: "ask_agent", args: { agent: "nera", task: "Rotate the staging logs.", background: true } }] };
        if (turn === 3) return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [{ goal: "Check the docs links", context: "The docs are in /srv/docs.", deliverable: "Broken links." }], background: true } }] };
        return { toolCalls: [{ id: "a3", name: "ask_agent", args: { agent: "nera", task: "Rotate the staging logs." } }] };
      },
    });

    say(d.gateway, "deploy", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1, 4_000, "the first ask in the background");
    const [nox] = d.jobs.backgroundTurns("nouva");

    // `background: true` with no room: refused, naming the limit and what holds it — and nothing ran.
    say(d.gateway, "rotate logs", "m2");
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("seen: Not started")), 4_000, "the refusal");
    expect(replies(d.gateway).at(-1)).toStartWith(
      `seen: Not started: you already have 1 job working in the background (helpers and asks), the most this agent may have (\`[delegate] max_background = 1\`): ${nox!.id} "ask nox: Deploy v2 to staging, then check it answers on /health. The person wants it out before the demo." (`,
    );
    expect(replies(d.gateway).at(-1)).toContain("leave `background` off to wait for nera's answer.");
    expect(d.asked.some((request) => request.who.kind === "agent" && request.who.id === "nera")).toBe(false);

    // A helper is held to the same one.
    say(d.gateway, "cek link docs", "m3");
    await eventually(() => replies(d.gateway).some((text) => text.includes("the most this agent may have (`[delegate] max_background = 1`)") && text.includes("Check the docs links")), 4_000, "the helper refused");
    expect(d.jobs.backgroundTurns("nouva").map((job) => job.id)).toEqual([nox!.id]);

    // An ask that outlasts its wait with no room stays in the foreground to the end — and the answer says why it took so long.
    say(d.gateway, "rotate logs, wait for it", "m4");
    await eventually(() => d.asked.some((request) => request.who.kind === "agent" && request.who.id === "nera"), 4_000, "nera asked");
    // A fixed sleep, and it has to be: nera must still be at work when the ask's wait runs out, and the move it then
    // tries — and is refused — leaves nothing to wait for. Its answer below says it stayed.
    await sleep(WAIT_MS * 2);
    expect(d.jobs.backgroundTurns("nouva").map((job) => job.id)).toEqual([nox!.id]);
    neraFinishes.open();
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("seen: [nera · success]")), 4_000, "the answer, waited for");
    expect(replies(d.gateway).at(-1)).toContain("Logs rotated.");
    expect(replies(d.gateway).at(-1)).toContain(
      "(This took longer than 300ms and stayed in the foreground: you already have 1 job working in the background (helpers and asks), the most this agent may have (`[delegate] max_background = 1`).)",
    );
  });
});

describe("no ping-pong", () => {
  test("a helper's ask waits for its answer however long it takes: it moves nothing behind itself", async () => {
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          if (toolResults(body).length === 0) return { toolCalls: [{ id: "h1", name: "ask_agent", args: { agent: "nox", task: "Which version runs on staging?" } }] };
          return { text: `Nox says: ${toolResults(body)[0]!.split("\n")[1]}` };
        }
        if (who.kind === "agent" && who.id === "nox") {
          // A fixed sleep, pacing the fake: well past the wait an ask gives, which a helper's ask must sit through.
          await sleep(WAIT_MS * 3);
          return { text: "Staging runs v1.9." };
        }
        if (!body.stream) return { text: "Helper lagi jalan." };
        if (lastUser(body).includes("[System event")) return { text: `Laporan: ${/Nox says: [^\n]+/.exec(lastUser(body))?.[0] ?? "?"}` };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [{ goal: "Find the staging version", context: "Nox runs staging.", deliverable: "The version." }], background: true } }] };
      },
    });
    say(d.gateway, "cek versi staging", "m1");
    await eventually(() => replies(d.gateway).includes("Laporan: Nox says: Staging runs v1.9."), 6_000, "the helper's report");
    // One job: the helper's. Its ask never became one.
    expect(d.jobs.list({}).map((job) => job.kind)).toEqual(["helper"]);
    const helper = d.asked.find((request) => request.who.kind === "helper")!;
    expect(offered(helper.body, "ask_agent")).toEqual(["agent", "task", "tier"]);
    // And the asking agent's own turn was offered the parameter.
    expect(offered(nouvas(d)[0]!.body, "ask_agent")).toEqual(["agent", "task", "tier", "background"]);
  });

  test("a scheduled turn's ask waits too: nobody to stay free for, and no chat an answer could wake", async () => {
    const d = await daemon({ answer: async () => ({ text: "done" }) });
    const job = { id: "job_report", name: "report", agentId: "nouva", session: "isolated", trigger: { kind: "every", everyMs: 60_000 }, payload: { kind: "agentTurn", message: "check" }, target: { gatewayId: "telegram:main", chatId: "chat-1" }, delivery: { mode: "none" }, enabled: true };
    await d.bench.pipeline.cronExecutors().runTurn({ job: job as never, session: { gatewayId: "telegram:main", chatId: "cron:job_report" }, message: "check", signal: new AbortController().signal });
    expect(offered(nouvas(d)[0]!.body, "ask_agent")).toEqual(["agent", "task", "tier"]);
  });

  test("the asked agent's tools are told who asked it — `exec` keeps its commands in the foreground by it (0.8.8)", async () => {
    // A job an asked agent starts reports to the agent that asked (`job-wakes.ts` `reportsTo`); on 0.8.7 its commands went
    // to the background on their own, and its "I'll follow up" reached nobody.
    const d = await daemon({
      answer: (who, body) => {
        if (!body.stream) return { text: "ok" };
        const results = toolResults(body);
        if (who.kind === "agent" && who.id === "nox") return results.length === 0 ? { toolCalls: [{ id: "p1", name: "probe", args: { what: "staging" } }] } : { text: "Staging answers." };
        if (results.length === 0 && lastUser(body).startsWith("deploy")) return { toolCalls: [{ id: "p0", name: "probe", args: { what: "own" } }] };
        if (results.length === 1 && lastUser(body).startsWith("deploy")) return askNox();
        return { text: "Done." };
      },
    });
    say(d.gateway, "deploy", "m1");
    await eventually(() => d.ran.length === 2, 4_000, "both probes");
    expect(d.ran).toEqual(["own", "staging"]);
    expect(d.askers).toEqual([undefined, "nouva"]);
  });

  test("an asked agent that starts a job is wrapped up told its end goes to the agent that asked — no follow-up promised (0.8.8)", async () => {
    const d = await daemon({
      answer: (who, body) => {
        if (who.kind === "agent" && who.id === "nox") return body.stream ? { toolCalls: [{ id: "p1", name: "probe", args: { what: "bg" } }] } : { text: "Started the scan as job_bg; nouva gets its result." };
        if (!body.stream) return { text: "ok" };
        return toolResults(body).length === 0 ? askNox() : { text: "Done." };
      },
    });
    say(d.gateway, "deploy", "m1");
    await eventually(() => d.asked.some((request) => request.who.kind === "agent" && request.who.id === "nox" && !request.body.stream), 4_000, "nox's wrap-up");
    const wrapUp = d.asked.find((request) => request.who.kind === "agent" && request.who.id === "nox" && !request.body.stream)!;
    expect(JSON.stringify(wrapUp.body.messages)).toContain("not to you, and you are not woken when it finishes");
    expect(JSON.stringify(wrapUp.body.messages)).not.toContain("you will follow up with the result");
  });

  test("the asked agent, working in the background, has no `ask_agent` at all", async () => {
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") return await never();
        if (!body.stream) return { text: "ok" };
        return askNox({ background: true });
      },
    });
    say(d.gateway, "deploy", "m1");
    await eventually(() => d.asked.some((request) => request.who.kind === "agent" && request.who.id === "nox"), 4_000, "nox at work");
    const nox = d.asked.find((request) => request.who.kind === "agent" && request.who.id === "nox")!;
    expect(nox.body.tools?.map((tool) => tool.function.name)).not.toContain("ask_agent");
  });
});

describe("an approval the asked agent needs after the asking turn ended", () => {
  test("is asked in the chat, in its name, saying whose work it is — and once answered the work goes on and the answer comes back", async () => {
    const asks: ApprovalAsk[] = [];
    const answer = gate();
    const recording: ApprovalGate = {
      available: true,
      canAsk: () => true,
      pending: (): ApprovalRequest[] => [],
      expireAll: () => 0,
      request: async (ask): Promise<ApprovalOutcome> => {
        asks.push(ask);
        await answer.opened;
        return { status: "approved", by: "user-1", decision: "allow-once" };
      },
    };
    const d = await daemon({
      approvals: recording,
      packs: { nox: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["probe"]\napproval_required = ["probe"]\n\n[agent]\napprovals = "careful"\n' },
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") {
          if (toolResults(body).length === 0) {
            // Only once the asking turn is over.
            await eventually(() => replies(d.gateway).includes("Nox lagi kerja."), 4_000, "the asking turn's reply");
            return { toolCalls: [{ id: "x1", name: "probe", args: { what: "the staging database" } }] };
          }
          return { text: "Migrated the staging database." };
        }
        if (!body.stream) return { text: "Nox lagi kerja." };
        if (lastUser(body).includes("[System event")) return { text: "Migrasi beres." };
        return askNox({ task: "Migrate the staging database." });
      },
    });

    say(d.gateway, "migrate db staging", "m1");
    await eventually(() => asks.length === 1, 4_000, "the approval asked");
    const [job] = d.jobs.backgroundTurns("nouva");
    expect(replies(d.gateway)).toEqual(["Nox lagi kerja."]);
    expect(asks[0]).toMatchObject({ agentId: "nox", gatewayId: "telegram:main", chatId: "chat-1", tool: "probe", senderId: "user-1" });
    expect(asks[0]!.reason).toStartWith(`nox, working in the background on what nouva asked (${job!.id}: "Migrate the staging database."), wants to run this: `);
    expect(d.ran).toEqual([]);

    answer.open();
    await eventually(() => replies(d.gateway).includes("Migrasi beres."), 4_000, "the answer passed on");
    expect(d.ran).toEqual(["the staging database"]);
    expect(d.jobs.get(job!.id)?.status).toBe("succeeded");
  });
});

describe("in a room", () => {
  test("the answer wakes the asking agent in the room it was asked from — once the turn it is in there has ended", async () => {
    const noxFinishes = gate();
    const storyFinishes = gate();
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "agent" && who.id === "nox") {
          await noxFinishes.opened;
          return { text: "Deployed v2." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Nox lagi deploy." };
        if (asked.includes("[System event")) return { text: "Deploy beres." };
        if (asked.includes("cerita")) {
          await storyFinishes.opened;
          return { text: "Dahulu kala..." };
        }
        return askNox({ background: true });
      },
    });
    const room = { chatId: "group-1", chatType: "group" as const };

    say(d.gateway, "nouva: deploy v2 ke staging", "m1", room);
    await eventually(() => replies(d.gateway).includes("Nox lagi deploy."), 4_000, "the asking turn's reply");
    expect(d.gateway.sent.find((message) => message.text === "Nox lagi deploy.")?.chatId).toBe("group-1");

    // The asking agent is at work in the room when the answer comes: the wake-up waits for that turn.
    say(d.gateway, "nouva: ceritain sesuatu", "m2", room);
    await eventually(() => nouvas(d).some((request) => lastUser(request.body).includes("cerita")), 4_000, "the story under way");
    noxFinishes.open();
    await eventually(() => d.jobs.list({}).every((job) => job.status === "succeeded"), 4_000, "nox done");
    // A fixed sleep: what is shown is that the wake-up did *not* start while the story turn runs.
    await sleep(50);
    expect(wakeOf(d)).toBeUndefined();

    storyFinishes.open();
    await eventually(() => replies(d.gateway).includes("Deploy beres."), 4_000, "the answer passed on");
    expect(replies(d.gateway)).toEqual(["Nox lagi deploy.", "Dahulu kala...", "Deploy beres."]);
    expect(d.gateway.sent.find((message) => message.text === "Deploy beres.")?.chatId).toBe("group-1");
  });
});

describe("once in the background", () => {
  test("the asking turn's stop no longer reaches it — its job's does; before it moved, the asking turn's stop did", async () => {
    const d = await daemon({ answer: async (who) => (who.kind === "agent" && who.id === "nox" ? await never() : { text: "?" }) });
    const asking = (signal: AbortSignal): ToolContext =>
      ({ agentId: "nouva", sessionId: "ses_nouva", turnId: "turn_1", chatId: "chat-1", chatType: "dm", gateway: "telegram", gatewayId: "telegram:main", senderId: "user-1", workspaceDir: d.bench.dataDir, agentDir: d.bench.dataDir, workspaceRoots: [d.bench.dataDir], signal }) as ToolContext;
    const noxCalls = () => d.asked.filter((request) => request.who.kind === "agent" && request.who.id === "nox").length;

    // Waited on: the asking turn's stop stops it.
    const before = new AbortController();
    const waited = d.bench.pipeline.askRunner()({ to: "nox", from: "nouva", task: "Check staging.", ctx: asking(before.signal) }, false);
    if (!("run" in waited)) throw new Error("refused");
    await eventually(() => noxCalls() === 1, 4_000, "nox asked");
    before.abort("stopped-by-person");
    expect((await waited.run.answer).status).not.toBe("success");

    // Behind the asking turn: the asking turn's abort is nothing to it; its job's stop is.
    const after = new AbortController();
    const moved = d.bench.pipeline.askRunner()({ to: "nox", from: "nouva", task: "Check staging again.", ctx: asking(after.signal) }, false);
    if (!("run" in moved)) throw new Error("refused");
    await eventually(() => noxCalls() === 2, 4_000, "nox asked again");
    const detached = moved.run.detach();
    if (!("job" in detached)) throw new Error(`not moved: ${JSON.stringify(detached)}`);
    after.abort("stopped-by-person");
    // A fixed sleep: what is shown is that the asking turn's abort did *not* end it.
    await sleep(50);
    expect(d.jobs.get(detached.job)?.status).toBe("running");
    expect(d.jobs.kill(detached.job, "cli")).toBe(true);
    await eventually(() => d.jobs.get(detached.job)?.status === "killed", 4_000, "stopped by its job");
  });
});
