/**
 * Recording what the model cost.
 *
 * The property that matters most is the one that made the previous version dishonest: an unpriced
 * model must not be recorded as free. A zero in a cost column sums to a spend of nothing, which is
 * precisely how a daily cap fails open — and this daemon already talks to a proxy whose models are not
 * in any price book.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { UsageStore } from "@/modules/llm/usage.store.ts";
import { estimateCost } from "@nouride/llm";

let dir: string;
let db: SqliteDb;
let clock = 1_000_000;

beforeEach(async () => {
  dir = join(tmpdir(), `nouride-usage-${Math.floor(performance.now() * 1000)}`);
  mkdirSync(dir, { recursive: true });
  db = openDatabase(join(dir, "test.db"));
  await migrate(db);
  clock = 1_000_000;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const store = () => new UsageStore(db, () => clock);

const entry = (over: Partial<Parameters<UsageStore["record"]>[0]> = {}) => ({
  agentId: "nouva",
  model: "claude-sonnet-4-5",
  provider: "default",
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  ...over,
});

describe("UsageStore", () => {
  test("records a priced call with a cost", () => {
    const s = store();
    s.record(entry());

    const total = s.since(0);
    expect(total.requests).toBe(1);
    expect(total.inputTokens).toBe(1_000_000);
    // Sonnet is $3/M in and $15/M out.
    expect(total.usd).toBeCloseTo(18, 5);
    expect(total.unpricedRequests).toBe(0);
  });

  test("an unpriced model is null, never zero", () => {
    // The bug this file exists for. A `0` here is a free request, and a day of free requests is a
    // spend of nothing — a cap that never trips.
    const s = store();
    s.record(entry({ model: "some-proxy:unknown-model" }));

    const total = s.since(0);
    expect(total.requests).toBe(1);
    expect(total.usd).toBe(0);
    // And the total says so, rather than implying it covered everything.
    expect(total.unpricedRequests).toBe(1);

    const raw = db
      .prepare<{ estimated_cost_usd: number | null }>("SELECT estimated_cost_usd FROM llm_usage")
      .get();
    expect(raw?.estimated_cost_usd).toBeNull();
  });

  test("a prefixed model id is priced as the model it is", () => {
    // `antigravity:claude-sonnet-4-6` is a Sonnet behind a proxy, not an unknown model.
    const s = store();
    s.record(entry({ model: "antigravity:claude-sonnet-4-6" }));
    expect(s.since(0).unpricedRequests).toBe(0);
  });

  test("since respects its boundary", () => {
    const s = store();
    s.record(entry());
    clock += 60_000;
    s.record(entry());

    expect(s.since(0).requests).toBe(2);
    expect(s.since(1_000_001).requests).toBe(1);
    expect(s.since(clock + 1).requests).toBe(0);
  });

  test("spend can be read for one agent", () => {
    const s = store();
    s.record(entry({ agentId: "nouva" }));
    s.record(entry({ agentId: "other" }));

    expect(s.since(0).requests).toBe(2);
    expect(s.since(0, "nouva").requests).toBe(1);
  });

  test("an empty table sums to zero rather than null", () => {
    // COALESCE, not an accident: `SUM` over no rows is NULL, and NULL reaching a comparison against a
    // cap is a silently skipped check.
    expect(store().since(0)).toMatchObject({ usd: 0, requests: 0, inputTokens: 0 });
  });

  test("recent returns newest first", () => {
    const s = store();
    s.record(entry({ model: "first" }));
    clock += 1000;
    s.record(entry({ model: "second" }));

    expect(s.recent().map((r) => r.model)).toEqual(["second", "first"]);
  });

  test("a write failure never propagates to the caller", () => {
    // The answer has already been produced and, on a chat platform, already sent. A bookkeeping
    // failure must not become a user-visible one.
    const closed = openDatabase(join(dir, "closed.db"));
    closed.close();
    expect(() => new UsageStore(closed).record(entry())).not.toThrow();
  });

  test("sweep drops old rows and keeps recent ones", () => {
    const s = store();
    s.record(entry());
    clock += 10 * 24 * 60 * 60 * 1000;
    s.record(entry());

    expect(s.sweep(7)).toBe(1);
    expect(s.since(0).requests).toBe(1);
    // Zero disables it, the same as every other retention knob here.
    expect(s.sweep(0)).toBe(0);
  });
});

/**
 * Cache hits, stored so the question can be answered from data.
 *
 * The reason this column exists at all: the gateway in front of this daemon talks to Gemini through
 * Google's Cloud Code endpoint and never maps `usageMetadata.cachedContentTokenCount`, so a cache hit
 * and a cache miss look identical from here. Storing what the provider *did* say — including saying
 * nothing — is what makes "is caching working" a query instead of an argument.
 */
describe("prompt-cache hits", () => {
  test("what the provider reported is stored and summed", () => {
    const store = new UsageStore(db, () => clock);

    store.record({
      agentId: "nouva",
      model: "claude-sonnet-4-6",
      provider: "nougate",
      inputTokens: 10_000,
      outputTokens: 100,
      cachedInputTokens: 8_000,
    });

    const spend = store.since(0);
    expect(spend.inputTokens).toBe(10_000);
    expect(spend.cachedInputTokens).toBe(8_000);
    // 2k fresh at $3/M + 8k cached at $0.30/M + 100 out at $15/M
    expect(spend.usd).toBeCloseTo(0.006 + 0.0024 + 0.0015, 6);
  });

  test("writes are stored beside reads, and priced at a premium", () => {
    const store = new UsageStore(db, () => clock);

    store.record({
      agentId: "nouva",
      model: "claude-sonnet-4-6",
      provider: "nougate",
      inputTokens: 60_000,
      outputTokens: 100,
      cachedInputTokens: 50_000,
      cacheCreationInputTokens: 8_000,
    });

    const spend = store.since(0);
    expect(spend.cachedInputTokens).toBe(50_000);
    expect(spend.cacheCreationInputTokens).toBe(8_000);
    // 2k fresh at $3/M + 50k read at $0.30/M + 8k written at $3.75/M + 100 out at $15/M
    expect(spend.usd).toBeCloseTo(0.006 + 0.015 + 0.03 + 0.0015, 6);
  });

  test("reads alone cannot tell a healthy loop from a breakpoint nothing reads back", () => {
    // The reason the write column exists. Both requests move the same 8k through the cache, and on
    // the read column alone the second is indistinguishable from a cold start. The split is what
    // says one of them is paying a premium for entries no later request comes back for.
    const store = new UsageStore(db, () => clock);
    const base = { agentId: "nouva", model: "claude-sonnet-4-6", provider: "nougate" };

    const healthy = { ...base, inputTokens: 10_000, outputTokens: 10, cachedInputTokens: 8_000 };
    const surcharge = {
      ...base,
      inputTokens: 10_000,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 8_000,
    };
    store.record(healthy);
    store.record(surcharge);

    const spend = store.since(0);
    expect(spend.cachedInputTokens).toBe(8_000);
    expect(spend.cacheCreationInputTokens).toBe(8_000);

    // And the row that only writes costs more than the same request with no caching at all.
    const uncached = estimateCost(base.model, { inputTokens: 10_000, outputTokens: 10 });
    expect(estimateCost(base.model, surcharge).usd).toBeGreaterThan(uncached.usd);
    expect(estimateCost(base.model, healthy).usd).toBeLessThan(uncached.usd);
  });

  test("a provider that said nothing is stored as NULL, and sums as zero", () => {
    // NULL and 0 are different facts. Only the second one means the upstream had no hits; the first
    // means nobody asked it. Conflating them is how you conclude caching is broken when it is only
    // unreported.
    const store = new UsageStore(db, () => clock);

    store.record({
      agentId: "nouva",
      model: "claude-sonnet-4-6",
      provider: "nougate",
      inputTokens: 1_000,
      outputTokens: 10,
    });

    const row = db
      .prepare<{ cached: number | null; written: number | null }>(
        "SELECT cached_input_tokens AS cached, cache_creation_input_tokens AS written FROM llm_usage",
      )
      .get();
    expect(row?.cached).toBeNull();
    expect(row?.written).toBeNull();
    // And the aggregate still adds up, because SUM over NULL is not an error.
    expect(store.since(0).cachedInputTokens).toBe(0);
    expect(store.since(0).cacheCreationInputTokens).toBe(0);
  });
});

/**
 * `forSession` — what `/status` reads, and the distinction the nullable column exists for.
 *
 * "Every request reported zero cache hits" and "no request said anything about caching" mean
 * opposite things to somebody reading a bill, and `SUM` alone cannot tell them apart. Gemini behind
 * a gateway that never maps `cachedContentTokenCount` is the second case: it may well be caching,
 * and nothing here can see it. Reporting that as a confident zero is the failure.
 */
describe("what one session spent", () => {
  const session = { sessionId: "ses_1" };

  test("a provider that reports caching gets a number", () => {
    const s = store();
    s.record(entry({ ...session, inputTokens: 1000, outputTokens: 10, cachedInputTokens: 400 }));
    s.record(entry({ ...session, inputTokens: 2000, outputTokens: 20, cachedInputTokens: 1500 }));

    const usage = s.forSession("ses_1", 0);
    expect(usage.inputTokens).toBe(3000);
    expect(usage.outputTokens).toBe(30);
    expect(usage.cachedInputTokens).toBe(1900);
  });

  test("a provider that says nothing is null, not zero", () => {
    const s = store();
    s.record(entry({ ...session, inputTokens: 1000, outputTokens: 10 }));

    expect(s.forSession("ses_1", 0).cachedInputTokens).toBeNull();
  });

  test("and a genuine zero is still zero", () => {
    // The third state, and the one a `null`-or-number collapse would lose: the provider answered,
    // and the answer was that nothing hit the cache.
    const s = store();
    s.record(entry({ ...session, inputTokens: 1000, outputTokens: 10, cachedInputTokens: 0 }));

    expect(s.forSession("ses_1", 0).cachedInputTokens).toBe(0);
  });

  test("the last reply's input is the most recent request, not the largest", () => {
    // It predicts the next reply, so it has to be the newest row rather than a peak or an average.
    const s = store();
    s.record(entry({ ...session, inputTokens: 9000, outputTokens: 10 }));
    clock += 1000;
    s.record(entry({ ...session, inputTokens: 1200, outputTokens: 10 }));

    expect(s.forSession("ses_1", 0).lastInputTokens).toBe(1200);
  });

  test("another session's rows are not in it", () => {
    const s = store();
    s.record(entry({ ...session, inputTokens: 1000, outputTokens: 10 }));
    s.record(entry({ sessionId: "ses_2", inputTokens: 5000, outputTokens: 50 }));

    expect(s.forSession("ses_1", 0).inputTokens).toBe(1000);
  });
});

/**
 * A coding CLI's prompts (0.8.8): what it reported over ACP is recorded, so `/status` and a turn's record say it — and
 * the daily caps do not count it, the CLI being on its own account. A CLI working
 * for hours reaches millions of tokens; counted, it stopped every agent on the daemon's own models at the token cap.
 */
describe("a coding CLI's prompts", () => {
  const cli = (over: Partial<Parameters<UsageStore["record"]>[0]> = {}) =>
    entry({ sessionId: "ses_cli", model: "claude-sonnet-4-5", provider: "claude-code", inputTokens: 900_000, outputTokens: 40_000, cachedInputTokens: 800_000, cli: true, ...over });

  test("are recorded as the CLI's, at no cost — never priced from the list, though the model has a price", () => {
    const s = store();
    s.record(cli());
    const row = db.prepare<{ basis: string; estimated_cost_usd: number | null; provider: string }>("SELECT basis, estimated_cost_usd, provider FROM llm_usage").get();
    expect(row).toEqual({ basis: "cli", estimated_cost_usd: 0, provider: "claude-code" });
  });

  test("count in the conversation's usage, which `/status` reads", () => {
    const s = store();
    s.record(cli());
    expect(s.forSession("ses_cli", 0)).toMatchObject({ inputTokens: 900_000, outputTokens: 40_000, cachedInputTokens: 800_000 });
  });

  test("…and `/status` reads them alone: a turn the agent's own model answered is no CLI's (Nox's review)", () => {
    const s = store();
    s.record(cli());
    s.record(entry({ sessionId: "ses_cli", inputTokens: 5_000, outputTokens: 50 }));
    expect(s.forSession("ses_cli", 0, true)).toMatchObject({ inputTokens: 900_000, outputTokens: 40_000 });
    expect(s.forSession("ses_cli", 0)).toMatchObject({ inputTokens: 905_000, outputTokens: 40_050 });
  });

  test("are outside what the daily caps read, and what a spend alert names", () => {
    const s = store();
    s.record(cli());
    s.record(entry({ inputTokens: 1_000, outputTokens: 100 }));
    expect(s.since(0)).toMatchObject({ requests: 1, inputTokens: 1_000, outputTokens: 100, unpricedRequests: 0 });
    expect(s.since(0, "nouva").requests).toBe(1);
    expect(s.spenders(0)).toEqual([expect.objectContaining({ agentId: "nouva", tokens: 1_100 })]);
  });

  test("…nor in what a mission adds for its helpers: its turn's outcome counted the CLI's total already", () => {
    const s = store();
    s.record(cli({ purpose: "turn" }));
    expect(s.helperTokens("ses_cli", 0)).toBe(0);
  });

  test("…and a row from before, with no basis, still counts", () => {
    const s = store();
    s.record(entry({ inputTokens: 1_000, outputTokens: 0 }));
    db.prepare("UPDATE llm_usage SET basis = NULL").run();
    expect(s.since(0).requests).toBe(1);
  });
});
