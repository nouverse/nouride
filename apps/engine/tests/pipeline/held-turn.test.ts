/**
 * A turn refused for a plan's limit that said when it ends is held until then and taken up by itself
 * (`pipeline/provider-resume.ts`): the person is told so, the time is on the turn's record for a restart in between, and
 * the turn goes on once the limit has ended.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { NourideError, type LoadedAgent } from "@nouride/shared";
import type { ExecutorDeps, TurnBrain } from "@/modules/llm/executor/types.ts";
import { envelope } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const LIMIT = "Every account of Nouva is at its limit: work (for about 3 hours more).";

/**
 * An external agent's brain refused for its accounts' limit until `until` once, and answering after: having said a word
 * first, as a CLI refused mid-turn has, or nothing, as one refused before it began.
 */
/** What each turn of the external agent was asked, in order. */
const asked: string[] = [];

function cliRefusedUntil(until: () => number | undefined, silent = false) {
  let refused = 0;
  const cli = {
    runnerFor: (_agent: LoadedAgent, d: ExecutorDeps): TurnBrain => ({
      run: async (req) => {
        asked.push(typeof req.userMessage.content === "string" ? req.userMessage.content : JSON.stringify(req.userMessage.content));
        if (refused === 0) {
          refused += 1;
          if (!silent) d.onText?.("Looking first.");
          const at = until();
          throw new NourideError("external_accounts_spent", LIMIT, LIMIT, at === undefined ? {} : { retryAt: at });
        }
        d.onText?.("went on");
        const turn = [req.userMessage, { role: "assistant" as const, content: "went on", timestamp: Date.now() }];
        const compaction = { threshold: 1e9, limit: 1e9, totalLimit: 1e9, source: "test", summaryModel: "", summarizerWindow: 0 };
        return { text: "went on", messages: [...req.history, ...turn], turnMessages: turn, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0, iterations: 0, approvalsRefused: 0, toolSteps: [], stopReason: "stop", contextTokens: 0, truncated: false, compaction, tokenScale: 1 };
      },
    }),
  };
  return cli;
}

async function bench(until: () => number | undefined, silent = false): Promise<Bench> {
  const made = await pipelineBench({ agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n', deps: { externalAgents: cliRefusedUntil(until, silent), providerResumeMs: 10 } });
  cleanups.push(made.dispose);
  made.pipeline.attach();
  return made;
}

describe("a turn refused for a limit that said when it ends", () => {
  test("is told it goes on by itself then, keeps the time on its record, and is taken up once the limit has ended", async () => {
    let at = 0;
    const made = await bench(() => (at = Date.now() + 300));
    made.gateway.receive(envelope({ id: "m1", text: "push the fix", timestamp: Date.now() }));
    await eventually(() => made.gateway.sent.length > 0, 5_000, "the refusal told");
    expect(made.gateway.lastText()).toBe(`${LIMIT} I'll go on by myself once that limit ends, or say "continue".`);
    const record = made.db.prepare<{ retry_promised: number | null; retry_at: number | null }>("SELECT retry_promised, retry_at FROM turn_records WHERE message_id = 'm1'").get()!;
    expect(record).toEqual({ retry_promised: 1, retry_at: at });
    // Not before the end: what it says is the end.
    expect(made.gateway.sent.some((sent) => sent.text.includes("went on"))).toBe(false);
    await eventually(() => made.gateway.sent.some((sent) => sent.text.includes("went on")), 5_000, "the turn taken up after the limit's end");
    expect(Date.now()).toBeGreaterThanOrEqual(at);
  });

  test("refused before it said anything, as every account spent is before a message is sent: held all the same, not given to the model", async () => {
    let at = 0;
    const made = await bench(() => (at = Date.now() + 300), true);
    made.gateway.receive(envelope({ id: "m1", text: "push the fix", timestamp: Date.now() }));
    await eventually(() => made.gateway.sent.length > 0, 5_000, "the refusal told");
    expect(made.gateway.sent.map((sent) => sent.text)).toEqual([`${LIMIT} I'll go on by myself once that limit ends, or say "continue".`]);
    expect(made.db.prepare<{ retry_at: number | null }>("SELECT retry_at FROM turn_records WHERE message_id = 'm1'").get()!.retry_at).toBe(at);
    await eventually(() => made.gateway.sent.some((sent) => sent.text.includes("went on")), 5_000, "the turn taken up after the limit's end");
    expect(Date.now()).toBeGreaterThanOrEqual(at);
  });

  test("one that said nothing of when it ends, refused before a word, goes to the agent's own model as before", async () => {
    const made = await bench(() => undefined, true);
    made.gateway.receive(envelope({ id: "m1", text: "push the fix", timestamp: Date.now() }));
    await eventually(() => made.gateway.sent.length > 0, 5_000, "something told");
    expect(made.gateway.lastText()).toContain("own model answered this time");
  });

  test("is taken up with words for a limit's end, not a provider's few minutes", async () => {
    asked.splice(0);
    const made = await bench(() => Date.now() + 200);
    made.gateway.receive(envelope({ id: "m1", text: "push the fix", timestamp: Date.now() }));
    await eventually(() => made.gateway.sent.some((sent) => sent.text.includes("went on")), 5_000, "the turn taken up");
    expect(asked.at(-1)).toContain(`Your plan's limit stopped you while you were working on "push the fix", and that limit has ended now.`);
    expect(asked.at(-1)).not.toContain("few minutes");
  });

  test("someone else in the chat meanwhile does not drop it; the person who asked saying something does", async () => {
    const others = await bench(() => Date.now() + 400);
    others.gateway.receive(envelope({ id: "m1", text: "push the fix", timestamp: Date.now() }));
    await eventually(() => others.gateway.sent.length > 0, 5_000, "the refusal told");
    others.gateway.receive(envelope({ id: "m2", senderId: "user-2", senderName: "Mira", text: "what's the weather", timestamp: Date.now() }));
    // Mira answered, and the held turn taken up after the end all the same: two answers.
    await eventually(() => others.gateway.sent.filter((sent) => sent.text.includes("went on")).length === 2, 5_000, "the held turn taken up beside Mira's");

    const same = await bench(() => Date.now() + 400);
    // When the hold's time came, it asked whether the person spoke since: what tells a hold let go from one not yet due.
    const spoke = same.turns.spokeInChatSince.bind(same.turns);
    let asked = false;
    same.turns.spokeInChatSince = (...args) => ((asked = true), spoke(...args));
    same.gateway.receive(envelope({ id: "m1", text: "push the fix", timestamp: Date.now() }));
    await eventually(() => same.gateway.sent.length > 0, 5_000, "the refusal told");
    same.gateway.receive(envelope({ id: "m2", text: "never mind, do the docs", timestamp: Date.now() }));
    await eventually(() => same.gateway.sent.some((sent) => sent.text.includes("went on")), 5_000, "the new message answered");
    // At the end: the person moved on, so it is theirs, and nothing is taken up for them.
    await eventually(() => asked, 5_000, "the hold's time come");
    await same.pipeline.idle();
    expect(same.gateway.sent.filter((sent) => sent.text.includes("went on"))).toHaveLength(1);
  });

  test("a limit that did not say when it ends is not held: the person is told to say continue, as before", async () => {
    const made = await bench(() => undefined);
    made.gateway.receive(envelope({ id: "m1", text: "push the fix", timestamp: Date.now() }));
    await eventually(() => made.gateway.sent.length > 0, 5_000, "the refusal told");
    expect(made.gateway.lastText()).not.toContain("I'll go on by myself");
    const record = made.db.prepare<{ retry_at: number | null }>("SELECT retry_at FROM turn_records WHERE message_id = 'm1'").get()!;
    expect(record.retry_at).toBeNull();
  });
});
