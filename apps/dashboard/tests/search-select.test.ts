/**
 * `SearchSelect`, the dashboard's one dropdown: a button that opens a list to pick one from. A long list has a field to
 * narrow it; a short one (`searchLabel` left out) has none and is picked with a press or the keys. Mounted on its own
 * with a list that is not People, so what it does is its own and not the chat page's.
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
async function mounted(value: string, short: { named?: boolean; details?: boolean } | null = null) {
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
        options: short?.details ? FRUIT.map((fruit, at) => ({ ...fruit, detail: String(at + 1) })) : FRUIT,
        value: now,
        onChange: (next: string) => {
          picked.push(next);
          draw(next);
        },
        label: "Fruit",
        ...(short ? { named: short.named === true } : { searchLabel: "Find a fruit" }),
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
    /** A key pressed on a short list, which has the keys itself. */
    listKey: (key: string) => document.querySelector('[role="listbox"][aria-label="Fruit"]')!.dispatchEvent(new (window as unknown as typeof globalThis).KeyboardEvent("keydown", { key, bubbles: true })),
    open: () => document.querySelector('[role="listbox"][aria-label="Fruit"]') !== null,
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

test("a short list has no field: it opens on what it holds, and the keys move, jump to a letter and pick", async () => {
  const select = await mounted("grape", {});
  try {
    select.button().click();
    await eventually(() => select.open(), 2_000, "the list");
    expect(select.field()).toBeNull();
    expect(select.rows()).toEqual(["Apple", "Grape", "Orange", "Pear"]);
    // On the row it holds, with the keys on the list itself.
    expect(select.lit()).toBe(1);
    expect(document.activeElement?.getAttribute("role")).toBe("listbox");
    select.listKey("ArrowDown");
    await eventually(() => select.lit() === 2, 2_000, "the next row");
    select.listKey("p");
    await eventually(() => select.lit() === 3, 2_000, "the row that starts with p");
    select.listKey("Home");
    await eventually(() => select.lit() === 0, 2_000, "the first row");
    select.listKey("End");
    await eventually(() => select.lit() === 3, 2_000, "the last row");
    select.listKey("Enter");
    await eventually(() => !select.open(), 2_000, "the list closed");
    expect(select.picked).toEqual(["pear"]);
    expect(select.button().getAttribute("aria-label")).toBe("Fruit: Pear");
  } finally {
    select.done();
  }
});

test("a short list closes on Escape with nothing picked, and a press on a row picks it", async () => {
  const select = await mounted("apple", {});
  try {
    select.button().click();
    await eventually(() => select.open(), 2_000, "the list");
    select.listKey("Escape");
    await eventually(() => !select.open(), 2_000, "the list closed");
    expect(select.picked).toEqual([]);
    select.button().click();
    await eventually(() => select.open(), 2_000, "the list again");
    ([...document.querySelectorAll('[role="listbox"][aria-label="Fruit"] [role="option"] button')][2] as HTMLElement).click();
    await eventually(() => !select.open(), 2_000, "the list closed");
    expect(select.picked).toEqual(["orange"]);
  } finally {
    select.done();
  }
});

test("its button names what is picked where it is told to, and a row carries its detail", async () => {
  const select = await mounted("grape", { named: true, details: true });
  try {
    expect(select.button().textContent).toBe("Fruit: Grape");
    select.button().click();
    await eventually(() => select.open(), 2_000, "the list");
    expect(select.rows()).toEqual(["Apple1", "Grape2", "Orange3", "Pear4"]);
  } finally {
    select.done();
  }
  const plain = await mounted("grape", {});
  try {
    expect(plain.button().textContent).toBe("Grape");
  } finally {
    plain.done();
  }
});

test("the keys' next row: around the ends, to the first and last, and to the next row a letter starts", async () => {
  const { nextRow } = await import("@/commons/components/ui/SearchSelect");
  const rows = ["All", "Scheduled", "Webhooks", "Shared"];
  expect(nextRow(rows, 3, "ArrowDown")).toBe(0);
  expect(nextRow(rows, 0, "ArrowUp")).toBe(3);
  expect(nextRow(rows, 2, "Home")).toBe(0);
  expect(nextRow(rows, 0, "End")).toBe(3);
  // The next one that starts with it, past the row it is on, and around to the first.
  expect(nextRow(rows, 0, "s")).toBe(1);
  expect(nextRow(rows, 1, "S")).toBe(3);
  expect(nextRow(rows, 3, "s")).toBe(1);
  // A letter no row starts with, or a key that is none of these, moves nothing; nor does anything in an empty list.
  expect(nextRow(rows, 2, "z")).toBe(2);
  expect(nextRow(rows, 2, "Shift")).toBe(2);
  expect(nextRow([], 0, "ArrowDown")).toBe(0);
});
