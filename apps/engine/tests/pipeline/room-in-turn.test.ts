/**
 * A turn that makes room for itself when its own steps fill the window, through the whole pipeline
 * (`TurnExecutor.roomInTurn`, `llm/summarize-steps.ts`).
 *
 * The model here has a window it enforces, as a real one does: a request past it is answered with the provider's own
 * refusal. A long turn's steps pass it however much old tool output is cleared, and the turn used to end there, on an
 * overflow that leaving out earlier turns cannot clear. Now it sums its oldest steps up and goes on to its answer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { sessionIdFor, type Tool } from "@nouride/shared";
import { STEPS_NOTE } from "@/modules/llm/summarize-steps.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

/** What one step of the model's says before its call: long enough that the steps, not their results, fill the window. */
const THOUGHT = "Reading the next service's logs to see what is filling the disk, one directory at a time. ".repeat(14);
const NOTES = "Headline: the logs of the first services were read\n\n## Done\n- The first services' logs are small.\n\n## Open\n- The rest are still to read.";

/** The summarizer's request, by the words its instruction starts with. */
const isSummary = (body: { messages?: { role: string; content: unknown }[] }) => String(body.messages?.[0]?.content ?? "").startsWith("You are writing your own notes");

/**
 * A daemon whose model takes `window` characters of messages and refuses more, as a provider refuses a request past
 * its context; `steps` rounds of one call each, then an answer. `summary`: what the summarizer answers, or a status
 * it fails with.
 */
async function longTurn(options: { steps: number; window: number; summary?: string | number; declared?: number; pauseAt?: number }) {
  const seen = { order: [] as ("turn" | "summary")[], refused: 0, requests: [] as { messages: { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }[] }[] };
  const probe: Tool = {
    definition: { name: "probe", description: "Read one service's logs.", parameters: { type: "object", properties: { n: { type: "number" } } } },
    requiresApproval: false,
    execute: async (args) => {
      const n = (args as { n?: number }).n;
      // A shutdown, asked for while this call runs: the turn stops at the next step boundary and is closed.
      if (n === options.pauseAt) bench!.pipeline.pause();
      return { content: `svc${String(n)}: 2G of logs`, isError: false };
    },
  } as Tool;
  const bot = new FakeGateway("telegram:nouva", "telegram");
  /** The model: the summarizer's requests answered here, a request past the window refused, the rest by the script. */
  const model =
    (scripted: typeof fetch) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: unknown }[] };
        const json = (status: number, answer: unknown) => new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
        if (isSummary(body)) {
          seen.order.push("summary");
          if (typeof options.summary === "number") return json(options.summary, { error: { message: "the summarizer is overloaded" } });
          return json(200, { model: "test-model", choices: [{ message: { content: options.summary ?? NOTES }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
        }
        if (JSON.stringify(body.messages ?? []).length > options.window) {
          seen.refused += 1;
          return json(400, { error: { message: "This model's maximum context length is 16000 tokens. Your messages resulted in more." } });
        }
        seen.order.push("turn");
        seen.requests.push(body as never);
        return await scripted(url, init);
      }) as typeof fetch;
  // The window the agent is told its model has: small, so a long turn's steps pass it.
  const agentToml = `[llm]\nprovider = "test"\ncontext_window = ${options.declared ?? 16_000}\nmax_tool_iterations = 200\n\n[tools]\nenabled = ["probe"]\napproval_required = []\n`;
  bench = await pipelineBench({
    turns: [...Array.from({ length: options.steps }, (_, n) => ({ text: `${n + 1}. ${THOUGHT}`, toolCalls: [{ id: `c${n + 1}`, name: "probe", args: { n: n + 1 } }] })), { text: "The disk is full of logs." }],
    gateway: bot,
    maxAttempts: 1,
    agentToml,
    fetch: model,
  });
  bench.pipeline.setTools(new Map([["probe", probe]]));
  bench.pipeline.attach();
  bot.receive(envelope({ gatewayId: bot.id, chatId: "814", senderId: "814", timestamp: Date.now(), text: "cek kenapa disk penuh" }));
  await bench.pipeline.idle();
  const turn = bench.turns.latestForSession(sessionIdFor({ agentId: "nouva", gatewayId: bot.id, chatId: "814" }))!;
  const steps = bench.turns.stepsSince(turn.id, 0);
  // The summaries asked for while the turn ran: before its last request. One after its answer is the conversation's
  // own upkeep for the next turn, and not this.
  const inTurn = seen.order.slice(0, seen.order.lastIndexOf("turn")).filter((one) => one === "summary").length;
  const session = { agentId: "nouva", gatewayId: bot.id, chatId: "814" };
  return {
    seen,
    inTurn,
    bot,
    steps,
    compacts: steps.filter((step) => step.kind === "compact").map((step) => step.text),
    turn: bench.turns.get(turn.id)!,
    history: () => bench!.sessions.load(session).messages,
    journals: () => bench!.journal.count(),
    /** The daemon started again over the same install, and one more message from the person. */
    async afterRestart(text: string, answer: string) {
      // Its own connection: the one before is still the stopped process's.
      const again = new FakeGateway("telegram:nouva", "telegram");
      const next = await bench!.reboot({ turns: [{ text: answer }], gateway: again, maxAttempts: 1, fetch: model });
      bench = next;
      next.pipeline.setTools(new Map([["probe", probe]]));
      next.pipeline.attach();
      const from = seen.requests.length;
      again.receive(envelope({ id: "m-next", gatewayId: again.id, chatId: "814", senderId: "814", timestamp: Date.now(), text }));
      await next.pipeline.idle();
      return { asked: seen.requests.slice(from), said: again.lastText() };
    },
  };
}

/** Every tool result in a request has its call in the reply before it. */
function pairsWhole(messages: { role: string; tool_calls?: unknown[]; tool_call_id?: string }[]): boolean {
  let open = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") open = new Set(((message.tool_calls ?? []) as { id: string }[]).map((call) => call.id));
    else if (message.role === "tool" && !open.has(message.tool_call_id ?? "")) return false;
  }
  return true;
}

describe("a turn whose own steps fill the model's window", () => {
  test("sums its oldest steps up and ends with its answer, where it ended on a full context", async () => {
    const h = await longTurn({ steps: 60, window: 46_000 });

    expect(h.bot.lastText()).toBe("The disk is full of logs.");
    expect(h.turn.status).toBe("done");
    // Room is made down to a line under the one that starts it, so the turn has some to work in before it is asked
    // for notes again: about one summary to three steps on this small a window, where starting at the lower line
    // asks for one at nearly every step.
    expect(h.inTurn).toBeLessThan(30);
    // The model never saw a request past its window: room was made before the request, not after a refusal.
    expect(h.seen.refused).toBe(0);
    expect(h.inTurn).toBeGreaterThanOrEqual(1);
    expect(h.compacts.some((text) => /^context full: summing up \d+ earlier step\(s\) of this turn, ~/.test(text))).toBe(true);
    expect(h.compacts.some((text) => /^summed up \d+ earlier step\(s\) of this turn, now ~/.test(text))).toBe(true);
    // Every request after it: the notes at the head of a reply, no result without its call, no two of one role in a row.
    const after = h.seen.requests.filter((request) => JSON.stringify(request.messages).includes(STEPS_NOTE));
    expect(after.length).toBeGreaterThan(0);
    for (const request of after) {
      expect(pairsWhole(request.messages)).toBe(true);
      const roles = request.messages.filter((message) => message.role !== "system").map((message) => message.role);
      expect(roles.some((role, index) => index > 0 && role === roles[index - 1] && role !== "tool")).toBe(false);
      const noted = request.messages.find((message) => String(message.content).includes(STEPS_NOTE))!;
      expect(noted.role).toBe("assistant");
      expect(String(noted.content)).toContain("Headline: the logs of the first services were read");
    }
    // Every call still ran, once each.
    expect(h.steps.filter((step) => step.kind === "tool")).toHaveLength(60);
  }, 60_000);

  test("a turn that never fills the window makes no call but its own", async () => {
    const h = await longTurn({ steps: 6, window: 10_000_000, declared: 200_000 });
    expect(h.bot.lastText()).toBe("The disk is full of logs.");
    expect(h.seen.order.filter((one) => one === "turn")).toHaveLength(7);
    expect(h.inTurn).toBe(0);
    expect(h.compacts.filter((text) => text.includes("of this turn"))).toEqual([]);
  }, 60_000);

  test("a summarizer that fails is said once and not asked again: the turn goes on as it is", async () => {
    // A window the steps never pass here, so what is seen is the failure's own handling and not an overflow after it.
    const h = await longTurn({ steps: 60, window: 10_000_000, summary: 503 });
    expect(h.bot.lastText()).toBe("The disk is full of logs.");
    expect(h.inTurn).toBe(1);
    expect(h.compacts.filter((text) => text === "could not sum up this turn's earlier steps: carrying on as it is")).toHaveLength(1);
  }, 60_000);

  test("cut off by a restart after it made room, it is closed into what the model held, and the turn after it fits and answers", async () => {
    // Stopped at its fiftieth call, well after its oldest steps were summed up.
    const h = await longTurn({ steps: 60, window: 46_000, pauseAt: 50 });
    expect(h.inTurn).toBeGreaterThanOrEqual(1);
    expect(h.turn.status).toBe("interrupted");
    expect(h.journals()).toBe(0);

    // The conversation holds the turn as the model held it: the notes, its newest steps, and where it was cut off.
    const kept = h.history();
    const text = JSON.stringify(kept);
    expect(text).toContain(STEPS_NOTE);
    expect(text).toContain("interrupted here by a restart");
    // What was asked, once, at its head: the journal was rewritten from the turn's own messages, not from the question on.
    expect(kept.filter((message) => message.role === "user").map((message) => String(message.content).includes("cek kenapa disk penuh"))).toEqual([true]);
    expect(kept[0]!.role).toBe("user");
    const calls = kept.flatMap((message) => message.toolCalls ?? []).map((call) => call.id);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(50);
    expect(calls.at(-1)).toBe("c50");
    expect(pairsWhole(kept.map((message) => ({ role: message.role, ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}), ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}) })))).toBe(true);
    // Every step as first recorded would be a turn no request carries: this one fits the window it ran in.
    expect(text.length).toBeLessThan(46_000);

    const { asked, said } = await h.afterRestart("lanjut", "Carrying on: the rest of the logs are large.");
    expect(said).toBe("Carrying on: the rest of the logs are large.");
    expect(h.seen.refused).toBe(0);
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0]!.messages)).toContain(STEPS_NOTE);
    expect(pairsWhole(asked[0]!.messages)).toBe(true);
  }, 60_000);
});
