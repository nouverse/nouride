/**
 * The automation canvas and its one panel, through the whole app: a pressed box's fields beside the canvas where there
 * is room and in the box itself on a phone, a step added to a lane, a new step that is a script to write, and an
 * automation that stops by itself after a set time, on its page and once it has.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep, AutomationSummary } from "@nouride/wire";
import { answer, dom, dropdown, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { STEPS, TWO_AGENTS, addStep, automation, barButton, closeStep, detail, drawn, editStep, field, flowDrawn, labelled, ok, openWhose, saveBar, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const [CHECK, FIND, OK, TELL] = STEPS as [AutomationStep, AutomationStep, AutomationStep, AutomationStep];
const shown = (over: Partial<AutomationSummary> = {}) => answer({ [PAGE]: detail(automation(over)), ...TWO_AGENTS });
const panel = (host: HTMLElement) => host.querySelector<HTMLElement>('main aside section[aria-label="Change this box"]');

async function saved(host: HTMLElement): Promise<{ path: string; body: unknown }[]> {
  const record = recordPosts({ "/cron/cron_e": ok({ job: automation() }) });
  await eventually(() => barButton(host, "Save")?.disabled === false, 2_000, "Save offered");
  barButton(host, "Save")!.click();
  await eventually(() => record.posts.length > 0, 2_000, "the save");
  record.restore();
  return record.posts;
}

/** A window of that many pixels across, for as long as `during` runs: a width a page asks for matches where the window has it. */
async function atWidth(px: number, during: () => Promise<void>): Promise<void> {
  const view = dom.window as unknown as { matchMedia: (query: string) => unknown };
  const was = view.matchMedia;
  view.matchMedia = (query: string) => {
    const asked = /\(min-width: (\d+)px\)/.exec(query);
    return { matches: asked ? px >= Number(asked[1]) : (was.call(dom.window, query) as { matches: boolean }).matches, media: query, addEventListener: () => {}, removeEventListener: () => {} };
  };
  try {
    await during();
  } finally {
    view.matchMedia = was;
  }
}

describe("a pressed box's fields", () => {
  test("open beside the canvas where there is room, one box at a time, and the last runs come back when it is closed", async () => {
    shown();
    const seen = { rest: "", panel: [] as string[], card: [] as string[], scrolls: [] as string[], held: [] as string[], step: "", inBox: true, start: "", results: "", closed: "", states: [] as (string | undefined)[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.rest = host.querySelector("main aside")?.textContent ?? "";
      seen.panel = (host.querySelector("main aside[data-panel]")?.getAttribute("class") ?? "").split(/\s+/);
      editStep(host, 2).click();
      await eventually(() => panel(host) !== null, 2_000, "the panel");
      seen.step = panel(host)!.querySelector("header")?.textContent ?? "";
      // The card is the frame: what scrolls is its fields, and its head and its Done are not among them.
      seen.card = (panel(host)!.closest("section")?.getAttribute("class") ?? "").split(/\s+/);
      const body = panel(host)!.querySelector<HTMLElement>("[data-fields-body]")!;
      seen.scrolls = (body.getAttribute("class") ?? "").split(/\s+/);
      seen.held = ["header", "[data-fields-foot]"].map((part) => `${part} ${panel(host)!.querySelector(part) !== null && !body.contains(panel(host)!.querySelector(part)) ? "stays" : "scrolls away"}`);
      seen.held.push(`Done ${[...panel(host)!.querySelectorAll("[data-fields-foot] button")].some((button) => button.textContent === "Done") ? "in the foot" : "not in the foot"}`);
      seen.held.push(`the answers ${body.querySelector("[data-path]") ? "in the fields" : "out of the fields"}`);
      // Not in the box too: the canvas stays as it was, with the pressed box lit.
      seen.inBox = stepCard(host, "find").querySelector("[data-step-fields]") !== null;
      seen.states = STEPS.map((step) => stepCard(host, step.id).dataset.state);
      labelled(host, "Change how it starts").click();
      await eventually(() => panel(host)?.querySelector("[data-start-fields]") != null, 2_000, "how it starts");
      seen.start = `${panel(host)!.querySelectorAll("[data-step-fields]").length} ${panel(host)!.querySelector("header")?.textContent}`;
      labelled(host, "Change where its results go").click();
      await eventually(() => panel(host)?.querySelector("[data-results-fields]") != null, 2_000, "where its results go");
      seen.results = `${panel(host)!.querySelectorAll("[data-start-fields]").length} ${panel(host)!.querySelector("header")?.textContent}`;
      labelled(host, "Close where its results go").click();
      await eventually(() => panel(host) === null, 2_000, "the panel closed");
      seen.closed = host.querySelector("main aside")?.textContent ?? "";
    });
    expect(seen.rest).toBe("Recent runsIt has not run yet.");
    // It stays where it is, as tall as the window has room for (measured, with the old guess until it is), and it is
    // not what scrolls: a card scrolled under its edge lost its top and its Done. The card clips, its fields scroll
    // inside it, and its head and foot stand outside them.
    expect(seen.panel).toEqual(expect.arrayContaining(["xl:sticky", "xl:top-4", "xl:max-h-[var(--panel-room,calc(100dvh-13rem))]", "xl:-mb-[var(--panel-room,calc(100dvh-13rem))]", "xl:flex-col", "xl:w-[23.5rem]"]));
    expect(seen.panel.filter((name) => name.includes("overflow"))).toEqual([]);
    expect(seen.card).toEqual(expect.arrayContaining(["xl:flex", "xl:min-h-0", "xl:flex-col", "xl:overflow-hidden"]));
    expect(seen.scrolls).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "xl:overflow-y-auto", "xl:overscroll-contain"]));
    expect(seen.held).toEqual(["header stays", "[data-fields-foot] stays", "Done in the foot", "the answers in the fields"]);
    expect(seen.step).toBe("Step 2 · Ask an agentNouva works on it");
    expect(seen.inBox).toBe(false);
    expect(seen.states).toEqual([undefined, "open", undefined, undefined]);
    expect(seen.start).toBe("0 StartWhen it runs");
    expect(seen.results).toBe("0 ResultsWho runs it, and where it reports");
    expect(seen.closed).toBe("Recent runsIt has not run yet.");
  });

  test("on a phone they open in the box itself, with the moves a pointer finds on the box; whose it is opens over the canvas", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { beside: true, inBox: false, start: false, moved: [] as string[], copied: [] as string[], whose: "" };
    await atWidth(390, async () => {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        editStep(host, 2).click();
        await eventually(() => stepCard(host, "find").querySelector("[data-step-fields]") !== null, 2_000, "the fields in the box");
        seen.inBox = true;
        seen.beside = panel(host) !== null;
        labelled(host, "Move this step down").click();
        await eventually(() => drawn(host)[2] === "find", 2_000, "the step moved");
        seen.moved = drawn(host);
        labelled(host, "Duplicate this step").click();
        await flowDrawn(host, 5);
        seen.copied = drawn(host);
        sent = await saved(host);
        labelled(host, "Change how it starts").click();
        await eventually(() => host.querySelector('main [aria-label="Start"] [data-start-fields]') !== null, 2_000, "how it starts, in its box");
        seen.start = true;
        await openWhose(host);
        // Before the canvas in the page, not in the column beside it.
        const whose = host.querySelector('main section[aria-label="Whose it is"]')!;
        seen.whose = `${whose.closest("aside") === null} ${Boolean(whose.compareDocumentPosition(host.querySelector("[data-flow]")!) & 4)}`;
      });
    });
    expect(seen.inBox).toBe(true);
    expect(seen.beside).toBe(false);
    expect(seen.moved).toEqual(["check", "ok", "find", "tell"]);
    expect(seen.copied).toEqual(["check", "ok", "find", "s5", "tell"]);
    expect((sent[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps).toEqual([CHECK, OK, FIND, { ...FIND, id: "s5" }, TELL]);
    expect(seen.start).toBe(true);
    expect(seen.whose).toBe("true true");
  });
});

describe("the room the canvas has", () => {
  test("a laptop's window has none beside the canvas: with the menu and a panel there its boxes were too narrow for their titles, so a box opens in place up to a desktop's width", async () => {
    shown();
    const seen: Record<number, { inBox: boolean; beside: boolean }> = {};
    for (const px of [1024, 1279, 1280, 1440]) {
      await atWidth(px, async () => {
        await renderPage(PAGE, async (host) => {
          await flowDrawn(host);
          editStep(host, 2).click();
          await eventually(() => host.querySelector("main [data-step-fields]") !== null, 2_000, "the fields");
          seen[px] = { inBox: stepCard(host, "find").querySelector("[data-step-fields]") !== null, beside: panel(host) !== null };
        });
      });
    }
    expect(seen).toEqual({ 1024: { inBox: true, beside: false }, 1279: { inBox: true, beside: false }, 1280: { inBox: false, beside: true }, 1440: { inBox: false, beside: true } });
  });

  test("a lane stands beside its step where the canvas itself has the room, asked of the canvas and not of the window; short of it the lane hangs under its step and every box keeps its width", async () => {
    const LOOK: AutomationStep = { id: "look", kind: "agentTurn", message: "Look into why it failed.", then: { to: "find" } };
    shown({ payload: { kind: "steps", steps: [{ ...CHECK, then: { to: "find" }, whenFailed: { to: "look" } }, LOOK, FIND, OK, TELL] } });
    const seen = { canvas: [] as string[], row: [] as string[], plain: [] as string[], lane: [] as string[], byWindow: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 5);
      const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/);
      seen.canvas = classes(host.querySelector("[data-flow]"));
      // The row of the step that owns the lane: its box in one column, the lane in the other.
      seen.row = classes(stepCard(host, "check").parentElement?.parentElement);
      seen.lane = classes(host.querySelector("[data-lane]")?.parentElement);
      // A happy-dom window lays nothing out, so each is held by the class that places it. Nothing on the canvas is
      // placed by a laptop's or a desktop's window: what a lane asks is the canvas's own width.
      seen.byWindow = [...host.querySelectorAll("[data-flow] *")].flatMap((element) => classes(element).filter((name) => /^(max-)?(lg|xl|2xl):/.test(name)));
    });
    shown();
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.plain = (stepCard(host, "check").parentElement?.parentElement?.getAttribute("class") ?? "").split(/\s+/);
    });
    expect(seen.canvas).toContain("@container/flow");
    // A box of 20rem, the lane's line of 4.5rem and a lane of 15rem: 39.5rem, and a box never narrower than its 21rem short of that.
    expect(seen.row).toEqual(expect.arrayContaining(["mx-auto", "w-full", "max-w-[21rem]", "@[39.5rem]/flow:grid", "@[39.5rem]/flow:max-w-none", "@[39.5rem]/flow:grid-cols-[20rem_15rem]", "@[39.5rem]/flow:gap-x-[4.5rem]"]));
    expect(seen.lane).toEqual(expect.arrayContaining(["@max-[39.5rem]/flow:ml-6", "@max-[39.5rem]/flow:border-l-2", "@max-[39.5rem]/flow:pl-3"]));
    expect(seen.byWindow).toEqual([]);
    // With no lane anywhere there is nothing to make room for.
    expect(seen.plain).toEqual(["mx-auto", "w-full", "max-w-[21rem]"]);
  });
});

describe("steps added on the canvas", () => {
  test("the list of kinds scrolls in itself where the window has no room for all of it, and is not cut off at its own edge", async () => {
    shown();
    let classes: string[] = [];
    let kinds = 0;
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      labelled(host, "Add a step at the end").click();
      const dialog = () => host.ownerDocument.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Add a step"]');
      await eventually(() => dialog() !== null, 2_000, "the picker");
      classes = (dialog()!.getAttribute("class") ?? "").split(/\s+/);
      kinds = dialog()!.querySelectorAll("button").length;
    });
    // Under a button low in the window it was 300 px of a 500 px list, cut where it ended: its last kinds out of reach.
    // Every kind of step, and a mission that is drafted, which is its own entry in the list.
    expect(kinds).toBe(7);
    expect(classes).toContain("overflow-y-auto");
    expect(classes).not.toContain("overflow-hidden");
  });


  test("a step picked for a lane stands at the lane's end, before its mark, and takes the lane's ending", async () => {
    // What runs if the check fails, then back to the step below.
    const LOOK: AutomationStep = { id: "look", kind: "agentTurn", message: "Look into why it failed.", then: { to: "find" } };
    shown({ payload: { kind: "steps", steps: [{ ...CHECK, then: { to: "find" }, whenFailed: { to: "look" } }, LOOK, FIND, OK, TELL] } });
    let sent: { path: string; body: unknown }[] = [];
    const seen = { lane: [] as string[], kicker: "", end: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 5);
      await addStep(host, "Add a step to what runs if it fails", "Send a message");
      await flowDrawn(host, 6);
      const lane = host.querySelector<HTMLElement>('[data-lane="whenFailed"]')!;
      seen.lane = [...lane.querySelectorAll<HTMLElement>('[data-flow-anchor^="step:"]')].map((box) => box.dataset.flowAnchor!.slice(5));
      seen.end = lane.querySelector("[data-lane-end]")?.textContent ?? "";
      await eventually(() => host.querySelector('[data-step-fields="s6"]') !== null, 2_000, "the new step open");
      seen.kicker = host.querySelector('[data-step-fields="s6"] header p')?.textContent ?? "";
      type(field(host, "Message"), "The check failed. What was found is above.");
      sent = await saved(host);
    });
    expect(seen.lane).toEqual(["look", "s6"]);
    expect(seen.kicker).toBe("If it fails · Send a message");
    expect(seen.end).toBe("Then back to step 2, “Nouva works on it”");
    expect((sent[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps).toEqual([
      { ...CHECK, then: { to: "find" }, whenFailed: { to: "look" } },
      { id: "look", kind: "agentTurn", message: "Look into why it failed." },
      // Back into the line at the step right after it: what a step with no path of its own does.
      { id: "s6", kind: "systemEvent", text: "The check failed. What was found is above." },
      FIND,
      OK,
      TELL,
    ]);
  });

  test("a new \"Run a script\" step is a script to write or ask for, opened on its text; Save waits for it one thing at a time", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { box: "", ask: [] as string[], lacks: [] as string[], written: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await addStep(host, "Add a step at the end", "Run a script");
      await flowDrawn(host, 5);
      await eventually(() => host.querySelector('[data-step-fields="s5"]') !== null, 2_000, "the new step open");
      seen.box = stepCard(host, "s5").textContent ?? "";
      seen.ask = [...host.querySelectorAll<HTMLElement>('main [data-step-fields] button[title^="Ask Nouva"]')].map((button) => button.getAttribute("title") ?? "");
      seen.written = dropdown(host, "Written in").holds();
      seen.lacks.push(saveBar(host)?.querySelector("p")?.textContent ?? "");
      type(field(host, "Script"), "date");
      await eventually(() => saveBar(host)?.textContent?.includes("Say what the script does") === true, 2_000, "the next thing");
      seen.lacks.push(saveBar(host)?.querySelector("p")?.textContent ?? "");
      type(field(host, "What it does"), "Says what day it is.");
      sent = await saved(host);
    });
    expect(seen.box).toBe("Run a scriptA script · no AIIf it fails, the run ends, and its chat is told why.");
    expect(seen.ask).toEqual(["Ask Nouva to write this script"]);
    expect(seen.written).toBe("Shell");
    expect(seen.lacks).toEqual(["Step 5: Write the script, or ask an agent to write it.", "Step 5: Say what the script does, in one line."]);
    expect((sent[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps.at(-1)).toEqual({ id: "s5", kind: "command", argv: ["sh"], script: { text: "date", about: "Says what day it is." } });
  });

  /**
   * "Draft a mission" is in the list of what a step can be, beside "Start a mission". As a field inside a mission's
   * step alone it was not found: the list said an automation could only start one.
   */
  test("\"Draft a mission\" is its own entry under the plus: picked, the step drafts, its box and its head say so, and it is saved as that", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { entries: [] as string[], hint: "", box: "", mark: "", head: "", choice: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      labelled(host, "Add a step at the end").click();
      const entries = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Add a step"] button')];
      await eventually(() => entries().length > 0, 2_000, "the picker");
      seen.entries = entries().map((button) => button.querySelector("span span")?.textContent ?? "");
      const draft = entries().find((button) => button.querySelector("span span")?.textContent === "Draft a mission")!;
      seen.hint = draft.querySelectorAll("span span")[1]?.textContent ?? "";
      draft.click();
      await flowDrawn(host, 5);
      await eventually(() => host.querySelector('[data-step-fields="s5"]') !== null, 2_000, "the new step open");
      seen.box = stepCard(host, "s5").querySelector("button")?.textContent ?? "";
      seen.mark = stepCard(host, "s5").querySelector("svg")?.getAttribute("class") ?? "";
      seen.head = host.querySelector('[data-step-fields="s5"]')?.closest("section")?.querySelector("p")?.textContent ?? "";
      seen.choice = dropdown(host, "When the run gets here").holds();
      type(field(host, "Goal"), "Close what is still open.");
      sent = await saved(host);
    });
    expect(seen.entries).toEqual(["Ask an agent", "Run a script", "Send a message", "Start a mission", "Draft a mission", "Wait for your OK", "Several at the same time"]);
    expect(seen.hint).toBe("Long work, left in the Backlog for you to start. The run goes on.");
    expect(seen.box).toStartWith("Draft a mission");
    // Its own mark on the box, not the target of a mission that starts.
    expect(seen.mark).toContain("notebook-pen");
    expect(seen.head).toBe("Step 5 · Draft a mission");
    expect(seen.choice).toBe("Leave it in the Backlog as a draft");
    expect((sent[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps.at(-1)).toEqual({ id: "s5", kind: "mission", goal: "Close what is still open.", draft: true });
  });
});

describe("an automation that stops by itself", () => {
  const LABEL = "Stop by itself after";
  const marks = (host: HTMLElement) => host.querySelector('main section[aria-label="Who and where"] [data-marks]')?.textContent ?? null;
  const results = async (host: HTMLElement) => {
    labelled(host, "Change where its results go").click();
    await eventually(() => host.querySelector("main [data-results-fields]") !== null, 2_000, "where its results go");
  };

  test("is set to a length of time where its results go, said in its box, and sent as that length alone", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { before: "" as string | null, holds: "" as string | null, offered: [] as string[], hint: "", after: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.before = marks(host);
      await results(host);
      seen.holds = dropdown(host, LABEL).holds();
      seen.offered = await dropdown(host, LABEL).open();
      seen.hint = host.querySelector("main [data-results-fields]")?.textContent ?? "";
      await dropdown(host, LABEL).pick("6 hours");
      await eventually(() => marks(host) !== null, 2_000, "its mark");
      seen.after = marks(host);
      sent = await saved(host);
    });
    expect(seen.before).toBeNull();
    expect(seen.holds).toBe("Never");
    expect(seen.offered).toEqual(["Never", "1 hour", "6 hours", "1 day", "1 week", "30 days"]);
    expect(seen.hint).toContain("Counted from when it is turned on. When the time is up it turns itself off, and says so where it reports.");
    expect(seen.after).toBe("It stops by itself after 6 hours.");
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { delivery: { mode: "announce", lasts: 21_600_000 } } }]);
  });

  test("one that has a length holds it, a length no choice names among them; the moment it ends is the server's and is never sent back; Never takes it off", async () => {
    // Ninety minutes, as an agent or the command line may set it, with the moment the server worked out.
    shown({ delivery: { mode: "announce", once: true, lasts: 5_400_000, endsAt: 1_900_000_000_000 } });
    const sent: unknown[] = [];
    const seen = { box: "" as string | null, holds: "" as string | null, offered: [] as string[] };
    for (const pick of ["1 day", "Never"]) {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        seen.box = marks(host);
        await results(host);
        seen.holds = dropdown(host, LABEL).holds();
        seen.offered = await dropdown(host, LABEL).open();
        await dropdown(host, LABEL).pick(pick);
        sent.push((await saved(host))[0]?.body);
      });
    }
    expect(seen.box).toBe("It tells once, then turns itself off. It stops by itself after 90 minutes.");
    expect(seen.holds).toBe("90 minutes");
    expect(seen.offered).toEqual(["Never", "1 hour", "90 minutes", "6 hours", "1 day", "1 week", "30 days"]);
    expect(sent).toEqual([{ delivery: { mode: "announce", once: true, lasts: 86_400_000 } }, { delivery: { mode: "announce", once: true } }]);
  });

  test("is asked only of one that runs again and again at a time: started by hand it has no clock to stop on, and its length is not sent", async () => {
    shown({ delivery: { mode: "announce", lasts: 3_600_000, endsAt: 1_900_000_000_000 } });
    let sent: { path: string; body: unknown }[] = [];
    const seen = { scheduled: false, byHand: true, box: "" as string | null };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await results(host);
      seen.scheduled = dropdown(host, LABEL).button() !== undefined;
      labelled(host, "Change how it starts").click();
      await eventually(() => host.querySelector('main [data-start-fields] [role="radiogroup"]') !== null, 2_000, "how it starts");
      [...host.querySelectorAll<HTMLElement>('main [data-start-fields] [role="radio"]')].find((choice) => choice.querySelector("span")?.textContent === "Manual")!.click();
      await eventually(() => saveBar(host) !== null, 2_000, "something to save");
      seen.box = marks(host);
      await results(host);
      seen.byHand = dropdown(host, LABEL).button() !== undefined;
      sent = await saved(host);
    });
    expect(seen.scheduled).toBe(true);
    expect(seen.byHand).toBe(false);
    expect(seen.box).toBeNull();
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { manual: true, delivery: { mode: "announce" } } }]);
  });

  test("once its time is up its page says so as information, apart from one that told or kept failing, and that turning it on gives it the time again", async () => {
    const off = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("main header [data-off]")].map((note) => `${note.dataset.off}: ${note.textContent} ${note.getAttribute("class")?.includes("text-info") ? "info" : "other"}`);
    const seen: Record<string, string[]> = {};
    for (const [name, one] of [
      ["ended", automation({ enabled: false, disabledReason: "ended", delivery: { mode: "announce", lasts: 3_600_000 } })],
      ["told", automation({ enabled: false, disabledReason: "told", delivery: { mode: "announce", once: true } })],
      ["reader", automation({ enabled: false, disabledReason: "ended", person: { key: "gading", name: "Gading" }, changeable: false })],
      ["running", automation({ delivery: { mode: "announce", lasts: 3_600_000 } })],
    ] as const) {
      answer({ [PAGE]: detail(one), ...TWO_AGENTS, ...(name === "reader" ? { "/auth/me": ok({ kind: "user", role: "operator", actor: "tester", user: { id: "usr_1", username: "tester", displayName: "", role: "operator", createdAt: 1, updatedAt: 1, mustChangePassword: false, lastLoginAt: null, hasPassword: true } }) } : {}) });
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        seen[name] = off(host);
      });
    }
    expect(seen.ended).toEqual(["ended: It ran for the time it was given, and turned itself off. Turn it on to give it that time again. info"]);
    expect(seen.told).toEqual(["told: It told you, and turned itself off. Turn it on to be told again. info"]);
    // One who only reads it is told what happened, and offered nothing.
    expect(seen.reader).toEqual(["ended: It ran for the time it was given, and turned itself off. info"]);
    expect(seen.running).toEqual([]);
  });
});

describe("the canvas, closed and read", () => {
  test("a box pressed again closes; an account that only looks is given words and no box to press", async () => {
    shown();
    const seen = { open: false, closed: false };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 1).click();
      await eventually(() => closeStep(host, 1) !== null, 2_000, "the step open");
      seen.open = host.querySelector('[data-step-fields="check"]') !== null;
      closeStep(host, 1).click();
      await eventually(() => editStep(host, 1) !== null, 2_000, "the step closed");
      seen.closed = host.querySelector("[data-step-fields]") === null;
    });
    expect(seen).toEqual({ open: true, closed: true });
  });
});
