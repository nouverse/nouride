/**
 * A model field's whole list, opened with the chevron at its end.
 *
 * Typing filters by what the box holds, and a model's list never opens on focus alone (a phone's keyboard moved it
 * under the finger). So a field that already held a model offered that one model and nothing else: to see the others,
 * a person had to delete its name first. The chevron lists every option whatever the field holds, and closes the list
 * when pressed again. Mounted on an agent's Model tab, where the field arrives holding the agent's model.
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const MODELS = ["test-model", "model-two", "other-three"];

test("a field holding a model lists every model from the chevron, nothing on focus or on a press, and closes on a second press", async () => {
  answer({ "/providers/test/models": { status: 200, body: { ok: true, models: MODELS } } });
  const seen: { onFocus: unknown; onPress: unknown; listed: string[]; chevronBefore: string | null; chevronOpen: string | null; afterSecond: unknown } = {
    onFocus: "not run",
    onPress: "not run",
    listed: [],
    chevronBefore: null,
    chevronOpen: null,
    afterSecond: "not run",
  };

  await renderPage("/agents/nouva/model", async (host) => {
    const document = host.ownerDocument;
    const field = () => [...host.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].find((input) => input.value === "test-model");
    await eventually(() => field() !== undefined, 2_000, "the model field holding the agent's model");
    const input = field()!;
    const chevron = () => input.parentElement!.querySelector<HTMLButtonElement>("button[aria-label]")!;
    const list = () => document.body.querySelector('[role="listbox"]');
    const rows = () => [...document.body.querySelectorAll('[role="listbox"] [role="option"]')].map((row) => row.textContent ?? "");
    // The models arrive after the field: the chevron has nothing to open until they do.
    await eventually(() => !chevron().disabled, 2_000, "the models listed");

    // React draws what a focus does before focus() returns: a list opened on it would be there now.
    input.focus();
    await eventually(() => document.activeElement === input, 2_000, "the field focused");
    seen.onFocus = list();
    // Nor on a press: only a field that asks for it lists on one (a conversation's picker, in a wide window). React
    // draws what a press does in the microtasks after it, so a list opened on it would be there once they have run.
    input.click();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    seen.onPress = list();

    seen.chevronBefore = chevron().getAttribute("aria-label");
    chevron().click();
    await eventually(() => list() !== null, 2_000, "the whole list");
    seen.listed = rows();
    seen.chevronOpen = chevron().getAttribute("aria-label");

    chevron().click();
    await eventually(() => list() === null, 2_000, "the list closed");
    seen.afterSecond = list();
  });

  expect(seen.onFocus).toBeNull();
  expect(seen.onPress).toBeNull();
  expect(seen.chevronBefore).toBe("Show the whole list");
  // Every option, though the field holds one of them and two do not contain its name.
  expect(seen.listed).toEqual(MODELS);
  expect(seen.chevronOpen).toBe("Hide the list");
  expect(seen.afterSecond).toBeNull();
});

test("a list the chevron opened without the field's focus closes on a press anywhere else", async () => {
  // The chevron does not focus the field, so the field has no blur to close it with.
  answer({ "/providers/test/models": { status: 200, body: { ok: true, models: MODELS } } });
  const seen = { focused: true, open: false, afterPress: "not run" as unknown };

  await renderPage("/agents/nouva/model", async (host) => {
    const document = host.ownerDocument;
    const view = document.defaultView as unknown as typeof globalThis;
    const input = () => [...host.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].find((field) => field.value === "test-model");
    await eventually(() => input() !== undefined, 2_000, "the model field holding the agent's model");
    const chevron = () => input()!.parentElement!.querySelector<HTMLButtonElement>("button[aria-label]")!;
    const list = () => document.body.querySelector('[role="listbox"]');
    await eventually(() => !chevron().disabled, 2_000, "the models listed");

    chevron().click();
    await eventually(() => list() !== null, 2_000, "the whole list");
    seen.open = true;
    seen.focused = document.activeElement === input();

    host.querySelector("h1, h2, h3, p")!.dispatchEvent(new view.PointerEvent("pointerdown", { bubbles: true }));
    await eventually(() => list() === null, 2_000, "the list closed by a press elsewhere");
    seen.afterPress = list();
  });

  expect(seen.open).toBe(true);
  expect(seen.focused).toBe(false);
  expect(seen.afterPress).toBeNull();
});
