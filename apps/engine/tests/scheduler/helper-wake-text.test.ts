/**
 * What a background helper's end says (0.7.15): the wake-up that carries its handoff, the line the daemon posts itself
 * when it stopped short, and what the reply then owes.
 *
 * A prompt is behaviour: the wording that carries each rule is asserted directly — the handoff is in it, the report is
 * in the person's language, each helper is reported as it arrives, and a helper that did not finish is said not to have.
 */

import { describe, expect, test } from "bun:test";
import type { MessageEnvelope } from "@nouride/shared";
import type { JobCompletion, JobRecord } from "@/modules/jobs/jobs.store.ts";
import { helperFailureNotice, helperReportRequirement, helperWakeMessage } from "@/modules/jobs/helper-wake-text.ts";
import type { SubAgentHandoff } from "@/modules/tools/handoff.ts";
import { JobWakes, wakeCause } from "@/modules/pipeline/job-wakes.ts";
import { eventually } from "../wait.ts";

const report = (over: Partial<SubAgentHandoff> = {}): SubAgentHandoff => ({
  agentId: "nouva",
  status: "success",
  summary: "Found 3 broken links: /guide/a, /api/b, /blog/c.",
  files: ["/srv/docs/broken-links.md"],
  spills: [],
  metrics: { toolCalls: 14, steps: 9, ms: 252_000 },
  ...over,
});

function helper(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_ab12",
    agentId: "nouva",
    gatewayId: "telegram:main",
    chatId: "chat-1",
    command: "helper: Find every broken link on the docs site",
    cwd: "/srv",
    status: "succeeded",
    pid: null,
    exitCode: null,
    logPath: "/data/jobs/nouva/job_ab12.log",
    startedAt: 1_000,
    endedAt: 253_000,
    onComplete: null,
    kind: "helper",
    brief: { goal: "Find every broken link on the docs site", context: "The site is in /srv/docs; build it with `bun run build`.", deliverable: "A list of broken links, with the page each is on." },
    ask: null,
    report: report(),
    turnId: "turn_1",
    senderId: "u1",
    ...over,
  };
}

const done = (over: Partial<JobRecord> = {}, extra: Partial<JobCompletion> = {}): JobCompletion => ({ job: helper(over), tail: "12:00:01 started: Find every broken link\n12:00:02 → read: /srv/docs", ...extra });

describe("a helper that finished", () => {
  test("wakes its agent with its handoff, to report in the person's language — each one as it arrives", () => {
    const text = helperWakeMessage(done());
    expect(text).toContain("[System event: not a message from a person. Nobody is waiting on a reply.]");
    expect(text).toContain('Background helper job_ab12 ("Find every broken link on the docs site") finished after 4m 12s.');
    // The handoff, whole: its status, its words, the files it changed, the numbers.
    expect(text).toContain("[nouva · success]");
    expect(text).toContain("Found 3 broken links: /guide/a, /api/b, /blog/c.");
    expect(text).toContain("Files it changed: /srv/docs/broken-links.md");
    expect(text).toContain("14 tool calls · 9 steps · 252s");
    expect(text).toContain("Report THIS result to the person now, in their language. Translate the handoff, do not paste it");
    expect(text).toContain("If another helper is still running, say it is still going and that you will report it when it finishes. Do not wait for it to report this one.");
    // Nothing to start again from.
    expect(text).not.toContain("Its brief:");
  });

  test("the daemon posts nothing of its own, and the reply owes the report before anything else", () => {
    expect(helperFailureNotice(done())).toBeNull();
    expect(helperReportRequirement(done())).toContain("Report what it found or did to the person, in their language, BEFORE anything else you mention.");
  });
});

describe("a helper that did not finish", () => {
  const short = () => done({ status: "failed", report: report({ status: "requires_human", summary: "Checked /guide; /api needs an approval.", reason: "one tool call was not approved, so part of this was not done" }) });

  test("is said by the daemon itself, with why", () => {
    expect(helperFailureNotice(short())).toBe('⚠️ Background helper job_ab12 ("Find every broken link on the docs site") stopped before it finished its work: one tool call was not approved, so part of this was not done.');
  });

  test("wakes its agent to say what got done and what did not, with its brief to start again from", () => {
    const text = helperWakeMessage(short());
    expect(text).toContain("stopped at an approval nobody gave");
    expect(text).toContain("It did NOT finish its work.");
    expect(text).toContain("what it got done and what it did not, from its handoff, and what you propose");
    expect(text).toContain("If it stopped at an approval, say which call is waiting");
    expect(text).toContain("Its brief:\nGOAL\nFind every broken link on the docs site");
    expect(helperReportRequirement(short())).toContain("did NOT finish its work");
  });

  test("stopped at this install's limit: not to be started again as it was", () => {
    const completion = done({ status: "killed" }, { stop: { by: "deadline", limitMs: 1_800_000 } });
    expect(helperFailureNotice(completion)).toContain("was stopped after 30m, this install's limit for a background job (`[security] job_max_ms`). It had not finished.");
    const text = helperWakeMessage(completion);
    expect(text).toContain("it ran out of time");
    expect(text).toContain("Do not start it again with the same brief: it would be stopped at the same limit");
  });

  test("stopped by somebody: nothing posted, and silence allowed if it was just said", () => {
    const completion = done({ status: "killed", report: report({ status: "incomplete", summary: "", reason: "the turn was stopped before it finished" }) });
    expect(helperFailureNotice(completion)).toBeNull();
    expect(helperReportRequirement(completion)).toBeNull();
    expect(helperWakeMessage(completion)).toContain('If that has just been said, reply with only "." (it is not sent).');
  });

  test("cut off by a restart: what it had done, from its log, that it is not resumed, and its brief to start again", () => {
    const completion = done({ status: "interrupted", report: null });
    expect(helperFailureNotice(completion)).toBe('⚠️ Background helper job_ab12 ("Find every broken link on the docs site") was interrupted by a restart and is not resumed.');
    const text = helperWakeMessage(completion);
    expect(text).toContain("was interrupted by a restart before it finished");
    expect(text).toContain("(it handed nothing back)");
    expect(text).toContain("Its log, to where it stopped:\n```\n12:00:01 started: Find every broken link\n12:00:02 → read: /srv/docs\n```");
    expect(text).toContain("A restart cut it off, and a helper is not resumed.");
    expect(text).toContain("start it again with `delegate`, from its brief below, adding to `context` what this one already did");
    expect(text).toContain("Its brief:");
    expect(helperReportRequirement(completion)).toContain("cut off by a restart and is not resumed");
  });
});

test("a chain of wake-ups with nobody speaking still ends in a stop", () => {
  expect(helperWakeMessage(done(), { position: 3, limit: 3 })).toContain("Report this result, then STOP");
  expect(helperWakeMessage(done(), { position: 1, limit: 3 })).not.toContain("STOP");
});

describe("the road it takes", () => {
  test("a helper's end is woken with its own words, and its turn is headed as a helper's", async () => {
    const pushed: MessageEnvelope[] = [];
    const pending = new Set<Promise<void>>();
    const wakes = new JobWakes({
      deps: { gateways: new Map([["telegram:main", { platform: "telegram" }]]) } as never,
      queue: { push: (envelope: MessageEnvelope) => void pushed.push(envelope) } as never,
      admission: { noteJobWake: () => ({ position: 1, limit: 100 }) } as never,
      chatTypes: { of: () => "dm" } as never,
      turnContext: { waitUntilFree: async () => {} } as never,
      pending,
    });
    wakes.completion(done({ status: "failed", report: report({ status: "incomplete", reason: "it ran out of time with work still to do" }) }));
    // Pushed once the agent is free in that chat — at once, here.
    await eventually(() => pushed.length === 1, 4_000, "the wake-up pushed");

    const [envelope] = pushed;
    expect(envelope?.text).toContain("Its handoff:");
    expect(envelope?.text).not.toContain("exit code");
    expect(envelope?.announce).toContain("stopped before it finished its work: it ran out of time with work still to do");
    expect(envelope?.owedReport).toContain("did NOT finish its work");
    expect(wakeCause({ ...envelope!, senderId: "nouride:system" })).toEqual({ via: "job completion", job: "job_ab12", outcome: "failed", helper: true });
  });
});
