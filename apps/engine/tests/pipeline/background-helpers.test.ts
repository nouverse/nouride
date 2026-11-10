/**
 * Helpers that work in the background (0.7.15), through the real pipeline: a person's message, the agent's turn, the
 * job, the wake-up and the report — with a model that answers each request by who is asking.
 *
 * What was asked for, and what each test here holds (2026-10-18): the agent hands a long task to a helper and its
 * turn ends at once, so it can be talked to meanwhile; the helper's result arrives by itself; two helpers are reported
 * one by one, each as it finishes, with no barrier; the limit refuses the one over it; the dashboard's setting applies
 * to the next one; a helper writes no memory and starts no helper; an approval it needs asks in the parent's chat with
 * its name on it; `/stop` stops it; and a restart closes it as interrupted and wakes the parent with what it had done.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTextFileIfExists } from "@nouride/runtime";
import type { ApprovalRequest, Tool } from "@nouride/shared";
import type { BoxBusy } from "@/commons/box-load.ts";
import { helperDeadline } from "@/modules/pipeline/subagent.ts";
import { JobStore } from "@/modules/jobs/jobs.store.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import type { ApprovalAsk, ApprovalGate, ApprovalOutcome } from "@/modules/tools/approval.ts";
import { saveAgentMaxBackground } from "@/modules/config/settings/jobs.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";
import { reportInterruptedJobs } from "@/boot/jobs.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { conversationOf, envelope, FakeGateway } from "../helpers.ts";
import { eventually } from "../wait.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

// ── a model that answers by who is asking ─────────────────────────────────────────────────────────────────────────

interface Said {
  text?: string;
  toolCalls?: { id: string; name: string; args: unknown }[];
}

/** The parent, or a helper — by its goal, read from the brief that is its first message. */
type Who = { kind: "parent" } | { kind: "helper"; goal: string };

interface Asked {
  who: Who;
  body: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string; parameters: unknown } }[]; stream?: boolean };
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? "").join("") : "";

function whoAsks(body: Asked["body"]): Who {
  const system = textOf(body.messages[0]?.content);
  if (!system.includes("You are a helper doing one piece of work")) return { kind: "parent" };
  const brief = textOf(body.messages.find((message) => message.role === "user")?.content);
  return { kind: "helper", goal: /GOAL\n([^\n]+)/.exec(brief)?.[1] ?? "" };
}

/** The last thing a person — or the daemon — said to the model, in this request. */
const lastUser = (body: Asked["body"]): string => textOf(conversationOf(body.messages).filter((message) => message.role === "user").at(-1)?.content);

/** A provider answering each request through `answer`, as the OpenAI wire does: streamed, or whole for a wrap-up. */
function provider(answer: (who: Who, body: Asked["body"]) => Said | Promise<Said>) {
  const asked: Asked[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Asked["body"];
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
    if (!body.stream) {
      return Response.json({ model: "test-model", choices: [{ message: { content: said.text ?? "" }, finish_reason: "stop" }], usage });
    }
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

// ── the daemon, as boot wires it ──────────────────────────────────────────────────────────────────────────────────

const benches: Bench[] = [];
const stores: JobStore[] = [];
afterEach(async () => {
  // As a shutdown stops them (`boot/shutdown.ts`): the helpers first, then whatever turn is still in flight — before the
  // database they write to goes.
  for (const jobs of stores.splice(0)) await jobs.killAll();
  for (const bench of benches) await bench.pipeline.drain();
  for (const bench of benches.splice(0)) bench.dispose();
});

/** A tool that notes it ran — the parent's, which a helper inherits. */
function probe(ran: string[]): Tool {
  return {
    requiresApproval: false,
    definition: { name: "probe", description: "checks one thing", parameters: { type: "object", properties: { what: { type: "string" } } } },
    async execute(args) {
      ran.push(String(args.what ?? ""));
      return { content: `checked ${String(args.what ?? "")}`, isError: false };
    },
  };
}

/** What reached `exec`: its arguments, and the longest wait the context allowed. */
interface ExecSeen {
  args: Record<string, unknown>;
  commandMaxMs: number | undefined;
}

/** A stand-in for `exec` with its real options — the job-starting ones a helper is not given among them. */
function exec(seen: ExecSeen[]): Tool {
  const flag = { type: "boolean" };
  return {
    requiresApproval: false,
    definition: {
      name: "exec",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, timeout_ms: { type: "integer", description: "max 240000" }, background: flag, keep_working: flag, service: flag, on_complete: { type: "string" } },
      },
    },
    async execute(args, ctx) {
      seen.push({ args, commandMaxMs: ctx.commandMaxMs });
      return { content: "alpha-done", isError: false };
    },
  };
}

/** A tool that reads a person's notes, and with `change` writes them — what every later prompt reads. */
function notes(written: string[]): Tool {
  return {
    requiresApproval: false,
    keepsInPrompt: (args) => args.change !== undefined,
    definition: { name: "person_jot", description: "a person's notes", parameters: { type: "object", properties: { change: { type: "string" } } } },
    async execute(args) {
      if (args.change !== undefined) written.push(String(args.change));
      return { content: "notes", isError: false };
    },
  };
}

const PACK = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "probe", "person_jot", "memory_write", "read"]\napproval_required = []\n';

async function daemon(options: {
  answer: (who: Who, body: Asked["body"]) => Said | Promise<Said>;
  approvals?: ApprovalGate;
  agentToml?: string;
  /** A process over the same install, after a restart. */
  after?: Bench;
  /** Whether the box is busy — a helper in the background looks again every 5 ms while it is. */
  load?: BoxBusy;
  /** `[security] job_max_ms`, for the turn and the job's deadline alike. */
  jobMaxMs?: number;
}) {
  const { fetchImpl, asked } = provider(options.answer);
  const gateway = new FakeGateway();
  let jobs!: JobStore;
  // What the daemon says in its own voice — the line it posts before a wake-up's turn — recorded rather than sent.
  const notices: string[] = [];
  const notifier = { toChat: async (_target: unknown, text: string) => (notices.push(text), true), alert: async () => true };
  const deps = ({ db, dataDir }: { db: Bench["db"]; dataDir: string }) => {
    jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4, ...(options.jobMaxMs ? { maxMs: () => options.jobMaxMs! } : {}) });
    return {
      jobs,
      notifier: notifier as never,
      ...(options.approvals ? { approvals: options.approvals } : {}),
      ...(options.load ? { load: options.load, roomCheckMs: 5 } : {}),
    };
  };
  const bench = options.after
    ? await options.after.reboot({ fetch: () => fetchImpl, gateway, deps })
    : await pipelineBench({
        fetch: () => fetchImpl,
        gateway,
        agentToml: options.agentToml ?? PACK,
        // A steering reply is its own model call, and the script here answers by who asks, not by turn.
        configure: (config) => {
          config.queue.steerReply = false;
          if (options.jobMaxMs) config.security.jobMaxMs = options.jobMaxMs;
        },
        deps,
      });
  // A restarted one too, so it is drained: its `dispose` removes nothing — the first one owns the install.
  benches.push(bench);
  stores.push(jobs);
  const ran: string[] = [];
  const written: string[] = [];
  const execs: ExecSeen[] = [];
  const tools = createBuiltinTools({
    security: bench.config.security,
    runSubagent: bench.pipeline.subagentRunner(),
    startHelper: bench.pipeline.backgroundHelpers(),
  });
  tools.set("probe", probe(ran));
  tools.set("person_jot", notes(written));
  tools.set("exec", exec(execs));
  bench.pipeline.setTools(tools);
  bench.pipeline.attach();
  // As boot joins them (`boot/jobs.ts`): a job's end wakes the pipeline.
  jobs.setOnComplete((completion) => bench.pipeline.wakeForJob(completion));
  return { bench, gateway, asked, jobs, ran, written, notices, execs };
}

const say = (gateway: FakeGateway, text: string, id: string) => gateway.receive(envelope({ id, text, timestamp: Date.now() }));
const replies = (gateway: FakeGateway) => gateway.sent.map((message) => message.text);

/** A brief, as the parent's model writes one. */
const brief = (goal: string) => ({ goal, context: "The docs site is in /srv/docs, built with `bun run build`; the person wants it checked tonight.", deliverable: "A list of broken links, each with the page it is on." });

// ── the tests ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("a long task, handed to a helper in the background", () => {
  test("the turn ends before the helper does, the person is answered meanwhile, and the report arrives by itself", async () => {
    const helperFinishes = gate();
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          // One step of its own, then held until the test lets it finish.
          if (!body.messages.some((message) => message.role === "tool")) return { toolCalls: [{ id: "h1", name: "probe", args: { what: "/srv/docs" } }] };
          await helperFinishes.opened;
          return { text: "Found 3 broken links: /guide/a, /api/b, /blog/c." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Siap — helper lagi ngecek semua link di background. Nanti gw kabarin." };
        if (asked.includes("[System event")) return { text: `Beres: ${/Found [^\n]+/.exec(asked)?.[0] ?? "(no handoff)"}` };
        if (asked.includes("jam berapa")) return { text: "Jam 12 siang." };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Find every broken link on the docs site")], background: true } }] };
      },
    });

    say(d.gateway, "cek semua link di docs dong, lama sih", "m1");
    // The turn ends with what it started — the helper is still working.
    await eventually(() => replies(d.gateway).includes("Siap — helper lagi ngecek semua link di background. Nanti gw kabarin."), 4_000, "the parent's reply");
    const [job] = d.jobs.backgroundTurns("nouva");
    expect(job).toMatchObject({ kind: "helper", status: "running", chatId: "chat-1", gatewayId: "telegram:main" });
    expect(d.bench.turns.forSession(d.bench.sessions.load({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1" }).id)[0]?.status).toBe("done");
    await eventually(() => d.ran.length === 1, 4_000, "the helper's own step");

    // Talked to meanwhile — and the turn that answers is told what is still running for it.
    say(d.gateway, "jam berapa sekarang?", "m2");
    await eventually(() => replies(d.gateway).includes("Jam 12 siang."), 4_000, "the answer meanwhile");
    expect(d.jobs.get(job!.id)?.status).toBe("running");
    const meanwhile = d.asked.find((request) => request.who.kind === "parent" && lastUser(request.body).includes("jam berapa"))!;
    expect(lastUser(meanwhile.body)).toContain(`(Still working in the background for you: ${job!.id} "Find every broken link on the docs site"`);

    // The report arrives by itself, carrying the helper's handoff.
    helperFinishes.open();
    await eventually(() => replies(d.gateway).some((text) => text.startsWith("Beres:")), 4_000, "the report");
    expect(replies(d.gateway)).toEqual([
      "Siap — helper lagi ngecek semua link di background. Nanti gw kabarin.",
      "Jam 12 siang.",
      "Beres: Found 3 broken links: /guide/a, /api/b, /blog/c.",
    ]);
    const wake = d.asked.find((request) => request.who.kind === "parent" && lastUser(request.body).includes("[System event"))!;
    expect(lastUser(wake.body)).toContain(`Background helper ${job!.id} ("Find every broken link on the docs site") finished`);
    expect(lastUser(wake.body)).toContain("Its handoff:\n[nouva · success]\nFound 3 broken links: /guide/a, /api/b, /blog/c.");
    expect(d.jobs.get(job!.id)).toMatchObject({ status: "succeeded", report: { status: "success" } });
    // Its steps are its log.
    const log = (await readTextFileIfExists(job!.logPath)) ?? "";
    expect(log).toContain("→ probe");

    // And a turn of its own (0.7.26), named in that log: read like a chat turn — its steps, its report — and linked to
    // its job and to the turn that asked, which lists it.
    const inspector = new TurnInspector(d.bench.db);
    const asking = inspector.inspect(job!.turnId!)!;
    const [handed] = asking.delegated ?? [];
    expect(handed).toMatchObject({ agentId: "nouva", status: "done", cause: { via: "delegate", job: job!.id, parent: job!.turnId } });
    expect(log).toContain(`its turn is ${handed!.id}`);
    const own = inspector.inspect(handed!.id)!;
    expect(own.turn.prompt).toContain("Find every broken link on the docs site");
    expect(own.turn.reply).toBe("Found 3 broken links: /guide/a, /api/b, /blog/c.");
    expect(own.steps.map((step) => [step.kind, step.text])).toContainEqual(["tool", 'probe {"what":"/srv/docs"}']);
    expect(own.steps.at(-1)).toMatchObject({ kind: "note", text: "handed back success" });
    // No turn of the conversation: the chat's transcript is the person's turns and the wake-ups.
    expect(d.bench.turns.forChat("telegram:main", "chat-1").map((turn) => turn.id)).not.toContain(handed!.id);
  });

  test("two helpers' results each wake the parent as each one finishes — no barrier", async () => {
    const first = gate();
    const second = gate();
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          await (who.goal.startsWith("Check the API") ? first : second).opened;
          return { text: `done: ${who.goal}` };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "Two helpers are on it." };
        if (asked.includes("[System event")) return { text: `Reported: ${/done: ([^\n]+)/.exec(asked)?.[1] ?? "?"}` };
        return {
          toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Check the API reference pages"), brief("Check the blog pages")], background: true } }],
        };
      },
    });

    say(d.gateway, "check the API docs and the blog, separately", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 2 && replies(d.gateway).includes("Two helpers are on it."), 4_000, "both started");

    // The second to start finishes first, and is reported while the first is still working.
    second.open();
    await eventually(() => replies(d.gateway).includes("Reported: Check the blog pages"), 4_000, "the first report");
    expect(d.jobs.backgroundTurns("nouva").map((job) => job.brief?.goal)).toEqual(["Check the API reference pages"]);

    first.open();
    await eventually(() => replies(d.gateway).includes("Reported: Check the API reference pages"), 4_000, "the second report");
    expect(replies(d.gateway)).toEqual(["Two helpers are on it.", "Reported: Check the blog pages", "Reported: Check the API reference pages"]);
  });
});

describe("the machine an agent is told about", () => {
  test("is said in its prompt, which does not change with what is running; the load is said on the message, only while something runs", async () => {
    const helperFinishes = gate();
    const d = await daemon({
      // With a shell, so its helper has one too: the machine is said to whoever can load it.
      agentToml: PACK.replace('"read"]', '"read", "exec"]'),
      answer: async (who, body) => {
        if (who.kind === "helper") {
          await helperFinishes.opened;
          return { text: "Found nothing broken." };
        }
        const asked = lastUser(body);
        if (!body.stream) return { text: "On it." };
        if (asked.includes("[System event")) return { text: "Reported." };
        if (asked.includes("what time") || asked.includes("and now")) return { text: "Noon." };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Find every broken link on the docs site")], background: true } }] };
      },
    });
    const system = (request: Asked) => textOf(request.body.messages[0]?.content);
    const parent = (words: string) => d.asked.find((request) => request.who.kind === "parent" && lastUser(request.body).includes(words))!;

    say(d.gateway, "check every link on the docs site", "m1");
    await eventually(() => replies(d.gateway).includes("On it."), 4_000, "the parent's reply");
    say(d.gateway, "what time is it?", "m2");
    await eventually(() => replies(d.gateway).includes("Noon."), 4_000, "the answer while the helper works");
    helperFinishes.open();
    await eventually(() => replies(d.gateway).includes("Reported."), 4_000, "the report");
    say(d.gateway, "and now?", "m3");
    await eventually(() => replies(d.gateway).filter((text) => text === "Noon.").length === 2, 4_000, "the answer with nothing running");

    const idle = parent("check every link");
    const busy = parent("what time is it?");
    const after = parent("and now?");

    // The cached prefix: the same bytes with a helper running as with none, before and after.
    expect(system(busy)).toBe(system(idle));
    expect(system(after)).toBe(system(idle));
    // In it, the bench's machine (four cores, 4 GiB), every figure as it was read, and the limit it gives: two.
    const MACHINE = "- **This machine** has 4 cores, 4.0GB of memory, shared by every agent on it. At once: at most 2 of your helpers in the background.";
    expect(system(idle)).toContain(MACHINE);
    // And `/prompt` builds the same block: the diagnostic is told what a turn is.
    const shown = await d.bench.pipeline.renderPrompt("nouva", envelope({ id: "p1", chatType: "dm", text: "x" }));
    expect(typeof shown === "string" ? shown : shown.text).toContain(MACHINE);

    // What runs now is on the message, at its end, and only while something runs.
    expect(lastUser(busy.body)).toEndWith("(Running now: 1 of the 2 helpers and asks you may have in the background.)");
    expect(lastUser(idle.body)).not.toContain("Running now");
    expect(lastUser(after.body)).not.toContain("Running now");
    // Kept with the message as it was sent: the next request repeats it, so the conversation's cache holds too.
    expect(textOf(after.body.messages.find((message) => message.role === "user" && textOf(message.content).includes("what time is it?"))?.content)).toBe(lastUser(busy.body));

    // A helper is told the machine it runs commands on, and no limit: it starts no helper of its own.
    const helper = system(d.asked.find((request) => request.who.kind === "helper")!);
    expect(helper).toContain("- **This machine** has 4 cores, 4.0GB of memory, shared by every agent on it.\n");
    expect(helper).not.toContain("of your helpers");
  });
});

describe("the limit", () => {
  test("refuses the one over it with what is running — and the dashboard's setting applies to the next turn", async () => {
    const hold = gate();
    let asks = 0;
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          await hold.opened;
          return { text: "done" };
        }
        if (!body.stream) return { text: "ok" };
        const asked = lastUser(body);
        if (body.messages.at(-1)?.role === "tool") return { text: "noted" };
        if (asked.includes("[System event")) return { text: "reported" };
        asks += 1;
        const tasks = asks === 1 ? [brief("First piece"), brief("Second piece")] : [brief(`Piece ${asks + 1}`)];
        return { toolCalls: [{ id: `d${asks}`, name: "delegate", args: { tasks, background: true } }] };
      },
    });

    say(d.gateway, "two things", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 2, 4_000, "two running");
    const running = d.jobs.backgroundTurns("nouva").map((job) => job.id);

    // A third, with nothing set: refused at the two the bench's machine has room for, said as the machine's, naming both.
    say(d.gateway, "and a third", "m2");
    await eventually(() => replies(d.gateway).includes("noted"), 4_000, "the refusal read");
    const refusal = textOf(d.asked.findLast((request) => request.body.messages.at(-1)?.role === "tool")!.body.messages.at(-1)!.content);
    expect(refusal).toContain('Not started: "Piece 3". You already have 2 jobs working in the background (helpers and asks), the most this agent may have (2, what this machine has room for: `[delegate] max_background` is not set)');
    for (const id of running) expect(refusal).toContain(id);
    expect(d.jobs.backgroundTurns("nouva")).toHaveLength(2);

    // Raised from the agent's Settings page: the next one starts — no restart.
    const pack = join(d.bench.agentsDir, "nouva", "config.toml");
    const settings = {} as SettingsDeps;
    expect(await saveAgentMaxBackground(settings, { agentConfigPath: pack, reload: () => d.bench.registry.reload("nouva"), value: 3, actor: "t", agentId: "nouva" })).toMatchObject({ ok: true });
    say(d.gateway, "and a fourth", "m3");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 3, 4_000, "a third running");

    // Turned off: the next turn's `delegate` has no `background`, and its prompt says nothing of it.
    expect(await saveAgentMaxBackground(settings, { agentConfigPath: pack, reload: () => d.bench.registry.reload("nouva"), value: 0, actor: "t", agentId: "nouva" })).toMatchObject({ ok: true });
    say(d.gateway, "a fifth", "m4");
    await eventually(() => d.asked.some((request) => request.who.kind === "parent" && lastUser(request.body).includes("a fifth")), 4_000, "the next turn");
    const off = d.asked.find((request) => request.who.kind === "parent" && lastUser(request.body).includes("a fifth"))!;
    const delegateTool = off.body.tools?.find((tool) => tool.function.name === "delegate");
    expect(Object.keys((delegateTool?.function.parameters as { properties: object }).properties)).toEqual(["tasks", "tier"]);
    expect(textOf(off.body.messages[0]?.content)).not.toContain("background: true");
    hold.open();
  });
});

describe("what a helper may not do", () => {
  test("it writes no memory and starts no helper — and has the rest of what its parent has", async () => {
    const hold = gate();
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          if (!body.messages.some((message) => message.role === "tool")) return { toolCalls: [{ id: "h1", name: "person_jot", args: { change: "remember: the person likes tabs" } }] };
          await hold.opened;
          return { text: "could not keep it" };
        }
        if (!body.stream) return { text: "ok" };
        if (lastUser(body).includes("[System event")) return { text: "reported" };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Tidy the docs config")], background: true } }] };
      },
    });

    say(d.gateway, "tidy it", "m1");
    await eventually(() => d.asked.filter((request) => request.who.kind === "helper").length === 2, 4_000, "the helper's second call");
    const [opening, afterRefusal] = d.asked.filter((request) => request.who.kind === "helper");
    const offered = opening!.body.tools?.map((tool) => tool.function.name) ?? [];
    expect(offered).not.toContain("delegate");
    expect(offered).not.toContain("memory_write");
    // What it inherits: the parent's own tool, and reading.
    expect(offered).toEqual(expect.arrayContaining(["probe", "read", "person_jot"]));
    // Nor the conversation's work notes (0.7.26): its agent is their one writer; a helper is handed a copy.
    expect(offered).not.toContain("notes");
    // The write was refused at the gate, and never ran.
    expect(d.written).toEqual([]);
    expect(textOf(afterRefusal!.body.messages.at(-1)?.content)).toContain("a helper writes no memory");
    hold.open();
  });

  test("an approval it needs asks in the parent's chat, naming it and its goal — and waits the question's whole window", async () => {
    const asks: ApprovalAsk[] = [];
    const recording: ApprovalGate = {
      available: true,
      canAsk: () => true,
      pending: (): ApprovalRequest[] => [],
      expireAll: () => 0,
      request: async (ask): Promise<ApprovalOutcome> => {
        asks.push(ask);
        return { status: "approved", by: "user-1", decision: "allow-once" };
      },
    };
    const d = await daemon({
      approvals: recording,
      agentToml: '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "probe"]\napproval_required = ["probe"]\n\n[agent]\napprovals = "careful"\n',
      answer: async (who, body) => {
        if (who.kind === "helper") {
          if (!body.messages.some((message) => message.role === "tool")) return { toolCalls: [{ id: "h1", name: "probe", args: { what: "the build" } }] };
          return { text: "the build is fine" };
        }
        if (!body.stream) return { text: "ok" };
        if (lastUser(body).includes("[System event")) return { text: "reported" };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief('Check the "docs" build')], background: true } }] };
      },
    });

    say(d.gateway, "check the build", "m1");
    await eventually(() => replies(d.gateway).includes("reported"), 4_000, "the report");
    expect(asks).toHaveLength(1);
    const [job] = d.jobs.list({ agentId: "nouva" });
    expect(asks[0]).toMatchObject({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", tool: "probe", senderId: "user-1" });
    // The model's words, unable to close the quotes they sit in.
    expect(asks[0]!.reason).toStartWith(`a background task (${job!.id}: "Check the 'docs' build") wants to run this: `);
    // Nobody is waiting on a turn here: it waits as long as the question stays open (five minutes by default), not a
    // turn's slice of it — its own clock is the agent's whole turn, an hour.
    expect(asks[0]!.waitMs).toBeGreaterThan(d.bench.config.security.approvalTimeoutMs);
    expect(d.ran).toEqual(["the build"]);
  });
});

describe("a helper's commands", () => {
  const WITH_EXEC = PACK.replace('"read"]', '"read", "exec"]');
  const JOB_OPTIONS = ["background", "keep_working", "service", "on_complete"];
  /** The helper's script: a job asked for, then — told no — the command in the foreground, waiting as long as it needs. */
  const helper = (body: Asked["body"]): Said => {
    const results = body.messages.filter((message) => message.role === "tool").length;
    if (results === 0) return { toolCalls: [{ id: "h1", name: "exec", args: { command: "make -C /srv/docs", background: true } }] };
    if (results === 1) return { toolCalls: [{ id: "h2", name: "exec", args: { command: "sleep 12; echo alpha-done", timeout_ms: 600_000 } }] };
    return { text: "It printed alpha-done." };
  };

  test("run in the foreground, read by the helper: no job of its own, a job asked for refused, and the wait a background helper may ask for", async () => {
    const d = await daemon({
      agentToml: WITH_EXEC,
      answer: (who, body) => {
        if (who.kind === "helper") return helper(body);
        if (!body.stream) return { text: "Started." };
        if (lastUser(body).includes("[System event")) return { text: "Done." };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Build the docs site")], background: true } }] };
      },
    });
    say(d.gateway, "build the docs, it takes a while", "m1");
    await eventually(() => replies(d.gateway).includes("Done."), 6_000, "the report");

    const [job] = d.jobs.list({ agentId: "nouva" });
    expect(d.jobs.list({ agentId: "nouva" })).toHaveLength(1);
    expect(job).toMatchObject({ kind: "helper", status: "succeeded", report: { status: "success", summary: "It printed alpha-done." } });

    // Never offered: the options that start a job are not in the schema the helper's model sees.
    const requests = d.asked.filter((request) => request.who.kind === "helper");
    const schema = requests[0]!.body.tools!.find((tool) => tool.function.name === "exec")!.function.parameters as { properties: Record<string, { description?: string }> };
    expect(Object.keys(schema.properties).filter((key) => JOB_OPTIONS.includes(key))).toEqual([]);
    expect(schema.properties.timeout_ms?.description).toContain("up to 1800000");
    // Asked for anyway, refused with what to do — and the command never ran.
    expect(textOf(requests[1]!.body.messages.find((message) => message.role === "tool")?.content)).toContain("A helper runs every command in the foreground");
    expect(d.execs).toHaveLength(1);
    // Run in the foreground, whatever the command looks like, with the wait a helper in the background may have.
    expect(d.execs[0]).toEqual({ args: { command: "sleep 12; echo alpha-done", timeout_ms: 600_000, background: false, service: false }, commandMaxMs: 1_800_000 });
  });

  test("a helper waited on keeps exec's usual wait — it runs inside a turn somebody is waiting on", async () => {
    const d = await daemon({
      agentToml: WITH_EXEC,
      answer: (who, body) => {
        if (who.kind === "helper") return helper(body);
        if (body.messages.some((message) => message.role === "tool")) return { text: "Built." };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Build the docs site")] } }] };
      },
    });
    say(d.gateway, "build the docs", "m1");
    await eventually(() => replies(d.gateway).includes("Built."), 6_000, "the answer");

    const requests = d.asked.filter((request) => request.who.kind === "helper");
    const schema = requests[0]!.body.tools!.find((tool) => tool.function.name === "exec")!.function.parameters as { properties: Record<string, { description?: string }> };
    expect(Object.keys(schema.properties).filter((key) => JOB_OPTIONS.includes(key))).toEqual([]);
    expect(schema.properties.timeout_ms?.description).toBe("max 240000");
    expect(d.execs).toEqual([{ args: { command: "sleep 12; echo alpha-done", timeout_ms: 600_000, background: false, service: false }, commandMaxMs: undefined }]);
    expect(d.jobs.list({ agentId: "nouva" })).toEqual([]);
  });
});

describe("where background helpers are not offered", () => {
  const delegateParams = (request: Asked) =>
    Object.keys((request.body.tools?.find((tool) => tool.function.name === "delegate")?.function.parameters as { properties: object }).properties);

  test("a scheduled turn's delegate waits for its helpers: nobody to stay free for, and no chat a report could reach", async () => {
    const d = await daemon({ answer: async () => ({ text: "reported" }) });
    const job = { id: "job_report", name: "report", agentId: "nouva", session: "isolated", trigger: { kind: "every", everyMs: 60_000 }, payload: { kind: "agentTurn", message: "check" }, target: { gatewayId: "telegram:main", chatId: "chat-1" }, delivery: { mode: "none" }, enabled: true };
    await d.bench.pipeline.cronExecutors().runTurn({ job: job as never, session: { gatewayId: "telegram:main", chatId: "cron:job_report" }, message: "check", signal: new AbortController().signal });
    expect(delegateParams(d.asked[0]!)).toEqual(["tasks", "tier"]);
  });

  test("an agent asked by another hands work only to helpers it waits for — its answer is the caller's, not the chat's", async () => {
    const { fetchImpl, asked } = provider(async (_who, body) => {
      const system = textOf(body.messages[0]?.content);
      if (system.includes("agent id: nox")) return { text: "nox's answer" };
      if (body.messages.at(-1)?.role === "tool") return { text: "done" };
      return { toolCalls: [{ id: "a1", name: "ask_agent", args: { agent: "nox", task: "check the build" } }] };
    });
    const pack = '[llm]\nprovider = "test"\n\n[tools]\nenabled = ["delegate", "ask_agent"]\n';
    const gateway = new FakeGateway();
    const bench = await pipelineBench({
      fetch: () => fetchImpl,
      gateway,
      agents: [{ id: "nouva", configToml: pack }, { id: "nox", configToml: pack }],
      config: { daemon: { orchestrator: "nouva" }, agents: { mentions_enabled: true } },
      configure: (config) => void (config.queue.steerReply = false),
      deps: ({ db, dataDir }) => {
        const jobs = new JobStore({ db, logDir: join(dataDir, "jobs"), maxConcurrentPerAgent: 4 });
        stores.push(jobs);
        return { jobs };
      },
    });
    benches.push(bench);
    const tools = createBuiltinTools({
      security: bench.config.security,
      runSubagent: bench.pipeline.subagentRunner(),
      startHelper: bench.pipeline.backgroundHelpers(),
      askAgent: { run: bench.pipeline.peerTurnRunner(), peers: (caller) => ["nouva", "nox"].filter((id) => id !== caller) },
    });
    bench.pipeline.setTools(tools);
    bench.pipeline.attach();
    say(gateway, "ask nox", "m1");
    await eventually(() => replies(gateway).includes("done"), 4_000, "the caller's answer");
    const [caller, peer] = [asked[0]!, asked.find((request) => textOf(request.body.messages[0]?.content).includes("agent id: nox"))!];
    expect(delegateParams(caller)).toEqual(["tasks", "background", "tier"]);
    expect(delegateParams(peer)).toEqual(["tasks", "tier"]);
  });
});

describe("a helper's budget", () => {
  test("in the foreground, half of a pack's own round trips; in the background, all of them — and its prompt says the same", async () => {
    const d = await daemon({
      agentToml: '[llm]\nprovider = "test"\nmax_tool_iterations = 20\n\n[tools]\nenabled = ["delegate", "probe"]\n',
      answer: async (who, body) => {
        if (who.kind === "helper") return { text: "done" };
        if (!body.stream) return { text: "ok" };
        if (body.messages.at(-1)?.role === "tool") return { text: "both done" };
        if (lastUser(body).includes("[System event")) return { text: "reported" };
        return {
          toolCalls: [
            { id: "d1", name: "delegate", args: { tasks: [brief("A quick look")] } },
            { id: "d2", name: "delegate", args: { tasks: [brief("A long look")], background: true } },
          ],
        };
      },
    });
    say(d.gateway, "look twice", "m1");
    await eventually(() => replies(d.gateway).includes("reported"), 4_000, "the background helper's report");
    const prompt = (goal: string) => textOf(d.asked.find((request) => request.who.kind === "helper" && request.who.goal === goal)!.body.messages[0]?.content);
    // The pack's own 20 used to reach the helper whole: the half was put in the daemon's limits, which a pack overrides.
    expect(prompt("A quick look")).toContain("At most 10 tool round-trips");
    expect(prompt("A long look")).toContain("At most 20 tool round-trips");
  });
});

describe("stopping it", () => {
  test("/stop stops the helpers working for this chat, and says so", async () => {
    const d = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") return await new Promise<Said>(() => {});
        if (!body.stream) return { text: "on it" };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("A very long check")], background: true } }] };
      },
    });
    say(d.gateway, "check everything", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1 && replies(d.gateway).includes("on it"), 4_000, "a helper running");
    const [job] = d.jobs.backgroundTurns("nouva");

    say(d.gateway, "/stop", "m2");
    await eventually(() => replies(d.gateway).some((text) => text?.includes("Stopped the helper working in the background too.")), 4_000, "the stop");
    await eventually(() => d.jobs.get(job!.id)?.status === "killed", 4_000, "the helper stopped");
  });
});

describe("a restart", () => {
  test("closes it as interrupted, and wakes the parent with what it had done and that it can be started again", async () => {
    const first = await daemon({
      answer: async (who, body) => {
        if (who.kind === "helper") {
          if (!body.messages.some((message) => message.role === "tool")) return { toolCalls: [{ id: "h1", name: "probe", args: { what: "/srv/docs/guide" } }] };
          return await new Promise<Said>(() => {});
        }
        if (!body.stream) return { text: "on it" };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Find every broken link on the docs site")], background: true } }] };
      },
    });
    say(first.gateway, "check the links", "m1");
    await eventually(() => first.ran.length === 1, 4_000, "the helper's first step");
    const [job] = first.jobs.backgroundTurns("nouva");

    // The daemon goes: the store closes and stops its helpers, and writes nothing.
    await first.jobs.killAll();
    expect(first.jobs.get(job!.id)?.status).toBe("running");

    // The next process, over the same install, as boot brings it up.
    const next = await daemon({
      after: first.bench,
      answer: async (_who, body) => {
        const asked = lastUser(body);
        return { text: asked.includes("was interrupted by a restart") ? "Helper tadi keputus restart; mau gw jalanin lagi?" : "?" };
      },
    });
    const orphaned = next.jobs.interruptOrphaned();
    reportInterruptedJobs({ jobs: next.jobs, orphanedJobs: orphaned, pipeline: next.bench.pipeline });

    await eventually(() => replies(next.gateway).includes("Helper tadi keputus restart; mau gw jalanin lagi?"), 4_000, "the parent woken");
    const wake = lastUser(next.asked.find((request) => lastUser(request.body).includes("[System event"))!.body);
    expect(wake).toContain(`Background helper ${job!.id} ("Find every broken link on the docs site") was interrupted by a restart before it finished`);
    expect(wake).toContain("→ probe");
    expect(wake).toContain("a helper is not resumed");
    expect(wake).toContain("start it again with `delegate`, from its brief below");
    expect(wake).toContain("Its brief:\nGOAL\nFind every broken link on the docs site");
    expect(next.jobs.get(job!.id)?.status).toBe("interrupted");
    // The daemon says it itself, before the turn.
    expect(next.notices).toEqual([`⚠️ Background helper ${job!.id} ("Find every broken link on the docs site") was interrupted by a restart and is not resumed.`]);
  });
});

describe("making room for the machine (0.8.0)", () => {
  const logOf = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const helperRequests = (d: { asked: Asked[] }) => d.asked.filter((request) => request.who.kind === "helper");

  test("started on a busy box, it waits — its log says why — while the person is answered; it starts once the box has room", async () => {
    let busy: string | null = "the CPU was 92% busy over the last minute";
    const d = await daemon({
      load: { busy: () => busy },
      answer: async (who, body) => {
        if (who.kind === "helper") return { text: "Found 2 broken links: /guide/a, /api/b." };
        const asked = lastUser(body);
        if (!body.stream) return { text: "On it, in the background." };
        if (asked.includes("[System event")) return { text: `Done: ${/Found [^\n]+/.exec(asked)?.[0] ?? "?"}` };
        if (asked.includes("jam berapa")) return { text: "Jam 12 siang." };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Find every broken link on the docs site")], background: true } }] };
      },
    });
    say(d.gateway, "cek semua link di docs", "m1");
    await eventually(() => replies(d.gateway).includes("On it, in the background."), 4_000, "the parent's reply");
    const [job] = d.jobs.backgroundTurns("nouva");
    await eventually(() => logOf(job!.logPath).includes(`background helper ${job!.id} waits while the box is busy: the CPU was 92% busy over the last minute`), 4_000, "the wait, in its log");

    // A turn somebody is waiting for does not wait: the person is answered while the helper does.
    say(d.gateway, "jam berapa sekarang?", "m2");
    await eventually(() => replies(d.gateway).includes("Jam 12 siang."), 4_000, "the answer meanwhile");
    expect(helperRequests(d)).toEqual([]);
    expect(d.jobs.get(job!.id)?.status).toBe("running");

    busy = null;
    await eventually(() => replies(d.gateway).includes("Done: Found 2 broken links: /guide/a, /api/b."), 4_000, "the report");
    expect(helperRequests(d)).toHaveLength(1);
    expect(logOf(job!.logPath)).toContain(`background helper ${job!.id} goes on: the box has room again`);
    expect(d.jobs.get(job!.id)?.status).toBe("succeeded");
  });

  test("stopped while it waits, it ends without having started", async () => {
    const d = await daemon({
      load: { busy: () => "thermal_zone0 is at 86 °C, at or past its passive trip point of 85 °C" },
      answer: async (who, body) => {
        if (who.kind === "helper") return { text: "done" };
        if (!body.stream) return { text: "on it" };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("A very long check")], background: true } }] };
      },
    });
    say(d.gateway, "check everything", "m1");
    await eventually(() => d.jobs.backgroundTurns("nouva").length === 1 && replies(d.gateway).includes("on it"), 4_000, "a helper waiting");
    const [job] = d.jobs.backgroundTurns("nouva");
    await eventually(() => logOf(job!.logPath).includes("waits while the box is busy"), 4_000, "the wait, in its log");

    say(d.gateway, "/stop", "m2");
    await eventually(() => d.jobs.get(job!.id)?.status === "killed", 4_000, "the helper stopped");
    expect(helperRequests(d)).toEqual([]);
  });

  test("with job_max_ms set, it waits half of it at most — the other half is for the work, which then finishes", async () => {
    const d = await daemon({
      jobMaxMs: 2_000,
      load: { busy: () => "the CPU was 97% busy over the last minute" },
      answer: async (who, body) => {
        if (who.kind === "helper") return { text: "Checked." };
        const asked = lastUser(body);
        if (!body.stream) return { text: "on it" };
        if (asked.includes("[System event")) return { text: "reported" };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("A quick check")], background: true } }] };
      },
    });
    say(d.gateway, "check it", "m1");
    await eventually(() => replies(d.gateway).includes("on it"), 4_000, "the parent's reply");
    const [job] = d.jobs.backgroundTurns("nouva");
    await eventually(() => replies(d.gateway).includes("reported"), 6_000, "the report");
    expect(d.jobs.get(job!.id)?.status).toBe("succeeded");
    expect(logOf(job!.logPath)).toContain(`background helper ${job!.id} goes on with the box still busy (the CPU was 97% busy over the last minute): it has waited the most it waits`);
  });

  test("a wait is not taken from its turn's clock — but job_max_ms still counts from its job's start, as the job's own deadline does", () => {
    const MIN = 60_000;
    // Ten minutes waiting for room: the turn's thirty start when it does.
    expect(helperDeadline({ queuedAt: 0, startedAt: 10 * MIN, turnMs: 30 * MIN, jobMs: 0 })).toBe(40 * MIN);
    // A job allowed twenty minutes ends at twenty, waiting included: the turn wraps up before that, not after.
    expect(helperDeadline({ queuedAt: 0, startedAt: 10 * MIN, turnMs: 30 * MIN, jobMs: 20 * MIN })).toBe(20 * MIN);
    // A job longer than the turn and its wait together: the turn's own clock.
    expect(helperDeadline({ queuedAt: 0, startedAt: 10 * MIN, turnMs: 30 * MIN, jobMs: 60 * MIN })).toBe(40 * MIN);
  });

  test("a helper in the foreground never asks, however busy the box: it is part of a turn somebody is waiting for", async () => {
    let looks = 0;
    const d = await daemon({
      load: { busy: () => ((looks += 1), "the CPU was 99% busy over the last minute") },
      answer: (who, body) => {
        if (who.kind === "helper") return { text: "Checked: all fine." };
        if (body.messages.some((message) => message.role === "tool")) return { text: "All fine." };
        return { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief("Check the docs site")] } }] };
      },
    });
    say(d.gateway, "check the docs", "m1");
    await eventually(() => replies(d.gateway).includes("All fine."), 4_000, "the answer");
    expect(helperRequests(d)).toHaveLength(1);
    expect(looks).toBe(0);
  });
});
