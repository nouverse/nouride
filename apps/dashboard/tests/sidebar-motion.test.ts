/**
 * The sidebar moves (item 6 of its release): on a phone it is More (0.8.24, where it was a drawer from the side), a sheet
 * that slides up over a shade that fades, and slides back down — drawn once, and kept drawn while closed so it can be
 * seen to go, out of reach once hidden; on every width the page you are on is marked by one highlight that moves to the
 * item you open, where the mark jumped. Only place and opacity
 * move, and the reduced-motion rule cuts the moving while keeping what places the drawer (`reduced-motion.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const words = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/);
/** The menu's own nav: the tab bar under it is a nav too. */
const MENU = 'nav[aria-label="Menu"]';
/** The drawer: the sidebar's own frame, around the one nav. */
const drawer = (host: HTMLElement) => host.querySelector(MENU)?.parentElement?.parentElement ?? null;
const moreButton = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Tabs"] button')].find((button) => button.textContent?.includes("More")) ?? null;
const shade = (host: HTMLElement) => [...host.querySelectorAll('button[aria-label="Close menu"]')].find((button) => !button.closest("nav") && !drawer(host)?.contains(button)) ?? null;

describe("on a phone, More", () => {
  test("is drawn once, closed: out of place and out of reach, its shade faded out — and beside the page from a laptop up", async () => {
    let seen = { navs: 0, drawer: [] as string[], shade: [] as string[] };
    await renderPage("/missions", async (host) => {
      await eventually(() => host.querySelector(MENU) !== null, 4_000, "the sidebar");
      seen = { navs: host.querySelectorAll(MENU).length, drawer: words(drawer(host)), shade: words(shade(host)) };
    });
    expect(seen.navs).toBe(1);
    expect(seen.drawer).toEqual(expect.arrayContaining(["invisible", "translate-y-full", "transition-[translate,visibility]", "lg:visible", "lg:translate-y-0"]));
    expect(seen.shade).toEqual(expect.arrayContaining(["invisible", "opacity-0", "transition-[opacity,visibility]", "lg:hidden"]));
  });

  test("slides up over its shade when the tab bar's More is pressed, and back down — still drawn — when a page is chosen in it", async () => {
    let seen = { open: [] as string[], shade: [] as string[], closed: [] as string[], kept: false };
    await renderPage("/missions", async (host, app) => {
      await eventually(() => moreButton(host) !== null, 4_000, "the tab bar's More");
      const frame = drawer(host);
      moreButton(host)!.click();
      await eventually(() => words(drawer(host)).includes("translate-y-0") && moreButton(host)!.getAttribute("aria-expanded") === "true", 2_000, "More to open");
      seen.open = words(drawer(host));
      seen.shade = words(shade(host));
      (host.querySelector(`${MENU} a[href$="/skills"]`) as HTMLElement).click();
      await eventually(() => app.location().endsWith("/skills") && words(drawer(host)).includes("translate-y-full"), 4_000, "More to close");
      seen.closed = words(drawer(host));
      seen.kept = drawer(host) === frame;
    });
    expect(seen.open).toEqual(expect.arrayContaining(["visible", "translate-y-0"]));
    expect(seen.shade).toEqual(expect.arrayContaining(["visible", "opacity-100"]));
    expect(seen.closed).toEqual(expect.arrayContaining(["invisible", "translate-y-full"]));
    expect(seen.kept).toBe(true);
  });
});

// On a phone, More opened from Agents and Settings chosen in it, the tab bar then took some taps and not others: the
// sheet lay over the bar while open (More's place was Sign out, the tabs' the account's line), grew with Settings' pages
// as it slid away, and for the 200 ms it slid, a tap on a tab landed on one of those pages.
describe("on a phone, More and the tab bar", () => {
  const tabs = (host: HTMLElement) => host.querySelector<HTMLElement>('nav[aria-label="Tabs"]');
  const tab = (host: HTMLElement, name: string) => [...(tabs(host)?.querySelectorAll<HTMLElement>("a") ?? [])].find((one) => one.textContent?.trim().startsWith(name)) ?? null;

  test("the bar stays over the open sheet, which leaves it room, and goes back under what opens over the page once closed", async () => {
    let seen = { closedBar: [] as string[], openBar: [] as string[], sheet: [] as string[] };
    await renderPage("/agents", async (host) => {
      await eventually(() => moreButton(host) !== null, 4_000, "the tab bar's More");
      seen.closedBar = words(tabs(host));
      moreButton(host)!.click();
      await eventually(() => moreButton(host)!.getAttribute("aria-expanded") === "true", 2_000, "More to open");
      seen = { ...seen, openBar: words(tabs(host)), sheet: words(drawer(host)) };
    });
    expect(seen.closedBar).toContain("z-40");
    expect(seen.closedBar).not.toContain("z-[60]");
    // Over the sheet (z-50) while it is open.
    expect(seen.openBar).toContain("z-[60]");
    expect(seen.sheet).toContain("z-50");
    expect(seen.sheet).toContain("max-lg:pb-[calc(4.75rem+env(safe-area-inset-bottom))]");
  });

  test("put away, the sheet and its shade take no tap at once, not only when hidden; from a laptop up the menu takes them", async () => {
    let seen = { drawer: [] as string[], shade: [] as string[] };
    await renderPage("/agents", async (host) => {
      await eventually(() => host.querySelector(MENU) !== null, 4_000, "the sidebar");
      seen = { drawer: words(drawer(host)), shade: words(shade(host)) };
    });
    expect(seen.drawer).toEqual(expect.arrayContaining(["pointer-events-none", "lg:pointer-events-auto"]));
    expect(seen.shade).toContain("pointer-events-none");
  });

  test("a tab closes More, the tab of the page you are on too, and More closes what it opened", async () => {
    const seen: Record<string, string | null> = {};
    await renderPage("/agents", async (host, app) => {
      await eventually(() => moreButton(host) !== null, 4_000, "the tab bar's More");
      const expanded = () => moreButton(host)!.getAttribute("aria-expanded");
      moreButton(host)!.click();
      await eventually(() => expanded() === "true", 2_000, "More to open");
      // The page is Agents already: its address does not change, so only the tab's own press can close the sheet.
      tab(host, "Agents")!.click();
      await eventually(() => expanded() === "false", 2_000, "More to close on the current page's tab");
      seen.sameTab = expanded();
      moreButton(host)!.click();
      await eventually(() => expanded() === "true", 2_000, "More to open again");
      moreButton(host)!.click();
      await eventually(() => expanded() === "false", 2_000, "More to close itself");
      seen.more = expanded();
      seen.at = app.location();
    });
    expect(seen.sameTab).toBe("false");
    expect(seen.more).toBe("false");
    expect(seen.at).toMatch(/\/agents$/);
  });

  test("among Settings' pages, the sheet's Settings is one line and the one marked; the pages are listed from a laptop up only", async () => {
    let seen = { phone: [] as string[], phoneCurrent: null as string | null, laptop: [] as string[], laptopCurrent: null as string | null, pages: [] as string[], listed: 0 };
    await renderPage("/models", async (host) => {
      await eventually(() => host.querySelectorAll(`${MENU} a[href$="/settings"]`).length === 2, 4_000, "the menu's Settings");
      const [phone, laptop] = [...host.querySelectorAll<HTMLElement>(`${MENU} a[href$="/settings"]`)];
      const models = host.querySelector<HTMLElement>(`${MENU} a[href$="/models"]`);
      seen = {
        phone: words(phone),
        phoneCurrent: phone!.getAttribute("aria-current"),
        laptop: words(laptop),
        laptopCurrent: laptop!.getAttribute("aria-current"),
        pages: words(models?.parentElement),
        listed: models ? 1 : 0,
      };
    });
    expect(seen.phone).toContain("lg:hidden");
    expect(seen.phoneCurrent).toBe("page");
    expect(seen.laptop).toContain("max-lg:hidden");
    // From a laptop up the page itself is the one marked, as before.
    expect(seen.laptopCurrent).toBeNull();
    expect(seen.listed).toBe(1);
    expect(seen.pages).toContain("max-lg:hidden");
  });
});

describe("the page you are on", () => {
  test("is marked on the item that is drawn: one kept for another width is passed over", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { NavHighlight } = await import("@/commons/components/layout/NavHighlight");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const Nav = () => {
      const nav = React.useRef<HTMLElement>(null);
      return React.createElement(
        "nav",
        { ref: nav },
        React.createElement(NavHighlight, { nav }),
        React.createElement("a", { href: "/settings", "aria-current": "page", style: { display: "none" }, "data-kept": "" }, "Settings"),
        React.createElement("a", { href: "/models", "aria-current": "page", "data-drawn": "" }, "Models"),
      );
    };
    const root = createRoot(host);
    try {
      flushSync(() => root.render(React.createElement(Nav)));
      for (const [selector, top] of [["[data-kept]", 0], ["[data-drawn]", 80]] as const) {
        const link = host.querySelector<HTMLElement>(selector)!;
        for (const [name, value] of [["offsetTop", top], ["offsetLeft", 12], ["offsetWidth", selector === "[data-kept]" ? 0 : 232], ["offsetHeight", selector === "[data-kept]" ? 0 : 36]] as const) {
          Object.defineProperty(link, name, { configurable: true, get: () => value });
        }
      }
      flushSync(() => root.render(React.createElement(Nav)));
      await eventually(() => (host.querySelector<HTMLElement>("[data-current-mark]")?.style.translate ?? "") !== "", 2_000, "the mark placed");
      const mark = host.querySelector<HTMLElement>("[data-current-mark]")!;
      expect(mark.style.translate).toContain("80px");
      expect(mark.style.width).toBe("232px");
    } finally {
      flushSync(() => root.unmount());
      host.remove();
    }
  });

  /** Each nav link given a place, as a browser would lay them out: one under another, 40px apart. */
  function laidOut(host: HTMLElement): void {
    [...host.querySelectorAll<HTMLElement>(`${MENU} a`)].forEach((link, at) => {
      for (const [name, value] of [["offsetTop", 20 + at * 40], ["offsetLeft", 12], ["offsetWidth", 232], ["offsetHeight", 36]] as const) {
        Object.defineProperty(link, name, { configurable: true, get: () => value });
      }
    });
  }
  const mark = (host: HTMLElement) => host.querySelector<HTMLElement>(`${MENU} [data-current-mark]`);

  test("is marked by one highlight under its item, which moves — its place only — to the item opened", async () => {
    let seen = { marks: 0, first: "", second: "", where: "", size: "", moves: false, current: [] as string[] };
    await renderPage("/missions", async (host, app) => {
      await eventually(() => host.querySelector(`${MENU} a[aria-current="page"]`) !== null, 4_000, "the current item");
      laidOut(host);
      (host.querySelector(`${MENU} a[href$="/work"]`) as HTMLElement).click();
      await eventually(() => app.location().endsWith("/work") && (mark(host)?.style.translate ?? "") !== "", 4_000, "the mark placed");
      seen.first = mark(host)!.style.translate;
      laidOut(host);
      (host.querySelector(`${MENU} a[href$="/skills"]`) as HTMLElement).click();
      await eventually(() => app.location().endsWith("/skills") && mark(host)!.style.translate !== seen.first, 4_000, "the mark moved");
      const links = [...host.querySelectorAll<HTMLElement>(`${MENU} a`)];
      const current = host.querySelector<HTMLElement>(`${MENU} a[aria-current="page"]`)!;
      seen = {
        ...seen,
        marks: host.querySelectorAll(`${MENU} [data-current-mark]`).length,
        second: mark(host)!.style.translate,
        where: `12px ${20 + links.indexOf(current) * 40}px`,
        size: `${mark(host)!.style.width} ${mark(host)!.style.height}`,
        moves: words(mark(host)).includes("transition-[translate]"),
        current: words(current),
      };
    });
    expect(seen.marks).toBe(1);
    expect(seen.second).toBe(seen.where);
    expect(seen.second).not.toBe(seen.first);
    expect(seen.size).toBe("232px 36px");
    expect(seen.moves).toBe(true);
    // The item itself only says it is current in its colour and weight: the mark is the highlight's.
    expect(seen.current).toEqual(expect.arrayContaining(["text-secondary", "font-semibold"]));
    expect(seen.current).not.toContain("border");
    expect(seen.current).not.toContain("bg-secondary/10");
  });

  test("follows its item when the items move under it, as the sidebar is drawn again", async () => {
    let seen = { before: "", after: "", where: "" };
    await renderPage("/missions", async (host) => {
      await eventually(() => (mark(host)?.style.translate ?? "") !== "", 4_000, "the mark placed");
      laidOut(host);
      // Drawn again — the theme switched, here — with every item 40px lower, as one added above would put them.
      const current = host.querySelector<HTMLElement>(`${MENU} a[aria-current="page"]`)!;
      const top = current.offsetTop;
      Object.defineProperty(current, "offsetTop", { configurable: true, get: () => top + 40 });
      seen.before = mark(host)!.style.translate;
      (host.querySelector('button[aria-label^="Switch to the"]') as HTMLElement).click();
      await eventually(() => mark(host)!.style.translate === `12px ${top + 40}px`, 2_000, "the mark to follow its item");
      seen = { ...seen, after: mark(host)!.style.translate, where: `12px ${top + 40}px` };
    });
    expect(seen.after).toBe(seen.where);
    expect(seen.after).not.toBe(seen.before);
  });

  test("on a page that is none of the sidebar's items, the highlight is hidden rather than left on the last one", async () => {
    let hidden = false;
    await renderPage("/update", async (host) => {
      await eventually(() => mark(host) !== null, 4_000, "the mark");
      hidden = words(mark(host)).includes("invisible") && host.querySelector(`${MENU} a[aria-current="page"]`) === null;
    });
    expect(hidden).toBe(true);
  });
});

describe("the highlight's first placement", () => {
  test("does not move — it is placed where it belongs, and moves only from then on", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { NavHighlight } = await import("@/commons/components/layout/NavHighlight");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const Nav = () => {
      const nav = React.useRef<HTMLElement>(null);
      return React.createElement("nav", { ref: nav }, React.createElement(NavHighlight, { nav }), React.createElement("a", { href: "/missions", "aria-current": "page" }, "Missions"));
    };
    const root = createRoot(host);
    // Each state the mark is drawn in, in order: whether it is placed, and whether it moves.
    const states: { placed: boolean; moves: boolean }[] = [];
    const record = () => {
      const mark = host.querySelector<HTMLElement>("[data-current-mark]");
      if (mark) states.push({ placed: mark.style.translate !== "" && !words(mark).includes("invisible"), moves: words(mark).includes("transition-[translate]") });
    };
    const watched = new MutationObserver(record);
    watched.observe(host, { subtree: true, attributes: true, childList: true });
    try {
      flushSync(() => root.render(React.createElement(Nav)));
      record();
      await eventually(() => states.some(({ moves }) => moves), 2_000, "the mark to move from then on");
    } finally {
      watched.disconnect();
      root.unmount();
      host.remove();
    }
    const firstPlaced = states.find(({ placed }) => placed);
    expect(firstPlaced).toEqual({ placed: true, moves: false });
    expect(states.findIndex(({ moves }) => moves)).toBeGreaterThan(states.indexOf(firstPlaced!));
  });
});

describe("the page's fonts arriving", () => {
  test("place the highlight again: a font that comes late moves the items", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { NavHighlight } = await import("@/commons/components/layout/NavHighlight");
    let arrive = () => {};
    const fonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready: new Promise<void>((resolve) => (arrive = resolve)) } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const Nav = () => {
      const nav = React.useRef<HTMLElement>(null);
      return React.createElement("nav", { ref: nav }, React.createElement(NavHighlight, { nav }), React.createElement("a", { href: "/missions", "aria-current": "page" }, "Missions"));
    };
    const root = createRoot(host);
    let seen = "";
    try {
      flushSync(() => root.render(React.createElement(Nav)));
      const link = host.querySelector<HTMLElement>("a")!;
      await eventually(() => (host.querySelector<HTMLElement>("[data-current-mark]")?.style.translate ?? "") !== "", 2_000, "the mark placed");
      Object.defineProperty(link, "offsetTop", { configurable: true, get: () => 64 });
      arrive();
      await eventually(() => host.querySelector<HTMLElement>("[data-current-mark]")!.style.translate.endsWith(" 64px"), 2_000, "the mark placed again");
      seen = host.querySelector<HTMLElement>("[data-current-mark]")!.style.translate;
    } finally {
      root.unmount();
      host.remove();
      if (fonts) Object.defineProperty(document, "fonts", fonts);
      else delete (document as unknown as { fonts?: unknown }).fonts;
    }
    expect(seen).toBe("0px 64px");
  });
});
