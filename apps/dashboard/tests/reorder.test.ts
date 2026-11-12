/**
 * `ReorderList`, a list a person puts in another order: by dragging an item's handle, with the arrow keys on it, or
 * with buttons the item draws. The decisions are `lib/reorder.ts`'s, tested on their own; the list is mounted with
 * rows a hundred pixels tall, as a browser would lay them out, and dragged with the pointer's own events.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dropIndex, moved, shiftOf } from "@/commons/lib/reorder";
import { useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

describe("where a dragged item lands", () => {
  const slots = [0, 100, 200, 300].map((top) => ({ top, height: 100 }));

  test("it takes a neighbour's place once it is more than halfway over it, and not before", () => {
    expect(dropIndex(slots, 0, 0)).toBe(0);
    expect(dropIndex(slots, 0, 99)).toBe(0);
    expect(dropIndex(slots, 0, 101)).toBe(1);
    expect(dropIndex(slots, 0, 500)).toBe(3);
    expect(dropIndex(slots, 3, -101)).toBe(2);
    expect(dropIndex(slots, 3, -230)).toBe(1);
    expect(dropIndex(slots, 3, -900)).toBe(0);
    expect(dropIndex(slots, 9, 50)).toBe(9);
  });

  test("rows of other heights: the held one's middle against each other's", () => {
    const uneven = [{ top: 0, height: 40 }, { top: 40, height: 300 }, { top: 340, height: 40 }];
    // The small first row passes the tall second once its middle (20) is below the tall one's (190).
    expect(dropIndex(uneven, 0, 169)).toBe(0);
    expect(dropIndex(uneven, 0, 171)).toBe(1);
  });

  test("the others stand aside by the held one's height, only between where it was and where it is", () => {
    // Held from 0 over 2: the two it passed move up.
    expect([0, 1, 2, 3].map((index) => shiftOf(index, 0, 2, 100))).toEqual([0, -100, -100, 0]);
    // Held from 3 over 1: the two it passed move down.
    expect([0, 1, 2, 3].map((index) => shiftOf(index, 3, 1, 80))).toEqual([0, 80, 80, 0]);
    expect([0, 1, 2].map((index) => shiftOf(index, 1, 1, 100))).toEqual([0, 0, 0]);
  });

  test("an item taken from one place to another, the rest in their order; a move to nowhere changes nothing", () => {
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
    for (const [from, to] of [[1, 1], [0, 4], [-1, 0], [4, 0]] as const) expect(moved(["a", "b", "c", "d"], from, to)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the list, mounted", () => {
  let real: () => DOMRect;

  // Rows a hundred pixels tall, one under the other, as a browser lays them out: the DOM here has no layout.
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

  async function mounted(options: { disabled?: boolean } = {}) {
    const { createElement, useState } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReorderList } = await import("@/commons/components/ui/ReorderList");
    const moves: [number, number][] = [];
    const held: boolean[] = [];
    function List() {
      const [items, setItems] = useState(["a", "b", "c", "d"]);
      return createElement(ReorderList<string>, {
        items,
        keyOf: (item: string) => item,
        nameOf: (item: string) => `row ${item}`,
        label: "Rows",
        disabled: options.disabled === true,
        onHeld: (now: boolean) => held.push(now),
        onMove: (from: number, to: number) => {
          moves.push([from, to]);
          setItems((was) => moved(was, from, to));
        },
        children: (item: string, _index: number, grip) =>
          createElement(
            "div",
            { "data-row": item, "data-first": String(grip.first), "data-last": String(grip.last), "data-held": String(grip.held) },
            createElement("button", { ...grip.handle, "data-grip": item }, "grip"),
            createElement("button", { "data-up": item, onClick: () => grip.move(-1) }, "up"),
            createElement("button", { "data-down": item, onClick: () => grip.move(1) }, "down"),
          ),
      });
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(createElement(List));
    await eventually(() => host.querySelectorAll("[data-row]").length === 4, 2_000, "the rows");
    const Mouse = (window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
    const Key = (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    return {
      host,
      moves,
      held,
      order: () => [...host.querySelectorAll("[data-row]")].map((row) => row.getAttribute("data-row")).join(""),
      row: (item: string) => host.querySelector(`[data-reorder-key="${item}"]`) as HTMLElement,
      grip: (item: string) => host.querySelector(`[data-grip="${item}"]`) as HTMLButtonElement,
      press: (selector: string) => (host.querySelector(selector) as HTMLElement).click(),
      pointer: (type: string, target: EventTarget, clientY: number) => target.dispatchEvent(new Mouse(type, { clientY, button: 0, bubbles: true })),
      key: (target: EventTarget, key: string) => target.dispatchEvent(new Key("keydown", { key, bubbles: true })),
      said: () => host.querySelector('[aria-live="polite"]')?.textContent ?? "",
      done: () => {
        root.unmount();
        host.remove();
      },
    };
  }

  test("an item's buttons move it one place, and the move is said for whoever cannot see it", async () => {
    const list = await mounted();
    try {
      list.press('[data-down="a"]');
      await eventually(() => list.order() === "bacd", 2_000, "a moved down");
      expect(list.moves).toEqual([[0, 1]]);
      expect(list.said()).toBe("row a moved to place 2 of 4");
      list.press('[data-up="d"]');
      await eventually(() => list.order() === "badc", 2_000, "d moved up");
      // At the ends there is nowhere to go: nothing is asked.
      list.press('[data-up="b"]');
      list.press('[data-down="c"]');
      expect(list.moves).toEqual([[0, 1], [3, 2]]);
      expect([list.host.querySelector('[data-row="b"]')?.getAttribute("data-first"), list.host.querySelector('[data-row="c"]')?.getAttribute("data-last")]).toEqual(["true", "true"]);
    } finally {
      list.done();
    }
  });

  test("the arrow keys on a handle move its item, and the handle says so in its name", async () => {
    const list = await mounted();
    try {
      expect(list.grip("c").getAttribute("aria-label")).toBe("Move row c: drag it, or press the up or down arrow");
      list.key(list.grip("c"), "ArrowUp");
      await eventually(() => list.order() === "acbd", 2_000, "c moved up");
      list.key(list.grip("c"), "ArrowDown");
      await eventually(() => list.order() === "abcd", 2_000, "c moved back");
      list.key(list.grip("c"), "Enter");
      expect(list.moves).toEqual([[2, 1], [1, 2]]);
    } finally {
      list.done();
    }
  });

  test("a drag: the held item follows the pointer, the others stand aside, and letting go puts it where it is", async () => {
    const list = await mounted();
    try {
      list.pointer("pointerdown", list.grip("d"), 350);
      await eventually(() => list.row("d").hasAttribute("data-held"), 2_000, "d held");
      expect(list.held).toEqual([true]);
      list.pointer("pointermove", window, 120);
      await eventually(() => list.row("d").style.transform === "translateY(-230px)", 2_000, "d following the pointer");
      // Its middle is over b's row now: b and c stand aside by its height, a stays.
      expect(["a", "b", "c"].map((item) => list.row(item).style.transform)).toEqual(["translateY(0px)", "translateY(100px)", "translateY(100px)"]);
      expect(list.row("d").style.transition).toBe("none");
      expect(list.order()).toBe("abcd");
      list.pointer("pointerup", window, 120);
      await eventually(() => list.order() === "adbc", 2_000, "d put down");
      expect(list.moves).toEqual([[3, 1]]);
      expect(list.held).toEqual([true, false]);
      expect(list.row("b").style.transform).toBe("");
    } finally {
      list.done();
    }
  });

  test("a drag let go where it began, or ended with Escape, moves nothing", async () => {
    const list = await mounted();
    try {
      list.pointer("pointerdown", list.grip("b"), 150);
      list.pointer("pointermove", window, 190);
      list.pointer("pointerup", window, 190);
      await eventually(() => !list.row("b").hasAttribute("data-held"), 2_000, "b put down");
      list.pointer("pointerdown", list.grip("b"), 150);
      list.pointer("pointermove", window, 380);
      await eventually(() => list.row("b").style.transform === "translateY(230px)", 2_000, "b far down");
      list.key(window, "Escape");
      await eventually(() => !list.row("b").hasAttribute("data-held"), 2_000, "b let go of");
      list.pointer("pointerup", window, 380);
      expect(list.order()).toBe("abcd");
      expect(list.moves).toEqual([]);
    } finally {
      list.done();
    }
  });

  test("disabled, nothing moves: not by the pointer, a key or a button", async () => {
    const list = await mounted({ disabled: true });
    try {
      expect(list.grip("a").disabled).toBe(true);
      list.pointer("pointerdown", list.grip("a"), 50);
      list.pointer("pointermove", window, 300);
      list.pointer("pointerup", window, 300);
      list.key(list.grip("a"), "ArrowDown");
      list.press('[data-down="a"]');
      expect(list.order()).toBe("abcd");
      expect(list.moves).toEqual([]);
      expect(list.held).toEqual([]);
    } finally {
      list.done();
    }
  });
});
