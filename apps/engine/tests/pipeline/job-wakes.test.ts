/**
 * A quiet-job notice takes the completion's road: into the job's chat, after the agent's turn there,
 * masked — and without spending the per-chat allowance of *results* a completion is counted against.
 */

import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import type { JobRecord } from "@/modules/jobs/jobs.store.ts";
import { JobWakes, wakeCause } from "@/modules/pipeline/job-wakes.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { childEnvOf } from "../helpers.ts";
import { sleep } from "../wait.ts";

const job: JobRecord = {
  id: "job_1",
  agentId: "nouva",
  gatewayId: "telegram:nouva",
  chatId: "c1",
  command: "make",
  cwd: "/tmp",
  status: "running",
  pid: 1,
  exitCode: null,
  logPath: "/tmp/x.log",
  startedAt: 0,
  endedAt: null,
  onComplete: null,
  kind: "command",
  brief: null,
  ask: null,
  report: null,
  turnId: null,
  senderId: null,
};

function wakes(turns?: Record<string, string>) {
  const waitedFor: string[] = [];
  const pushed: MessageEnvelope[] = [];
  let counted = 0;
  let release: () => void = () => {};
  const free = new Promise<void>((resolve) => (release = resolve));
  const pending = new Set<Promise<void>>();
  const subject = new JobWakes({
    deps: {
      config: { daemon: { timezone: "UTC" } },
      gateways: new Map([["telegram:nouva", { platform: "telegram" }]]),
      childEnv: childEnvOf({ API_KEY: "sekret-value-123" }),
      ownSecrets: () => ({ STORE_TOKEN: "own-store-token-456" }),
      ...(turns ? { turns: { get: (id: string) => (turns[id] ? { agentId: turns[id] } : null) } } : {}),
    } as never,
    queue: { push: (envelope: MessageEnvelope) => (pushed.push(envelope), true) } as never,
    admission: { noteJobWake: () => ((counted += 1), { position: counted, limit: 3 }) } as never,
    chatTypes: { of: () => "dm" } as never,
    turnContext: { waitUntilFree: (agentId: string) => (waitedFor.push(agentId), free) } as never,
    pending,
  });
  return { subject, pushed, pending, release, waitedFor, counted: () => counted };
}

describe("a job the deadline stopped", () => {
  test("is announced by the daemon and owed a report, with no exec hint — and the reason survives the masking", async () => {
    const w = wakes();
    w.subject.completion({
      job: { ...job, status: "killed", exitCode: 255, endedAt: 3_600_000 },
      tail: "token sekret-value-123\nstep 4/9",
      stop: { by: "deadline", limitMs: 3_600_000 },
    });
    w.release();
    await Promise.all(w.pending);
    const [envelope] = w.pushed;
    expect(envelope!.announce).toStartWith("⏱️ Background job job_1 was stopped after 1h 0m");
    expect(envelope!.owedReport).toContain("did NOT finish");
    expect(envelope!.text).toContain("was stopped by the daemon after 1h 0m");
    expect(envelope!.text).not.toContain("sekret-value-123");
  });
});

describe("why the turn a job wakes was started", () => {
  test("travels as data — the job and how it ended, a deadline's stop a stop whatever the row says", async () => {
    const ended = async (status: JobRecord["status"], stop?: { by: "deadline"; limitMs: number }) => {
      const w = wakes();
      w.subject.completion({ job: { ...job, status, exitCode: status === "succeeded" ? 0 : 1, endedAt: 10 }, tail: "", ...(stop ? { stop } : {}) });
      w.release();
      await Promise.all(w.pending);
      return wakeCause(w.pushed[0]!);
    };
    expect(await ended("succeeded")).toEqual({ via: "job completion", job: "job_1", outcome: "finished" });
    expect(await ended("failed")).toEqual({ via: "job completion", job: "job_1", outcome: "failed" });
    expect(await ended("interrupted")).toEqual({ via: "job completion", job: "job_1", outcome: "interrupted" });
    expect(await ended("killed", { by: "deadline", limitMs: 1_000 })).toEqual({ via: "job completion", job: "job_1", outcome: "stopped" });
  });

  test("and a person's message has none, whatever its raw payload holds", () => {
    const typed = { senderId: "123", raw: { via: "job completion", job: "job_1", outcome: "failed" } } as unknown as MessageEnvelope;
    expect(wakeCause(typed)).toBeUndefined();
    expect(wakeCause({ senderId: SYSTEM_SENDER, raw: { via: "job quiet", job: "job_1" } } as unknown as MessageEnvelope)).toEqual({ via: "job quiet", job: "job_1" });
  });
});

describe("a quiet-job notice", () => {
  test("waits for the agent's turn, then enters the job's own chat from the daemon", async () => {
    const w = wakes();
    w.subject.quiet(job, "still going");
    // Past the microtask queue: a push that merely deferred itself, rather than waiting, lands here.
    await sleep(10);
    expect(w.pushed).toHaveLength(0);
    w.release();
    await Promise.all(w.pending);
    expect(w.pushed).toHaveLength(1);
    expect(w.pushed[0]).toMatchObject({ gatewayId: "telegram:nouva", chatId: "c1", mentions: ["nouva"], raw: { via: "job quiet", job: "job_1" } });
  });

  test("is masked like a tool result — the log tail can hold a credential", async () => {
    const w = wakes();
    w.subject.quiet(job, "curl -H 'Authorization: sekret-value-123'");
    w.release();
    await Promise.all(w.pending);
    expect(w.pushed[0]!.text).not.toContain("sekret-value-123");
  });

  test("does not count against the chat's allowance of job results", async () => {
    const w = wakes();
    w.subject.quiet(job, "still going");
    w.release();
    await Promise.all(w.pending);
    expect(w.counted()).toBe(0);
  });
});

describe("an ask that moved to the background (0.7.19)", () => {
  // Nouva asked Nox; Nox outlasted the wait, and the ask became a job of Nouva's.
  const ask: JobRecord = {
    ...job,
    kind: "ask",
    pid: null,
    command: "ask nox: Deploy v2 to staging.",
    ask: { agent: "nox", task: "Deploy v2 to staging." },
    status: "succeeded",
    endedAt: 10,
    turnId: "turn_nouva",
    report: { agentId: "nox", status: "success", summary: "Deployed.", files: [], spills: [], metrics: { toolCalls: 1, steps: 2, ms: 9 } },
  };

  test("wakes the agent that asked — after its turn there — with the answer, and says whose it was", async () => {
    const w = wakes({ turn_nouva: "nouva" });
    w.subject.completion({ job: ask, tail: "" });
    w.release();
    await Promise.all(w.pending);
    const [envelope] = w.pushed;
    expect(w.waitedFor).toEqual(["nouva"]);
    expect(envelope).toMatchObject({ gatewayId: "telegram:nouva", chatId: "c1", senderId: SYSTEM_SENDER, mentions: ["nouva"] });
    expect(envelope!.text).toContain("The answer from nox has arrived");
    expect(envelope!.text).not.toContain("which you asked with ask_agent");
    expect(wakeCause(envelope!)).toEqual({ via: "job completion", job: "job_1", outcome: "finished", asked: "nox" });
  });

  test("the answer is masked as the tool result it used to be — its report and the line the daemon posts", async () => {
    const w = wakes({ turn_nouva: "nouva" });
    const leaky = { ...ask.report!, status: "failed" as const, summary: "Used sekret-value-123 and own-store-token-456 to log in.", reason: "rejected sekret-value-123" };
    w.subject.completion({ job: { ...ask, status: "failed", report: leaky }, tail: "" });
    w.release();
    await Promise.all(w.pending);
    expect(w.pushed[0]!.text).toContain("Used ");
    expect(w.pushed[0]!.text).not.toContain("sekret-value-123");
    // And the daemon's own credentials, as every tool result is masked of them.
    expect(w.pushed[0]!.text).not.toContain("own-store-token-456");
    expect(w.pushed[0]!.announce).toContain("nox stopped before finishing job_1");
    expect(w.pushed[0]!.announce).not.toContain("sekret-value-123");
  });

  test("counts one wake-up of the chain with no person in it — and at its limit, says to stop", async () => {
    const w = wakes({ turn_nouva: "nouva" });
    for (let n = 0; n < 3; n++) w.subject.completion({ job: ask, tail: "" });
    w.release();
    await Promise.all(w.pending);
    expect(w.counted()).toBe(3);
    expect(w.pushed[1]!.text).not.toContain("STOP");
    expect(w.pushed[2]!.text).toContain("[This is wake-up 3 in a chain with no message from a person in it, and the limit for this install is 3.");
  });
});

describe("a job an agent started while another asked it (nouride-releases#10)", () => {
  // Nox ran inside Nouva's turn (`ask_agent`), in Nouva's chat, and started a build there.
  const asked = { ...job, agentId: "nox", turnId: "turn_nouva", status: "succeeded" as const, exitCode: 0, endedAt: 10 };

  test("wakes the agent that asked, told whose job it was — never the asked agent in a chat that is not its own", async () => {
    const w = wakes({ turn_nouva: "nouva" });
    w.subject.completion({ job: asked, tail: "built" });
    w.release();
    await Promise.all(w.pending);
    const [envelope] = w.pushed;
    expect(envelope!.mentions).toEqual(["nouva"]);
    expect(w.waitedFor).toEqual(["nouva"]);
    expect(envelope!.text).toStartWith("[This job was started by nox, which you asked with ask_agent.");
    expect(envelope!.text).toContain("finished successfully");
    // Addressed to the agent it wakes: an `@nox` here ran Nox as well, from the same message (found live).
    expect(envelope!.text).toContain("@nouva");
    expect(envelope!.text).not.toContain("@nox");
  });

  test("its own job, a job with no turn, or one whose turn is gone, wakes its own agent as before", async () => {
    for (const [turnId, turns] of [["turn_nox", { turn_nox: "nox" }], [null, { turn_nouva: "nouva" }], ["turn_swept", {}]] as const) {
      const w = wakes(turns as Record<string, string>);
      w.subject.completion({ job: { ...asked, turnId }, tail: "" });
      w.release();
      await Promise.all(w.pending);
      expect(w.pushed[0]!.mentions).toEqual(["nox"]);
      expect(w.pushed[0]!.text).not.toContain("which you asked");
    }
  });
});
