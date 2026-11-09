/**
 * A helper in the foreground that runs long, through the real pipeline: `delegate` without `background` waits for its
 * helpers up to a minute — a test's wait is shorter — and a helper still working then carries on in the background as a
 * job of the agent's, as if `background: true` had started it at that moment. The turn ends, so the person can talk to
 * the agent meanwhile, and the helper's result wakes the agent when it comes.
 *
 * Found live: an agent sent three tasks it said would take five to ten minutes to helpers in the foreground, and the
 * person's chat with it was held for eight minutes.
 *
 * What each test holds: a quick helper is answered in the turn as before; a slow one moves after the wait, is told so,
 * gets a background helper's clock and command limit, and its result wakes the agent; one call can do both; with no
 * room under the limit one stays and is waited for, saying why; the one limit counts a helper that moved; `/stop` stops
 * one; and where a turn may hold nothing in the background — a scheduled one — nothing moves.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readTextFileIfExists } from "@nouride/runtime";
import type { Tool } from "@nouride/shared";
import { AuditLog } from "@/commons/audit.store.ts";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { MOVED_NOTE } from "@/modules/tools/builtins/delegate.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { conversationOf, envelope, FakeGateway } from "../helpers.ts";
import { eventually, sleep } from "../wait.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

// ── a model that answers by who is asking ─────────────────────────────────────────────────────────────────────────

interface Said {
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}

/** The parent, or a helper — by its goal, read from the brief that is its first message. */
type Who = { kind: "parent" } | { kind: "helper"; goal: string };

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
  if (!system.includes("You are a helper doing one piece of work")) return { kind: "parent" };
  const brief = textOf(body.messages.find((message) => message.role === "user")?.content);
  return { kind: "helper", goal: /GOAL\n([^\n]+)/.exec(brief)?.[1] ?? "" };
}

const lastUser = (body: Body): string => textOf(conversationOf(body.messages).filter((message) => message.role === "user").at(-1)?.content);
const toolResults = (body: Body): string[] => body.messages.filter((message) => message.role === "tool").map((message) => textOf(message.content));

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

/** A gate a test opens: a helper's model call waits on it, so the test decides when that helper finishes. */
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

/** What reached `exec`: what it was asked, the longest a command could wait, and when the turn must be done by. */
interface ExecSeen {
  command: string;
  commandMaxMs: number | undefined;
  deadlineAt: number | undefined;
}

/** A stand-in for `exec` that notes what each call was allowed. */
function exec(seen: ExecSeen[]): Tool {
  return {
    requiresApproval: false,
    definition: { name: "exec", description: "Run a shell command.", parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer" } } } },
    async execute(args, ctx) {
      seen.push({ command: String(args.command ?? ""), commandMaxMs: ctx.commandMaxMs, deadlineAt: ctx.deadlineAt });
      return { content: `ran ${String(args.command ?? "")}`, isError: false };
    },
  };
}

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "exec"]\napproval_required = []\n';

/** How long `delegate` waits here before its helpers still working move: long enough for a step, short for a test. */
const WAIT_MS = 300;
/** `[security] job_max_ms` here: far shorter than a turn's hour, so the clock a helper has once it moved is told apart. */
const JOB_MAX_MS = 10 * 60_000;

async function daemon(options: { answer: (who: Who, body: Body) => Said | Promise<Said>; agentToml?: string }) {
  const { fetchImpl, asked } = provider(options.answer);
  const gateway = new FakeGateway();
  let jobs!: JobStore;
  const notices: string[] = [];
  const notifier = { toChat: async (_target: unknown, text: string) => (notices.push(text), true), alert: async () => true };
  const bench = await pipelineBench({
    fetch: () => fetchImpl,
    gateway,
    agentToml: options.agentToml ?? PACK,
    // A steering reply is its own model call, and the script here answers by who asks, not by turn.
    configure: (config) => {
      config.queue.steerReply = false;
      config.security.jobMaxMs = JOB_MAX_MS;
    },
    deps: ({ db, dataDir }) => {
      jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4, maxMs: () => JOB_MAX_MS });
      return { jobs, notifier: notifier as never };
    },
  });
  benches.push(bench);
  stores.push(jobs);
  const execs: ExecSeen[] = [];
  // As `boot/tools.ts` wires it — audited — with a wait a test can sit through.
  const tools = createBuiltinTools({
    security: bench.config.security,
    runSubagent: bench.pipeline.subagentRunner(),
    startHelper: bench.pipeline.backgroundHelpers(),
    waitedHelper: { start: bench.pipeline.waitedHelpers(), waitMs: WAIT_MS },
    audit: new AuditLog(bench.db),
  });
  tools.set("exec", exec(execs));
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  // As boot joins them (`boot/jobs.ts`): a job's end wakes the pipeline.
  jobs.setOnComplete((completion) => bench.pipeline.wakeForJob(completion));
  return { bench, gateway, asked, jobs, execs, notices };
}

type Daemon = Awaited<ReturnType<typeof daemon>>;

const say = (gateway: FakeGateway, text: string, id: string) => gateway.receive(envelope({ id, text, timestamp: Date.now() }));
const replies = (gateway: FakeGateway) => gateway.sent.map((message) => message.text);

/** A brief, as the parent's model writes one. */
const brief = (goal: string) => ({ goal, context: "The docs site is in /srv/docs, built with `bun run build`.", deliverable: "A list of broken links, each with the page it is on." });
const delegate = (goals: string[], extra: Record<string, unknown> = {}): Said => ({ toolCalls: [{ id: "d1", name: "delegate", args: { tasks: goals.map(brief), ...extra } }] });

/** The parent's requests: its turns, the wrap-ups and the wake-ups among them. */
const parents = (d: Daemon) => d.asked.filter((request) => request.who.kind === "parent");
const helperRequests = (d: Daemon, goal: string) => d.asked.filter((request) => request.who.kind === "helper" && request.who.goal === goal);
const wakeOf = (d: Daemon) => parents(d).find((request) => lastUser(request.body).includes("[System event"));
/** The tool result the parent's wrap-up was asked on — what `delegate` told it. */
const toldAtWrapUp = (d: Daemon) => toolResults(parents(d).find((request) => !request.body.stream)!.body).at(-1) ?? "";

// ── the tests ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("a helper in the foreground", () => {
  test("that answers inside the wait is answered in the turn, as before: no job", async () => {
    const d = await daemon({
      answer: (who, body) => {
        if (who.kind === "helper") return { text: "No broken links." };
        if (toolResults(body).length > 0) return { text: toolResults(body)[0]!.includes("No broken links.") ? "Hasilnya: aman." : "?" };
        return delegate(["Find every broken link on the docs site"]);
      },
    });
    say(d.gateway, "cek link docs", "m1");
    await eventually(() => replies(d.gateway).includes("Hasilnya: aman."), 4_000, "the answer");
    expect(replies(d.gateway)).toEqual(["Hasilnya: aman."]);
    expect(d.jobs.list({})).toEqual([]);
  });

  test("still working after the wait moves to the background: the turn ends, the person is answered meanwhile, and its result wakes the agent", async () => {
    const helperFinishes = gate();
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          const done = toolResults(body).length;
          // One step while it is waited on, one once the turn that waited has answered — then held until the test lets it finish.
          if (done === 0) return { toolCalls: [{ id: "h1", name: "exec", args: { command: "check before" } }] };
          if (done === 1) {
            await eventually(() => replies(d.gateway).includes("Helper masih ngecek link di background — nanti gw kabarin."), 4_000, "the parent's reply");
            return { toolCalls: [{ id: "h2", name: "exec", args: { command: "check after" } }] };
          }
          await helperFinishes.opened;
          return { text: "Found 3 broken links: /guide/a, /api/b, /blog/c." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Helper masih ngecek link di background — nanti gw kabarin." };
        if (asked.includes("[System event")) return { text: `Beres: ${/Found [^\n]+/.exec(asked)?.[0] ?? "(no handoff)"}` };
        if (asked.includes("jam berapa")) return { text: "Jam 12 siang." };
        return delegate(["Find every broken link on the docs site"]);
      },
    });

    say(d.gateway, "cek semua link di docs", "m1");
    // The turn ends with what is happening — the helper is still at work.
    await eventually(() => replies(d.gateway).includes("Helper masih ngecek link di background — nanti gw kabarin."), 4_000, "the parent's reply");
    const [job] = d.jobs.backgroundTurns("nouva");
    expect(job).toMatchObject({ kind: "helper", agentId: "nouva", status: "running", chatId: "chat-1", gatewayId: "telegram:main", brief: { goal: "Find every broken link on the docs site" } });
    const session = d.bench.sessions.load({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" }).id;
    const [asking] = d.bench.turns.forSession(session);
    expect(asking).toMatchObject({ status: "done", id: job!.turnId });

    // What the agent was told — the words that keep it from reporting a result it has not seen — and the turn it ended on.
    const told = toldAtWrapUp(d);
    expect(told).toContain(`── task 1: Find every broken link on the docs site\nStill working after 300ms, now in the background as ${job!.id}.`);
    expect(told).toContain(`Still working, now in the background: ${job!.id} "Find every broken link on the docs site".`);
    expect(told).toContain(
      "Your turn ends now, so the person can talk to you meanwhile. Each result comes to you as a message of its own when that helper finishes: you have not seen it, so do not say what it will find. Tell the person it is still being worked on, and that you will report each result when it comes.",
    );
    expect(told).toContain("Stop one with `nouride jobs kill <id>` if the person asks.");
    expect(lastUser(parents(d).find((request) => !request.body.stream)!.body)).toContain("A helper you were waiting on is still working, now in the background");

    // The helper is told it moved, before its next step, and from then has what a helper started there has: its own
    // clock — `job_max_ms` from when it began, not the parent's hour — and commands of up to thirty minutes.
    await eventually(() => d.execs.length === 2, 4_000, "the helper's step after the move");
    const [before, after] = d.execs;
    expect(before).toMatchObject({ command: "check before", commandMaxMs: undefined });
    expect(after).toMatchObject({ command: "check after", commandMaxMs: 1_800_000 });
    expect(after!.deadlineAt! - job!.startedAt).toBe(JOB_MAX_MS);
    expect(before!.deadlineAt! - job!.startedAt).toBeGreaterThan(50 * 60_000);
    await eventually(() => helperRequests(d, "Find every broken link on the docs site").length === 3, 4_000, "the helper's third request");
    const third = helperRequests(d, "Find every broken link on the docs site")[2]!;
    expect(toolResults(third.body).join("\n")).toContain(MOVED_NOTE);
    expect(MOVED_NOTE).toContain("you now work in the background");
    expect(MOVED_NOTE).toContain("may run up to thirty minutes: give it `timeout_ms`.");
    expect(toolResults(helperRequests(d, "Find every broken link on the docs site")[1]!.body).join("\n")).not.toContain(MOVED_NOTE);

    // Talked to meanwhile — and told what is still at work for it.
    say(d.gateway, "jam berapa sekarang?", "m2");
    await eventually(() => replies(d.gateway).includes("Jam 12 siang."), 4_000, "the answer meanwhile");
    const meanwhile = parents(d).find((request) => lastUser(request.body).includes("jam berapa"))!;
    expect(lastUser(meanwhile.body)).toContain(`(Still working in the background for you: ${job!.id} "Find every broken link on the docs site"`);
    expect(d.jobs.get(job!.id)?.status).toBe("running");

    // Its result arrives by itself, and wakes the agent as a background helper's does.
    helperFinishes.open();
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("Beres:")), 4_000, "the report");
    expect(replies(d.gateway).at(-1)).toBe("Beres: Found 3 broken links: /guide/a, /api/b, /blog/c.");
    const wake = lastUser(wakeOf(d)!.body);
    expect(wake).toContain(`Background helper ${job!.id} ("Find every broken link on the docs site") finished`);
    expect(wake).toContain("Its handoff:\n[nouva · success]\nFound 3 broken links: /guide/a, /api/b, /blog/c.");
    expect(d.jobs.get(job!.id)).toMatchObject({ status: "succeeded", report: { status: "success" } });

    // Its steps: before the move, rows of the turn that waited and the first lines of its job's log; after it, the log.
    const log = (await readTextFileIfExists(job!.logPath)) ?? "";
    expect(log).toContain("started: Find every broken link on the docs site");
    expect(log).toContain("→ exec check before");
    expect(log).toContain("→ exec check after");
    const steps = d.bench.turns.stepsSince(asking!.id).map((step) => step.text);
    expect(steps.some((text) => text.includes("check before"))).toBe(true);
    expect(steps.some((text) => text.includes("check after"))).toBe(false);
    // From the move on, a turn record of its own, named in the log.
    const [handed] = new TurnInspector(d.bench.db).inspect(asking!.id)!.delegated ?? [];
    expect(handed).toMatchObject({ agentId: "nouva", status: "done", cause: { via: "delegate", job: job!.id, parent: asking!.id } });
    expect(log).toContain(`its turn is ${handed!.id}`);
    const own = new TurnInspector(d.bench.db).inspect(handed!.id)!;
    expect(own.steps[0]?.text).toBe(`moved to the background as ${job!.id} (its steps before this are turn ${asking!.id}'s)`);
    expect(own.turn.reply).toBe("Found 3 broken links: /guide/a, /api/b, /blog/c.");
  });

  test("one call can do both: a helper that answered is reported in the turn, one still working moves", async () => {
    const longFinishes = gate();
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          if (who.goal === "Check the blog pages") return { text: "The blog has no broken links." };
          await longFinishes.opened;
          return { text: "The API reference has 2 broken links." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Blog aman; API masih dicek." };
        if (asked.includes("[System event")) return { text: "API: 2 link rusak." };
        return delegate(["Check the blog pages", "Check the API reference pages"]);
      },
    });

    say(d.gateway, "cek blog sama API docs", "m1");
    await eventually(() => replies(d.gateway).includes("Blog aman; API masih dicek."), 4_000, "the parent's reply");
    const [job] = d.jobs.backgroundTurns("nouva");
    expect(d.jobs.list({ agentId: "nouva" })).toHaveLength(1);
    expect(job!.brief?.goal).toBe("Check the API reference pages");
    const told = toldAtWrapUp(d);
    expect(told).toContain("── task 1: Check the blog pages\n[nouva · success]");
    expect(told).toContain("The blog has no broken links.");
    expect(told).toContain(`── task 2: Check the API reference pages\nStill working after 300ms, now in the background as ${job!.id}.`);
    expect(told).toContain("Tell the person what the helpers that answered found, and that the rest is still being worked on and you will report it when it comes.");

    longFinishes.open();
    await eventually(() => replies(d.gateway).includes("API: 2 link rusak."), 4_000, "the report");
    expect(lastUser(wakeOf(d)!.body)).toContain("The API reference has 2 broken links.");
  });

  test("/stop in the chat stops one that moved, and says so", async () => {
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") return await never();
        if (!body.stream) return { text: "masih jalan" };
        return delegate(["A very long check"]);
      },
    });
    say(d.gateway, "check everything", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1 && replies(d.gateway).includes("masih jalan"), 4_000, "a helper moved");
    const [job] = d.jobs.backgroundTurns("nouva");

    say(d.gateway, "/stop", "m2");
    await eventually(() => replies(d.gateway).some((text) => text?.includes("Stopped the helper working in the background too.")), 4_000, "the stop");
    await eventually(() => d.jobs.get(job!.id)?.status === "killed", 4_000, "the helper stopped");
  });
});

describe("the one limit", () => {
  test("counts a helper that moved; and with no room, one that runs long stays in the foreground to the end, saying why", async () => {
    const lingers = gate();
    let turn = 0;
    const d = await daemon({
      agentToml: `${PACK}\n[delegate]\nmax_background = 1\n`,
      answer: async (who, body) => {
        if (who.kind === "helper") {
          if (who.goal === "Check the archive pages") {
            // A fixed sleep, pacing the fake: past the wait, so the move is tried — and refused — before it answers.
            await sleep(WAIT_MS * 3);
            return { text: "The archive has 1 broken link." };
          }
          await lingers.opened;
          return { text: "done" };
        }
        if (!body.stream) return { text: "masih jalan" };
        if (conversationOf(body.messages).at(-1)?.role === "tool") return { text: `seen: ${toolResults(body).at(-1)}` };
        turn += 1;
        if (turn === 1) return delegate(["Check the API reference pages"]);
        if (turn === 2) return delegate(["Check the blog pages"], { background: true });
        return delegate(["Check the archive pages"]);
      },
    });

    // The first moves: there is room for one.
    say(d.gateway, "cek API docs", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1 && replies(d.gateway).includes("masih jalan"), 4_000, "the first moved");
    const [moved] = d.jobs.backgroundTurns("nouva");

    // A helper asked for in the background is refused: the one that moved holds the limit.
    say(d.gateway, "cek blog di background", "m2");
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("seen: Not started")), 4_000, "the refusal");
    expect(replies(d.gateway).at(-1)).toContain(
      `Not started: "Check the blog pages". You already have 1 job working in the background (helpers and asks), the most this agent may have (\`[delegate] max_background = 1\`): ${moved!.id} "Check the API reference pages"`,
    );

    // And one that runs long now has nowhere to go: it is waited for, and its answer says why it took so long.
    say(d.gateway, "cek archive", "m3");
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("seen: ── task 1: Check the archive pages")), 6_000, "the answer, waited for");
    expect(replies(d.gateway).at(-1)).toContain("The archive has 1 broken link.");
    expect(replies(d.gateway).at(-1)).toContain(
      "(This took longer than 300ms and stayed in the foreground: you already have 1 job working in the background (helpers and asks), the most this agent may have (`[delegate] max_background = 1`).)",
    );
    expect(d.jobs.list({ agentId: "nouva" }).map((job) => job.id)).toEqual([moved!.id]);
    lingers.open();
  });
});

describe("the same work already in the background", () => {
  test("does not keep one that runs long in the foreground: its work is under way, and it moves all the same", async () => {
    const hold = gate();
    let turn = 0;
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          await hold.opened;
          return { text: "done" };
        }
        if (!body.stream) return { text: "masih jalan" };
        turn += 1;
        return delegate(["Check the API reference pages"], turn === 1 ? { background: true } : {});
      },
    });
    say(d.gateway, "cek API docs di background", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1 && replies(d.gateway).length === 1, 4_000, "the first in the background");
    // Started again in the foreground — `background: true` would have been refused as a twin — and still at work after the wait.
    say(d.gateway, "cek lagi API docs", "m2");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 2, 4_000, "the second moved");
    expect(d.jobs.backgroundTurns("nouva").map((job) => job.brief?.goal)).toEqual(["Check the API reference pages", "Check the API reference pages"]);
    hold.open();
  });
});

describe("where nothing may move", () => {
  test("a scheduled turn's delegate waits for its helpers to the end: no `background`, and no job", async () => {
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          // A fixed sleep, pacing the fake: past the wait, which a scheduled turn's helper must sit through.
          await sleep(WAIT_MS * 3);
          return { text: "No broken links." };
        }
        if (toolResults(body).length > 0) return { text: "reported" };
        return delegate(["Find every broken link on the docs site"]);
      },
    });
    const job = { id: "job_report", name: "report", agentId: "nouva", session: "isolated", trigger: { kind: "every", everyMs: 60_000 }, payload: { kind: "agentTurn", message: "check" }, target: { gatewayId: "telegram:main", chatId: "chat-1" }, delivery: { mode: "none" }, enabled: true };
    await d.bench.pipeline.cronExecutors().runTurn({ job: job as never, session: { gatewayId: "telegram:main", chatId: "cron:job_report" }, message: "check", signal: new AbortController().signal });
    const first = parents(d)[0]!;
    expect(Object.keys((first.body.tools?.find((tool) => tool.function.name === "delegate")?.function.parameters as { properties: object }).properties)).toEqual(["tasks", "tier"]);
    expect(d.jobs.list({})).toEqual([]);
    const told = toolResults(parents(d).at(-1)!.body).at(-1)!;
    expect(told).toContain("No broken links.");
    expect(told).not.toContain("stayed in the foreground");
  });
});
