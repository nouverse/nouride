/**
 * Every turn's spend check is told to the spend alerts (`turn-context.ts`, `checkSpend`): the one place a day's steps
 * toward the cap are said from, for chat and job turns alike.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { BudgetVerdict } from "@/modules/llm/budget.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { envelope } from "../helpers.ts";
import { eventually } from "../wait.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.dispose();
});

describe("a turn past the spend threshold", () => {
  test("tells the spend alerts what today's verdict is", async () => {
    const told: BudgetVerdict[] = [];
    const bench = await pipelineBench({
      turns: [{ text: "hello" }],
      config: { llm: { defaults: { provider: "test", model: "test-model" }, limits: { max_daily_tokens: 10_000 } } },
      deps: ({ db }) => ({ usage: new UsageStore(db), spendAlerts: { check: (verdict) => void told.push(verdict) } }),
    });
    benches.push(bench);
    bench.db.prepare("INSERT INTO llm_usage (id, agent_id, model, provider, input_tokens, output_tokens, timestamp) VALUES ('u1', 'nouva', 'm', 'test', 9000, 0, ?)").run(Date.now());
    bench.pipeline.attach();
    bench.gateway.receive(envelope({ id: "m1", chatType: "dm", chatId: "chat-1", text: "hi", timestamp: Date.now() }));
    await eventually(() => bench.gateway.sent.length > 0, 3_000, "the reply");

    expect(told.length).toBeGreaterThan(0);
    expect(told[0]).toMatchObject({ action: "allow", cap: "tokens" });
    expect(Math.round((told[0] as { pct: number }).pct)).toBe(90);
  });
});
