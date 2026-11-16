/**
 * On a phone the tab bar goes away as a page is scrolled down and comes back as it is scrolled up; it is there at the
 * page's top, while More is open and on a page too short to scroll. What stands over it, the chat's button, the toasts
 * and the bar that saves an automation, is placed by one value for the bar's foot (`--foot`), where each wrote a number
 * of its own (5.5rem, 5.25rem, 5.5rem): so each comes down with the bar and goes back up with it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";
import { FOOT_AT_REST, HIDE_AFTER_PX, nextFoot, type FootState } from "@/commons/lib/foot";

useMountHarness();

const SRC = join(dirname(import.meta.path), "..", "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

/** Scrolls one after another, from the page's top, on a page `maxY` tall past the window. */
function run(ys: number[], { maxY = 2000, more = false } = {}): boolean[] {
  let state: FootState = FOOT_AT_REST;
  return ys.map((y) => {
    state = nextFoot(state, { y, maxY, more });
    return state.shown;
  });
}

describe("the decision", () => {
  test("down past a short distance hides; less does not", () => {
    // From the top, where the run down begins.
    expect(run([20, HIDE_AFTER_PX - 1])).toEqual([true, true]);
    expect(run([20, 40, HIDE_AFTER_PX])).toEqual([true, true, false]);
  });

  test("any way up shows, at once, and a new run down starts its distance again", () => {
    expect(run([20, 300, 299])).toEqual([true, false, true]);
    expect(run([20, 300, 290, 300, 290 + HIDE_AFTER_PX])).toEqual([true, false, true, true, false]);
  });

  test("the top shows", () => {
    expect(run([20, 300, 4])).toEqual([true, false, true]);
    expect(run([20, 300, -30])).toEqual([true, false, true]);
  });

  test("while More is open it shows", () => {
    expect(run([20, 300], { more: true })).toEqual([true, true]);
  });

  test("a page that cannot scroll shows", () => {
    expect(run([20, 300], { maxY: 0 })).toEqual([true, true]);
  });

  test("a bounce past the foot and back is no scroll up: the bar stays away", () => {
    expect(run([20, 1990, 2060, 2000])).toEqual([true, false, false, false]);
  });
});

describe("one value for the foot", () => {
  test("the chat's button, the toasts, the save bar and the chat's card are placed by --foot", () => {
    expect(read("commons/components/floating-chat/FloatingChat.tsx")).toContain('BUTTON_PLACE = "right-4 bottom-[calc(var(--foot)+0.75rem)]');
    expect(read("commons/components/floating-chat/FloatingChat.tsx")).toContain("bottom-[calc(var(--foot)+4.75rem)]");
    expect(read("commons/components/ui/toast.tsx")).toContain("max-lg:bottom-[calc(var(--foot)+0.5rem)]!");
    expect(read("modules/automations/components/SaveBar.tsx")).toContain('className="sticky bottom-[calc(var(--foot)+0.75rem)]');
  });

  test("main.css says the bar's reach once, and what is away", () => {
    const css = read("styles/main.css");
    expect(css).toMatch(/--foot-bar:\s*calc\(4\.75rem \+ env\(safe-area-inset-bottom\)\);\s*--foot:\s*var\(--foot-bar\);/);
    expect(css).toMatch(/:root\[data-foot="away"\]\s*\{\s*--foot:\s*env\(safe-area-inset-bottom\);/);
  });

  test("no number of the bar's height is written anywhere else", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return files(path);
        return /\.(tsx?|css)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
      });
    // A height over the bar, written as a number and the screen's inset: what each place wrote before.
    const found = files(SRC).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/(bottom|pb)-\[calc\([\d.]+rem\+env\(safe-area-inset-bottom\)\)\]/g)].map((m) => `${relative(SRC, path)}: ${m[0]}`),
    );
    // The bar itself, 0.5rem off the foot, and the strip under it are what the value measures.
    expect(found).toEqual(["commons/components/layout/TabBar.tsx: bottom-[calc(0.5rem+env(safe-area-inset-bottom))]"]);
  });
});

describe("on a phone", () => {
  const phone = () => dom.happyDOM.setViewport({ width: 390, height: 844 });
  afterEach(() => {
    dom.happyDOM.setViewport({ width: 1024, height: 768 });
    delete dom.document.documentElement.dataset.foot;
  });
  /** A DOM here has no layout: the page is given a height to scroll through. */
  const tall = (main: HTMLElement) => {
    Object.defineProperty(main, "scrollHeight", { configurable: true, value: 3000 });
    Object.defineProperty(main, "clientHeight", { configurable: true, value: 800 });
  };
  const scrollTo = (main: HTMLElement, y: number) => {
    main.scrollTop = y;
    main.dispatchEvent(new dom.Event("scroll") as never);
  };

  test("a long page scrolled down puts the bar away and the foot with it; scrolled up, both are back", async () => {
    phone();
    const seen: Record<string, unknown> = {};
    await renderPage("/missions", async (host) => {
      await eventually(() => host.querySelector('nav[aria-label="Tabs"]') !== null && host.querySelector("main") !== null, 4_000, "the tab bar");
      const main = host.querySelector("main") as HTMLElement;
      const bar = () => host.querySelector('nav[aria-label="Tabs"]') as HTMLElement;
      tall(main);
      scrollTo(main, 20);
      scrollTo(main, 400);
      // The bar's own mark is drawn with it; the document's is written by an effect after that. Waited for together:
      // read the moment the bar changed, the document's was once still the old one, in a full run of the suite.
      const foot = () => dom.document.documentElement.dataset.foot;
      await eventually(() => bar().hasAttribute("data-away") && foot() === "away", 2_000, "the bar away, and the foot with it");
      seen.away = { foot: foot(), inert: bar().hasAttribute("inert"), classes: bar().className.split(" ") };
      scrollTo(main, 380);
      await eventually(() => !bar().hasAttribute("data-away") && foot() === undefined, 2_000, "the bar back, and the foot with it");
      seen.back = { foot: foot() ?? null, classes: bar().className.split(" ") };
    });
    expect(seen.away).toEqual({ foot: "away", inert: true, classes: expect.arrayContaining(["translate-y-[calc(100%+0.5rem+env(safe-area-inset-bottom))]", "transition-[translate]"]) });
    expect(seen.back).toEqual({ foot: null, classes: expect.not.arrayContaining(["translate-y-[calc(100%+0.5rem+env(safe-area-inset-bottom))]"]) });
  });

  test("from a laptop up nothing is followed: the bar is not there", () => {
    expect(read("commons/components/layout/RootLayout.tsx")).toContain("useFoot(scroller, { active: !laptop, more: moreOpen, page: pathname })");
  });
});
