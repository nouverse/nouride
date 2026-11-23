/**
 * An automation's steps, edited on its page: a step added between two cards, each kind's fields written in place, a
 * step copied, deleted and put back, moved by its menu, its handle's keys and a drag, and where the run goes from a
 * step set, drawn, and put back when a move would turn it backward. Each ends in the one thing that matters: what Save
 * sends is exactly the list on the page.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AutomationStep } from "@nouride/wire";
import { answer, dropdown, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { addStep, AS_VIEWER, automation, barButton, closeStep, detail, drawn, editStep, field, flowDrawn, labelled, ok, saveBar, stepCard, stepMenu, STEPS, TWO_AGENTS } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const PAGE = "/automations/cron_e";
const [CHECK, FIND, OK, TELL] = STEPS as [AutomationStep, AutomationStep, AutomationStep, AutomationStep];
const shown = (steps: AutomationStep[] = STEPS) => answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps } })), ...TWO_AGENTS });

/** Save pressed, and the one body it sent. */
async function saved(host: HTMLElement): Promise<{ path: string; body: unknown }[]> {
  const record = recordPosts({ "/cron/cron_e": ok({ job: automation() }) });
  await eventually(() => barButton(host, "Save")?.disabled === false, 2_000, "Save offered");
  barButton(host, "Save")!.click();
  await eventually(() => record.posts.length > 0, 2_000, "the save");
  record.restore();
  return record.posts;
}
const steps = (posts: { path: string; body: unknown }[]) => (posts[0]?.body as { payload: { steps: AutomationStep[] } }).payload.steps;

describe("adding, copying and deleting", () => {
  test("a step added on the line between two cards opens to be written, and Save waits for what it lacks", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { before: false, lacks: "", disabled: false, order: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      // Nothing changed yet: no bar.
      seen.before = saveBar(host) !== null;
      await addStep(host, "Add a step before step 2", "Send a message");
      await flowDrawn(host, 5);
      seen.order = drawn(host);
      seen.lacks = saveBar(host)?.textContent ?? "";
      seen.disabled = barButton(host, "Save")?.disabled === true;
      type(field(host, "Message"), "Checking the shop.");
      sent = await saved(host);
    });
    expect(seen.before).toBe(false);
    expect(seen.order).toEqual(["check", "s5", "find", "ok", "tell"]);
    expect(seen.lacks).toContain("Step 2: Write the message to send.");
    expect(seen.disabled).toBe(true);
    expect(sent).toEqual([{ path: "/cron/cron_e", body: { payload: { kind: "steps", steps: [CHECK, { id: "s5", kind: "systemEvent", text: "Checking the shop." }, FIND, OK, TELL] } } }]);
  });

  test("a copy stands after its step; a deleted step is put back by Undo, where it was", async () => {
    shown();
    const seen = { copied: [] as string[], deleted: [] as string[], toast: "", undone: [] as string[] };
    let sent: { path: string; body: unknown }[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await stepMenu(host, 2, "Duplicate");
      await flowDrawn(host, 5);
      seen.copied = drawn(host);
      await stepMenu(host, 1, "Delete");
      await flowDrawn(host, 4);
      seen.deleted = drawn(host);
      const undo = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Undo");
      await eventually(() => undo() !== undefined, 2_000, "the Undo");
      seen.toast = undo()!.closest('[role="status"]')?.textContent ?? "";
      undo()!.click();
      await flowDrawn(host, 5);
      seen.undone = drawn(host);
      sent = await saved(host);
    });
    expect(seen.copied).toEqual(["check", "find", "s5", "ok", "tell"]);
    expect(seen.deleted).toEqual(["find", "s5", "ok", "tell"]);
    expect(seen.toast).toContain("Step 1 deleted");
    expect(seen.undone).toEqual(["check", "find", "s5", "ok", "tell"]);
    expect(steps(sent)).toEqual([CHECK, FIND, { ...FIND, id: "s5" }, OK, TELL]);
  });

  test("at twenty steps nothing more is offered, and the page says why", async () => {
    shown(Array.from({ length: 20 }, (_, n) => ({ id: `s${n + 1}`, kind: "systemEvent", text: "x" })));
    const seen = { plus: -1, said: "", copy: false };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 20);
      seen.plus = host.querySelectorAll('[aria-label^="Add a step"]').length;
      seen.said = host.querySelector("[data-flow]")?.textContent ?? "";
      labelled(host, "More for step 1").click();
      const copy = () => [...host.ownerDocument.body.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find((button) => button.textContent?.trim() === "Duplicate");
      await eventually(() => copy() !== undefined, 2_000, "the menu");
      seen.copy = copy()!.disabled;
    });
    expect(seen.plus).toBe(0);
    expect(seen.said).toContain("An automation runs at most 20 steps.");
    expect(seen.copy).toBe(true);
  });

  test("an account that only looks reads the steps and can change none of them", async () => {
    shown();
    answer({ [PAGE]: detail(automation()), ...TWO_AGENTS, ...AS_VIEWER });
    const seen = { edits: -1, plus: -1, grips: -1, name: false };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.edits = host.querySelectorAll('[aria-label^="Edit step"], [aria-label^="More for step"]').length;
      seen.plus = host.querySelectorAll('[aria-label^="Add a step"]').length;
      seen.grips = host.querySelectorAll('[aria-label^="Move step"]').length;
      seen.name = host.querySelector('input[aria-label="Name"]') !== null;
    });
    expect(seen).toEqual({ edits: 0, plus: 0, grips: 0, name: false });
  });
});

describe("each kind, written in its card", () => {
  test("a command's line and limit, an agent's words and who does it, a wait's question and how long, a name, and another kind", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { titles: [] as string[], agents: [] as string[], kinds: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 1).click();
      await eventually(() => host.textContent?.includes("Give up after (seconds)") === true, 2_000, "the command's fields");
      type(field(host, "Command"), "ls -la");
      type(field(host, "Give up after (seconds)"), "30");

      editStep(host, 2).click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the agent's fields");
      type(field(host, "What to ask"), "Look into it.");
      seen.agents = await dropdown(host, "Who does it").open();
      await dropdown(host, "Who does it").pick("Nix");

      editStep(host, 3).click();
      await eventually(() => host.textContent?.includes("Wait for an answer for") === true, 2_000, "the wait's fields");
      type(field(host, "Question"), "Post it?");
      await dropdown(host, "Wait for an answer for").pick("1 hour");

      editStep(host, 4).click();
      await eventually(() => field(host, "Name") !== null && host.textContent?.includes("Sent as written") === true, 2_000, "the message's fields");
      type(field(host, "Name"), "Say so");
      // What kind of step it is, with the rest that is set once: under "More about this step".
      seen.kinds = await dropdown(host, "Kind of step").open();
      await dropdown(host, "Kind of step").pick("Start a mission");
      await eventually(() => host.textContent?.includes("The run waits here until the mission ends") === true, 2_000, "the mission's fields");
      seen.titles = STEPS.map((step) => stepCard(host, step.id).querySelector("button")?.textContent ?? "");
      sent = await saved(host);
    });
    expect(seen.agents).toEqual(["Nouva, who runs this automation", "Nix"]);
    expect(seen.kinds).toEqual(["Ask an agent", "Run a script", "Send a message", "Start a mission", "Wait for your OK", "Several at the same time"]);
    // A box is a title and one line: what its kind does or its name, then the start of its words.
    expect(seen.titles[0]).toBe("Run a scriptls -la");
    // Another agent's step says whose it is.
    expect(seen.titles[1]).toBe("Nix works on itLook into it.");
    expect(seen.titles[3]).toBe("Say soThe shop was down.");
    expect(steps(sent)).toEqual([
      { id: "check", kind: "command", argv: ["sh", "-lc", "ls -la"], timeoutMs: 30_000 },
      { id: "find", kind: "agentTurn", message: "Look into it.", agentId: "nix" },
      { id: "ok", kind: "approval", ask: "Post it?", timeoutMs: 3_600_000 },
      // The words it held are the new kind's: a message's text is the mission's goal.
      { id: "tell", name: "Say so", kind: "mission", goal: "The shop was down." },
    ]);
  });

  test("a step left with something missing says so on its card, and Discard changes puts the page back", async () => {
    shown();
    const seen = { card: "", state: "", bar: "", after: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 2).click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the fields");
      type(field(host, "What to ask"), " ");
      // Still being written: not told. Left behind: told.
      expect(stepCard(host, "find").querySelector('[role="alert"]')).toBeNull();
      closeStep(host, 2).click();
      await eventually(() => stepCard(host, "find").querySelector('[role="alert"]') !== null, 2_000, "the card's problem");
      seen.card = stepCard(host, "find").querySelector('[role="alert"]')?.textContent ?? "";
      seen.state = stepCard(host, "find").dataset.state ?? "";
      seen.bar = saveBar(host)?.textContent ?? "";
      barButton(host, "Discard changes")!.click();
      await eventually(() => saveBar(host) === null, 2_000, "the bar gone");
      seen.after = stepCard(host, "find").textContent ?? "";
    });
    expect(seen.card).toBe("Write what to ask the agent.");
    // Its own mark, apart from a step that failed in a run.
    expect(seen.state).toBe("lacking");
    expect(seen.bar).toContain("Step 2: Write what to ask the agent.");
    expect(seen.after).toContain("Find out why the shop is down.");
  });
});

describe("another order", () => {
  let real: () => DOMRect;
  // Cards a hundred pixels tall, one under the other, as a browser lays them out: the DOM here has no layout.
  beforeEach(() => {
    const proto = (window as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
    real = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset?.reorderKey === undefined || !this.parentElement) return real.call(this);
      const at = [...this.parentElement.children].indexOf(this);
      return { top: at * 100, bottom: at * 100 + 100, height: 100, left: 0, right: 300, width: 300, x: 0, y: at * 100 } as DOMRect;
    };
  });
  afterEach(() => {
    (window as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype.getBoundingClientRect = real;
  });

  test("by a step's menu, by the arrow keys on its handle, and by dragging the handle: what Save sends is the order on the page", async () => {
    shown();
    const seen = { menu: [] as string[], keys: [] as string[], dragged: [] as string[] };
    let sent: { path: string; body: unknown }[] = [];
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await stepMenu(host, 4, "Move up");
      await eventually(() => drawn(host)[2] === "tell", 2_000, "tell moved up");
      seen.menu = drawn(host);
      const Key = (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
      host.querySelector<HTMLElement>('[aria-label^="Move step 1:"]')!.dispatchEvent(new Key("keydown", { key: "ArrowDown", bubbles: true }));
      await eventually(() => drawn(host)[1] === "check", 2_000, "check moved down");
      seen.keys = drawn(host);
      // The last card held by its handle and carried to the top.
      const Mouse = (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
      host.querySelector<HTMLElement>('[aria-label^="Move step 4:"]')!.dispatchEvent(new Mouse("pointerdown", { clientY: 350, button: 0, bubbles: true }));
      const heldCard = () => host.querySelector<HTMLElement>("[data-reorder-key][data-held]");
      await eventually(() => heldCard() !== null, 2_000, "the card held");
      window.dispatchEvent(new Mouse("pointermove", { clientY: 20, bubbles: true }));
      await eventually(() => heldCard()?.style.transform === "translateY(-330px)", 2_000, "the card following the pointer");
      window.dispatchEvent(new Mouse("pointerup", { clientY: 20, bubbles: true }));
      await eventually(() => drawn(host)[0] === "ok", 2_000, "ok put down first");
      seen.dragged = drawn(host);
      sent = await saved(host);
    });
    expect(seen.menu).toEqual(["check", "find", "tell", "ok"]);
    expect(seen.keys).toEqual(["find", "check", "tell", "ok"]);
    expect(seen.dragged).toEqual(["ok", "find", "check", "tell"]);
    expect(steps(sent)).toEqual([OK, FIND, CHECK, TELL]);
  });
});

/** One of a step's paths as the open fields ask it: its answers by what each is called, and a press on one. */
type Asked = "whenFailed" | "whenEmpty";
const pathOf = (host: HTMLElement, exit: Asked) => host.querySelector<HTMLElement>(`[data-path="${exit}"]`);
const answers = (host: HTMLElement, exit: Asked) => [...(pathOf(host, exit)?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
const called = (one: HTMLElement) => one.querySelector("span")?.textContent ?? "";
const answerNames = (host: HTMLElement, exit: Asked) => answers(host, exit).map(called);
const chosen = (host: HTMLElement, exit: Asked) => answers(host, exit).filter((one) => one.getAttribute("aria-checked") === "true").map(called);
const choose = (host: HTMLElement, exit: Asked, name: string) => answers(host, exit).find((one) => called(one) === name)!.click();
const pressed = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.trim() === label);

describe("where the run goes from a step", () => {
  test("what a failure does is asked with four answers; going on and asking first are said in the step's own box, and saved as the shape that runs them", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { before: 0, offered: [] as string[], first: [] as string[], goOn: "", unwritten: "", ask: "", boxes: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      // Nothing a step says for itself: no strip, no lane, no chip, no line.
      seen.before = host.querySelectorAll("[data-rule], [data-lane], [data-branch], [data-flow-link]").length;
      editStep(host, 1).click();
      await eventually(() => pathOf(host, "whenFailed") !== null, 2_000, "the question");
      seen.offered = answerNames(host, "whenFailed");
      seen.first = chosen(host, "whenFailed");

      choose(host, "whenFailed", "Go on anyway");
      await eventually(() => stepCard(host, "check").querySelector('[data-rule-kind="goOn"]') !== null, 2_000, "the strip");
      seen.goOn = stepCard(host, "check").querySelector("[data-rule]")?.textContent ?? "";

      choose(host, "whenFailed", "Ask me first");
      await eventually(() => stepCard(host, "check").querySelector('[data-rule-kind="ask"]') !== null, 2_000, "the question's strip");
      seen.unwritten = stepCard(host, "check").querySelector("[data-rule]")?.textContent ?? "";
      type(labelled(host, "Question to ask if it fails") as HTMLTextAreaElement, "The shop check failed. Go on anyway?");
      await eventually(() => stepCard(host, "check").querySelector("[data-rule]")?.textContent?.includes("Go on anyway?") === true, 2_000, "the question in the box");
      seen.ask = stepCard(host, "check").querySelector("[data-rule]")?.textContent ?? "";
      // The wait it asks with is no box of its own: the steps drawn are the four there were.
      seen.boxes = drawn(host);
      sent = await saved(host);
    });
    expect(seen.before).toBe(0);
    expect(seen.offered).toEqual(["Stop and tell me", "Go on anyway", "Ask me first", "Do something else"]);
    expect(seen.first).toEqual(["Stop and tell me"]);
    expect(seen.goOn).toBe("If it fails, the run goes on anyway.");
    expect(seen.unwritten).toContain("Write the question to ask.");
    // The question, and where each answer leads, in the box.
    expect(seen.ask).toBe("If it fails, it asks you:“The shop check failed. Go on anyway?”Yes goes onNo stops here");
    expect(seen.boxes).toEqual(["check", "find", "ok", "tell"]);
    // The wait stands right after its step, which passes it over when done: the main line never falls into it.
    expect(steps(sent)).toEqual([{ ...CHECK, then: { to: "find" }, whenFailed: { to: "s5" } }, { id: "s5", kind: "approval", ask: "The shop check failed. Go on anyway?", then: { to: "find" } }, FIND, OK, TELL]);
  });

  test("a question nobody wrote is said on its step's box once the step is left, and Save waits for it", async () => {
    shown();
    const seen = { card: "", state: "", bar: "", disabled: false };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 1).click();
      await eventually(() => pathOf(host, "whenFailed") !== null, 2_000, "the question");
      choose(host, "whenFailed", "Ask me first");
      await eventually(() => stepCard(host, "check").querySelector('[data-rule-kind="ask"]') !== null, 2_000, "the question's strip");
      closeStep(host, 1).click();
      await eventually(() => stepCard(host, "check").querySelector('[role="alert"]') !== null, 2_000, "the box's problem");
      seen.card = stepCard(host, "check").querySelector('[role="alert"]')?.textContent ?? "";
      seen.state = stepCard(host, "check").dataset.state ?? "";
      seen.bar = saveBar(host)?.textContent ?? "";
      seen.disabled = barButton(host, "Save")?.disabled === true;
    });
    expect(seen.card).toBe("Write the question to ask.");
    expect(seen.state).toBe("lacking");
    expect(seen.bar).toContain("Write the question to ask.");
    expect(seen.disabled).toBe(true);
  });

  test("other steps in its place hang in a lane at its side that ends in a mark; another answer takes them along, with a way back", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { boxes: [] as string[], lane: "", kicker: "", told: [] as string[], ends: [] as string[], back: "", stop: "", toast: "", gone: [] as string[], undone: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 1).click();
      await eventually(() => pathOf(host, "whenFailed") !== null, 2_000, "the question");
      choose(host, "whenFailed", "Do something else");
      // Its first step is drawn beside the step, and opened to be written.
      await flowDrawn(host, 5);
      seen.boxes = drawn(host);
      const lane = () => host.querySelector<HTMLElement>('[data-lane="whenFailed"]')!;
      seen.lane = lane().querySelector("p")?.textContent ?? "";
      await eventually(() => host.querySelector('[data-step-fields="s5"]') !== null, 2_000, "the lane's step open");
      seen.kicker = host.querySelector('[data-step-fields="s5"] header p')?.textContent ?? "";
      // A step of a lane answers for its own failure, with the two answers that need no drawing of their own; and
      // where its lane ends is set from it, as from the step the lane hangs on.
      seen.told = answerNames(host, "whenFailed");
      seen.ends = [...host.querySelectorAll<HTMLElement>('[data-step-fields="s5"] [data-lane-end-field] button')].map((button) => `${button.textContent}${button.getAttribute("aria-pressed") === "true" ? " ✓" : ""}`);
      type(field(host, "What to ask"), "Look into why it failed.");
      seen.back = lane().querySelector("[data-lane-end]")?.textContent ?? "";

      editStep(host, 1).click();
      await eventually(() => pressed(host, "Then stop") !== undefined, 2_000, "the lane's end");
      pressed(host, "Then stop")!.click();
      await eventually(() => lane().querySelector('[data-lane-end="stop"]') !== null, 2_000, "the stop");
      seen.stop = lane().querySelector("[data-lane-end]")?.textContent ?? "";

      choose(host, "whenFailed", "Stop and tell me");
      await flowDrawn(host, 4);
      seen.gone = drawn(host);
      await eventually(() => pressed(host.ownerDocument.body, "Undo") !== undefined, 2_000, "the Undo");
      seen.toast = pressed(host.ownerDocument.body, "Undo")!.parentElement?.textContent ?? "";
      pressed(host.ownerDocument.body, "Undo")!.click();
      await flowDrawn(host, 5);
      seen.undone = drawn(host);
      sent = await saved(host);
    });
    // In the list right after its step; on the canvas beside it, off the main line.
    expect(seen.boxes).toEqual(["check", "s5", "find", "ok", "tell"]);
    expect(seen.lane).toBe("If it fails");
    expect(seen.kicker).toBe("If it fails · Ask an agent");
    expect(seen.told).toEqual(["Stop and tell me", "Go on anyway"]);
    expect(seen.ends).toEqual(["Go back to step 2, “Nouva works on it” ✓", "Stop"]);
    expect(seen.back).toBe("Then back to step 2, “Nouva works on it”");
    expect(seen.stop).toBe("The run stops here");
    expect(steps(sent)).toEqual([{ ...CHECK, then: { to: "find" }, whenFailed: { to: "s5" } }, { id: "s5", kind: "agentTurn", message: "Look into why it failed.", then: "end" }, FIND, OK, TELL]);
    expect(seen.gone).toEqual(["check", "find", "ok", "tell"]);
    expect(seen.toast).toContain("went with it");
    expect(seen.undone).toEqual(["check", "s5", "find", "ok", "tell"]);
  });

  test("a question changed for other steps: the wait goes, and the lane's first step opens to be written though it takes the id the wait had", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { asked: [] as string[], open: "", kicker: "", boxes: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 1).click();
      await eventually(() => pathOf(host, "whenFailed") !== null, 2_000, "the question");
      choose(host, "whenFailed", "Ask me first");
      await eventually(() => stepCard(host, "check").querySelector('[data-rule-kind="ask"]') !== null, 2_000, "the question's strip");
      type(labelled(host, "Question to ask if it fails") as HTMLTextAreaElement, "Go on anyway?");
      choose(host, "whenFailed", "Do something else");
      // The wait was step s5, and so is the step that takes its place: found by what the choice made, not by an id
      // the list did not hold before.
      await eventually(() => host.querySelector('[data-lane="whenFailed"]') !== null, 2_000, "the lane");
      await eventually(() => host.querySelector('[data-step-fields="s5"] header p')?.textContent === "If it fails · Ask an agent", 2_000, "the lane's step open");
      seen.open = host.querySelector("main [data-step-fields]")?.getAttribute("data-step-fields") ?? "";
      seen.kicker = host.querySelector('[data-step-fields="s5"] header p')?.textContent ?? "";
      seen.asked = [...host.querySelectorAll("[data-rule]")].map((rule) => rule.textContent ?? "");
      seen.boxes = drawn(host);
      type(field(host, "What to ask"), "Look into why it failed.");
      sent = await saved(host);
    });
    expect(seen.open).toBe("s5");
    expect(seen.kicker).toBe("If it fails · Ask an agent");
    expect(seen.asked).toEqual([]);
    expect(seen.boxes).toEqual(["check", "s5", "find", "ok", "tell"]);
    expect(steps(sent)).toEqual([{ ...CHECK, then: { to: "find" }, whenFailed: { to: "s5" } }, { id: "s5", kind: "agentTurn", message: "Look into why it failed.", then: { to: "find" } }, FIND, OK, TELL]);
  });

  test("a path written elsewhere that the canvas has no drawing for is a chip and a line to where it lands, and is offered as it is until it is changed", async () => {
    // A failure that leads to a step the main line reaches too, and a step that ends the run early.
    shown([{ ...CHECK, whenFailed: { to: "tell" }, then: "end" }, FIND, OK, TELL]);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { chips: [] as string[], links: [] as (string | null)[], lit: "", target: "", offered: [] as string[], now: [] as string[], done: [] as string[], after: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await eventually(() => host.querySelectorAll("[data-branch]").length === 2, 2_000, "the chips");
      seen.chips = [...host.querySelectorAll("[data-branch]")].map((chip) => chip.textContent ?? "");
      await eventually(() => host.querySelector("[data-flow-link]") !== null, 2_000, "the line");
      seen.links = [...host.querySelectorAll("[data-flow-link]")].map((link) => link.getAttribute("data-flow-link"));
      // The pointer on the chip lights its line and the box it lands on.
      const chip = host.querySelector<HTMLElement>('[data-branch="whenFailed"]')!;
      chip.dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("mouseover", { bubbles: true }));
      await eventually(() => host.querySelector("[data-flow-link]")?.getAttribute("data-state") === "active", 2_000, "the line lit");
      seen.lit = host.querySelector("[data-flow-link]")?.getAttribute("data-state") ?? "";
      seen.target = stepCard(host, "tell").dataset.state ?? "";

      editStep(host, 1).click();
      await eventually(() => pathOf(host, "whenFailed") !== null, 2_000, "the question");
      seen.offered = answerNames(host, "whenFailed");
      seen.now = chosen(host, "whenFailed");
      // Where it goes when done is asked only of a step that does not go on to the one drawn below.
      seen.done = await dropdown(host, "When it is done").open();
      await dropdown(host, "When it is done").pick("Go on to the next step");
      await eventually(() => host.querySelectorAll("[data-branch]").length === 1, 2_000, "one chip left");
      choose(host, "whenFailed", "Stop and tell me");
      await eventually(() => host.querySelectorAll("[data-branch]").length === 0, 2_000, "the chips gone");
      seen.after = host.querySelectorAll("[data-flow-link]").length;
      sent = await saved(host);
    });
    expect(seen.chips).toEqual(["Once doneend here", "If it failsstep 4, Tell the group"]);
    // Ending the run is no jump: only the path to a later step is a line.
    expect(seen.links).toEqual(["check:whenFailed"]);
    expect([seen.lit, seen.target]).toEqual(["active", "target"]);
    // With the run ending after it, there is nothing to go on to: the answer it holds is the one more offered.
    expect(seen.offered).toEqual(["Stop and tell me", "Do something else", "Go to step 4, Tell the group"]);
    expect(seen.now).toEqual(["Go to step 4, Tell the group"]);
    expect(seen.done).toEqual(["Go on to the next step", "End the run here", "Jump to step 3, Wait for your OK", "Jump to step 4, Tell the group"]);
    expect(seen.after).toBe(0);
    expect(steps(sent)).toEqual([CHECK, FIND, OK, TELL]);
  });

  test("the last step has nothing to go on to: a path that says to is no rule, and neither going on nor asking first is offered on it", async () => {
    // As an agent or the command line may write it, and as the page once let a person set it: "go on" with no step to go on to.
    shown([CHECK, { ...FIND, whenFailed: "next", whenEmpty: "next", then: "end" }]);
    const seen = { drawn: 0, last: [] as string[], lastNow: [] as string[], silent: [] as string[], middle: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 2);
      seen.drawn = host.querySelectorAll("[data-branch], [data-rule], [data-lane]").length;
      editStep(host, 2).click();
      await eventually(() => host.querySelector('[data-step-fields="find"]') !== null, 2_000, "the last step's fields");
      seen.last = answerNames(host, "whenFailed");
      seen.lastNow = chosen(host, "whenFailed");
      seen.silent = answerNames(host, "whenEmpty");
      // The step before it has a step to go on to.
      editStep(host, 1).click();
      await eventually(() => host.querySelector('[data-step-fields="check"]') !== null, 2_000, "a middle step's fields");
      seen.middle = answerNames(host, "whenFailed");
    });
    expect(seen.drawn).toBe(0);
    expect(seen.last).toEqual(["Stop and tell me", "Do something else"]);
    expect(seen.lastNow).toEqual(["Stop and tell me"]);
    expect(seen.silent).toEqual(["Stop quietly", "Do something else"]);
    expect(seen.middle).toEqual(["Stop and tell me", "Go on anyway", "Ask me first", "Do something else"]);
  });

  test("a message has one way out, and is asked nothing of where the run goes", async () => {
    shown();
    let paths = -1;
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 4).click();
      await eventually(() => host.querySelector('[data-step-fields="tell"]') !== null, 2_000, "the message's fields");
      paths = host.querySelectorAll("[data-path]").length;
    });
    expect(paths).toBe(0);
  });

  test("a move that would turn a path backward puts it back to its default, and the box says so", async () => {
    shown([{ ...CHECK, whenFailed: { to: "ok" } }, FIND, OK, TELL]);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { chips: 0, beside: "", note: "", after: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.chips = host.querySelectorAll("[data-branch]").length;
      // The step it points at, carried above it.
      await stepMenu(host, 3, "Move up");
      await eventually(() => drawn(host)[1] === "ok", 2_000, "ok above find");
      // Right after its step, the step it led to is where the run goes anyway: no jump any more, a rule of its box.
      seen.beside = `${host.querySelectorAll("[data-branch]").length} ${stepCard(host, "check").querySelector("[data-rule]")?.textContent}`;
      await stepMenu(host, 2, "Move up");
      await eventually(() => drawn(host)[0] === "ok", 2_000, "ok above check");
      await eventually(() => stepCard(host, "check").querySelector('[role="status"]') !== null, 2_000, "the note");
      seen.note = stepCard(host, "check").querySelector('[role="status"] span')?.textContent ?? "";
      seen.after = host.querySelectorAll("[data-branch], [data-flow-link]").length;
      sent = await saved(host);
    });
    expect(seen.chips).toBe(1);
    expect(seen.beside).toBe("0 If it fails, the run goes on anyway.");
    expect(seen.note).toBe('"If it fails" led to a step that is no longer after this one, so it is back to: end the run, as failed.');
    expect(seen.after).toBe(0);
    expect(steps(sent)).toEqual([OK, CHECK, FIND, TELL]);
  });

  test("a deleted step takes the paths that led to it, each said on its card until it is read", async () => {
    shown([{ ...CHECK, whenFailed: { to: "tell" }, whenEmpty: { to: "tell" } }, FIND, OK, TELL]);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { notes: [] as string[], left: -1 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      await stepMenu(host, 4, "Delete");
      await flowDrawn(host, 3);
      const notes = () => [...stepCard(host, "check").querySelectorAll('[role="status"]')];
      await eventually(() => notes().length === 2, 2_000, "the notes");
      seen.notes = notes().map((note) => note.querySelector("span")?.textContent ?? "");
      (notes()[0]!.querySelector("button") as HTMLElement).click();
      await eventually(() => notes().length === 1, 2_000, "one read");
      seen.left = notes().length;
      sent = await saved(host);
    });
    expect(seen.notes).toEqual([
      '"If it fails" led to a step that was deleted, so it is back to: end the run, as failed.',
      '"With nothing to say" led to a step that was deleted, so it is back to: end the run quietly.',
    ]);
    expect(seen.left).toBe(1);
    expect(steps(sent)).toEqual([CHECK, FIND, OK]);
  });
});

describe("what a failure does is seen on the canvas, whatever the answer", () => {
  test("a step left at a stop says so in its box, as one given another answer says that; a message, which cannot fail, says nothing", async () => {
    shown();
    const seen = { stops: {} as Record<string, string>, marks: 0, after: "", rule: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      const stop = (id: string) => stepCard(host, id).querySelector("[data-stops]")?.textContent ?? "";
      for (const step of STEPS) seen.stops[step.id] = stop(step.id);
      // Each with a stop's mark before its words: the flag a person looks for.
      seen.marks = host.querySelectorAll("[data-stops] svg").length;
      editStep(host, 1).click();
      await eventually(() => pathOf(host, "whenFailed") !== null, 2_000, "the question");
      choose(host, "whenFailed", "Go on anyway");
      await eventually(() => stepCard(host, "check").querySelector('[data-rule-kind="goOn"]') !== null, 2_000, "going on, in the box");
      seen.after = stop("check");
      seen.rule = stepCard(host, "check").querySelector("[data-rule]")?.textContent ?? "";
    });
    expect(seen.stops).toEqual({
      check: "If it fails, the run ends, and its chat is told why.",
      find: "If it fails, the run ends, and its chat is told why.",
      ok: "If you say no, the run ends. Nothing is counted as failed.",
      tell: "",
    });
    expect(seen.marks).toBe(3);
    expect(seen.after).toBe("");
    expect(seen.rule).toBe("If it fails, the run goes on anyway.");
  });
});

describe("a lane, changed from the lane itself", () => {
  const LOOK: AutomationStep = { id: "look", kind: "agentTurn", message: "Look into why it failed.", then: { to: "find" } };
  const LANED: AutomationStep[] = [{ ...CHECK, then: { to: "find" }, whenFailed: { to: "look" } }, LOOK, FIND, OK, TELL];
  const lane = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-lane="whenFailed"]')!;
  const end = (host: HTMLElement) => lane(host).querySelector<HTMLElement>("[data-lane-end]")!;

  test("its end is its mark, pressed: back into the line at a step named by its place, or a stop; and the same from a step of the lane's own fields", async () => {
    shown(LANED);
    const seen = { mark: "", offered: [] as string[], stopped: "", field: [] as string[], back: "" };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 5);
      seen.mark = end(host).textContent ?? "";
      end(host).querySelector("button")!.click();
      const items = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')];
      await eventually(() => items().length === 2, 2_000, "the two ends");
      seen.offered = items().map((item) => `${item.textContent}${item.getAttribute("aria-checked") === "true" ? " ✓" : ""}`);
      items()[1]!.click();
      await eventually(() => end(host).dataset.laneEnd === "stop", 2_000, "the stop");
      seen.stopped = end(host).textContent ?? "";

      // And from the lane's own step, where "set on that step" used to send a person looking.
      host.querySelector<HTMLElement>('[aria-label^="Edit the side step"]')!.click();
      await eventually(() => host.querySelector('[data-step-fields="look"] [data-lane-end-field]') !== null, 2_000, "the lane's end, in its step's fields");
      const ends = () => [...host.querySelectorAll<HTMLElement>('[data-step-fields="look"] [data-lane-end-field] button')];
      seen.field = ends().map((button) => `${button.textContent}${button.getAttribute("aria-pressed") === "true" ? " ✓" : ""}`);
      ends()[0]!.click();
      await eventually(() => end(host).dataset.laneEnd === "back", 2_000, "back into the line");
      seen.back = end(host).textContent ?? "";
      // Stopped and put back: as it was, so there is nothing to save.
      await eventually(() => saveBar(host) === null, 2_000, "nothing left to save");
    });
    expect(seen.mark).toBe("Then back to step 2, “Nouva works on it”");
    expect(seen.offered).toEqual(["Then back to step 2, “Nouva works on it” ✓", "The run stops here"]);
    expect(seen.stopped).toBe("The run stops here");
    expect(seen.field).toEqual(["Go back to step 2, “Nouva works on it”", "Stop ✓"]);
    expect(seen.back).toBe("Then back to step 2, “Nouva works on it”");
  });

  test("a step of a lane goes on anyway: said in its own box, the lane still a lane, and saved as the shape that runs it", async () => {
    shown(LANED);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { offered: [] as string[], now: [] as string[], rule: "", stop: "", lane: [] as string[], chips: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 5);
      host.querySelector<HTMLElement>('[aria-label^="Edit the side step"]')!.click();
      await eventually(() => pathOf(host, "whenFailed") !== null, 2_000, "what a failure does, asked of a lane's step");
      seen.offered = answerNames(host, "whenFailed");
      seen.now = chosen(host, "whenFailed");
      choose(host, "whenFailed", "Go on anyway");
      await eventually(() => stepCard(host, "look").querySelector('[data-rule-kind="goOn"]') !== null, 2_000, "going on, in the lane step's box");
      seen.rule = stepCard(host, "look").querySelector("[data-rule]")?.textContent ?? "";
      seen.stop = stepCard(host, "look").querySelector("[data-stops]")?.textContent ?? "";
      seen.lane = [...lane(host).querySelectorAll<HTMLElement>('[data-flow-anchor^="step:"]')].map((box) => box.dataset.flowAnchor!.slice(5));
      seen.chips = host.querySelectorAll("[data-branch]").length;
      sent = await saved(host);
    });
    expect(seen.offered).toEqual(["Stop and tell me", "Go on anyway"]);
    expect(seen.now).toEqual(["Stop and tell me"]);
    expect(seen.rule).toBe("If it fails, the run goes on anyway.");
    expect(seen.stop).toBe("");
    expect(seen.lane).toEqual(["look"]);
    expect(seen.chips).toBe(0);
    expect(steps(sent)).toEqual([{ ...CHECK, then: { to: "find" }, whenFailed: { to: "look" } }, { id: "look", kind: "agentTurn", message: "Look into why it failed.", whenFailed: "next" }, FIND, OK, TELL]);
  });
});

describe("who does a step", () => {
  test("is picked by face and by typing a name: each agent with its picture, the list narrowed as it is typed, and only an agent of the list an answer", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { rows: [] as string[], faces: 0, field: false, narrowed: [] as string[], none: "", holds: "", face: false, byKey: [] as string[] };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 2).click();
      await eventually(() => dropdown(host, "Who does it").button() !== undefined, 2_000, "who does it");
      seen.rows = await dropdown(host, "Who does it").open();
      const list = () => host.ownerDocument.body.querySelector<HTMLElement>('[role="listbox"][aria-label="Who does it"]')!;
      seen.faces = list().querySelectorAll('[role="option"] [role="img"]').length;
      const find = host.ownerDocument.body.querySelector<HTMLInputElement>('input[aria-label="Find an agent"]');
      seen.field = find !== null;
      type(find!, "ni");
      await eventually(() => list().querySelectorAll('[role="option"]').length === 1, 2_000, "the list narrowed");
      seen.narrowed = [...list().querySelectorAll('[role="option"] span.truncate')].map((row) => row.textContent ?? "");
      type(find!, "zz");
      await eventually(() => list().querySelectorAll('[role="option"]').length === 0, 2_000, "nothing by that name");
      seen.none = list().textContent ?? "";
      type(find!, "nix");
      await eventually(() => list().querySelectorAll('[role="option"]').length === 1, 2_000, "Nix");
      list().querySelector<HTMLElement>('[role="option"] button')!.click();
      await eventually(() => dropdown(host, "Who does it").holds() === "Nix", 2_000, "Nix picked");
      seen.holds = dropdown(host, "Who does it").holds() ?? "";
      seen.face = dropdown(host, "Who does it").button()!.querySelector('[role="img"]') !== null;
      // Typed from the button itself: the first letter opens the list with that letter already in its field.
      const button = dropdown(host, "Who does it").button()!;
      button.dispatchEvent(new (host.ownerDocument.defaultView as unknown as typeof globalThis).KeyboardEvent("keydown", { key: "x", bubbles: true }));
      await eventually(() => host.ownerDocument.body.querySelector<HTMLInputElement>('input[aria-label="Find an agent"]')?.value === "x", 2_000, "the list, opened by a letter");
      seen.byKey = [...list().querySelectorAll('[role="option"] span.truncate')].map((row) => row.textContent ?? "");
      button.click();
      sent = await saved(host);
    });
    expect(seen.rows).toEqual(["Nouva, who runs this automation", "Nix"]);
    expect(seen.faces).toBe(2);
    expect(seen.field).toBe(true);
    expect(seen.narrowed).toEqual(["Nix"]);
    expect(seen.none).toBe("No agent called “zz”");
    expect(seen.holds).toBe("Nix");
    expect(seen.face).toBe(true);
    expect(seen.byKey).toEqual(["Nix"]);
    expect(steps(sent)[1]).toEqual({ ...FIND, agentId: "nix" } as AutomationStep);
  });
});
