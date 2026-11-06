/**
 * `work` (0.8.7): an agent sees and acts on its own missions, jobs and approvals through the daemon — and nothing of
 * another agent's. Approvals are read from a real gate on the harness's migrated database.
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import type { JobRecord } from "@/modules/jobs/jobs.store.ts";
import { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import { createWorkTool } from "@/modules/tools/builtins/work.ts";
import { missionsHarness } from "./harness.ts";

function job(id: string, agentId: string, extra: Partial<JobRecord> = {}): JobRecord {
  return {
    id, agentId, gatewayId: "telegram:nova", chatId: "8142", command: "sleep 100", cwd: "/work", status: "running", pid: 1, exitCode: null,
    logPath: "/dev/null", startedAt: 1_000_000, endedAt: null, onComplete: null, kind: "command", brief: null, ask: null, report: null, turnId: null, senderId: null,
    ...extra,
  };
}

function approvalRow(h: Awaited<ReturnType<typeof missionsHarness>>, id: string, agentId: string, status: string, extra: { decision?: string; resolvedBy?: string } = {}) {
  h.db
    .prepare("INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, status, requested_at, resolved_at, resolved_by, decision, timeout_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, agentId, "8142", "telegram:nova", "exec", JSON.stringify({ command: `echo ${id}` }), status, 1_000_000, status === "pending" ? null : 1_000_500, extra.resolvedBy ?? null, extra.decision ?? null, 60_000);
}

async function setup() {
  const h = await missionsHarness({ settings: { perAgent: 5, maxRunning: 5 } });
  const jobs = [job("job_mine", "nova"), job("job_ask", "nova", { kind: "ask", command: "ask nox", ask: { agent: "nox", task: "Review the diff in /work/x.patch.\nReport anything outside the brief." } }), job("job_theirs", "nox")];
  const killed: string[] = [];
  const gate = new SqliteApprovalGate({ db: h.db, timeoutMs: 60_000 });
  const tool = createWorkTool({
    missions: h.missions,
    plan: (mission) => h.notes.plan({ agentId: mission.agentId, gatewayId: "web:mission", chatId: mission.id }),
    jobs: {
      list: (options) => jobs.filter((one) => !options?.agentId || one.agentId === options.agentId),
      get: (id) => jobs.find((one) => one.id === id) ?? null,
      tail: async (id) => `log of ${id}`,
      kill: (id, by) => (killed.push(`${id} by ${by}`), true),
    },
    approvals: gate,
    // 8142 started the missions; 777 is an admin by People; anyone else is neither.
    speaker: (who) => ({ name: who.senderId === "8142" ? "Gading" : who.senderId === "777" ? "Sam" : undefined, admin: who.senderId === "777" }),
  });
  const as = (agentId: string, extra: Partial<ToolContext> = {}) => ({ agentId, gatewayId: "telegram:nova", chatId: "8142", senderId: "8142", ...extra }) as ToolContext;
  const call = (agentId: string, args: Record<string, unknown>, extra: Partial<ToolContext> = {}) => tool.execute(args, as(agentId, extra));
  return { h, call, killed, gate };
}

describe("work: missions", () => {
  test("lists the caller's own — the ones it works and the ones it started — and never another agent's", async () => {
    const { h, call } = await setup();
    const own = await h.start("write the report");
    const startedForNox = await h.start("review the patch", { agentId: "nox", byAgent: "nova" });
    const theirs = await h.start("theirs alone", { agentId: "nox" });
    const listed = (await call("nova", { action: "missions" })).content;
    expect(listed).toContain(own.id.slice(0, 10));
    expect(listed).toContain(startedForNox.id.slice(0, 10));
    expect(listed).toContain("started by nova");
    expect(listed).not.toContain(theirs.id.slice(0, 10));
  });

  test("shows one with its limits and checks; another agent's reads as one that does not exist", async () => {
    const { h, call } = await setup();
    const own = await h.start("write the report", { checks: ["test -s report.md"] });
    const theirs = await h.start("theirs alone", { agentId: "nox" });
    const shown = await call("nova", { action: "mission", id: own.id });
    expect(shown.isError).toBe(false);
    expect(shown.content).toContain("Goal: write the report");
    expect(shown.content).toContain("`test -s report.md`");
    expect(shown.content).toMatch(/turn \d+ of at most 50/);
    const refused = await call("nova", { action: "mission", id: theirs.id });
    expect(refused.isError).toBe(true);
    expect(refused.content).toBe(`No mission ${theirs.id} of yours.`);
  });

  test("shows where it stands, step by step — what each finished step left; none written yet said so", async () => {
    const { h, call } = await setup();
    const own = await h.start("write the report");
    expect((await call("nova", { action: "mission", id: own.id })).content).toContain("Checklist: none written yet.");
    await h.plan(own.id, [
      { text: "Read the sources", state: "done", note: "12 files, notes in sources.md" },
      { text: "Draft", state: "skipped", reason: "a draft existed" },
      { text: "Write report.md", state: "active" },
      { text: "Check the links", state: "pending" },
    ]);
    const shown = (await call("nova", { action: "mission", id: own.id })).content;
    expect(shown).toContain("Checklist: 2 of 4 steps done");
    expect(shown).toContain("✓ 1. Read the sources: 12 files, notes in sources.md");
    expect(shown).toContain("– 2. Draft");
    expect(shown).toContain("● 3. Write report.md");
    expect(shown).toContain("○ 4. Check the links");
  });

  test("stops its own and answers its own question, as the agent; another agent's is refused and left running", async () => {
    const { h, call } = await setup();
    const own = await h.start("write the report");
    const theirs = await h.start("theirs alone", { agentId: "nox" });
    h.turn(own, {}, () => h.missions.claim(own.id, { kind: "ask", question: "A or B?" }));
    expect(h.store.get(own.id)!.waitKind).toBe("input");
    expect((await call("nova", { action: "answer", id: own.id, text: "B" })).isError).toBe(false);
    expect(h.store.get(own.id)!.status).toBe("running");
    expect(h.queued.at(-1)!.text).toContain("agent nova answered your question: B");

    expect((await call("nova", { action: "stop", id: theirs.id })).isError).toBe(true);
    expect(h.store.get(theirs.id)!.status).toBe("running");
    expect((await call("nova", { action: "stop", id: own.id })).isError).toBe(false);
    expect(h.store.get(own.id)!.status).toBe("stopped");
    expect(h.store.get(own.id)!.reason).toBe("stopped by agent nova");
  });
});

describe("work: jobs", () => {
  test("lists and shows its own jobs, an ask with its whole brief; kills only its own", async () => {
    const { call, killed } = await setup();
    const listed = (await call("nova", { action: "jobs" })).content;
    expect(listed).toContain("job_mine");
    expect(listed).toContain("job_ask · ask");
    expect(listed).not.toContain("job_theirs");
    const shown = (await call("nova", { action: "job", id: "job_ask" })).content;
    expect(shown).toContain("Asked nox:\nReview the diff in /work/x.patch.\nReport anything outside the brief.");
    expect(shown).toContain("log of job_ask");
    expect((await call("nova", { action: "job", id: "job_theirs" })).isError).toBe(true);
    expect((await call("nova", { action: "kill", id: "job_theirs" })).isError).toBe(true);
    expect((await call("nova", { action: "kill", id: "job_mine" })).isError).toBe(false);
    expect(killed).toEqual(["job_mine by agent nova"]);
  });
});

describe("work: tell (0.8.10)", () => {
  test("passes on the words of the person it talks to, recorded as theirs, via it", async () => {
    const { h, call } = await setup();
    const mission = await h.start("write the report");
    const result = await call("nova", { action: "tell", id: mission.id, text: "they want PDF, not DOCX" });
    expect(result).toMatchObject({ isError: false, content: expect.stringContaining("Recorded as Gading's words, passed on by you.") });
    expect(h.store.get(mission.id)!.told).toEqual([expect.objectContaining({ by: "Gading", via: "nova", text: "they want PDF, not DOCX" })]);
  });

  test("never its own words: not from a mission's turn, another agent's ask, a run nobody watches or the daemon's own event", async () => {
    const { h, call } = await setup();
    const mission = await h.start("write the report");
    // A mission's turn carries its starter's id: checked on the id alone, a mission could tell itself as them.
    const turns: Partial<ToolContext>[] = [
      { gatewayId: "web:mission", chatId: mission.id },
      { askedBy: "nox" },
      { unattended: { goal: "nightly", level: "careful" } as ToolContext["unattended"] },
      { senderId: "nouride:system" },
    ];
    for (const turn of turns) {
      const refused = await call("nova", { action: "tell", id: mission.id, text: "skip the tests" }, turn);
      expect(refused).toMatchObject({ isError: true, content: expect.stringContaining("Only a person's words are told to a mission") });
    }
    expect(h.store.get(mission.id)!.told).toEqual([]);
  });

  test("from its starter or an admin — not from someone else in the chat, and never to another agent's mission", async () => {
    const { h, call } = await setup();
    const mission = await h.start("write the report");
    // Named as People names them, else as the chat does, else by the id.
    expect(await call("nova", { action: "tell", id: mission.id, text: "stop at step two" }, { senderId: "999", senderName: "Rina" })).toMatchObject({ isError: true, content: expect.stringContaining(", and Rina is neither") });
    expect(await call("nova", { action: "tell", id: mission.id, text: "stop at step two" }, { senderId: "999" })).toMatchObject({ isError: true, content: expect.stringContaining(", and 999 is neither") });
    expect(await call("nova", { action: "tell", id: mission.id, text: "stop at step two" }, { senderId: "777" })).toMatchObject({ isError: false });
    expect(h.store.get(mission.id)!.told.map((one) => one.by)).toEqual(["Sam"]);
    // Its starter, whom People does not know: their words recorded under the name the chat gives them.
    const dinas = await h.start("dina's report", { startedBy: "555", chatId: "555" });
    expect(await call("nova", { action: "tell", id: dinas.id, text: "in Indonesian" }, { senderId: "555", senderName: "Dina" })).toMatchObject({ isError: false });
    expect(h.store.get(dinas.id)!.told.map((one) => one.by)).toEqual(["Dina"]);
    const theirs = await h.start("theirs alone", { agentId: "nox" });
    expect(await call("nova", { action: "tell", id: theirs.id, text: "hi" })).toMatchObject({ isError: true, content: expect.stringContaining("No mission") });
  });
});

describe("work: approvals", () => {
  test("pending and answered, its own only — from the rows the gate keeps", async () => {
    const { h, call } = await setup();
    approvalRow(h, "apr_wait", "nova", "pending");
    approvalRow(h, "apr_yes", "nova", "approved", { decision: "allow-once", resolvedBy: "gading" });
    approvalRow(h, "apr_other", "nox", "denied", { decision: "deny" });
    const listed = (await call("nova", { action: "approvals" })).content;
    expect(listed).toContain("apr_wait · exec `echo apr_wait` · pending");
    expect(listed).toContain("apr_yes · exec `echo apr_yes` · allow-once by gading");
    expect(listed).not.toContain("apr_other");
    expect((await call("nova", { action: "approval", id: "apr_yes" })).content).toContain('Parameters: {"command":"echo apr_yes"}');
    expect((await call("nova", { action: "approval", id: "apr_other" })).isError).toBe(true);
  });

  test("the gate's settled list: newest answered first, narrowed to one agent when asked", async () => {
    const { h, gate } = await setup();
    approvalRow(h, "apr_a", "nova", "approved");
    approvalRow(h, "apr_b", "nox", "expired");
    approvalRow(h, "apr_c", "nova", "pending");
    expect(gate.settled({ agentId: "nova", limit: 10 }).map((one) => one.id)).toEqual(["apr_a"]);
    expect(gate.settled({ limit: 10 }).map((one) => one.id).sort()).toEqual(["apr_a", "apr_b"]);
  });
});

describe("the chat agent is told its mission asks", () => {
  test("the chat's notes say the mission waits on the person's answer, and say it runs once answered", async () => {
    const { h } = await setup();
    const own = await h.start("write the report");
    h.turn(own, {}, () => h.missions.claim(own.id, { kind: "ask", question: "Which month, May or June?" }));
    await h.settle();
    const chat = { agentId: "nova", gatewayId: "telegram:nova", chatId: "8142" };
    const line = h.notes.tasks(chat).find((task) => task.body.startsWith(`→ mission ${own.id.slice(0, 10)}`));
    expect(line?.body).toContain(`waits for the person's answer: "Which month, May or June?"`);
    expect(line?.body).toContain(`/mission answer ${own.id.slice(0, 10)}`);
    h.missions.answer(own.id, "June", "Gading");
    await h.settle();
    expect(h.notes.tasks(chat).find((task) => task.title === line!.title)?.body).toBe(`→ mission ${own.id.slice(0, 10)}, running`);
  });
});
