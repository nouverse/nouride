/**
 * One automation's page and one mission's page, for a reader who only reads it: it reports to a chat of theirs and is
 * another person's, so the daemon lets them see it and refuses every change (`changeable: false`).
 *
 * The page says whose it is under its title, and offers nothing that changes it: each case is a control that would be
 * pressed and refused, or a line that tells the reader something waits for them when it waits for its own person.
 * Beside each, the same page for whoever may change it, so a control missing from both would not pass as hidden.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationSummary, JobRunSummary, MissionDetail, MissionView } from "@nouride/wire";
import { lastRunLine, stateOf } from "@/modules/automations/lib/list";
import { outcomeWords, runWords } from "@/modules/automations/lib/runs";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { automation, detail, drawn, flowDrawn, ok, stepCard, TWO_AGENTS } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
/** An account that may change automations and missions, on a box whose orchestrator is known: the page's Ask button is drawn. */
const AS_OPERATOR = { ...TWO_AGENTS, "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) };
const GADING = { key: "gading", name: "Gading" };
const THEIRS = { person: GADING, changeable: false } as const;
const PAGE = "/automations/cron_e";
const NOTE = "This is Gading's. It reports to a chat of yours, so you can read it here but not change it.";

const note = (host: HTMLElement) => host.querySelector("main [data-read-only]")?.textContent ?? null;
const pressable = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("main button")].map((button) => button.textContent?.replace(/\s+/g, " ").trim() || button.getAttribute("aria-label") || "");
/** What on an automation's page changes it, counted: its switch, Run now, its menu, the name's field, a card's Change, a step's own controls. */
const changes = (host: HTMLElement) => ({
  switches: host.querySelectorAll('main [role="switch"]').length,
  runNow: pressable(host).filter((label) => label === "Run now").length,
  menu: host.querySelectorAll('main header [aria-label^="More for"]').length,
  name: host.querySelectorAll('main input[aria-label="Name"]').length,
  change: pressable(host).filter((label) => label === "Change").length,
  steps: host.querySelectorAll('main [aria-label^="Edit step"], main [aria-label^="Add a step"], main [aria-label^="Move step"]').length,
  ask: pressable(host).filter((label) => label.includes("to change it")).length,
});
const NONE = { switches: 0, runNow: 0, menu: 0, name: 0, change: 0, steps: 0, ask: 0 };

const WAITING = WIRE["/automations/cron_1"] as { automation: AutomationSummary; runs: JobRunSummary[]; suggested?: AutomationSummary; timezone: string };
const [waitingRun] = WAITING.runs;

describe("what waits for a person, on an automation the reader only reads", () => {
  test("a run and a step say who answers it, quietly; the reader's own say it waits for them", () => {
    expect(runWords(waitingRun!, "Gading")).toEqual({ label: "Waiting for Gading", tone: "quiet" });
    expect(runWords(waitingRun!)).toEqual({ label: "Waiting for you", tone: "needs" });
    const step = waitingRun!.steps!.find((one) => one.status === "waiting")!;
    expect(outcomeWords(step, "an admin")).toEqual({ label: "Waiting for an admin", tone: "quiet" });
    expect(outcomeWords(step)).toEqual({ label: "Waiting for you", tone: "needs" });
  });

  test("its row in the list says the same, and a name in its last run keeps its capital", () => {
    const name = () => "Nouva";
    const theirs = automation({ lastRun: waitingRun!, ...THEIRS });
    expect(stateOf(theirs, name)).toEqual({ word: "Waiting for Gading", tone: "quiet" });
    expect(lastRunLine(theirs)?.words).toEndWith(", waiting for Gading");
    expect(stateOf(automation({ lastRun: waitingRun!, changeable: false }), name)).toEqual({ word: "Waiting for an admin", tone: "quiet" });
    // A change suggested to it is not the reader's to answer either: said, without the colour of what needs them.
    expect(stateOf(automation({ suggested: "cron_s", ...THEIRS }), name)).toEqual({ word: "A change is suggested", tone: "quiet" });
    const own = automation({ lastRun: waitingRun!, person: GADING, changeable: true });
    expect(stateOf(own, name)).toEqual({ word: "Waiting for you", tone: "needs" });
    expect(lastRunLine(own)?.words).toEndWith(", waiting for you");
  });
});

describe("an automation's page, for a reader who only reads it", () => {
  test("says whose it is under its name and offers nothing that changes it; its steps and its runs are read", async () => {
    const run: JobRunSummary = { id: "run_9", jobId: "cron_e", startedAt: Date.now() - 60_000, finishedAt: Date.now() - 30_000, status: "success", result: "All well." };
    answer({ ...AS_OPERATOR, [PAGE]: detail(automation(THEIRS), [run]) });
    const seen = { note: null as string | null, changes: NONE, title: "", steps: 0, runs: "", who: "", picked: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.note = note(host);
      seen.changes = changes(host);
      seen.title = host.querySelector("main h1")?.textContent ?? "";
      seen.steps = drawn(host).length;
      seen.runs = host.querySelector('main [aria-label="Recent runs"]')?.textContent ?? "";
      seen.who = [...host.querySelectorAll("main aside section")].find((card) => card.textContent?.includes("Who may change it"))?.textContent ?? "";
      // A run is still opened and read over the steps.
      (host.querySelector('main [aria-label="Recent runs"] button') as HTMLElement).click();
      await eventually(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Last run", 2_000, "the run over the steps");
      seen.picked = stepCard(host, "check").textContent ?? "";
    });
    expect(seen.note).toBe(NOTE);
    expect(seen.changes).toEqual(NONE);
    expect(seen.title).toBe("Shop check");
    expect(seen.steps).toBe(4);
    expect(seen.runs).toContain("Done");
    expect(seen.who).toContain("Gading changes its steps and answers what it asks. You can read them, and how each run went.");
    expect(seen.who).not.toContain("You change the steps here");
    expect(seen.picked.length).toBeGreaterThan(0);
  });

  test("the same page for whoever may change it has every one of those, and no such line", async () => {
    answer({ ...AS_OPERATOR, [PAGE]: detail(automation({ person: GADING, changeable: true })) });
    const seen = { note: "?" as string | null, changes: NONE, who: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.note = note(host);
      seen.changes = changes(host);
      seen.who = host.querySelector("main aside")?.textContent ?? "";
    });
    expect(seen.note).toBeNull();
    // Two cards with Change (how it starts, who runs it), and each of four steps with its own controls.
    expect(seen.changes).toMatchObject({ switches: 1, runNow: 1, menu: 1, name: 1, change: 2, ask: 1 });
    expect(seen.changes.steps).toBeGreaterThan(4);
    expect(seen.who).toContain("You change the steps here");
  });

  test("one that is nobody's says so, and that an admin is who changes it", async () => {
    answer({ ...AS_OPERATOR, [PAGE]: detail(automation({ changeable: false })) });
    const seen = { note: null as string | null, who: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.note = note(host);
      seen.who = host.querySelector("main aside")?.textContent ?? "";
    });
    expect(seen.note).toBe("This is nobody's. It reports to a chat of yours, so you can read it here but not change it.");
    expect(seen.who).toContain("An admin changes its steps and answers what it asks.");
  });

  test("a run that waits for a person says who answers it, and has neither answer", async () => {
    answer({ ...AS_OPERATOR, "/automations/cron_1": ok({ ...WAITING, automation: { ...WAITING.automation, ...THEIRS } }) });
    const seen = { chip: "", buttons: ["?"], text: "", state: "" as string | undefined, runs: "" };
    await renderPage("/automations/cron_1", async (host) => {
      await flowDrawn(host);
      const card = stepCard(host, "ok");
      seen.chip = card.querySelector("[data-tone]")?.textContent ?? "";
      seen.buttons = [...card.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
      seen.text = card.textContent ?? "";
      seen.state = card.dataset.state;
      seen.runs = host.querySelector('main [aria-label="Recent runs"]')?.textContent ?? "";
    });
    expect(seen.chip).toBe("Waiting for Gading");
    expect(seen.buttons).toEqual([]);
    expect(seen.text).toContain("Gading can answer this.");
    expect(seen.text).not.toContain("Waiting for you");
    // Not lit as what needs the reader.
    expect(seen.state).toBeUndefined();
    expect(seen.runs).toContain("Waiting for Gading");
  });

  test("a webhook's address is not on the page: the daemon does not send it, and the page asks for nothing in its place", async () => {
    const hook = { webhookToken: "hook_1", path: "/hooks/hook_1", url: "https://box.example.com/hooks/hook_1", urlGuessed: false, reach: { state: "internet" as const, why: "It answered from outside." } };
    const webhook = { start: "webhook" as const, trigger: { kind: "webhook" as const } };
    answer({ ...AS_OPERATOR, [PAGE]: detail(automation({ ...webhook, ...THEIRS })) });
    const seen = { start: "", address: true, test: true };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.start = host.querySelector('main [aria-label="Start"]')?.textContent ?? "";
      seen.address = host.querySelector("main")?.textContent?.includes("/hooks/") === true;
      seen.test = pressable(host).some((label) => label === "Send a test" || label === "Make a new address");
    });
    expect(seen.start).toContain("when its address is called");
    expect(seen).toMatchObject({ address: false, test: false });

    // Its owner's page, for the same automation, holds the address.
    answer({ ...AS_OPERATOR, [PAGE]: detail(automation({ ...webhook, person: GADING, changeable: true, hook })) });
    let owner = "";
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      owner = host.querySelector('main [aria-label="Start"]')?.textContent ?? "";
    });
    expect(owner).toContain("https://box.example.com/hooks/hook_1");
  });

  test("a change an agent suggested is read and not answered: on one they only read, and where the change itself is not theirs", async () => {
    const change = automation({ id: "cron_s", enabled: false, proposal: { by: "nouva", at: 1, replaces: "cron_e" } });
    const banner = (host: HTMLElement) => host.querySelector<HTMLElement>('main [aria-label="Suggested change"]');
    const answers = (host: HTMLElement) => [...banner(host)!.querySelectorAll("button")].map((button) => button.textContent ?? "").filter((label) => label === "Accept" || label === "Discard");
    const seen: Record<string, string[]> = {};
    for (const [name, current, suggested] of [
      ["theirs", automation({ suggested: "cron_s", ...THEIRS }), { ...change, changeable: true }],
      ["not theirs to answer", automation({ suggested: "cron_s", person: GADING, changeable: true }), { ...change, changeable: false }],
      ["theirs to answer", automation({ suggested: "cron_s", person: GADING, changeable: true }), { ...change, changeable: true }],
    ] as const) {
      answer({ ...AS_OPERATOR, [PAGE]: detail(current, [], suggested) });
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await eventually(() => banner(host) !== null, 2_000, "the banner");
        seen[name] = answers(host);
      });
    }
    expect(seen).toEqual({ theirs: [], "not theirs to answer": [], "theirs to answer": ["Accept", "Discard"] });
  });
});

const SHOWN = WIRE["/missions/msn_1"] as MissionDetail;
const mission = (over: Partial<MissionView> = {}, more: Partial<MissionDetail> = {}) => ok({ ...SHOWN, ...more, mission: { ...SHOWN.mission, ...over } });
const TOLD = [{ id: "tel_1", by: "Gading", at: 1, text: "use the second tab" }];
const QUESTION = "Which folder should it go in?";
const asking: Partial<MissionView> = { status: "waiting", seen: "needs_you", waitKind: "input", reason: QUESTION, answers: [{ question: QUESTION, at: 1 }] };
const PARKED = { id: "apr_m1", agentId: "nouva", chatId: "msn_1", tool: "exec", params: { command: "rm -rf build/cache" }, preview: { kind: "command" as const, command: "rm -rf build/cache", clipped: false }, requestedAt: 1, timeoutMs: 86_400_000 };
const MISSION = "/missions/msn_1";
/** What on a mission's page changes it, counted: what is said to it, the box that tells it, the box that answers it, an approval's answers. */
const says = (host: HTMLElement) => ({
  actions: pressable(host).filter((label) => ["Stop", "Continue", "Accept", "Accept as it is", "Start it", "Drop it", "Delete"].includes(label)),
  tell: host.querySelectorAll('main textarea[placeholder^="e.g."]').length,
  answer: host.querySelectorAll('main textarea[placeholder="Your answer"]').length,
  approve: pressable(host).filter((label) => /^(Approve|Deny|Allow)/.test(label)).length,
});

describe("a mission's page, for a reader who only reads it", () => {
  test("says whose it is under its goal; nothing is said to it from here, and what it was told, its checklist and its turns are read", async () => {
    answer({ ...AS_OPERATOR, [MISSION]: mission({ ...THEIRS, told: TOLD }) });
    const seen = { note: null as string | null, says: says(document.body), text: "" };
    await renderPage(MISSION, async (host) => {
      await eventually(() => host.querySelector("main h1") !== null, 3_000, "the page");
      seen.note = note(host);
      seen.says = says(host);
      seen.text = host.querySelector("main")?.textContent ?? "";
    });
    expect(seen.note).toBe(NOTE);
    expect(seen.says).toEqual({ actions: [], tell: 0, answer: 0, approve: 0 });
    expect(seen.text).toContain("use the second tab");
    expect(seen.text).toContain("What it was told while it worked.");
    for (const card of ["Checklist", "Turns", "Done when"]) expect(seen.text).toContain(card);
  });

  test("with nothing told it has no Tell it card at all", async () => {
    answer({ ...AS_OPERATOR, [MISSION]: mission({ ...THEIRS, told: [] }) });
    let text = "";
    await renderPage(MISSION, async (host) => {
      await eventually(() => host.querySelector("main h1") !== null, 3_000, "the page");
      text = host.querySelector("main")?.textContent ?? "";
    });
    expect(text).not.toContain("Tell it");
  });

  test("the same page for whoever may change it has Stop and the box that tells it, and no such line", async () => {
    answer({ ...AS_OPERATOR, [MISSION]: mission({ person: GADING, changeable: true, told: TOLD }) });
    const seen = { note: "?" as string | null, says: says(document.body) };
    await renderPage(MISSION, async (host) => {
      await eventually(() => host.querySelector("main h1") !== null, 3_000, "the page");
      seen.note = note(host);
      seen.says = says(host);
    });
    expect(seen.note).toBeNull();
    expect(seen.says).toMatchObject({ actions: ["Stop"], tell: 1 });
  });

  test("one that asked a question waits for its own person: no box to answer, nothing that says it needs the reader, the question still read", async () => {
    answer({ ...AS_OPERATOR, [MISSION]: mission({ ...THEIRS, ...asking }) });
    const seen = { badge: "", says: says(document.body), text: "", alerts: -1 };
    await renderPage(MISSION, async (host) => {
      await eventually(() => host.querySelector("main h1") !== null, 3_000, "the page");
      seen.badge = host.querySelector("main header")?.textContent ?? "";
      seen.says = says(host);
      seen.text = host.querySelector("main")?.textContent ?? "";
      seen.alerts = host.querySelectorAll('main [role="status"].alert').length;
    });
    expect(seen.badge).toContain("Waiting for Gading");
    expect(seen.says).toEqual({ actions: [], tell: 0, answer: 0, approve: 0 });
    expect(seen.text).not.toContain("Needs you");
    expect(seen.text).not.toContain("waits for your answer");
    expect(seen.alerts).toBe(0);
    expect(seen.text).toContain(QUESTION);

    // Its own person's page asks them, and has the box.
    answer({ ...AS_OPERATOR, [MISSION]: mission({ person: GADING, changeable: true, ...asking }) });
    const own = { says: says(document.body), text: "" };
    await renderPage(MISSION, async (host) => {
      await eventually(() => host.querySelector('main textarea[placeholder="Your answer"]') !== null, 3_000, "the answer box");
      own.says = says(host);
      own.text = host.querySelector("main")?.textContent ?? "";
    });
    expect(own.says.answer).toBe(1);
    expect(own.text).toContain("It asked a question and waits for your answer.");
  });

  test("a call it parked is not theirs to approve: its card is not on the page, and is on its own person's", async () => {
    const seen: Record<string, { approve: number; said: boolean }> = {};
    for (const [name, whose] of [["theirs", THEIRS], ["own", { person: GADING, changeable: true }]] as const) {
      answer({ ...AS_OPERATOR, [MISSION]: mission({ ...whose, status: "waiting", seen: "needs_you", waitKind: "approval" }, { parked: [PARKED] }) });
      await renderPage(MISSION, async (host) => {
        await eventually(() => host.querySelector("main h1") !== null, 3_000, "the page");
        if (name === "own") await eventually(() => host.textContent?.includes("rm -rf build/cache") === true, 3_000, "the parked call");
        seen[name] = { approve: says(host).approve, said: host.querySelector("main")?.textContent?.includes("Waiting for your approval") === true };
      });
    }
    expect(seen.theirs).toEqual({ approve: 0, said: false });
    expect(seen.own?.said).toBe(true);
    expect(seen.own?.approve).toBeGreaterThan(0);
  });

  test("one that ended is not theirs to delete", async () => {
    const ended: Partial<MissionView> = { status: "stopped", seen: "ended", endedAt: 2, reason: "stopped by its person" };
    answer({ ...AS_OPERATOR, [MISSION]: mission({ ...THEIRS, ...ended }) });
    let theirs = ["?"];
    await renderPage(MISSION, async (host) => {
      await eventually(() => host.querySelector("main h1") !== null, 3_000, "the page");
      theirs = says(host).actions;
    });
    answer({ ...AS_OPERATOR, [MISSION]: mission({ person: GADING, changeable: true, ...ended }) });
    let own: string[] = [];
    await renderPage(MISSION, async (host) => {
      await eventually(() => says(host).actions.length > 0, 3_000, "its actions");
      own = says(host).actions;
    });
    expect(theirs).toEqual([]);
    expect(own).toEqual(["Delete"]);
  });
});
