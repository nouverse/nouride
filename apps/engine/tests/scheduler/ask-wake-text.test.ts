/**
 * What the asking agent is woken with when an ask in the background ends (0.7.19): what it asked, when and of whom —
 * the person may have moved on — then the answer; how it ended, said for each way it can; and the line the daemon posts
 * itself where the model might not.
 */

import { describe, expect, test } from "bun:test";
import type { JobCompletion, JobRecord } from "@/modules/jobs/jobs.store.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { askFailureNotice, askReportRequirement, askWakeMessage } from "@/modules/jobs/ask-wake-text.ts";

const report = (over: Partial<SubAgentHandoff> = {}): SubAgentHandoff => ({
  agentId: "nox",
  status: "success",
  summary: "Deployed v2 to staging; /health answers 200.",
  files: [],
  spills: [],
  metrics: { toolCalls: 6, steps: 4, ms: 754_000 },
  ...over,
});

/** 2026-10-19 07:05 UTC — 14:05 in Jakarta. */
const ASKED = Date.UTC(2026, 9, 19, 7, 5, 0);

function asked(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_ask1",
    agentId: "nouva",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    command: "ask nox: Deploy v2 to staging, then check it answers on /health.",
    cwd: "/srv",
    status: "succeeded",
    pid: null,
    exitCode: null,
    logPath: "/data/jobs/nouva/job_ask1.log",
    startedAt: ASKED,
    endedAt: ASKED + 754_000,
    onComplete: null,
    kind: "ask",
    brief: null,
    ask: { agent: "nox", task: "Deploy v2 to staging, then check it answers on /health.\nThe person wants it out before the demo." },
    report: report(),
    turnId: "turn_1",
    senderId: "u1",
    ...over,
  };
}

const at = { timeZone: "Asia/Jakarta", now: ASKED + 12 * 60_000 };
const wake = (completion: JobCompletion, extra: Partial<Parameters<typeof askWakeMessage>[1]> = {}) => askWakeMessage(completion, { ...at, ...extra });

describe("the answer, arrived", () => {
  test("wakes the asking agent with what it asked, when, and of whom — then the answer — and says to give the context first", () => {
    const text = wake({ job: asked(), tail: "" });
    expect(text).toStartWith("[System event: not a message from a person. Nobody is waiting on a reply.]\n@nouva\n");
    expect(text).toContain("The answer from nox has arrived, to what you asked at 14:05 (12m ago), in the background as job_ask1:");
    // The ask, on one line: enough to know which one.
    expect(text).toContain('"Deploy v2 to staging, then check it answers on /health. The person wants it out before the demo."');
    expect(text).toContain("nox's handoff:\n[nox · success]\nDeployed v2 to staging; /health answers 200.");
    expect(text).toContain("1. What it is the answer to: what you asked, and when. They may have moved on to something else since.");
    expect(text).toContain('If you already passed on this exact answer, reply with only "." (it is not sent).');
    expect(text).not.toContain("@nox");
    // Nothing for the daemon to say first; the reply owes the answer, in context.
    expect(askFailureNotice({ job: asked(), tail: "" })).toBeNull();
    expect(askReportRequirement({ job: asked(), tail: "" })).toContain("say first what it is the answer to: they may have moved on since");
  });

  test("in a mission's turn, the answer goes into the work and its report — nobody reads the reply", () => {
    // "Pass THIS answer on to the person now" reached a mission's turn, whose reply
    // nobody reads, so the answer went nowhere.
    const text = wake({ job: asked({ gatewayId: "web:mission", chatId: "msn_1" }), tail: "" });
    expect(text).toContain("This turn is the mission's: nobody reads its reply. Use nox's answer in the work.");
    expect(text).toContain("goes in the mission's report when it ends");
    expect(text).not.toContain("Pass THIS answer on to the person now");
  });

  test("a long ask is cut to one line, and its time is the daemon's clock", () => {
    const task = `Audit ${"every firewall rule on every host ".repeat(10)}and report.`;
    const text = wake({ job: asked({ ask: { agent: "nox", task } }), tail: "" }, { timeZone: "UTC" });
    expect(text).toContain("what you asked at 07:05 (12m ago)");
    const quoted = /\n"([^"]+)"\n/.exec(text)?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(160);
    expect(quoted).toEndWith("…");
  });
});

describe("how it ended, said for each way", () => {
  test("stopped short: the daemon says it, the reply owes what got done and what did not", () => {
    const job = asked({ status: "failed", report: report({ status: "requires_human", summary: "", reason: "a call was not approved" }) });
    expect(askFailureNotice({ job, tail: "" })).toBe("⚠️ nox stopped before finishing job_ask1: a call was not approved.");
    expect(wake({ job, tail: "" })).toContain("nox stopped at an approval nobody gave, on what you asked at 14:05");
    expect(wake({ job, tail: "" })).toContain("nox did NOT finish.");
    expect(askReportRequirement({ job, tail: "" })).toContain("who did NOT finish what you asked");
  });

  test("the time limit: the daemon says it stopped it, and asking again with the same task is ruled out", () => {
    const completion: JobCompletion = { job: asked({ status: "killed", report: report({ status: "incomplete", summary: "" }) }), tail: "", stop: { by: "deadline", limitMs: 1_800_000 } };
    expect(askFailureNotice(completion)).toBe("⏱️ nox's work in the background on job_ask1 was stopped after 30m, this install's limit for a background job (`[security] job_max_ms`). It had not finished.");
    expect(wake(completion)).toContain("nox was stopped by the daemon after 30m, this install's limit for a background job (`[security] job_max_ms`), before it finished what you asked at 14:05");
    expect(wake(completion)).toContain("Do not ask again with the same task: it would be stopped at the same limit");
  });

  test("a stop somebody made: nothing posted, and silence allowed if it was just said", () => {
    const completion: JobCompletion = { job: asked({ status: "killed", report: report({ status: "incomplete", summary: "" }) }), tail: "" };
    expect(askFailureNotice(completion)).toBeNull();
    expect(wake(completion)).toContain("nox was stopped before it finished what you asked at 14:05");
    expect(wake(completion)).toContain('If that has just been said, reply with only "." (it is not sent).');
  });

  test("a restart: said by the daemon, with the log to where it stopped, and how to ask again", () => {
    const completion: JobCompletion = { job: asked({ status: "interrupted", report: null }), tail: "07:05:10 → probe staging" };
    expect(askFailureNotice(completion)).toBe("⚠️ nox's work in the background on job_ask1 was interrupted by a restart and is not resumed.");
    const text = wake(completion);
    expect(text).toContain("nox was interrupted by a restart before it finished what you asked at 14:05");
    expect(text).toContain("nox's handoff:\n(nothing came back)");
    expect(text).toContain("Its log, to where it stopped:\n```\n07:05:10 → probe staging\n```");
    expect(text).toContain("ask nox again with `ask_agent`, saying in the task what was already done");
    expect(askReportRequirement(completion)).toContain("was cut off by a restart");
  });
});

describe("a chain of wake-ups with no person in it", () => {
  test("at its limit, the answer is still delivered — and the agent is told to start nothing more", () => {
    const text = wake({ job: asked(), tail: "" }, { chain: { position: 3, limit: 3 } });
    expect(text).toContain("The answer from nox has arrived");
    expect(text).toContain("[This is wake-up 3 in a chain with no message from a person in it, and the limit for this install is 3. Report this result, then STOP");
    expect(wake({ job: asked(), tail: "" }, { chain: { position: 2, limit: 3 } })).not.toContain("STOP");
    expect(wake({ job: asked(), tail: "" }, { chain: { position: 9, limit: 0 } })).not.toContain("STOP");
  });
});
