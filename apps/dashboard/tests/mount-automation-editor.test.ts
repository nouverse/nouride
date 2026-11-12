/**
 * An automation's steps, edited on its page: a step added between two cards, each kind's fields written in place, a
 * step copied, deleted and put back, moved by its menu, its handle's keys and a drag, and where the run goes from a
 * step set, drawn, and put back when a move would turn it backward. Each ends in the one thing that matters: what Save
 * sends is exactly the list on the page.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AutomationStep } from "@nouride/wire";
import { answer, dropdown, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { AS_VIEWER, STEPS, TWO_AGENTS, addStep, automation, barButton, detail, drawn, field, flowDrawn, labelled, ok, saveBar, stepCard, stepMenu } from "./automation-fixtures.ts";
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
      labelled(host, "Edit step 1").click();
      await eventually(() => host.textContent?.includes("Give up after (seconds)") === true, 2_000, "the command's fields");
      type(field(host, "Command"), "ls -la");
      type(field(host, "Give up after (seconds)"), "30");

      labelled(host, "Edit step 2").click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the agent's fields");
      type(field(host, "What to ask"), "Look into it.");
      seen.agents = await dropdown(host, "Who does it").open();
      await dropdown(host, "Who does it").pick("Nix");

      labelled(host, "Edit step 3").click();
      await eventually(() => host.textContent?.includes("Wait for an answer for") === true, 2_000, "the wait's fields");
      type(field(host, "Question"), "Post it?");
      await dropdown(host, "Wait for an answer for").pick("1 hour");

      labelled(host, "Edit step 4").click();
      await eventually(() => field(host, "Name") !== null && host.textContent?.includes("Sent as written") === true, 2_000, "the message's fields");
      type(field(host, "Name"), "Say so");
      seen.kinds = await dropdown(host, "What it does").open();
      await dropdown(host, "What it does").pick("Start a mission");
      await eventually(() => host.textContent?.includes("The run waits here until the mission ends") === true, 2_000, "the mission's fields");
      seen.titles = STEPS.map((step) => stepCard(host, step.id).querySelector("button, div > div")?.textContent ?? "");
      sent = await saved(host);
    });
    expect(seen.agents).toEqual(["Nouva, who runs this automation", "Nix"]);
    expect(seen.kinds).toEqual(["Ask an agent", "Run a command", "Send a message", "Start a mission", "Wait for your OK"]);
    expect(seen.titles[0]).toContain("Step 1 · Run a commandls -la");
    // Another agent's step says whose it is.
    expect(seen.titles[1]).toContain("Step 2 · Nix works on itLook into it.");
    expect(seen.titles[3]).toContain("Step 4 · Say soThe shop was down.");
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
      labelled(host, "Edit step 2").click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the fields");
      type(field(host, "What to ask"), " ");
      // Still being written: not told. Left behind: told.
      expect(stepCard(host, "find").querySelector('[role="alert"]')).toBeNull();
      labelled(host, "Close step 2").click();
      await eventually(() => stepCard(host, "find").querySelector('[role="alert"]') !== null, 2_000, "the card's problem");
      seen.card = stepCard(host, "find").querySelector('[role="alert"]')?.textContent ?? "";
      seen.state = stepCard(host, "find").dataset.state ?? "";
      seen.bar = saveBar(host)?.textContent ?? "";
      barButton(host, "Discard changes")!.click();
      await eventually(() => saveBar(host) === null, 2_000, "the bar gone");
      seen.after = stepCard(host, "find").textContent ?? "";
    });
    expect(seen.card).toBe("Write what to ask the agent.");
    expect(seen.state).toBe("failed");
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

describe("where the run goes from a step", () => {
  test("set from its card: only later steps are offered, the path is a chip under the card and a line to where it lands", async () => {
    shown();
    let sent: { path: string; body: unknown }[] = [];
    const seen = { before: 0, offered: [] as string[], chips: [] as string[], links: [] as (string | null)[], lit: "", target: "", last: "", lastPaths: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      // Nothing a step says for itself: no chip, no line.
      seen.before = host.querySelectorAll("[data-branch], [data-flow-link]").length;
      labelled(host, "Edit step 1").click();
      await eventually(() => host.textContent?.includes("Where the run goes from here") === true, 2_000, "the paths");
      seen.offered = await dropdown(host, "When it fails").open();
      await dropdown(host, "When it fails").pick("Jump to step 4, Tell the group");
      await dropdown(host, "When it is done").pick("End the run here");
      await eventually(() => host.querySelectorAll("[data-branch]").length === 2, 2_000, "the chips");
      seen.chips = [...host.querySelectorAll("[data-branch]")].map((chip) => chip.textContent ?? "");
      await eventually(() => host.querySelector("[data-flow-link]") !== null, 2_000, "the line");
      seen.links = [...host.querySelectorAll("[data-flow-link]")].map((link) => link.getAttribute("data-flow-link"));
      // The pointer on the chip lights its line and the card it lands on.
      const chip = host.querySelector<HTMLElement>('[data-branch="whenFailed"]')!;
      chip.dispatchEvent(new (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("mouseover", { bubbles: true }));
      await eventually(() => host.querySelector("[data-flow-link]")?.getAttribute("data-state") === "active", 2_000, "the line lit");
      seen.lit = host.querySelector("[data-flow-link]")?.getAttribute("data-state") ?? "";
      seen.target = stepCard(host, "tell").dataset.state ?? "";
      // The last step has nothing after it: no path is offered, and its card says how the run ends.
      labelled(host, "Edit step 4").click();
      await eventually(() => host.textContent?.includes("This is the last step") === true, 2_000, "the last step's editor");
      seen.last = [...host.querySelectorAll("p")].find((line) => line.textContent?.startsWith("This is the last step"))?.textContent ?? "";
      seen.lastPaths = ["When it is done", "When it fails", "When it has nothing to say"].filter((label) => dropdown(host, label).button() !== undefined).length;
      sent = await saved(host);
    });
    expect(seen.before).toBe(0);
    expect(seen.offered).toEqual(["Go on to step 2", "End the run, as failed", "Jump to step 3, Wait for your OK", "Jump to step 4, Tell the group"]);
    expect(seen.chips).toEqual(["Once doneend here", "If it failsstep 4, Tell the group"]);
    // Ending the run is no jump: only the path to a later step is a line.
    expect(seen.links).toEqual(["check:whenFailed"]);
    expect([seen.lit, seen.target]).toEqual(["active", "target"]);
    // A message sent has one way out, so nothing more is said of it.
    expect(seen.last).toBe("This is the last step, so the run ends after it.");
    expect(seen.lastPaths).toBe(0);
    expect(steps(sent)).toEqual([{ ...CHECK, then: "end", whenFailed: { to: "tell" } }, FIND, OK, TELL]);
  });

  test("the last step ends the run whichever way it went: though it holds a path, none is drawn under it or offered on it", async () => {
    // As an agent or the command line may write it, and as the page once let a person set it: "go on" with no step to go on to.
    shown([CHECK, { ...FIND, whenFailed: "next", whenEmpty: "next", then: "end" }]);
    const seen = { chips: 0, says: "", paths: 0, middle: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host, 2);
      seen.chips = host.querySelectorAll("[data-branch]").length;
      labelled(host, "Edit step 2").click();
      await eventually(() => host.textContent?.includes("This is the last step") === true, 2_000, "the last step's editor");
      seen.says = [...host.querySelectorAll("p")].find((line) => line.textContent?.startsWith("This is the last step"))?.textContent ?? "";
      seen.paths = host.querySelectorAll('button[aria-haspopup="listbox"][aria-label^="When it"]').length;
      // The step before it still has its three.
      labelled(host, "Edit step 1").click();
      await eventually(() => host.textContent?.includes("Where the run goes from here") === true, 2_000, "a middle step's paths");
      seen.middle = host.querySelectorAll('button[aria-haspopup="listbox"][aria-label^="When it"]').length;
    });
    expect(seen.chips).toBe(0);
    expect(seen.says).toBe("This is the last step, so the run ends after it. If it fails, the run ends as failed. With nothing to say, it ends quietly.");
    expect(seen.paths).toBe(0);
    expect(seen.middle).toBe(3);
  });

  test("a move that would turn a path backward puts it back to its default, and the card says so", async () => {
    shown([{ ...CHECK, whenFailed: { to: "ok" } }, FIND, OK, TELL]);
    let sent: { path: string; body: unknown }[] = [];
    const seen = { chips: 0, note: "", after: 0 };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.chips = host.querySelectorAll("[data-branch]").length;
      // The step it points at, carried above it.
      await stepMenu(host, 3, "Move up");
      await eventually(() => drawn(host)[1] === "ok", 2_000, "ok above find");
      expect(host.querySelectorAll("[data-branch]").length).toBe(1);
      await stepMenu(host, 2, "Move up");
      await eventually(() => drawn(host)[0] === "ok", 2_000, "ok above check");
      await eventually(() => stepCard(host, "check").querySelector('[role="status"]') !== null, 2_000, "the note");
      seen.note = stepCard(host, "check").querySelector('[role="status"] span')?.textContent ?? "";
      seen.after = host.querySelectorAll("[data-branch], [data-flow-link]").length;
      sent = await saved(host);
    });
    expect(seen.chips).toBe(1);
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
