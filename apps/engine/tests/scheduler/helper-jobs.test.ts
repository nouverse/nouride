/**
 * A helper working in the background is a job (0.7.15) — the job table's half of it.
 *
 * What a command's row already does has to hold for a helper's: it is listed, it is stopped by `nouride jobs kill`,
 * it is bounded by `job_max_ms`, a restart closes it as interrupted, and its end wakes its agent. And what is its own:
 * the brief it was given and the handoff it ended with travel with the row, and the per-agent limit refuses the one
 * over it with what is running.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { removePath, type SqliteDb } from "@nouride/runtime";
import { openAndMigrate } from "@/db/index.ts";
import { JobStore, type JobCompletion } from "@/modules/jobs/jobs.store.ts";
import type { HelperOutcome, RunningHelper, StartHelper } from "@/modules/jobs/helper-jobs.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { tempDir } from "../helpers.ts";
import { eventually } from "../wait.ts";

let dir: string;
let db: SqliteDb;

beforeEach(async () => {
  dir = tempDir("helper-jobs");
  db = await openAndMigrate(join(dir, "test.db"));
});

afterEach(() => {
  db.close();
  removePath(dir);
});

function store(options: { maxMs?: number; secrets?: Record<string, string> } = {}) {
  return new JobStore({
    db,
    logDir: join(dir, "logs"),
    maxConcurrentPerAgent: 1,
    ...(options.maxMs ? { maxMs: () => options.maxMs! } : {}),
    ...(options.secrets ? { secrets: () => options.secrets! } : {}),
  });
}

const handoff = (summary: string, over: Partial<SubAgentHandoff> = {}): SubAgentHandoff => ({
  agentId: "nouva",
  status: "success",
  summary,
  files: [],
  spills: [],
  metrics: { toolCalls: 3, steps: 2, ms: 1200 },
  ...over,
});

/** A helper whose turn ends when the test says, or on its abort — and how it was handed its job. */
function held() {
  let finish: (outcome: HelperOutcome) => void = () => {};
  let given: RunningHelper | undefined;
  const run = (job: RunningHelper) =>
    new Promise<HelperOutcome>((resolve) => {
      given = job;
      finish = resolve;
      job.signal.addEventListener("abort", () => resolve({ report: handoff("", { status: "incomplete", reason: "the turn was stopped before it finished" }) }), { once: true });
    });
  return { run, finish: (outcome: HelperOutcome) => finish(outcome), get job() { return given!; } };
}

function helper(s: JobStore, over: Partial<StartHelper> = {}) {
  return s.startHelper({
    agentId: "nouva",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    cwd: dir,
    brief: { goal: "Find every broken link on the docs site", context: "The site is in /srv/docs, built with `bun run build`.", deliverable: "A list of broken links with the page each is on." },
    senderId: "u1",
    turnId: "turn_1",
    limit: 2,
    run: held().run,
    ...over,
  });
}

function completions(s: JobStore): JobCompletion[] {
  const seen: JobCompletion[] = [];
  s.setOnComplete((completion) => seen.push(completion));
  return seen;
}

describe("a background helper's row", () => {
  test("is a running job of its own the moment it starts — its brief kept, its goal what the job list says", () => {
    const s = store();
    const started = helper(s);
    if (!("started" in started)) throw new Error("refused");
    const job = started.started;
    expect(job).toMatchObject({ kind: "helper", status: "running", pid: null, command: "helper: Find every broken link on the docs site", turnId: "turn_1", senderId: "u1" });
    expect(job.brief?.context).toContain("/srv/docs");
    expect(s.backgroundTurns("nouva").map((j) => j.id)).toEqual([job.id]);
    // Alive while this process runs its turn: it has no pid to ask about.
    expect(s.getSnapshot(job.id)?.processAlive).toBe(true);
  });

  test("ends with the handoff it was handed, and wakes its agent with it", async () => {
    const s = store();
    const seen = completions(s);
    const turn = held();
    const started = helper(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    turn.finish({ report: handoff("Found 3 broken links: /a, /b, /c.") });

    await eventually(() => seen.length === 1);
    expect(seen[0]!.job).toMatchObject({ id: started.started.id, status: "succeeded", kind: "helper" });
    expect(seen[0]!.job.report?.summary).toBe("Found 3 broken links: /a, /b, /c.");
    expect(s.get(started.started.id)?.report?.status).toBe("success");
    // Its log is its steps: what is left of it when the daemon dies under it.
    expect(seen[0]!.tail).toContain("started: Find every broken link");
    expect(seen[0]!.tail).toContain("Found 3 broken links");
  });

  test("one that did not finish its work is a failed job, its handoff saying why", async () => {
    const s = store();
    const seen = completions(s);
    const turn = held();
    helper(s, { run: turn.run });
    turn.finish({ report: handoff("I read two of the five pages.", { status: "requires_human", reason: "one tool call was not approved, so part of this was not done" }) });
    await eventually(() => seen.length === 1);
    expect(seen[0]!.job.status).toBe("failed");
    expect(seen[0]!.job.report?.reason).toContain("not approved");
  });

  test("a turn that throws is a helper that failed, with what it said", async () => {
    const s = store();
    const seen = completions(s);
    helper(s, { run: async () => Promise.reject(new Error("the provider refused the request")) });
    await eventually(() => seen.length === 1);
    expect(seen[0]!.job.status).toBe("failed");
    expect(seen[0]!.job.report).toMatchObject({ status: "failed", reason: "the provider refused the request" });
  });
});

describe("the limit", () => {
  test("refuses the one over it, with what is running", () => {
    const s = store();
    const first = helper(s, { limit: 1 });
    const second = helper(s, { limit: 1, brief: { goal: "Check the disk on every host", context: "Hosts are in ~/.ssh/config.", deliverable: "Free space per host." } });
    expect("started" in first).toBe(true);
    expect(second).toMatchObject({ refused: "limit", limit: 1 });
    if (!("refused" in second) || second.refused !== "limit") throw new Error("not refused for the limit");
    expect(second.running.map((job) => job.brief?.goal)).toEqual(["Find every broken link on the docs site"]);
    expect(s.backgroundTurns("nouva")).toHaveLength(1);
  });

  test("0 is off: nothing starts", () => {
    const s = store();
    expect(helper(s, { limit: 0 })).toMatchObject({ refused: "limit", limit: 0, running: [] });
  });

  test("is per agent", () => {
    const s = store();
    helper(s, { limit: 1 });
    expect("started" in helper(s, { limit: 1, agentId: "nox" })).toBe(true);
  });

  test("the same goal already running is not started twice", () => {
    const s = store();
    const first = helper(s);
    const again = helper(s, { brief: { goal: "find every broken link on the docs site.", context: "again", deliverable: "the list" } });
    if (!("started" in first)) throw new Error("refused");
    expect(again).toMatchObject({ refused: "duplicate" });
    if (!("refused" in again) || again.refused !== "duplicate") throw new Error("not refused as a duplicate");
    expect(again.running.id).toBe(first.started.id);
  });

  test("a helper does not count against the cap on commands, nor a command against the helpers' limit", async () => {
    const s = store();
    helper(s, { limit: 1 });
    // `maxConcurrentPerAgent: 1` — a running helper must not take the one command slot.
    const command = s.start({ agentId: "nouva", gatewayId: "telegram:main", chatId: "chat-1", argv: ["sleep", "2"], sandbox: { cwd: dir, env: { PATH: process.env.PATH ?? "" } } });
    expect(command.kind).toBe("command");
    expect(s.backgroundTurns("nouva")).toHaveLength(1);
    s.kill(command.id, "test");
  });
});

describe("stopping one", () => {
  test("`nouride jobs kill` aborts its turn, and it is recorded `killed`, whatever it handed back", async () => {
    const s = store();
    const seen = completions(s);
    const turn = held();
    const started = helper(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    expect(s.kill(started.started.id, "cli")).toBe(true);
    expect(turn.job.signal.aborted).toBe(true);
    await eventually(() => seen.length === 1);
    expect(seen[0]!.job.status).toBe("killed");
    expect(seen[0]!.stop).toBeUndefined();
  });

  test("`job_max_ms` stops it as it stops a command, and says the limit did", async () => {
    const s = store({ maxMs: 30 });
    const seen = completions(s);
    const turn = held();
    helper(s, { run: turn.run });
    await eventually(() => seen.length === 1);
    expect(turn.job.signal.reason).toBe("deadline");
    expect(seen[0]!.job.status).toBe("killed");
    expect(seen[0]!.stop).toEqual({ by: "deadline", limitMs: 30 });
  });
});

describe("a restart", () => {
  test("stopped at a step for a shutdown, it is left running with what it did — and the next boot closes it as interrupted", async () => {
    const s = store();
    const seen = completions(s);
    const turn = held();
    const started = helper(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    turn.finish({ report: handoff("Checked /a and /b; /c not yet.", { status: "incomplete" }), paused: true });
    await eventually(() => s.get(started.started.id)?.report !== null);
    expect(seen).toHaveLength(0);
    expect(s.get(started.started.id)?.status).toBe("running");

    // The next process over the same database.
    const next = store();
    const orphaned = next.interruptOrphaned();
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toMatchObject({ id: started.started.id, kind: "helper", status: "interrupted" });
    expect(orphaned[0]!.report?.summary).toBe("Checked /a and /b; /c not yet.");
    expect(orphaned[0]!.brief?.goal).toBe("Find every broken link on the docs site");
  });

  test("a shutdown stops every helper and writes nothing — the next boot closes them", async () => {
    const s = store();
    const seen = completions(s);
    const turn = held();
    const started = helper(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    expect(await s.killAll()).toBe(1);
    expect(turn.job.signal.reason).toBe("shutdown");
    expect(seen).toHaveLength(0);
    expect(s.get(started.started.id)?.status).toBe("running");
    expect(store().interruptOrphaned().map((job) => job.id)).toEqual([started.started.id]);
  });
});

describe("its log", () => {
  test("is its steps, masked of the agent's credentials", async () => {
    const s = store({ secrets: { API_TOKEN: "sekret-value-123" } });
    const seen = completions(s);
    const turn = held();
    const started = helper(s, { run: turn.run });
    if (!("started" in started)) throw new Error("refused");
    turn.job.log("→ exec: curl -H 'Authorization: sekret-value-123' https://api.test");
    turn.finish({ report: handoff("done") });
    await eventually(() => seen.length === 1);
    const text = readFileSync(started.started.logPath, "utf8");
    expect(text).toContain("→ exec: curl");
    expect(text).not.toContain("sekret-value-123");
  });
});
