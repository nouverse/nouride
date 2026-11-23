/**
 * An automation's unsaved changes, kept in the browser: a page left with a draft opens on it again, the list says what
 * was left, and Save, Cancel and Discard are what forget it. Found on a live box: six steps drawn, "Automations"
 * pressed to look at another one, and an empty page to come back to.
 *
 * Each page is rendered anew (`renderPage`), as a person comes back to it: nothing of the page before is in memory,
 * and what it shows of the draft it read from the browser's own store.
 */

import { describe, expect, test } from "bun:test";
import type { AutomationStep } from "@nouride/wire";
import { answer, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { AS_VIEWER, STEPS, TWO_AGENTS, automation, barButton, detail, drawn, editStep, field, flowDrawn, ok, saveBar, stepCard } from "./automation-fixtures.ts";
import { eventually } from "./wait.ts";
import { draftOf } from "@/modules/automations/lib/draft";
import { NEW, baseOf, keptKey, type KeptDrafts } from "@/modules/automations/lib/kept-draft";

useMountHarness();

const PAGE = "/automations/cron_e";
const KEY = keptKey("tester");
const shown = (over: Parameters<typeof automation>[0] = {}) => answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps: STEPS }, ...over })), "/automations": ok({ automations: [automation({ payload: { kind: "steps", steps: STEPS }, ...over })], timezone: "UTC" }), ...TWO_AGENTS });
const kept = (): KeptDrafts => JSON.parse(localStorage.getItem(KEY) ?? "{}") as KeptDrafts;
const nameField = (host: HTMLElement) => host.querySelector('input[aria-label="Name"]') as HTMLInputElement;
const pressIn = (within: Element, label: string) => ([...within.querySelectorAll("button, a")].find((one) => one.textContent?.trim() === label) as HTMLElement).click();

async function firstStep(host: HTMLElement, kind: string) {
  await eventually(() => host.textContent?.includes("Add the first step") === true, 3_000, "the empty flow");
  ([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add the first step")) as HTMLElement).click();
  const kinds = () => [...host.ownerDocument.body.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Add a step"] button')];
  await eventually(() => kinds().length === 6, 2_000, "the picker");
  kinds().find((button) => button.querySelector("span span")?.textContent === kind)!.click();
  await flowDrawn(host, 1);
}

describe("one being made", () => {
  test("left unsaved, it is on the list as what it is, and its page opens on it again; Cancel throws it away", async () => {
    answer(TWO_AGENTS);
    const seen = { stored: [] as string[], row: "", discarded: false, undone: "", steps: [] as string[], name: "", note: "", typed: "", after: {} as KeptDrafts, went: "" };
    await renderPage("/automations/new", async (host) => {
      await firstStep(host, "Ask an agent");
      type(field(host, "What to ask"), "Sum up the mail.");
      type(nameField(host), "Morning brief");
      await eventually(() => kept()[NEW]?.draft.name === "Morning brief", 2_000, "the draft kept");
      seen.stored = [kept()[NEW]!.draft.name, ...kept()[NEW]!.draft.steps.map((step) => `${step.kind} ${(step as { message?: string }).message}`)];
    });

    // The list, as a page of its own: what was left is a row over it, with what to do with it.
    await renderPage("/automations", async (host) => {
      const row = () => host.querySelector<HTMLElement>("[data-unsaved-new]");
      await eventually(() => row() !== null, 3_000, "the row of what was left");
      seen.row = row()!.textContent ?? "";
      pressIn(row()!, "Discard");
      await eventually(() => row() === null, 2_000, "the row gone");
      seen.discarded = kept()[NEW] === undefined;
      // A press and not a question, so it has a way back.
      await eventually(() => [...host.ownerDocument.body.querySelectorAll("button")].some((button) => button.textContent === "Undo"), 2_000, "the Undo");
      pressIn(host.ownerDocument.body, "Undo");
      await eventually(() => row() !== null, 2_000, "the row back");
      seen.undone = kept()[NEW]?.draft.name ?? "";
    });

    await renderPage("/automations/new", async (host, app) => {
      await flowDrawn(host, 1);
      seen.steps = drawn(host).map((id) => stepCard(host, id).querySelector("[data-box-title]")?.textContent ?? "");
      seen.name = nameField(host).value;
      seen.note = [...(saveBar(host)?.querySelectorAll("p") ?? [])].map((line) => line.textContent).join(" | ");
      // Changed again, it is no longer "as you left it".
      type(nameField(host), "Morning brief, later");
      await eventually(() => !saveBar(host)?.textContent?.includes("You left this unsaved"), 2_000, "the note gone");
      seen.typed = kept()[NEW]?.draft.name ?? "";
      barButton(host, "Cancel")!.click();
      await eventually(() => app.location() === "/automations", 3_000, "the list");
      seen.went = app.location();
      seen.after = kept();
    });

    expect(seen.stored).toEqual(["Morning brief", "agentTurn Sum up the mail."]);
    expect(seen.row).toContain("Morning brief");
    expect(seen.row).toContain("Not saved yet");
    expect(seen.row).toContain("1 step");
    expect(seen.row).toContain("kept in this browser");
    expect(seen.discarded).toBe(true);
    expect(seen.undone).toBe("Morning brief");
    expect(seen.steps).toEqual(["Nouva works on it"]);
    expect(seen.name).toBe("Morning brief");
    expect(seen.note).toContain("You left this unsaved");
    expect(seen.note).toContain("It was kept in this browser.");
    expect(seen.typed).toBe("Morning brief, later");
    expect(seen.went).toBe("/automations");
    expect(seen.after).toEqual({});
  });

  test("saved, nothing of it is left to open the next new one on", async () => {
    answer(TWO_AGENTS);
    let after: KeptDrafts = { [NEW]: {} as never };
    await renderPage("/automations/new", async (host, app) => {
      await firstStep(host, "Ask an agent");
      type(field(host, "What to ask"), "Sum up the mail.");
      type(nameField(host), "Morning brief");
      (host.querySelector('[aria-label="Change where its results go"]') as HTMLElement).click();
      await eventually(() => host.querySelector('input[placeholder="Pick a chat, or type its id"]') !== null, 2_000, "the chat's field");
      type(host.querySelector('input[placeholder="Pick a chat, or type its id"]') as HTMLInputElement, "-100200");
      await eventually(() => kept()[NEW]?.draft.chatId === "-100200", 2_000, "the draft kept");
      const record = recordPosts({ "/cron": ok({ job: automation({ id: "cron_new" }) }) });
      await eventually(() => barButton(host, "Save automation")?.disabled === false, 2_000, "Save offered");
      barButton(host, "Save automation")!.click();
      await eventually(() => app.location() === "/automations/cron_new", 3_000, "its own page");
      record.restore();
      after = kept();
    });
    expect(after).toEqual({});
  });
});

describe("one that exists", () => {
  test("its page opens on the changes left on it, its row says they wait, and Discard changes forgets them", async () => {
    shown();
    const seen = { stored: "", row: "", card: "", note: "", back: "", after: {} as KeptDrafts };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 2).click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the agent's fields");
      type(field(host, "What to ask"), "Look into it, kindly.");
      await eventually(() => kept().cron_e !== undefined, 2_000, "the draft kept");
      seen.stored = (kept().cron_e!.draft.steps[1] as { message: string }).message;
    });
    await renderPage("/automations", async (host) => {
      await eventually(() => host.querySelector('[data-automation="cron_e"]') !== null, 3_000, "its row");
      seen.row = host.querySelector('[data-automation="cron_e"]')?.textContent ?? "";
      // Nothing of it was being made anew.
      expect(host.querySelector("[data-unsaved-new]")).toBeNull();
    });
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.card = stepCard(host, "find").textContent ?? "";
      seen.note = saveBar(host)?.textContent ?? "";
      barButton(host, "Discard changes")!.click();
      await eventually(() => saveBar(host) === null, 2_000, "the bar gone");
      seen.back = stepCard(host, "find").textContent ?? "";
      seen.after = kept();
    });
    expect(seen.stored).toBe("Look into it, kindly.");
    expect(seen.row).toContain("Unsaved changes");
    expect(seen.card).toContain("Look into it, kindly.");
    expect(seen.note).toContain("You changed this automation.");
    expect(seen.note).toContain("You left this unsaved");
    expect(seen.back).not.toContain("Look into it, kindly.");
    expect(seen.after).toEqual({});
  });

  test("saved, its kept changes are forgotten, and its row says nothing of them", async () => {
    shown();
    let after: KeptDrafts = { cron_e: {} as never };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      editStep(host, 2).click();
      await eventually(() => host.textContent?.includes("What to ask") === true, 2_000, "the agent's fields");
      type(field(host, "What to ask"), "Look into it, kindly.");
      await eventually(() => kept().cron_e !== undefined, 2_000, "the draft kept");
      const record = recordPosts({ "/cron/cron_e": ok({ job: automation() }) });
      await eventually(() => barButton(host, "Save")?.disabled === false, 2_000, "Save offered");
      barButton(host, "Save")!.click();
      await eventually(() => record.posts.length > 0 && saveBar(host) === null, 3_000, "the save");
      record.restore();
      after = kept();
    });
    expect(after).toEqual({});
  });

  test("changed by someone else since: it is drawn as it is saved, and the older changes are offered, not put over it", async () => {
    const mine = { ...draftOf(automation({ payload: { kind: "steps", steps: STEPS } }), "UTC"), name: "My own name for it" };
    const seed = () => localStorage.setItem(KEY, JSON.stringify({ cron_e: { draft: mine, at: Date.now() - 3_600_000, base: "what-it-was-then" } }));
    const seen = { offer: "", name: "", bar: false, shown: "", barNow: false, thrown: {} as KeptDrafts, offerGone: false };
    shown();
    seed();
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      const offer = () => host.querySelector<HTMLElement>("[data-older-draft]");
      await eventually(() => offer() !== null, 2_000, "the offer");
      seen.offer = offer()!.textContent ?? "";
      seen.name = nameField(host).value;
      seen.bar = saveBar(host) !== null;
      // Still kept while it waits to be asked about: looking at the page throws nothing away.
      expect(kept().cron_e?.draft.name).toBe("My own name for it");
      pressIn(offer()!, "Show my changes");
      await eventually(() => nameField(host).value === "My own name for it", 2_000, "the older changes drawn");
      seen.shown = nameField(host).value;
      seen.barNow = saveBar(host) !== null;
    });
    seed();
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      const offer = () => host.querySelector<HTMLElement>("[data-older-draft]");
      await eventually(() => offer() !== null, 2_000, "the offer");
      pressIn(offer()!, "Throw mine away");
      await eventually(() => offer() === null, 2_000, "the offer gone");
      await eventually(() => kept().cron_e === undefined, 2_000, "the older changes forgotten");
      seen.offerGone = offer() === null;
      seen.thrown = kept();
    });
    expect(seen.offer).toContain("never saved");
    expect(seen.offer).toContain("changed since");
    expect(seen.name).toBe("Shop check");
    expect(seen.bar).toBe(false);
    expect(seen.shown).toBe("My own name for it");
    expect(seen.barNow).toBe(true);
    expect(seen.offerGone).toBe(true);
    expect(seen.thrown).toEqual({});
  });

  test("made from it as it is now, a kept draft opens with no question", async () => {
    const one = automation({ payload: { kind: "steps", steps: STEPS } });
    const was = draftOf(one, "UTC");
    shown();
    localStorage.setItem(KEY, JSON.stringify({ cron_e: { draft: { ...was, name: "Renamed" }, at: Date.now() - 60_000, base: baseOf(was) } }));
    const seen = { name: "", offer: true };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.name = nameField(host).value;
      seen.offer = host.querySelector("[data-older-draft]") !== null;
    });
    expect(seen).toEqual({ name: "Renamed", offer: false });
  });

  test("one a reader may not change keeps nothing and opens on nothing kept", async () => {
    const was = draftOf(automation({ payload: { kind: "steps", steps: STEPS } }), "UTC");
    shown();
    answer({ [PAGE]: detail(automation({ payload: { kind: "steps", steps: STEPS } })), ...TWO_AGENTS, ...AS_VIEWER });
    localStorage.setItem(KEY, JSON.stringify({ cron_e: { draft: { ...was, name: "Renamed" }, at: 1, base: baseOf(was) } }));
    const seen = { name: "", bar: true, offer: true };
    await renderPage(PAGE, async (host) => {
      await flowDrawn(host);
      seen.name = host.querySelector("h1")?.textContent ?? "";
      seen.bar = saveBar(host) !== null;
      seen.offer = host.querySelector("[data-older-draft]") !== null;
    });
    expect(seen.name).toContain("Shop check");
    expect(seen.bar).toBe(false);
    expect(seen.offer).toBe(false);
  });

  test("one that is gone takes what was kept of it along", async () => {
    const was = draftOf(automation({ payload: { kind: "steps", steps: STEPS as AutomationStep[] } }), "UTC");
    answer({ [PAGE]: { status: 404, body: { error: "no such automation" } } });
    localStorage.setItem(KEY, JSON.stringify({ cron_e: { draft: { ...was, name: "Renamed" }, at: 1, base: baseOf(was) }, cron_other: { draft: was, at: 2, base: "b" } }));
    let after: string[] = [];
    await renderPage(PAGE, async (host) => {
      await eventually(() => host.textContent?.includes("No such automation") === true, 3_000, "that it is gone");
      await eventually(() => kept().cron_e === undefined, 2_000, "what was kept of it gone");
      after = Object.keys(kept());
    });
    expect(after).toEqual(["cron_other"]);
  });
});
