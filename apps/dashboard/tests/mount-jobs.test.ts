/**
 * Helpers & jobs (0.8.12), mounted: the owner asked to see a helper's log and turn on the dashboard, as a mission's are
 * — before, only `nouride jobs log` and `nouride turns show` on the box showed them. In a file of its own
 * over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import type { BackgroundJob } from "@nouride/wire";
import { answer, buttons, press, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });

const job = (over: Partial<BackgroundJob>): BackgroundJob => ({
  id: "job_1",
  agentId: "nexa",
  gatewayId: "telegram:nexa",
  chatId: "555",
  command: "helper: Render the async function video",
  kind: "helper",
  cwd: "/srv/work/async-explainer",
  status: "running",
  pid: null,
  exitCode: null,
  startedAt: Date.now() - 120_000,
  endedAt: null,
  logBytes: 6_144,
  logUpdatedAt: Date.now() - 5_000,
  processAlive: true,
  brief: { goal: "Render the async function video", context: "Project at /srv/work/async-explainer; Root.tsx not written yet.", deliverable: "The MP4 and the contact sheet." },
  report: null,
  turnId: "turn_parent",
  ...over,
});

const RUNNING = job({});
const GAVE_UP = job({
  id: "job_2",
  status: "failed",
  endedAt: Date.now() - 60_000,
  brief: { goal: "Check the stills of round 2", context: "", deliverable: "" },
  report: { agentId: "nexa", status: "incomplete", summary: "**Not finished.** Only four stills came through.", files: [], metrics: { toolCalls: 21, steps: 20, ms: 459_000 }, reason: "it kept getting the same answer to the same call and stopped with work still to do" },
});
const BUILD = job({ id: "job_3", kind: "command", command: "npx remotion render src/index.ts Main out/v.mp4", status: "succeeded", exitCode: 0, endedAt: Date.now() - 30_000, brief: null, turnId: null });

/** The turn that started job_1 lists the turns it handed off; job_1's own is the one whose cause names it. */
const TURNS = {
  "/turns/turn_parent": ok({
    turn: { id: "turn_parent", agentId: "nexa", status: "done", prompt: "gas", reply: "handed off" },
    calls: [],
    steps: [],
    delegated: [
      { id: "turn_other", agentId: "nexa", status: "done", prompt: "another", startedAt: 1, cause: { via: "delegate", job: "job_0", helper: true } },
      { id: "turn_own", agentId: "nexa", status: "running", prompt: "Render", startedAt: 2, cause: { via: "delegate", job: "job_1", helper: true } },
    ],
  }),
  "/turns/turn_own": ok({
    turn: { id: "turn_own", agentId: "nexa", status: "running", prompt: "Render", reply: "" },
    calls: [{ at: Date.now(), agentId: "nexa", model: "claude-opus-5-5", inputTokens: 40_994, outputTokens: 221, purpose: "helper", stopReason: "tool_calls" }],
    steps: [],
  }),
};

test("it is Work's third tab, between Missions and Schedule, and the menu marks Work while it is open (0.8.24)", async () => {
  answer({ "/jobs": ok({ jobs: [] }) });
  let seen = { tabs: [] as string[], current: [] as string[] };
  await renderPage("/jobs", async (host) => {
    await eventually(() => host.querySelector('main a[href="/dashboard/schedule"]') !== null, 2_000, "Work's tabs");
    seen = {
      tabs: [...host.querySelectorAll("main a")].filter((a) => /\/dashboard\/(work|missions|jobs|schedule|webhooks)$/.test(a.getAttribute("href") ?? "")).map((a) => a.textContent?.trim() ?? ""),
      // The item's name, without the count of what waits there.
      current: [...host.querySelectorAll('nav[aria-label="Menu"] a[aria-current="page"]')].map((a) => a.querySelector("span")?.textContent?.trim() ?? ""),
    };
  });
  expect(seen.tabs).toEqual(["Waiting for you", "Missions", "Helpers", "Schedule", "Webhooks"]);
  expect(seen.current).toEqual(["Work"]);
});

test("the list: a row per job opening its page, counted by tab, the Failed tab showing only what failed", async () => {
  answer({ "/jobs": ok({ jobs: [RUNNING, GAVE_UP, BUILD] }) });
  let all = "";
  let failed = "";
  await renderPage("/jobs", async (host) => {
    await eventually(() => host.textContent?.includes("Render the async function video") === true, 2_000, "the rows");
    all = host.innerHTML;
    [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Failed"))!.click();
    await eventually(() => !host.textContent?.includes("Render the async function video"), 2_000, "the Failed tab");
    failed = host.textContent ?? "";
  });
  expect(all).toContain('href="/dashboard/jobs/job_1"');
  expect(all).toContain("npx remotion render src/index.ts Main out/v.mp4");
  expect(all).toContain("it kept getting the same answer");
  expect(failed).toContain("Check the stills of round 2");
  expect(failed).not.toContain("npx remotion render");
});

test("the steps and the side column keep their own heights — a short log is not a tall empty card", async () => {
  answer({ "/jobs/job_1/log": ok({ id: "job_1", job: RUNNING, log: "one line" }), ...TURNS });
  let grid = "";
  await renderPage("/jobs/job_1", async (host) => {
    await eventually(() => host.textContent?.includes("one line") === true, 2_000, "the steps");
    grid = [...host.querySelectorAll("div")].find((div) => div.className.includes("lg:grid-cols-[minmax(0,1fr)_24rem]"))?.className ?? "";
  });
  expect(grid).toContain("items-start");
});

test("a running helper: its brief, its steps as written, its own turn's model calls, and a way to stop it", async () => {
  answer({ "/jobs/job_1/log": ok({ id: "job_1", job: RUNNING, log: "10:48:30 → read SKILL.md, theme.ts\n10:53:19 → exec cat > round.sh" }), ...TURNS });
  let text = "";
  let shown: string[] = [];
  let posted: { path: string }[] = [];
  await renderPage("/jobs/job_1", async (host) => {
    await eventually(() => host.textContent?.includes("Model calls (1)") === true, 2_000, "its own turn");
    text = host.textContent ?? "";
    shown = buttons(host);
    const record = recordPosts({ "/jobs/job_1/kill": ok({ ok: true, id: "job_1" }) });
    try {
      press(host, "Stop it");
      await eventually(() => record.posts.length > 0, 2_000, "the stop");
    } finally {
      record.restore();
    }
    posted = record.posts;
  });
  expect(text).toContain("Render the async function video");
  expect(text).toContain("Project at /srv/work/async-explainer; Root.tsx not written yet.");
  expect(text).toContain("The MP4 and the contact sheet.");
  expect(text).toContain("10:53:19 → exec cat > round.sh");
  // turn_own, found by the job's id in its cause — not turn_other, which the same turn also started.
  expect(text).toContain("turn_own");
  // A helper's model calls are counted with the turn that started it (`nouride turns show` says so); its own record
  // carries its requests. The card says which, rather than promising calls the live record does not hold.
  expect(text).toContain("Its model calls are counted with the turn that started it.");
  expect(text).not.toContain("turn_other");
  expect(shown).toContain("Stop it");
  expect(posted.map((post) => post.path)).toEqual(["/jobs/job_1/kill"]);
});

test("one that ended: what it handed back, said as not finished with the daemon's reason, and nothing to stop", async () => {
  answer({ "/jobs/job_2/log": ok({ id: "job_2", job: GAVE_UP, log: "10:56:04 ended: incomplete" }), ...TURNS });
  let text = "";
  let shown: string[] = [];
  await renderPage("/jobs/job_2", async (host) => {
    await eventually(() => host.textContent?.includes("Not finished") === true, 2_000, "the result");
    text = host.textContent ?? "";
    shown = buttons(host);
  });
  expect(text).toContain("Not finished: it kept getting the same answer to the same call and stopped with work still to do");
  expect(text).toContain("Only four stills came through.");
  expect(shown).not.toContain("Stop it");
});

test("a job that is not there says so, with the way back", async () => {
  answer({ "/jobs/job_gone/log": { status: 404, body: { error: "no such job", id: "job_gone" } } });
  const html = await renderPage("/jobs/job_gone");
  expect(html).toContain("No such job");
  expect(html).toContain('href="/dashboard/jobs"');
});

test("Logs → Helpers: each row opens the job's page here", async () => {
  answer({ "/jobs": ok({ jobs: [RUNNING, BUILD] }) });
  let html = "";
  await renderPage("/logs", async (host) => {
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Helpers")!.click();
    await eventually(() => host.innerHTML.includes('href="/dashboard/jobs/job_3"'), 2_000, "the job rows");
    html = host.innerHTML;
  });
  expect(html).toContain('href="/dashboard/jobs/job_1"');
  expect(html).toContain('href="/dashboard/jobs/job_3"');
});

test("the window that sweeps these rows is shown and set here, as on Logs (0.8.12)", async () => {
  answer({ "/jobs": ok({ jobs: [BUILD] }), "/retention": ok({ windows: { log: 3, audit: 30, cronRuns: 30, jobLogs: 3, sessions: 30 } }) });
  let text = "";
  let days = "";
  await renderPage("/jobs", async (host) => {
    await eventually(() => host.textContent?.includes("Keep these jobs and what they printed for") === true, 2_000, "the retention control");
    text = host.textContent ?? "";
    days = host.querySelector<HTMLInputElement>('input[type="number"]')?.value ?? "";
  });
  expect(text).toContain("[retention] job_log_days");
  expect(days).toBe("3");
});
