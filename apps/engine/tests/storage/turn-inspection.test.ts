/**
 * One turn, read whole by its id — `069_baseline.sql` and `turns/inspection.store.ts`.
 *
 * Usage knew the session and the audit log the chat, so two turns a minute apart in one conversation shared every
 * row and a turn's cost could only be guessed from timestamps. Each case is a way the join must hold: another turn's
 * calls kept out, an unpriced call never counted as free, retries counted, an id shortened only when it is unambiguous.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { removePath, type SqliteDb } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { openAndMigrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { LogStore } from "@/commons/logs.store.ts";
import { UsageStore, reportedCounts } from "@/modules/llm/usage.store.ts";
import { TurnInspector } from "@/modules/turns/inspection.store.ts";
import { servedBy } from "../../../cli/src/commands/turns.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { tempDir, turnStore } from "../helpers.ts";

/** A tool call's step and its result, as the contract has them — the stores in these tests are strict. */
const CALL = { callId: "call_1", name: "exec" };
const DONE = { callId: "call_1", name: "exec", error: false };

let dir: string;
let db: SqliteDb;
beforeEach(async () => {
  dir = tempDir("inspect");
  db = await openAndMigrate(join(dir, "test.db"));
});
afterEach(() => {
  db.close();
  removePath(dir);
});

const key = { sessionId: "ses_1", agentId: "ren", gatewayId: "web:dashboard", chatId: "web-1" };
const PRICED = "claude-sonnet-4-5";

function turnWith(prompt: string, steps = true): string {
  const turns = turnStore(db);
  const id = turns.begin({ ...key, prompt });
  if (steps) {
    turns.step(id, "tool", "glob *", CALL);
    turns.step(id, "tool_done", "glob 2 found · 6ms", DONE);
  }
  turns.finish(id, { status: "done", reply: "DeepSeek vs Luna." });
  return id;
}

/** A clock a second apart per call, so calls made in one millisecond still read back in the order they were made. */
const ticking = () => {
  let at = 1_760_000_000_000;
  return () => (at += 1_000);
};

describe("a turn read whole", () => {
  test("its calls added up in the join — another turn's in the same conversation kept out", () => {
    const usage = new UsageStore(db, ticking());
    const mine = turnWith("lu bisa cari deepseek flash v4?");
    const other = turnWith("then haiku 5.5");
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", sessionId: "ses_1", turnId: mine, inputTokens: 1_000, outputTokens: 100, latencyMs: 1_200, attempts: 1 });
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", sessionId: "ses_1", turnId: mine, inputTokens: 2_000, outputTokens: 200, cachedInputTokens: 900, latencyMs: 4_200, attempts: 3 });
    // A helper's call, charged to the turn that started it; and a model nobody has priced.
    usage.record({ agentId: "helper", model: "some-local-model", provider: "ollama", turnId: mine, inputTokens: 500, outputTokens: 50, latencyMs: 800, attempts: 1 });
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", sessionId: "ses_1", turnId: other, inputTokens: 9_999, outputTokens: 999 });

    const seen = new TurnInspector(db).inspect(mine)!;

    expect(seen.turn).toMatchObject({ id: mine, prompt: "lu bisa cari deepseek flash v4?", status: "done", reply: "DeepSeek vs Luna." });
    expect(seen.totals).toMatchObject({ calls: 3, inputTokens: 3_500, outputTokens: 350, cachedInputTokens: 900, unpriced: 1, latencyMs: 6_200, slowestMs: 4_200, retries: 2 });
    // The priced calls only — the unpriced one is said, never counted as free.
    expect(seen.totals.usd).toBeGreaterThan(0);
    expect(seen.calls.map((call) => [call.agentId, call.attempts])).toEqual([["ren", 1], ["ren", 3], ["helper", 1]]);
    expect(seen.calls[2]!.usd).toBeNull();
    expect(seen.steps.map((step) => step.kind)).toEqual(["tool", "tool_done"]);
  });

  test("each call says why it ended, read from the index `turns show` reads — and nothing where the provider said nothing", () => {
    const usage = new UsageStore(db, ticking());
    const id = turnWith("write the whole report");
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", turnId: id, inputTokens: 90_000, outputTokens: 8_192, stopReason: "max_tokens" });
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", turnId: id, inputTokens: 90_000, outputTokens: 40, stopReason: "tool_calls" });
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", turnId: id, inputTokens: 1_000, outputTokens: 10 });

    expect(new TurnInspector(db).inspect(id)!.calls.map((call) => call.stopReason ?? null)).toEqual(["max_tokens", "tool_calls", null]);
    // Read from the covering index alone, as every column of a call is (`069_baseline.sql`).
    const plan = db
      .prepare<{ detail: string }>("EXPLAIN QUERY PLAN SELECT timestamp, stop_reason, purpose FROM llm_usage WHERE turn_id = ? ORDER BY timestamp")
      .all(id)
      .map((row) => row.detail)
      .join(" ");
    expect(plan).toContain("COVERING INDEX idx_llm_usage_turn");
  });

  test("a turn with no recorded calls still reads, with nothing added up", () => {
    const id = turnWith("hello");

    expect(new TurnInspector(db).inspect(id)!.totals).toEqual({
      calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, usd: 0, unpriced: 0, latencyMs: 0, slowestMs: 0, retries: 0,
    });
  });

  test("its tool calls, from the audit log, in order — and what an error logged during it said", () => {
    const id = turnWith("run it");
    const audit = new AuditLog(db, (() => { let t = 1_000; return () => (t += 10); })());
    audit.record({ action: "tool_exec", agentId: "ren", turnId: id, details: { tool: "glob", args: { pattern: "*" }, ms: 6 } });
    audit.record({ action: "tool_exec", agentId: "ren", details: { tool: "exec", note: "another turn's, or none" } });
    audit.logSink({ timestamp: new Date().toISOString(), level: "error", component: "tools.mcp", message: "server went away", turn_id: id });
    audit.flush();

    const seen = new TurnInspector(db).inspect(id)!;

    expect(seen.audit.map((entry) => entry.action)).toEqual(["tool_exec", "error"]);
    expect(seen.audit[0]!.details).toMatchObject({ tool: "glob", args: { pattern: "*" } });
  });

  test("a shortened id finds the one turn it names, and two turns sharing it answer nothing", () => {
    const id = turnWith("first", false);
    const inspector = new TurnInspector(db);
    expect(inspector.inspect(id.slice(0, 12))?.turn.id).toBe(id);

    db.prepare("UPDATE turn_records SET id = 'turn_aaaa1' WHERE id = ?").run(id);
    db.prepare("UPDATE turn_records SET id = 'turn_aaaa2' WHERE id = ?").run(turnWith("second", false));
    expect(inspector.inspect("turn_aaaa")).toBeNull();
    expect(inspector.inspect("turn_aaaa2")?.turn.prompt).toBe("second");
    expect(inspector.inspect("nope")).toBeNull();
  });

  test("the newest turns, with what each cost — one agent's when named", () => {
    const usage = new UsageStore(db);
    const older = turnWith("older");
    const newer = turnWith("newer");
    db.prepare("UPDATE turn_records SET started_at = started_at - 60000 WHERE id = ?").run(older);
    db.prepare("UPDATE turn_records SET agent_id = 'nero' WHERE id = ?").run(older);
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", turnId: newer, inputTokens: 1_000, outputTokens: 100 });

    const inspector = new TurnInspector(db);
    const all = inspector.recent({ limit: 10 });
    expect(all.map((turn) => turn.prompt)).toEqual(["newer", "older"]);
    expect(all[0]!.calls).toBe(1);
    expect(all[0]!.usd).toBeGreaterThan(0);
    expect(all[1]!.usd).toBeNull();
    expect(inspector.recent({ limit: 10, agentId: "nero" }).map((turn) => turn.id)).toEqual([older]);
  });

  test("a turn that answered a person's edit carries its cause into the list, so the list can mark it; one typed as it is, none", () => {
    const turns = turnStore(db);
    const plain = turnWith("typed");
    const edited = turns.begin({ ...key, prompt: "edited", messageId: "41:edited:9", cause: { via: "edit", of: "41" } });
    turns.finish(edited, { status: "done", reply: "ok" });

    const listed = new TurnInspector(db).recent({ limit: 10 });
    expect(listed.find((turn) => turn.id === edited)?.cause).toEqual({ via: "edit", of: "41" });
    expect(listed.find((turn) => turn.id === plain)).not.toHaveProperty("cause");
  });
});

/**
 * Who answered a call, when a gateway in between said (`069_baseline.sql`): kept on the row, read back with the
 * turn, and printed where it is news — the provider always, the model only when it is not the one asked for.
 */
describe("what each call was for", () => {
  test("its purpose, its billing and whether its counts were estimated, read back with the turn", () => {
    const usage = new UsageStore(db, ticking(), undefined, (provider) => (provider === "nougate" ? "included" : "metered"));
    const id = turnWith("long conversation");
    usage.record({ agentId: "ren", model: "gemini-3.8-flash", provider: "nougate", turnId: id, purpose: "compaction", inputTokens: 90_000, outputTokens: 900 });
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", turnId: id, purpose: "turn", inputTokens: 10, outputTokens: 2, estimated: true });

    const calls = new TurnInspector(db).inspect(id)!.calls;
    expect(calls.map(({ purpose, basis, estimated }) => ({ purpose, basis, estimated }))).toEqual([
      { purpose: "compaction", basis: "included", estimated: undefined },
      { purpose: "turn", basis: "list", estimated: true },
    ]);
  });
});

describe("who answered each call", () => {
  test("kept as the gateway said it, read back with the turn, and nothing on a call it did not", () => {
    const usage = new UsageStore(db, ticking());
    const id = turnWith("which provider?");
    usage.record({ agentId: "ren", model: "router:smart", provider: "nougate", turnId: id, inputTokens: 10, outputTokens: 2, ...reportedCounts({ inputTokens: 10, outputTokens: 2, upstream: { provider: "anthropic", model: "claude-sonnet-4-6", attempts: 2 } }) });
    usage.record({ agentId: "ren", model: PRICED, provider: "anthropic", turnId: id, inputTokens: 10, outputTokens: 2 });

    const calls = new TurnInspector(db).inspect(id)!.calls;
    expect(calls[0]?.upstream).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6", attempts: 2 });
    expect(calls[1]?.upstream).toBeUndefined();

    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain(servedBy(calls[0]!))).toBe(" via anthropic claude-sonnet-4-6, 2 tried");
    expect(plain(servedBy({ model: "claude-sonnet-4-6", upstream: { provider: "anthropic", model: "claude-sonnet-4-6", attempts: 1 } }))).toBe(" via anthropic");
    expect(servedBy(calls[1]!)).toBe("");
  });

  test("and on the stream, with the call", () => {
    const rows: { kind: string; data: Record<string, unknown> }[] = [];
    new UsageStore(db, ticking(), { append: (row) => rows.push(row as unknown as (typeof rows)[number]), batch: (fn) => fn() }).record({
      agentId: "ren", model: "router:smart", provider: "nougate", turnId: "turn_x", inputTokens: 10, outputTokens: 2,
      ...reportedCounts({ inputTokens: 10, outputTokens: 2, upstream: { provider: "anthropic" } }),
    });
    expect(rows[0]?.data.upstream).toEqual({ provider: "anthropic" });
  });
});

describe("what carries the turn's id", () => {
  test("a usage row: the turn, the call's latency and its attempts, stored as written", () => {
    new UsageStore(db).record({ agentId: "ren", model: PRICED, provider: "anthropic", turnId: "turn_x", inputTokens: 1, outputTokens: 1, ...reportedCounts({ inputTokens: 1, outputTokens: 1, latencyMs: 640, attempts: 2 }) });

    expect(db.prepare("SELECT turn_id, latency_ms, attempts FROM llm_usage").get()).toEqual({ turn_id: "turn_x", latency_ms: 640, attempts: 2 });
  });

  test("a tool call's audit row, through the wrapper every built-in tool runs in — when it throws, too", async () => {
    const recorded: { action: string; turnId?: string; chatId?: string }[] = [];
    const tools = createBuiltinTools({
      security: DEFAULT_CONFIG.security,
      audit: { record: (entry: { action: string; turnId?: string }) => void recorded.push(entry) } as never,
      sessionStatus: (() => { throw new Error("no session here"); }) as never,
      runSubagent: (() => undefined) as never,
      askAgent: { run: () => undefined } as never,
      harness: { registry: () => undefined, providers: () => [], agentsDir: "/tmp/agents" } as never,
      reflection: {} as never,
      skillHub: {} as never,
      sendFile: { send: () => undefined } as never,
      memory: {} as never,
      nourideCli: { installDir: "/srv/nouride", command: "nouride" },
      people: {} as never,
      web: { search: { backend: "brave", apiKey: "x" } } as never,
    });
    const ctx = { agentId: "ren", sessionId: "ses_1", chatId: "web-1", gatewayId: "web:dashboard", senderId: "u1", turnId: "turn_abc" } as unknown as ToolContext;

    await tools.get("session_status")!.execute({}, ctx).catch(() => undefined);

    expect(recorded).toEqual([expect.objectContaining({ action: "tool_exec", turnId: "turn_abc", chatId: "web-1" })]);
  });

  test("a log line: the turn's id kept in the stored tail, where the table has no column for it", () => {
    const logs = new LogStore(db);
    logs.sink({ timestamp: new Date().toISOString(), level: "info", component: "pipeline.turn", message: "turn complete", agent_id: "ren", turn_id: "turn_abc", data: { iterations: 2 } });
    logs.flush();

    const row = db.prepare<{ data: string }>("SELECT data FROM log_entries").get()!;
    expect(JSON.parse(row.data)).toEqual({ iterations: 2, turn_id: "turn_abc" });
  });
});
