/**
 * `SearchSelect`, the dashboard's one way to pick one of a long list: a button that opens the list with a field to
 * narrow it, whatever the list holds. Mounted on its own with a list that is not People, so what it does is its own and
 * not the chat page's.
 */

import { expect, test } from "bun:test";
import { type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const FRUIT = [
  { value: "apple", label: "Apple" },
  { value: "grape", label: "Grape" },
  { value: "orange", label: "Orange" },
  { value: "pear", label: "Pear" },
];

/**
 * The select on a page of its own, holding `value`; what it was told to pick, in order. React is imported once the
 * harness has put its window in place: react-dom reads whether it has a DOM when it loads, and a copy loaded without one
 * handles no typing, in this file or in any other that runs after it in the same process.
 */
async function mounted(value: string) {
  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { SearchSelect } = await import("@/commons/components/ui/SearchSelect");
  const picked: string[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const draw = (now: string) =>
    root.render(
      createElement(SearchSelect<string>, {
        options: FRUIT,
        value: now,
        onChange: (next: string) => {
          picked.push(next);
          draw(next);
        },
        label: "Fruit",
        searchLabel: "Find a fruit",
        placeholder: "None yet",
      }),
    );
  draw(value);
  const button = () => host.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
  await eventually(() => button() !== null, 2_000, "the button");
  return {
    picked,
    button,
    field: () => document.querySelector('input[aria-label="Find a fruit"]') as HTMLInputElement | null,
    rows: () => [...document.querySelectorAll('[role="listbox"][aria-label="Fruit"] [role="option"]')].map((row) => row.textContent?.trim() ?? ""),
    /** The row the keys are on. */
    lit: () => [...document.querySelectorAll('[role="listbox"][aria-label="Fruit"] [role="option"] button')].findIndex((row) => row.classList.contains("bg-base-200")),
    said: () => document.querySelector('[role="listbox"][aria-label="Fruit"] li:not([role])')?.textContent ?? null,
    key: (key: string) => document.querySelector('input[aria-label="Find a fruit"]')!.dispatchEvent(new (window as unknown as typeof globalThis).KeyboardEvent("keydown", { key, bubbles: true })),
    done: () => {
      root.unmount();
      host.remove();
    },
  };
}

test("names what it holds on its button, and lists every option once opened", async () => {
  const select = await mounted("grape");
  try {
    expect(select.button().getAttribute("aria-label")).toBe("Fruit: Grape");
    expect(select.field()).toBeNull();
    select.button().click();
    await eventually(() => select.rows().length > 0, 2_000, "the list");
    expect(select.rows()).toEqual(["Apple", "Grape", "Orange", "Pear"]);
  } finally {
    select.done();
  }
});

test("narrows the list as a name is typed, says when nothing holds it, and picks with the keys", async () => {
  const select = await mounted("apple");
  try {
    select.button().click();
    await eventually(() => select.field() !== null, 2_000, "the field");
    type(select.field()!, "AP");
    await eventually(() => select.rows().length === 2, 2_000, "two left");
    expect(select.rows()).toEqual(["Apple", "Grape"]);
    type(select.field()!, "kiwi");
    await eventually(() => select.rows().length === 0, 2_000, "none left");
    expect(select.said()).toBe("Nothing called “kiwi”");
    type(select.field()!, "ap");
    await eventually(() => select.rows().length === 2, 2_000, "two again");
    expect(select.lit()).toBe(0);
    // A key at a time, as a person presses them: each is read against the list as it was last drawn.
    select.key("ArrowDown");
    await eventually(() => select.lit() === 1, 2_000, "the second row lit");
    select.key("Enter");
    await eventually(() => select.field() === null, 2_000, "the list closed");
    expect(select.picked).toEqual(["grape"]);
    expect(select.button().getAttribute("aria-label")).toBe("Fruit: Grape");
  } finally {
    select.done();
  }
});

test("closes on Escape with nothing picked, and says its placeholder while it holds none of the options", async () => {
  const select = await mounted("mango");
  try {
    expect(select.button().getAttribute("aria-label")).toBe("Fruit: None yet");
    select.button().click();
    await eventually(() => select.field() !== null, 2_000, "the field");
    select.key("Escape");
    await eventually(() => select.field() === null, 2_000, "the list closed");
    expect(select.picked).toEqual([]);
  } finally {
    select.done();
  }
});
