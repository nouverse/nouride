/**
 * A table in an agent's reply (`MarkdownTable.tsx`): its columns are the agent's, so it does not fold on a phone as
 * the dashboard's own tables do. It scrolls sideways in its box, a shade on each side that holds more says so, and
 * a column keeps a reader's width at every size of window: in a chat's column on a laptop a table of many columns was
 * squeezed as it was on a phone.
 */

import { describe, expect, test } from "bun:test";
import { moreToTheSide } from "@/commons/lib/scroll-edges";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

describe("which side of a box holds more", () => {
  test("none when it all fits; the end at the start; both in the middle; the start at the end", () => {
    expect(moreToTheSide(0, 300, 300)).toEqual({ start: false, end: false });
    expect(moreToTheSide(0, 600, 300)).toEqual({ start: false, end: true });
    expect(moreToTheSide(150, 600, 300)).toEqual({ start: true, end: true });
    expect(moreToTheSide(300, 600, 300)).toEqual({ start: true, end: false });
  });

  test("a pixel of slack is none: a box scrolled to its end a fraction short is at its end", () => {
    expect(moreToTheSide(299.5, 600, 300)).toEqual({ start: true, end: false });
    expect(moreToTheSide(0.5, 600, 300)).toEqual({ start: false, end: true });
  });
});

describe("a table in a reply", () => {
  test("scrolls in its box, and shades the side that holds more as it is scrolled", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { Markdown } = await import("@/commons/components/ui/Markdown");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    root.render(React.createElement(Markdown, { source: "| Name | Region | Revenue | Growth | Owner |\n|---|---|---|---|---|\n| Alpha | APAC | 1,200 | 12% | Mira |" }));
    try {
      await eventually(() => host.querySelector("table") !== null, 2_000, "the table");
      const frame = host.querySelector<HTMLElement>("table")!.closest("[class*=rounded-2xl]") as HTMLElement;
      const scroller = host.querySelector("table")!.parentElement as HTMLElement;
      expect(scroller.className).toContain("overflow-x-auto");
      // A least width for every cell, whatever the window's: what does not fit is scrolled to, never squeezed.
      const cells = [...host.querySelectorAll("th, td")].map((cell) => cell.className.split(" "));
      expect(cells).toHaveLength(10);
      expect(cells.every((classes) => classes.includes("min-w-28"))).toBe(true);
      expect(cells.some((classes) => classes.some((name) => name.endsWith(":min-w-28")))).toBe(false);
      const at = (left: number) => {
        Object.defineProperty(scroller, "scrollWidth", { value: 600, configurable: true });
        Object.defineProperty(scroller, "clientWidth", { value: 300, configurable: true });
        Object.defineProperty(scroller, "scrollLeft", { value: left, configurable: true });
        scroller.dispatchEvent(new dom.Event("scroll") as never);
      };
      const shades = () => [frame.hasAttribute("data-more-start"), frame.hasAttribute("data-more-end")];
      const shown = () => [...frame.querySelectorAll(":scope > span[aria-hidden]")].map((span) => span.className.includes("opacity-100"));
      at(0);
      await eventually(() => shades()[1] === true, 2_000, "more at the end");
      expect(shades()).toEqual([false, true]);
      expect(shown()).toEqual([false, true]);
      at(300);
      await eventually(() => shades()[0] === true && shades()[1] === false, 2_000, "more at the start");
      expect(shown()).toEqual([true, false]);
    } finally {
      root.unmount();
      host.remove();
    }
  });
});
