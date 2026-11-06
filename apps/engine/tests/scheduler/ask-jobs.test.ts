/**
 * An ask that moved to the background is a job (0.7.19) — the job table's half of it.
 *
 * The row is the asking agent's, with the asked agent and the task kept in it; it counts with that agent's helpers
 * against the one limit; it is listed and stopped like any job; `job_max_ms` bounds the whole of it, from when it was
 * asked — it waited in the foreground first; its log is masked of both agents' credentials; and a restart closes it as
 * interrupted, still an ask.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { JobDeadlines } from "@/modules/jobs/deadline.ts";
import { JobStore, type JobCompletion } from "@/modules/jobs/jobs.store.ts";
import type { HelperOutcome, RunningHelper, StartAsk } from "@/modules/jobs/helper-jobs.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { tempDir } from "../helpers.ts";
import { eventually } from "../wait.ts";

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
  dir = tempDir("ask-jobs");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  removePath(dir);
});

/** The deadlines a store arms, with how long each was armed for. */
class Recorded extends JobDeadlines {
  readonly armed: number[] = [];
  override arm(id: string, ms: number, onExpire: () => void): void {
    this.armed.push(ms);
    super.arm(id, ms, onExpire);
  }
}

function store(options: { maxMs?: number; secrets?: Record<string, Record<string, string>>; deadlines?: JobDeadlines } = {}) {
  return new JobStore({
    db,
    logDir: join(dir, "logs"),
    maxConcurrentPerAgent: 1,
    ...(options.maxMs ? { maxMs: () => options.maxMs! } : {}),
    ...(options.secrets ? { secrets: (agentId: string) => options.secrets![agentId] ?? {} } : {}),
    ...(options.deadlines ? { deadlines: options.deadlines } : {}),
  });
}

const handoff = (summary: string, over: Partial<SubAgentHandoff> = {}): SubAgentHandoff => ({
  agentId: "nox",
  status: "success",
  summary,
  files: [],
  spills: [],
  metrics: { toolCalls: 2, steps: 3, ms: 75_000 },
  ...over,
});

/** The asked agent's turn, adopted: ends when the test says, or on its abort. */
function held() {
  let finish: (outcome: HelperOutcome) => void = () => {};
  let given: RunningHelper | undefined;
  const run = (job: RunningHelper) =>
    new Promise<HelperOutcome>((resolve) => {
      given = job;
      finish = resolve;
      job.signal.addEventListener("abort", () => resolve({ report: handoff("", { status: "incomplete", reason: "it was stopped before it finished" }) }), { once: true });
    });
  return { run, finish: (outcome: HelperOutcome) => finish(outcome), get job() { return given!; } };
}

const TASK = "Deploy v2 to staging, then check it answers on /health.";

function ask(s: JobStore, over: Partial<StartAsk> = {}) {
  return s.startAsk({
    agentId: "nouva",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    cwd: dir,
    ask: { agent: "nox", task: TASK },
    senderId: "u1",
    turnId: "turn_1",
    limit: 2,
    startedAt: Date.now() - 60_000,
    run: held().run,
    ...over,
  });
}

function completions(s: JobStore): JobCompletion[] {
  const seen: JobCompletion[] = [];
  s.setOnComplete((completion) => seen.push(completion));
  return seen;
}

describe("an ask's row", () => {
  test("is the asking agent's, keeps who was asked and what, and starts when it was asked", () => {
    const s = store();
    const asked = Date.now() - 60_000;
    const started = ask(s, { startedAt: asked });
    if (!("started" in started)) throw new Error("refused");
    expect(started.started).toMatchObject({ kind: "ask", agentId: "nouva", status: "running", pid: null, turnId: "turn_1", senderId: "u1", brief: null, ask: { agent: "nox", task: TASK } });
    expect(started.started.command).toBe(`ask nox: ${TASK}`);
    expect(started.started.startedAt).toBe(asked);
    // Read back as it was written: one column, by the row's kind.
    expect(s.get(started.started.id)).toMatchObject({ kind: "ask", ask: { agent: "nox", task: TASK }, brief: null });
    expect(s.listSnapshots({ agentId: "nouva" })[0]).toMatchObject({ kind: "ask", processAlive: true });
    expect(s.backgroundTurns("nouva").map((job) => job.id)).toEqual([started.started.id]);
  });

  test("ends with the asked agent's handoff, and wakes the asking agent's chat with it", async () => {
    const s = store();
    const seen = completions(s);
    const turn = held();
    const started = ask(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    turn.finish({ report: handoff("Deployed; /health answers 200.") });
    await eventually(() => seen.length === 1);
    expect(seen[0]!.job).toMatchObject({ id: started.started.id, kind: "ask", status: "succeeded", agentId: "nouva", report: { agentId: "nox", summary: "Deployed; /health answers 200." } });
  });
});

describe("the one limit", () => {
  test("counts an ask with the helpers: a helper over it is refused naming the ask, and an ask over it naming the helper", () => {
    const s = store();
    expect("started" in ask(s, { limit: 1 })).toBe(true);
    const helper = s.startHelper({
      agentId: "nouva",
      gatewayId: "telegram:main",
      chatId: "chat-1",
      cwd: dir,
      brief: { goal: "Check the docs links", context: "The docs are in /srv/docs.", deliverable: "Broken links." },
      senderId: "u1",
      limit: 1,
      run: held().run,
    });
    expect(helper).toMatchObject({ refused: "limit", limit: 1 });
    if (!("refused" in helper) || helper.refused !== "limit") throw new Error("not refused");
    expect(helper.running.map((job) => job.kind)).toEqual(["ask"]);
    expect(ask(s, { limit: 1, ask: { agent: "nera", task: "Rotate the logs." } })).toMatchObject({ refused: "limit", limit: 1 });
    // Another agent's are its own.
    expect("started" in ask(s, { limit: 1, agentId: "nox", ask: { agent: "nera", task: "Rotate the logs." } })).toBe(true);
  });
});

describe("stopping one", () => {
  test("`nouride jobs kill` aborts the asked agent's turn, and it is recorded `killed`", async () => {
    const s = store();
    const seen = completions(s);
    const turn = held();
    const started = ask(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    expect(s.kill(started.started.id, "cli")).toBe(true);
    expect(turn.job.signal.reason).toBe("stopped");
    await eventually(() => seen.length === 1);
    expect(seen[0]!.job.status).toBe("killed");
  });

  test("`job_max_ms` bounds the whole ask — the wait in the foreground counts — and says the limit stopped it", async () => {
    const deadlines = new Recorded();
    const s = store({ maxMs: 400, deadlines });
    const seen = completions(s);
    const turn = held();
    ask(s, { run: turn.run, startedAt: Date.now() - 300 });
    // Armed for what is left of the limit, not the whole of it again.
    expect(deadlines.armed).toHaveLength(1);
    expect(deadlines.armed[0]).toBeGreaterThan(0);
    expect(deadlines.armed[0]).toBeLessThanOrEqual(100);
    await eventually(() => seen.length === 1);
    expect(turn.job.signal.reason).toBe("deadline");
    expect(seen[0]!.job.status).toBe("killed");
    expect(seen[0]!.stop).toEqual({ by: "deadline", limitMs: 400 });
  });
});

describe("its log", () => {
  test("is the asked agent's steps, masked of both agents' credentials", async () => {
    const s = store({ secrets: { nouva: { NOUVA_TOKEN: "nouva-secret-111" }, nox: { NOX_TOKEN: "nox-secret-222" } } });
    const seen = completions(s);
    const turn = held();
    const started = ask(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    turn.job.log("→ exec: deploy --token nox-secret-222 --as nouva-secret-111");
    turn.finish({ report: handoff("done") });
    await eventually(() => seen.length === 1);
    const text = readFileSync(started.started.logPath, "utf8");
    expect(text).toContain("started: nouva asked nox: Deploy v2 to staging");
    expect(text).toContain("→ exec: deploy --token");
    expect(text).not.toContain("nox-secret-222");
    expect(text).not.toContain("nouva-secret-111");
  });
});

describe("a restart", () => {
  test("closes it as interrupted, still an ask, with who was asked and what", async () => {
    const s = store();
    const turn = held();
    const started = ask(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    await s.killAll();
    const orphaned = store().interruptOrphaned();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toMatchObject({ id: started.started.id, kind: "ask", status: "interrupted", ask: { agent: "nox", task: TASK } });
  });
});
