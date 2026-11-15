/**
 * The row that stays at the top of the window (a page's tabs, its filter, its search): with no ground of its own
 * where the page put it, and the page's ground once the page scrolls under it. A ground at rest was a band across
 * the light at the page's top right, seen in a browser on the first build of it.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "getComputedStyle"] as const;
let dom: Window;
/** The observers the page made: what each watches, from where, and the way to say what it sees. */
let made: { root: unknown; margin: string | undefined; threshold: unknown; watched: unknown[]; gone: boolean; say: (ratio: number) => void }[] = [];

class Observer {
  private readonly entry: (typeof made)[number];
  constructor(tell: (entries: { intersectionRatio: number }[]) => void, options: { root?: unknown; rootMargin?: string; threshold?: unknown } = {}) {
    this.entry = { root: options.root, margin: options.rootMargin, threshold: options.threshold, watched: [], gone: false, say: (ratio) => tell([{ intersectionRatio: ratio }]) };
    made.push(this.entry);
  }
  observe(what: unknown) {
    this.entry.watched.push(what);
  }
  disconnect() {
    this.entry.gone = true;
  }
}

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) {
    const value = (dom as unknown as Record<string, unknown>)[key];
    (globalThis as unknown as Record<string, unknown>)[key] = typeof value === "function" && key === "getComputedStyle" ? value.bind(dom) : value;
  }
});

async function mount(observer: boolean) {
  made = [];
  if (observer) (globalThis as unknown as Record<string, unknown>).IntersectionObserver = Observer;
  else delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { StickyBar } = await import("@/commons/components/ui/StickyBar");
  // What scrolls, a column in it, and the row in the column: the row is watched from what scrolls, not from the column.
  const scroller = dom.document.createElement("main") as unknown as HTMLElement;
  scroller.setAttribute("style", "overflow-y: auto");
  const column = dom.document.createElement("div") as unknown as HTMLElement;
  scroller.appendChild(column);
  dom.document.body.appendChild(scroller as never);
  const root = createRoot(column);
  root.render(React.createElement(StickyBar, { label: "Filters", children: React.createElement("p", null, "tabs") }));
  await eventually(() => column.querySelector("[data-sticky-bar]") !== null, 2_000, "the row");
  return { scroller, row: () => column.querySelector("[data-sticky-bar]")!, unmount: () => (root.unmount(), scroller.remove()) };
}
const ground = (row: Element) => (row.getAttribute("class") ?? "").split(/\s+/).includes("bg-app-bar");

describe("the row that stays at the top of the window", () => {
  test("has no ground where the page put it, and the page's ground once the page scrolls under it", async () => {
    const { scroller, row, unmount } = await mount(true);
    try {
      await eventually(() => made.length === 1, 2_000, "the observer");
      // Watched from what scrolls it, whole or not, with nothing below or beside counting.
      expect({ root: made[0]!.root === scroller, threshold: made[0]!.threshold, watched: made[0]!.watched[0] === row() }).toEqual({ root: true, threshold: 1, watched: true });
      expect(made[0]!.margin).toMatch(/^0px \d+px \d+px \d+px$/);
      // Before anything is seen it keeps its ground: a row with none over a list is the worse mistake.
      expect({ state: row().getAttribute("data-sticky-bar"), ground: ground(row()) }).toEqual({ state: "over", ground: true });
      // Seen whole: it is where the page put it.
      made[0]!.say(1);
      await eventually(() => row().getAttribute("data-sticky-bar") === "rest", 2_000, "the row at rest");
      expect(ground(row())).toBe(false);
      expect(row().getAttribute("class")).not.toContain("after:bg-app-bar-fade");
      // One pixel of it above what scrolls: it has stopped at the top, with the page under it.
      made[0]!.say(0.98);
      await eventually(() => row().getAttribute("data-sticky-bar") === "over", 2_000, "the row over the page");
      expect(ground(row())).toBe(true);
      expect(row().getAttribute("class")).toContain("after:bg-app-bar-fade");
      // It stays one pixel above the top, or it would always be seen whole.
      expect((row().getAttribute("class") ?? "").split(/\s+/)).toContain("-top-px");
    } finally {
      unmount();
    }
    expect(made[0]!.gone).toBe(true);
  });

  test("keeps its ground where nothing can say whether it has stopped", async () => {
    const { row, unmount } = await mount(false);
    try {
      expect({ state: row().getAttribute("data-sticky-bar"), ground: ground(row()) }).toEqual({ state: "over", ground: true });
    } finally {
      unmount();
    }
  });
});

/**
 * A search that belongs to a part of the page under the row, drawn in the row (`StickyTools`): Explore's search sat in
 * its card and scrolled away with the first results, the one thing its tab is for.
 */
describe("what a part of the page under the row draws into it", () => {
  async function page(parts: { row: boolean; search: boolean; fill?: boolean }) {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StickyBar, StickyTools } = await import("@/commons/components/ui/StickyBar");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const draw = (now: typeof parts) =>
      root.render(
        React.createElement(
          "div",
          null,
          now.row ? React.createElement(StickyBar, { label: "Filters", children: React.createElement("p", null, "tabs") }) : null,
          React.createElement(
            "section",
            { "data-card": "" },
            now.search ? React.createElement(StickyTools, { ...(now.fill ? { fill: true } : {}), children: React.createElement("input", { type: "search", "aria-label": "Find" }) }) : null,
            React.createElement("p", null, "results"),
          ),
        ),
      );
    draw(parts);
    await eventually(() => host.querySelector("section") !== null, 2_000, "the page");
    const where = () => ({ inRow: host.querySelector('[data-sticky-bar] input[aria-label="Find"]') !== null, inCard: host.querySelector('[data-card] input[aria-label="Find"]') !== null });
    return { host, draw, where, unmount: () => (root.unmount(), host.remove()) };
  }

  test("is in the row, not in the card it is written in; and is gone from the row when its part goes", async () => {
    const { host, draw, where, unmount } = await page({ row: true, search: true });
    try {
      await eventually(() => where().inRow, 2_000, "the search in the row");
      expect(where()).toEqual({ inRow: true, inCard: false });
      // Once, and after the tabs: at the row's end.
      expect(host.querySelectorAll('input[aria-label="Find"]')).toHaveLength(1);
      expect(host.querySelector("[data-sticky-bar]")!.lastElementChild!.querySelector('input[aria-label="Find"]')).not.toBeNull();
      // Its tab left: the row holds nothing of it, and its place takes no room.
      draw({ row: true, search: false });
      await eventually(() => !where().inRow, 2_000, "the search gone");
      expect(host.querySelector("[data-sticky-tools]")!.childElementCount).toBe(0);
      expect(host.querySelector("[data-sticky-tools]")!.getAttribute("class")).toContain("empty:hidden");
    } finally {
      unmount();
    }
  });

  test("a search that is what its tab is for takes what the tabs leave", async () => {
    const { host, where, unmount } = await page({ row: true, search: true, fill: true });
    try {
      await eventually(() => where().inRow, 2_000, "the search in the row");
      expect(host.querySelector("[data-sticky-tools] > [data-fill]")!.querySelector('input[aria-label="Find"]')).not.toBeNull();
      expect(host.querySelector("[data-sticky-tools]")!.getAttribute("class")).toContain("has-[[data-fill]]:flex-[1_1_22rem]");
    } finally {
      unmount();
    }
  });

  test("where the page has no such row it is drawn where it is written, and moves to a row that comes or back when it leaves", async () => {
    const { draw, where, unmount } = await page({ row: false, search: true });
    try {
      await eventually(() => where().inCard, 2_000, "the search in its card");
      expect(where()).toEqual({ inRow: false, inCard: true });
      draw({ row: true, search: true });
      await eventually(() => where().inRow, 2_000, "the search in the row that came");
      expect(where()).toEqual({ inRow: true, inCard: false });
      draw({ row: false, search: true });
      await eventually(() => where().inCard, 2_000, "back in its card");
      expect(where()).toEqual({ inRow: false, inCard: true });
    } finally {
      unmount();
    }
  });

  test("a page left takes its row with it: the next page's part is not drawn into a row that is gone", async () => {
    const first = await page({ row: true, search: false });
    first.unmount();
    const { where, unmount } = await page({ row: false, search: true });
    try {
      await eventually(() => where().inCard, 2_000, "the search in its card");
      expect(where()).toEqual({ inRow: false, inCard: true });
    } finally {
      unmount();
    }
  });
});
