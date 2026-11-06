/**
 * Helper models' trouble, said where an operator looks (`llm/helper-trouble.ts`): `/health`'s issues — the Overview's
 * warnings — and `nouride doctor`.
 *
 * On the box (2026-10-21) every compaction failed for an afternoon on a pass model that had gone away, and the only
 * trace was a `warn` per failure in the journal. These run the real writers — a compaction that fails, a fallback — into
 * the real log table, and read back what they wrote.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { addLogSink, createLogger, LLMError, type ChatMessage, type LLMProvider } from "@nouride/shared";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { LogStore } from "@/commons/logs.store.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { compactHistory, resetCompactionBreaker } from "@/modules/llm/summarize.ts";
import { helperTrouble } from "@/modules/llm/helper-trouble.ts";
import { orOwnModel } from "@/modules/llm/helper-model.ts";
import { buildHealth } from "@/modules/web/health.ts";
import { healthIssues, helperChecks } from "@/cli/commands/doctor-checks.ts";
import { tempDir } from "../helpers.ts";

let db: SqliteDb;
let dataDir: string;
let logs: LogStore | undefined;
// One sink for the file, written to the test's store while it has one.
addLogSink((entry) => logs?.sink(entry));

beforeEach(async () => {
  resetCompactionBreaker();
  dataDir = tempDir("helper-trouble");
  db = await openAndMigrate(join(dataDir, "test.db"));
  logs = new LogStore(db);
});

afterEach(() => {
  logs?.stop();
  logs = undefined;
  db.close();
  removePath(dataDir);
});

const NO_ACCESS = '404 Not Found: {"error":{"message":"No account has access to \\"trouble-model\\""}}';
const PASS = { memory: { passModel: "trouble-model" }, llm: { context: {} } };

function provider(fails?: LLMError): LLMProvider {
  return {
    kind: "openai",
    baseUrl: "https://x.test",
    async chat(params: { model: string }) {
      if (fails) throw fails;
      return { text: "Headline: x\nnotes", toolCalls: [], stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, model: params.model };
    },
    async *stream() {
      throw new Error("not used");
    },
  } as unknown as LLMProvider;
}

const history = (): ChatMessage[] =>
  Array.from({ length: 10 }, (_, n) => [
    { role: "user" as const, content: `q ${n} ${"x".repeat(2_000)}`, timestamp: n },
    { role: "assistant" as const, content: `a ${n} ${"y".repeat(2_000)}`, timestamp: n },
  ]).flat();

const compact = (with_: LLMProvider, key: string) => compactHistory(history(), { provider: with_, model: "trouble-model", maxTokens: 10_000, limit: 10_000, key });

const read = (config = PASS, now = Date.now()) => {
  logs!.flush();
  return helperTrouble(logs!, config, now);
};

describe("what compaction and the memory pass ran into, read back", () => {
  test("a compaction that failed: how often, on which model, the last error, and the setting to change", async () => {
    await compact(provider(new LLMError(NO_ACCESS, 404)), "a");
    await compact(provider(new LLMError(NO_ACCESS, 404)), "b");

    const [trouble, ...rest] = read();
    expect(rest).toEqual([]);
    expect(trouble).toMatchObject({ job: "compaction", count: 2, model: "trouble-model", last: expect.stringContaining("No account has access") });
    expect(trouble!.fix).toContain("[memory] pass_model");
    expect(trouble!.summary).toBe("compaction failed 2 time(s) in the last 24 h, the last on trouble-model");
  });

  test("a helper the agents' own model stood in for, by the line the fallback writes", async () => {
    const fallback = orOwnModel(
      { profile: "nougate", model: "trouble-model", provider: provider(new LLMError(NO_ACCESS, 404)) },
      { profile: "anthropic", model: "own-model", provider: () => provider() },
      "compaction",
    );
    await compact(fallback, "c");

    expect(read()).toEqual([expect.objectContaining({ job: "fallback", count: 1, model: "nougate/trouble-model", last: expect.stringContaining("No account has access") })]);
  });

  test("nothing when nothing failed, or only longer than a day ago", async () => {
    await compact(provider(), "d");
    expect(read()).toEqual([]);

    await compact(provider(new LLMError(NO_ACCESS, 404)), "e");
    expect(read(PASS, Date.now() + 25 * 60 * 60_000)).toEqual([]);
  });

  test("the fix names the setting that chose the model, and none once none does", async () => {
    await compact(provider(new LLMError(NO_ACCESS, 404)), "f");
    expect(read({ memory: { passModel: "" }, llm: { context: { summaryModel: "trouble-model" } } })[0]!.fix).toContain("[llm.context] summary_model");
    expect(read({ memory: { passModel: "" }, llm: { context: {} } })[0]!.fix).toContain("the agent's own model failed here");
  });

  test("a failure as 0.8.15 and older logged it, with a dash in its words, is still counted", () => {
    // Its words changed with 0.8.16: a failure logged in the day before the upgrade is still that day's.
    createLogger("llm.summarize").warn("could not summarize history — keeping it as it was", { model: "trouble-model", error: `LLMError: ${NO_ACCESS}` });
    expect(read()).toEqual([expect.objectContaining({ job: "compaction", count: 1, model: "trouble-model" })]);
  });

  test("a line from before the model was logged is put on the model today's settings route the job to", () => {
    // Live, on the first boot of this build: every failure was `pass_model`'s, logged without a model, and doctor
    // called it "the agent's own model" — the wrong setting to look at.
    createLogger("llm.summarize").warn("could not summarize history — keeping it as it was", { error: `LLMError: ${NO_ACCESS}` });
    const [found] = read();
    expect(found!.model).toContain("trouble-model (probably");
    expect(found!.fix).toContain("[memory] pass_model");
  });
});

describe("trouble that is over is not said", () => {
  // Live (2026-10-21): pass_model was changed and the pass had filed everything, yet the Overview listed all three
  // failures for a day — and blamed the new model for the old one's.
  test("a compaction that worked since its last failure clears it", async () => {
    await compact(provider(new LLMError(NO_ACCESS, 404)), "r1");
    expect(read().some((t) => t.job === "compaction")).toBe(true);
    // Pruning tool output asks no model: it says nothing about whether the summarizer works again.
    createLogger("llm.summarize").info("history compacted", { pruned: 4, before: 900, after: 400 });
    expect(read().some((t) => t.job === "compaction")).toBe(true);
    createLogger("llm.summarize").info("history compacted", { turns: 2 });
    expect(read().some((t) => t.job === "compaction")).toBe(false);
  });

  test("a memory pass that finished since its model failed clears it", () => {
    createLogger("memory.pass").warn("memory pass call failed", { model: "trouble-model", error: NO_ACCESS });
    expect(read().some((t) => t.job === "memory pass")).toBe(true);
    // A pass whose calls all failed is "done" too — nothing filed, conversations still waiting.
    createLogger("memory.pass").info("memory pass done", { filed: 0, failed: 0, waiting: 0 });
    expect(read().some((t) => t.job === "memory pass")).toBe(true);
    createLogger("memory.pass").info("memory pass done", { filed: 3, failed: 0, waiting: 0 });
    expect(read().some((t) => t.job === "memory pass")).toBe(false);
  });

  test("a fallback is over once its helper answers again — not when another helper does", async () => {
    // Live (2026-10-21): the profile was saved with the wrong kind for nineteen seconds, the pass fell back once, and the
    // Overview said the pass model could not answer until the next evening.
    const state = { fails: true };
    const helper = (model: string) =>
      orOwnModel(
        { profile: "nougate", model, provider: { ...provider(), chat: (params: { model: string }) => (state.fails ? Promise.reject(new LLMError(NO_ACCESS, 404)) : provider().chat(params as never)) } as LLMProvider },
        { profile: "anthropic", model: "own-model", provider: () => provider() },
        "compaction",
      );
    // A model of its own: the fallback line is said once an hour per helper, and other tests here use theirs.
    const named = { memory: { passModel: "answers-again-model" }, llm: { context: { summaryModel: "another-model" } } };
    const fallback = () => read(named).some((t) => t.job === "fallback");
    await compact(helper("answers-again-model"), "r3");
    expect(fallback()).toBe(true);
    state.fails = false;
    await compact(helper("another-model"), "r4");
    expect(fallback()).toBe(true);
    await compact(helper("answers-again-model"), "r5");
    expect(fallback()).toBe(false);
  });

  test("a fallback for a helper the settings no longer name is over; one they still name is not", () => {
    createLogger("llm.helper").warn("helper model trouble-model unavailable — used the agent's own", { helper_model: "trouble-model", helper_profile: "p", reason: NO_ACCESS });
    expect(read().some((t) => t.job === "fallback")).toBe(true);
    expect(read({ memory: { passModel: "a-new-model" }, llm: { context: {} } }).some((t) => t.job === "fallback")).toBe(false);
  });
});

describe("said where an operator looks", () => {
  test("/health names it, without the provider's words — anybody who reaches the port reads it", async () => {
    await compact(provider(new LLMError(NO_ACCESS, 404)), "g");
    const trouble = read();
    const health = buildHealth({
      gateways: new Map(),
      db: { walSizeBytes: () => 0 },
      config: { daemon: { dataDir: "/tmp/nr-health" } },
      providerErrors: new Map(),
      status: "running",
      startedAt: Date.now(),
      agentCount: 1,
      helpers: () => trouble,
    } as unknown as DaemonContext);

    expect(health.payload.issues).toEqual([expect.stringMatching(/^compaction failed in the last 24 h on trouble-model, .*; set \[memory\] pass_model/)]);
    expect(health.payload.issues!.join("\n")).not.toContain("No account");
    expect(health.payload.status).toBe("ok");
  });

  test("doctor says each with its count, the last error and the fix — and nothing when there is none", async () => {
    await compact(provider(new LLMError(NO_ACCESS, 404)), "h");
    const now = Date.now() + 5 * 60_000;
    const [check, ...rest] = helperChecks(read(), now);
    expect(rest).toEqual([]);
    expect(check).toMatchObject({ level: "warn", message: "compaction failed 1 time(s) in the last 24 h, the last on trouble-model" });
    expect(check!.hint).toMatch(/^The last, 5 min ago: .*No account has access.*; set \[memory\] pass_model/);

    expect(helperChecks([], now)).toEqual([]);
  });

  test("doctor says it once: the same line from `/health` is left out of its issues", async () => {
    await compact(provider(new LLMError(NO_ACCESS, 404)), "i");
    const trouble = read();
    const issues = healthIssues([trouble[0]!.issue, "telegram:nouva: reconnecting"], trouble);
    expect(issues.map((check) => check.message)).toEqual(["health: telegram:nouva: reconnecting"]);
  });
});

describe("a helper key naming a tier (0.8.0)", () => {
  test("a fallback from the tier's model is still the setting's trouble, and the fix names the tier", () => {
    createLogger("llm.helper").warn("helper model m-tier-small unavailable — used the agent's own", { helper_model: "m-tier-small", helper_profile: "p", reason: NO_ACCESS });
    const tiered = { memory: { passModel: "small" }, llm: { context: {}, defaults: { provider: "p", smallModel: "m-tier-small" } } };
    const [found] = read(tiered).filter((t) => t.job === "fallback");
    expect(found?.fix).toContain('[memory] pass_model = "small" reaches it as the small tier: set the small model');
    // Once the tier names another model, the old one's trouble is over.
    const moved = { memory: { passModel: "small" }, llm: { context: {}, defaults: { provider: "p", smallModel: "m-new" } } };
    expect(read(moved).some((t) => t.job === "fallback")).toBe(false);
  });
});
