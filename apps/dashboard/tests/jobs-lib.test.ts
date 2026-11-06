/**
 * What the Helpers & jobs page (0.8.12) says about a job, decided apart from the page (`modules/jobs/lib/job.ts`): its
 * tab, its name, the line under it, and which handed-off turn is its own.
 */

import { describe, expect, test } from "bun:test";
import type { BackgroundJob } from "@/commons/lib/api";
import { jobTitle, ownTurnOf, rowLine, statusWord, tabOf } from "@/modules/jobs/lib/job";

const job = (over: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: "job_1",
  agentId: "nexa",
  gatewayId: "telegram:nexa",
  chatId: "555",
  command: "helper: Finish and render the video",
  kind: "helper",
  cwd: "/srv/work",
  status: "succeeded",
  pid: null,
  exitCode: null,
  startedAt: 1_000,
  endedAt: 61_000,
  logBytes: 6_000,
  logUpdatedAt: 61_000,
  processAlive: null,
  ...over,
});

describe("a job's tab and status word", () => {
  test("by how it ended; a daemon that died mid-job left it unfinished, so it is a failure", () => {
    expect(tabOf(job({ status: "running" }))).toBe("running");
    expect(tabOf(job({ status: "succeeded" }))).toBe("done");
    expect(tabOf(job({ status: "killed" }))).toBe("stopped");
    expect(tabOf(job({ status: "failed" }))).toBe("failed");
    expect(tabOf(job({ status: "interrupted" }))).toBe("failed");
    expect(statusWord(job({ status: "succeeded" })).word).toBe("done");
    expect(statusWord(job({ status: "killed" })).word).toBe("stopped");
  });
});

describe("its name", () => {
  test("a helper by its goal, an ask by who was asked and what, a command as it was run", () => {
    expect(jobTitle(job({ brief: { goal: "Render the async video", context: "", deliverable: "" } }))).toBe("Render the async video");
    expect(jobTitle(job({ kind: "ask", brief: null, ask: { agent: "nero", task: "review the PR" }, command: "ask nero: review the PR" }))).toBe("nero: review the PR");
    expect(jobTitle(job({ kind: "command", command: "npx remotion render" }))).toBe("npx remotion render");
    // An old row with no brief: the command's `helper: ` prefix is not part of the name.
    expect(jobTitle(job({ brief: null }))).toBe("Finish and render the video");
  });
});

describe("the line under it", () => {
  test("a helper that did not finish says so, with the daemon's reason — not the first words of its summary", () => {
    // Live (0.8.12): a helper ended for re-reading the same stills; its summary opened "Not finished".
    const line = rowLine(job({ status: "failed", report: { agentId: "nexa", status: "incomplete", summary: "**Not finished.**", files: [], metrics: { toolCalls: 21, steps: 20, ms: 459_000 }, reason: "it kept getting the same answer to the same call and stopped with work still to do" } }));
    expect(line).toEqual({ label: "incomplete", text: "it kept getting the same answer to the same call and stopped with work still to do" });
  });

  test("a finished helper: its first line, without the Markdown stars", () => {
    const line = rowLine(job({ report: { agentId: "nexa", status: "success", summary: "\n**Rendered** out/video.mp4\nmore", files: [], metrics: { toolCalls: 3, steps: 3, ms: 1 } } }));
    expect(line).toEqual({ label: "Handed back", text: "Rendered out/video.mp4" });
  });

  test("a command: its exit code and how much it printed; a running row with no process says so", () => {
    expect(rowLine(job({ kind: "command", command: "make", exitCode: 2, status: "failed", logBytes: 2048 }))).toEqual({ label: "Exit 2", text: "2.0 KB of output" });
    expect(rowLine(job({ status: "running", processAlive: false }))?.label).toBe("Not running");
    expect(rowLine(job({ status: "running", processAlive: true, logUpdatedAt: 50_000 }), 60_000)).toEqual({ label: "Now", text: "last wrote 10s ago" });
  });
});

describe("its own turn", () => {
  test("is the handed-off turn whose cause names this job — not another helper the same turn started", () => {
    const handed = [
      { id: "turn_a", agentId: "nexa", status: "done" as const, prompt: "a", startedAt: 1, cause: { via: "delegate", job: "job_0" } },
      { id: "turn_b", agentId: "nexa", status: "running" as const, prompt: "b", startedAt: 2, cause: { via: "delegate", job: "job_1" } },
    ];
    expect(ownTurnOf("job_1", handed)?.id).toBe("turn_b");
    expect(ownTurnOf("job_9", handed)).toBeNull();
    expect(ownTurnOf("job_1", undefined)).toBeNull();
  });
});
