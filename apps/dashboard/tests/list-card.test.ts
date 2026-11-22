/**
 * A long list in a card with another card under it: shown to a height, its last rows fading out, and opened in full
 * with one press. It scrolled inside the card before, a second thing to scroll under the page.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "ResizeObserver"] as const;
let dom: Window;
/** How tall the list is and how much of it shows: happy-dom lays nothing out, so a test says. */
let tall = { scroll: 0, client: 0 };

const MEASURED = ["scrollHeight", "clientHeight"] as const;
let measuredBefore: (PropertyDescriptor | undefined)[] = [];
const elementProto = () => (dom as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
  const proto = elementProto();
  measuredBefore = MEASURED.map((key) => Object.getOwnPropertyDescriptor(proto, key));
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => tall.scroll });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => tall.client });
});

// Put back: every window of a test run shares this prototype, and a file run after this one measured every element
// as the last list here was (a card's "Show all" drawn where nothing was long).
afterAll(() => {
  MEASURED.forEach((key, at) => {
    const was = measuredBefore[at];
    if (was) Object.defineProperty(elementProto(), key, was);
    else delete (elementProto() as Record<string, unknown>)[key];
  });
});

async function mount(maxHeight?: string) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ListCard } = await import("@/commons/components/ui/ListCard");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const rows = Array.from({ length: 40 }, (_, i) => React.createElement("p", { key: i }, `row ${i}`));
  root.render(React.createElement(ListCard, { title: "Drafts", ...(maxHeight ? { maxHeight } : {}), children: rows }));
  await eventually(() => (host.textContent ?? "").includes("row 39"), 2_000, "the list");
  return { host, unmount: () => (root.unmount(), host.remove()) };
}
const button = (host: HTMLElement) => [...host.querySelectorAll("button")].find((entry) => ["Show all", "Show less"].includes(entry.textContent?.trim() ?? ""));
const box = (host: HTMLElement) => host.querySelector("[data-expandable]")!;

describe("a list in a card", () => {
  test("with a height to show it to and more than that: cut short, opened in full with one press, and closed again", async () => {
    tall = { scroll: 900, client: 512 };
    const { host, unmount } = await mount("max-h-[32rem]");
    try {
      await eventually(() => button(host) !== undefined, 2_000, "the button");
      expect(button(host)!.textContent?.trim()).toBe("Show all");
      expect(button(host)!.getAttribute("aria-expanded")).toBe("false");
      expect(box(host).getAttribute("data-expandable")).toBe("closed");
      // Cut, not scrolled: nothing in the card scrolls by itself.
      expect(box(host).innerHTML).toContain("max-h-[32rem] overflow-hidden");
      expect(host.innerHTML).not.toContain("overflow-y-auto");
      button(host)!.click();
      await eventually(() => box(host).getAttribute("data-expandable") === "open", 2_000, "opened");
      expect(box(host).innerHTML).not.toContain("max-h-[32rem]");
      expect(button(host)!.textContent?.trim()).toBe("Show less");
      button(host)!.click();
      await eventually(() => box(host).getAttribute("data-expandable") === "closed", 2_000, "closed again");
    } finally {
      unmount();
    }
  });

  test("no taller than what shows, or a few pixels over: shown as it is, with no button", async () => {
    for (const scroll of [300, 512, 530]) {
      tall = { scroll, client: 512 };
      const { host, unmount } = await mount("max-h-[32rem]");
      try {
        expect(button(host)).toBeUndefined();
      } finally {
        unmount();
      }
    }
  });

  test("with no height given it is the page's own list: all of it, never cut", async () => {
    tall = { scroll: 9000, client: 512 };
    const { host, unmount } = await mount();
    try {
      expect(host.querySelector("[data-expandable]")).toBeNull();
      expect(button(host)).toBeUndefined();
      expect(host.innerHTML).not.toContain("max-h-");
    } finally {
      unmount();
    }
  });
});
