/**
 * A conversation follows its own end as it grows (`commons/hooks/use-sticky-scroll.ts`), from the draw its content
 * first appears in. Through the whole app, in the chat that floats over a page.
 *
 * What grows is watched by a `ResizeObserver` on the conversation's content. The content is not drawn at first: a
 * conversation still being read draws its loading shape. The hook looked for it once, as it was set up, so in the
 * floating chat, where the conversation is read after the panel is drawn, nothing was ever watched: an answer was
 * written on under the fold, and the way to what the agent made with it. Measured in a browser: 779 px from the end
 * when the answer was done.
 *
 * A browser's layout is not here, so the observer is the test's: it says what it was given to watch, and the test
 * says when that grew.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answer, dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

/** A `ResizeObserver` that keeps what it watches, and says it grew when the test says so. */
class WatchedGrowth {
  static all: WatchedGrowth[] = [];
  readonly watching = new Set<Element>();
  constructor(private readonly grew: () => void) {
    WatchedGrowth.all.push(this);
  }
  observe(element: Element): void {
    this.watching.add(element);
  }
  unobserve(element: Element): void {
    this.watching.delete(element);
  }
  disconnect(): void {
    this.watching.clear();
  }
  /** Whatever watches `element` is told it grew. */
  static grow(element: Element): void {
    for (const one of WatchedGrowth.all) if (one.watching.has(element)) one.grew();
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
let real: unknown;
beforeEach(() => {
  real = globals.ResizeObserver;
  globals.ResizeObserver = WatchedGrowth;
  WatchedGrowth.all = [];
});
afterEach(() => {
  globals.ResizeObserver = real;
  dom.localStorage.removeItem(LAST_AGENT_KEY);
});

/** The box the conversation scrolls in, and its content: what holds the exchanges, and grows. */
const scrollBox = () => card()?.querySelector(".overflow-y-auto") as HTMLElement | null;
const content = () => [...(scrollBox()?.children ?? [])].find((child) => child.textContent?.includes("is the disk full?")) as HTMLElement | undefined;
/** The box as a browser would have laid it out: this tall inside, this much of it seen, scrolled this far. */
function laidOut(box: HTMLElement, at: { height: number; seen: number; top: number }): void {
  Object.defineProperty(box, "scrollHeight", { value: at.height, configurable: true });
  Object.defineProperty(box, "clientHeight", { value: at.seen, configurable: true });
  box.scrollTop = at.top;
}
const scrolled = (box: HTMLElement) => box.dispatchEvent(new dom.Event("scroll") as unknown as Event);

describe("the conversation in the floating chat", () => {
  test("is watched from the draw its content appears in, and follows its end as it grows", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await eventually(() => floatButton(host) !== null, 3_000, "the button");
      floatButton(host)!.click();
      await eventually(() => boxIn(card()) !== null && content() !== undefined, 3_000, "the conversation read and drawn");
      const box = scrollBox()!;
      // Read after the panel was drawn: its content was not there when the hook was set up, and is watched all the same.
      await eventually(() => WatchedGrowth.all.some((one) => one.watching.has(content()!)), 2_000, "the content watched");

      // An answer is written: the content grows, and the view is at its end.
      laidOut(box, { height: 1_200, seen: 400, top: 0 });
      WatchedGrowth.grow(content()!);
      expect(box.scrollTop).toBe(1_200);

      // The reader scrolls up to read: what grows after that does not take them back.
      laidOut(box, { height: 1_500, seen: 400, top: 300 });
      scrolled(box);
      laidOut(box, { height: 1_900, seen: 400, top: 300 });
      WatchedGrowth.grow(content()!);
      expect(box.scrollTop).toBe(300);

      // Back at the end, near enough: it is followed again.
      laidOut(box, { height: 1_900, seen: 400, top: 1_400 });
      scrolled(box);
      laidOut(box, { height: 2_600, seen: 400, top: 1_400 });
      WatchedGrowth.grow(content()!);
      expect(box.scrollTop).toBe(2_600);
    });
  });

  test("put away, nothing of it is watched any more", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await eventually(() => floatButton(host) !== null, 3_000, "the button");
      floatButton(host)!.click();
      await eventually(() => WatchedGrowth.all.some((one) => one.watching.size > 0), 3_000, "the content watched");
      floatButton(host)!.click();
      await eventually(() => card() === null, 3_000, "the panel put away");
      // Counted, not listed: a failure that prints an element prints the whole page it is in.
      expect(WatchedGrowth.all.reduce((sum, one) => sum + one.watching.size, 0)).toBe(0);
    });
  });
});
