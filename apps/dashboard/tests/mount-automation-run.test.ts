/**
 * A run drawn over an automation's steps: how each step went, which the run never reached, the path it took, and the
 * step it waits in, answered right on its card. Over the engine's own answer for a run that waits for a person
 * (`fixtures/wire.json`), and over runs made here for each way a step can end.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep, JobRunSummary, StepRunOutcome } from "@nouride/wire";
import { answer, buttons, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { AS_VIEWER, STEPS, automation, detail, drawn, flowDrawn, ok, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const out = (id: string, status: StepRunOutcome["status"], more: Partial<StepRunOutcome> = {}): StepRunOutcome => ({ id, kind: STEPS.find((step) => step.id === id)?.kind ?? "command", status, startedAt: 1, ...more });
const run = (status: JobRunSummary["status"], steps: StepRunOutcome[] | undefined, more: Partial<JobRunSummary> = {}): JobRunSummary => ({ id: "run_1", jobId: "cron_e", startedAt: Date.now() - 60_000, status, ...(steps ? { steps } : {}), ...more });
const chip = (host: HTMLElement, id: string) => stepCard(host, id).querySelector("[data-tone]")?.textContent ?? "";
const pressTab = (host: HTMLElement, label: string) => ([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent === label) as HTMLElement).click();

describe("a run that waits for a person, as the engine answers it", () => {
  test("the page opens on the run: each step says how it went, the one never reached says so, and nothing can be edited", async () => {
    const seen = { tab: "", states: {} as Record<string, string | undefined>, chips: {} as Record<string, string>, why: "", open: false, mono: false, dimmed: false, last: "", edits: -1, note: "" };
    await renderPage("/automations/cron_1", async (host) => {
      await flowDrawn(host);
      seen.tab = host.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";
      for (const id of ["check", "find", "ok", "tell"]) {
        seen.states[id] = stepCard(host, id).dataset.state;
        seen.chips[id] = chip(host, id);
      }
      const why = stepCard(host, "check").querySelector("details")!;
      seen.why = why.textContent ?? "";
      seen.open = why.hasAttribute("open");
      seen.mono = why.querySelector("p")?.getAttribute("class")?.includes("font-mono") === true;
      seen.dimmed = stepCard(host, "tell").hasAttribute("data-dimmed");
      seen.last = stepCard(host, "tell").textContent ?? "";
      seen.edits = host.querySelectorAll('[aria-label^="Edit step"], [aria-label^="Add a step"], [aria-label^="Move step"]').length;
      seen.note = host.querySelector('[aria-label="Start"]')?.textContent ?? "";
    });
    expect(seen.tab).toBe("Last run");
    expect(seen.states).toEqual({ check: "failed", find: "done", ok: "needs", tell: undefined });
    expect(seen.chips).toEqual({ check: "Failed after 0.0 s", find: "Done in 0.0 s", ok: "Waiting for you", tell: "" });
    // A failure's reason is open, and a command's output is in the mono face.
    expect(seen.why).toContain("the shop answered 503");
    expect([seen.open, seen.mono]).toEqual([true, true]);
    expect(seen.dimmed).toBe(true);
    expect(seen.last).toContain("Not reached in this run");
    expect(seen.edits).toBe(0);
    expect(seen.note).toContain("This run started");
  });

  test("the path it took is drawn: the exit a step left by, and the lines it went along", async () => {
    const seen = { taken: [] as string[], other: [] as string[], lines: -1 };
    await renderPage("/automations/cron_1", async (host) => {
      await flowDrawn(host);
      seen.taken = [...host.querySelectorAll("[data-branch][data-taken]")].map((one) => one.textContent ?? "");
      seen.other = [...host.querySelectorAll("[data-branch]:not([data-taken])")].map((one) => one.textContent ?? "");
      seen.lines = host.querySelectorAll("[data-flow] [data-taken]:not([data-branch])").length;
    });
    // The command failed and its own path for that is to go on; done would have ended the run.
    expect(seen.taken).toEqual(["If it failsgo on"]);
    expect(seen.other).toEqual(["Once doneend here"]);
    // Into the first step, on to the second, on to the third; not past the step it waits in.
    expect(seen.lines).toBe(3);
  });

  test("the step it waits in carries what the step before said and the two answers, and each is sent as it is", async () => {
    const seen = { said: "", labels: [] as string[], twice: 0 };
    const sent: { path: string; body: unknown }[] = [];
    for (const label of ["Continue", "Stop"]) {
      await renderPage("/automations/cron_1", async (host) => {
        await flowDrawn(host);
        const card = stepCard(host, "ok");
        seen.said = card.querySelector("details")?.textContent ?? "";
        seen.labels = [...card.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
        // The question is the card's own line: asked once.
        seen.twice = (card.textContent ?? "").split("Send what was found to the group?").length - 1;
        const record = recordPosts({ "/automations/runs/run_1/answer": ok({ ok: true }) });
        ([...card.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as HTMLElement).click();
        await eventually(() => record.posts.length === 1, 2_000, "the answer");
        await eventually(() => host.textContent?.includes(label === "Continue" ? "Continued" : "Stopped") === true, 2_000, "what was said of it");
        record.restore();
        sent.push(...record.posts);
      });
    }
    expect(seen.said).toContain("What the step before said");
    expect(seen.said).toContain("The payment service was restarting after its update.");
    expect(seen.labels).toEqual(["Continue", "Stop"]);
    expect(seen.twice).toBe(1);
    expect(sent).toEqual([{ path: "/automations/runs/run_1/answer", body: { go: true } }, { path: "/automations/runs/run_1/answer", body: { go: false } }]);
  });

  test("an account that only looks reads the question and is offered no answer; an answer that came too late is said, not taken for a Continue", async () => {
    answer(AS_VIEWER);
    let viewer = { labels: [] as string[], text: "" };
    await renderPage("/automations/cron_1", async (host) => {
      await flowDrawn(host);
      viewer = { labels: [...stepCard(host, "ok").querySelectorAll("button")].map((button) => button.textContent?.trim() ?? ""), text: stepCard(host, "ok").textContent ?? "" };
    });
    expect(viewer.labels).toEqual([]);
    expect(viewer.text).toContain("Someone who may change automations can answer this.");

    answer({});
    let late = "";
    await renderPage("/automations/cron_1", async (host) => {
      await flowDrawn(host);
      const record = recordPosts({ "/automations/runs/run_1/answer": { status: 409, body: { error: "that run no longer waits", plain: "Nothing was changed. Reload the page, and try again." } } });
      ([...stepCard(host, "ok").querySelectorAll("button")].find((button) => button.textContent?.trim() === "Continue") as HTMLElement).click();
      await eventually(() => host.textContent?.includes("Could not answer Shop health check") === true, 2_000, "the refusal");
      record.restore();
      late = host.textContent ?? "";
    });
    expect(late).toContain("Nothing was changed. Reload the page, and try again.");
    expect(late).not.toContain("Continued");
  });
});

describe("each way a step can end", () => {
  const NINE: AutomationStep[] = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id) => ({ id, kind: id === "d" ? "mission" : id === "e" || id === "f" ? "approval" : "command", ...(id === "d" ? { goal: "Fix it" } : id === "e" || id === "f" ? { ask: "Go?" } : { argv: ["true"] }) }) as AutomationStep);

  test("done and how long, failed, nothing to say, at work, waiting for its mission with the way to it, a no, no answer, skipped, cut off", async () => {
    const outcomes: StepRunOutcome[] = [
      { id: "a", kind: "command", status: "done", startedAt: 1, ms: 48_000, said: "all good" },
      { id: "b", kind: "command", status: "empty", startedAt: 1, ms: 20 },
      { id: "c", kind: "command", status: "running", startedAt: 1 },
      { id: "d", kind: "mission", status: "waiting", startedAt: 1, said: "started mission msn_9", missionId: "msn_9" },
      { id: "e", kind: "approval", status: "declined", startedAt: 1, ms: 5, by: "Gading", said: "Gading said no" },
      { id: "f", kind: "approval", status: "expired", startedAt: 1, ms: 5 },
      { id: "g", kind: "command", status: "skipped", startedAt: 1 },
      { id: "h", kind: "command", status: "interrupted", startedAt: 1 },
    ];
    answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps: NINE } }), [run("waiting", outcomes, { waiting: { kind: "mission", step: "d", missionId: "msn_9", since: 1 } })]) });
    let chips: string[] = [];
    const seen = { folded: true, mission: "", pulse: [] as boolean[], states: [] as (string | undefined)[], reached: "", breathing: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 9);
      chips = NINE.map((step) => chip(host, step.id));
      // What a step said is folded; a failure's reason is the one opened.
      seen.folded = !stepCard(host, "a").querySelector("details")?.hasAttribute("open");
      seen.mission = stepCard(host, "d").querySelector("a")?.getAttribute("href") ?? "";
      // The step at work and the one that waits pulse, which the reduced-motion rule holds still.
      seen.pulse = NINE.map((step) => stepCard(host, step.id).querySelector("[data-tone] .animate-pulse") !== null);
      seen.states = NINE.map((step) => stepCard(host, step.id).dataset.state);
      seen.reached = stepCard(host, "i").textContent ?? "";
      seen.breathing = NINE.filter((step) => stepCard(host, step.id).querySelector("[data-working].animate-pulse") !== null).map((step) => step.id);
    });
    expect(chips).toEqual(["Done in 48 s", "Nothing to say", "Working", "Waiting for its mission", "Stopped by Gading", "Nobody answered", "Skipped", "Cut off by a restart", ""]);
    expect(seen.folded).toBe(true);
    expect(seen.mission).toBe("/dashboard/missions/msn_9");
    expect(seen.pulse).toEqual([false, false, true, true, false, false, false, false, false]);
    // And the card of a step at work breathes: a ring that pulses, on those two cards alone.
    expect(seen.breathing).toEqual(["c", "d"]);
    expect(seen.states).toEqual(["done", undefined, "working", "working", undefined, undefined, undefined, undefined, undefined]);
    expect(seen.reached).toContain("Not reached in this run");
  });

  test("a jump the run took is the line drawn as taken; one it did not take stays faint", async () => {
    const steps: AutomationStep[] = [{ id: "a", kind: "command", argv: ["true"], whenFailed: { to: "d" }, whenEmpty: { to: "c" } }, { id: "b", kind: "command", argv: ["true"] }, { id: "c", kind: "command", argv: ["true"] }, { id: "d", kind: "systemEvent", text: "It failed." }];
    answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps } }), [run("success", [out("a", "failed", { ms: 10 }), { id: "d", kind: "systemEvent", status: "done", startedAt: 1, ms: 5 }], { finishedAt: Date.now() })]) });
    let links: Record<string, string | null> = {};
    let reached: string[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      pressTab(host, "Last run");
      await eventually(() => host.querySelector("[data-flow]")?.getAttribute("data-flow") === "run" && host.querySelectorAll("[data-flow-link]").length === 2, 2_000, "the run's lines");
      links = Object.fromEntries([...host.querySelectorAll("[data-flow-link]")].map((link) => [link.getAttribute("data-flow-link")!, link.getAttribute("data-state")]));
      reached = drawn(host).filter((id) => !stepCard(host, id).hasAttribute("data-dimmed"));
    });
    expect(links).toEqual({ "a:whenFailed": "taken", "a:whenEmpty": "idle" });
    expect(reached).toEqual(["a", "d"]);
  });

  test("a run of one thing writes no steps: its one step went as the run did", async () => {
    const one = automation({ payload: { kind: "agentTurn", message: "Sum up the mail." } });
    answer({ [PAGE]: detail(one, [run("error", undefined, { finishedAt: Date.now() - 55_000, result: "the model did not answer in time" })]) });
    const seen = { chip: "", state: "", why: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 1);
      pressTab(host, "Last run");
      await eventually(() => chip(host, "s1") !== "", 2_000, "the run");
      seen.chip = chip(host, "s1");
      seen.state = stepCard(host, "s1").dataset.state ?? "";
      seen.why = stepCard(host, "s1").querySelector("details")?.textContent ?? "";
    });
    expect(seen.chip).toBe("Failed after 5.0 s");
    expect(seen.state).toBe("failed");
    expect(seen.why).toContain("the model did not answer in time");
  });
});

describe("following a run", () => {
  // The page's own two-second timer is what is waited for. When this failed on a release's run and on a pull
  // request's, the second ask never came at all: the query library had been loaded by a file with no DOM and took
  // itself for a server's, which sets no timer (`mount-harness.ts`, `asABrowser`). The wait is four of its turns, for
  // a machine running the whole suite beside it, and returns as soon as it holds.
  test("while one is at work the page asks again every two seconds, and draws the step that ended as it ends", async () => {
    const at = [run("running", [out("check", "done", { ms: 400 }), out("find", "running")])];
    answer({ [PAGE]: detail(automation(), at) });
    let asked = 0;
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/api/control/automations/cron_e")) asked += 1;
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    const seen = { first: "", then: "" };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        seen.first = chip(host, "find");
        await eventually(() => asked >= 2, 8_000, "asked again");
        answer({ [PAGE]: detail(automation(), [run("success", [out("check", "done", { ms: 400 }), out("find", "done", { ms: 9_000 })], { finishedAt: Date.now() })]) });
        await eventually(() => chip(host, "find") === "Done in 9.0 s", 8_000, "the step ended");
        seen.then = chip(host, "find");
      });
    } finally {
      globalThis.fetch = spy;
    }
    expect(seen.first).toBe("Working");
    expect(seen.then).toBe("Done in 9.0 s");
  }, 40_000);

  test("Recent runs lists them, newest first, and a press on one draws that run over the steps", async () => {
    const older = run("success", [out("check", "empty", { ms: 30 })], { id: "run_0", startedAt: Date.now() - 2 * 86_400_000, finishedAt: Date.now() - 2 * 86_400_000 + 30, result: "step 1 of 4 had nothing to say: the run ended there" });
    const newest = run("success", [out("check", "done", { ms: 400 }), out("find", "done", { ms: 900 }), out("ok", "done", { ms: 5, by: "Gading" }), out("tell", "done", { ms: 5 })], { finishedAt: Date.now() - 50_000, result: "The shop was down." });
    answer({ [PAGE]: detail(automation(), [newest, older]) });
    const seen = { rows: [] as string[], labels: [] as string[], picked: [] as (string | null)[], tab: "", chips: [] as string[], held: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      const rows = () => [...host.querySelectorAll<HTMLElement>('[aria-label="Recent runs"] li > button')];
      seen.rows = rows().map((row) => row.textContent ?? "");
      seen.labels = buttons(host).filter((label) => label === "Steps" || label === "Last run");
      // No run is drawn yet: the steps are.
      seen.held = rows().filter((row) => row.getAttribute("aria-pressed") === "true").length;
      rows()[1]!.click();
      await eventually(() => chip(host, "check") === "Nothing to say", 2_000, "the older run drawn");
      seen.picked = rows().map((row) => row.getAttribute("aria-pressed"));
      seen.tab = host.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";
      seen.chips = STEPS.map((step) => chip(host, step.id));
    });
    expect(seen.rows[0]).toContain("Done · 10 s");
    expect(seen.rows[0]).toContain("The shop was down.");
    expect(seen.rows[1]).toContain("step 1 of 4 had nothing to say");
    expect(seen.labels).toEqual(["Steps", "Last run"]);
    expect(seen.held).toBe(0);
    expect(seen.picked).toEqual(["false", "true"]);
    expect(seen.tab).toStartWith("Run of ");
    expect(seen.chips).toEqual(["Nothing to say", "", "", ""]);
  });
});
