/**
 * Inside Nouride Home, the dashboard draws its own ways out, so the app needs no second bar above it: Back in a phone's
 * header, which pages back as the phone's own Back does, and "Back to Nouride Home" in the menu and on the pages that
 * have no header, which leaves at once. They are two links (`home-app.ts`), so the app can tell them apart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_APP_BACK, homeAppPageBack, inHomeApp } from "@/commons/lib/home-app";
import { answer, dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

const WEBVIEW = "Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36";

describe("the way back to Nouride Home", () => {
  test("only the app's WebView is taken for the app", () => {
    expect(inHomeApp("Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36 NourideHome/1")).toBe(true);
    expect(inHomeApp("Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36")).toBe(false);
    expect(inHomeApp("Mozilla/5.0 (Macintosh) Safari/605.1.15")).toBe(false);
  });

  test("two addresses the app catches: one pages back, one leaves", () => {
    expect(homeAppPageBack(`${WEBVIEW} NourideHome/2`)).toBe("nouridehome://back");
    expect(HOME_APP_BACK).toBe("nouridehome://home");
  });

  test("an app that says it catches the one link is sent that one for Back, as before the two were told apart", () => {
    expect(homeAppPageBack(`${WEBVIEW} NourideHome/1`)).toBe("nouridehome://home");
    expect(homeAppPageBack(`${WEBVIEW} NourideHome/12`)).toBe("nouridehome://back");
    // No number at all is no word about a second link.
    expect(homeAppPageBack(`${WEBVIEW} NourideHome/`)).toBe("nouridehome://home");
  });

  test("the header draws its chevron only inside the app", () => {
    const header = readFileSync(join(import.meta.dir, "../src/commons/components/layout/RootLayout.tsx"), "utf8");
    expect(header).toContain('{inHomeApp() && <HomeAppBack className="-mr-1" />}');
  });
});

/** The app's WebView for the length of `run`, then the browser the harness is again. `says`: the number after the app's mark, 2 for an app that catches both links. */
async function asTheApp(run: () => Promise<void>, says = 2): Promise<void> {
  const before = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", { value: `${WEBVIEW} NourideHome/${says}`, configurable: true });
  try {
    await run();
  } finally {
    if (before) Object.defineProperty(navigator, "userAgent", before);
    else delete (navigator as unknown as { userAgent?: string }).userAgent;
  }
}

/** Every link the app catches, with its address, what it says (to the eye, and to a screen reader) and whether the header holds it. */
const appLinks = (host: HTMLElement) =>
  [...host.ownerDocument.body.querySelectorAll<HTMLAnchorElement>('a[href^="nouridehome://"]')].map((link) => ({
    href: link.getAttribute("href"),
    words: (link.textContent ?? "").trim(),
    label: link.getAttribute("aria-label"),
    inHeader: link.closest("header") !== null,
    classes: (link.getAttribute("class") ?? "").split(/\s+/),
  }));

/** The pages that have no header, each with what says it is drawn and the box its way back must be inside. */
const GATES: { name: string; path: string; drawn: (host: HTMLElement) => boolean; within: string }[] = [
  { name: "the sign-in", path: "/login", drawn: (host) => host.querySelector("input") !== null, within: '[class~="max-w-sm"][class~="bg-base-100"]' },
  { name: "the welcome", path: "/welcome", drawn: (host) => (host.textContent ?? "").includes("Personalize Your Account"), within: '[class~="max-w-md"][class~="bg-base-100"]' },
  { name: "the setup", path: "/setup", drawn: (host) => (host.textContent ?? "").includes("Set up Nouride"), within: '[class~="max-w-xl"]' },
  { name: "a connector's sign-in coming back", path: "/oauth/mcp/callback?code=c&state=s", drawn: (host) => host.querySelector(".card-body") !== null, within: ".card-body" },
];

interface Seen {
  links: { href: string | null; words: string; classes: string[]; inside: boolean; first: boolean; beforeMascot: boolean }[];
  fixed: number;
}

/** Every link to the app on the page, where each stands, and how many things the page holds to the window. */
function gate(host: HTMLElement, within: string): Seen {
  const all = [...host.ownerDocument.body.querySelectorAll<HTMLAnchorElement>('a[href^="nouridehome://"]')];
  return {
    links: all.map((link) => {
      const box = link.closest(within);
      const mascot = box?.querySelector("img") ?? null;
      return {
        href: link.getAttribute("href"),
        words: (link.textContent ?? "").trim(),
        classes: (link.getAttribute("class") ?? "").split(/\s+/),
        inside: box !== null,
        // The first row of its box: nothing of the box comes before it.
        first: box?.firstElementChild === link,
        // 4: the mascot follows it in the page (Node.DOCUMENT_POSITION_FOLLOWING).
        beforeMascot: mascot === null || (link.compareDocumentPosition(mascot) & 4) !== 0,
      };
    }),
    fixed: host.ownerDocument.body.querySelectorAll('[class~="fixed"]').length,
  };
}

describe("on the pages that have no header", () => {
  useMountHarness();

  // A bare chevron held to the window's corner stood outside the card, over nothing, and lay over the page as it
  // scrolled. Each page draws the way back as the first row of its own content instead.
  for (const page of GATES) {
    test(`${page.name}: in the app, a named button inside the page's own content, held to nothing; in a browser, none`, async () => {
      let inside: Seen | null = null;
      let outside: Seen | null = null;
      const signedOut = page.path === "/login";
      await asTheApp(async () => {
        answer(signedOut ? { "/auth/me": { status: 401, body: { error: "unauthorized" } } } : {});
        await renderPage(page.path, async (host) => {
          await eventually(() => page.drawn(host), 3_000, page.name);
          inside = gate(host, page.within);
        });
      });
      answer(signedOut ? { "/auth/me": { status: 401, body: { error: "unauthorized" } } } : {});
      await renderPage(page.path, async (host) => {
        await eventually(() => page.drawn(host), 3_000, page.name);
        outside = gate(host, page.within);
      });
      // One, and it is the button that asks at once: these pages have no page before them to go back to.
      expect(inside!.links).toHaveLength(1);
      const link = inside!.links[0]!;
      expect(link.href).toBe("nouridehome://home");
      expect(link.words).toBe("Nouride Home");
      expect(link.classes).toEqual(expect.arrayContaining(["btn", "btn-ghost", "btn-sm"]));
      expect(link.classes).not.toContain("fixed");
      expect(link.classes).not.toContain("absolute");
      expect(link).toMatchObject({ inside: true, first: true, beforeMascot: true });
      // Nothing on the page is held to the window.
      expect(inside!.fixed).toBe(0);
      expect(outside!.links).toEqual([]);
    });
  }

  test("the shell holds nothing to the window's corner on these pages", () => {
    const shell = readFileSync(join(import.meta.dir, "../src/commons/components/layout/RootLayout.tsx"), "utf8");
    expect(shell).not.toContain('HomeAppBack className="fixed');
  });

});

describe("Back and \"Back to Nouride Home\" are two links", () => {
  useMountHarness();
  afterEach(() => dom.happyDOM.setViewport({ width: 1024, height: 768 }));

  // One link for every way back, and the app could not tell a page back from leaving: the header's chevron left the
  // dashboard from any page.
  test("on a phone: the header's bare chevron pages back, and More's row leaves", async () => {
    let header: ReturnType<typeof appLinks> = [];
    let menu: ReturnType<typeof appLinks> = [];
    dom.happyDOM.setViewport({ width: 390, height: 844 });
    answer({});
    await asTheApp(async () => {
      await renderPage("/agents", async (host) => {
        await eventually(() => appLinks(host).some((link) => link.inHeader), 3_000, "the header's chevron");
        header = appLinks(host).filter((link) => link.inHeader);
        const more = ([...host.ownerDocument.body.querySelectorAll('nav[aria-label="Tabs"] button')] as unknown as HTMLElement[]).find((button) => (button.textContent ?? "").trim() === "More")!;
        more.click();
        await eventually(() => host.ownerDocument.body.querySelector('[data-sheet][data-open] a[href^="nouridehome://"]') !== null, 3_000, "More's row");
        menu = appLinks(host).filter((link) => !link.inHeader);
      });
    });
    // The header's: a bare chevron, named Back, held to nothing.
    expect(header.map(({ href, words, label, inHeader }) => ({ href, words, label, inHeader }))).toEqual([{ href: "nouridehome://back", words: "", label: "Back", inHeader: true }]);
    expect(header[0]!.classes).toContain("btn-square");
    expect(header[0]!.classes).not.toContain("fixed");
    expect(menu.map(({ href, words }) => ({ href, words }))).toEqual([{ href: "nouridehome://home", words: "Back to Nouride Home" }]);
  });

  // An installed app is not updated with the daemon. One that catches `nouridehome://home` alone opens any other link
  // outside itself, where nothing takes it: its header's chevron did nothing at all.
  test("on a phone, in an app that catches the one link: the header's chevron sends that one", async () => {
    let header: ReturnType<typeof appLinks> = [];
    dom.happyDOM.setViewport({ width: 390, height: 844 });
    answer({});
    await asTheApp(async () => {
      await renderPage("/agents", async (host) => {
        await eventually(() => appLinks(host).some((link) => link.inHeader), 3_000, "the header's chevron");
        header = appLinks(host).filter((link) => link.inHeader);
      });
    }, 1);
    expect(header.map(({ href, label }) => ({ href, label }))).toEqual([{ href: "nouridehome://home", label: "Back" }]);
  });

  test("from a laptop's width: the menu's row and the folded menu's tile leave, and nothing but the header's pages back", async () => {
    const seen: Record<string, ReturnType<typeof appLinks>> = {};
    answer({});
    await asTheApp(async () => {
      await renderPage("/", async (host) => {
        await eventually(() => appLinks(host).some((link) => link.words === "Back to Nouride Home"), 3_000, "the menu's row");
        seen.menu = appLinks(host);
      });
      await renderPage("/chat", async (host) => {
        await eventually(() => appLinks(host).some((link) => link.words === "Exit"), 3_000, "the folded menu's tile");
        seen.folded = appLinks(host);
      });
    });
    for (const place of ["menu", "folded"]) {
      const links = seen[place]!;
      expect(links.filter((link) => link.href === "nouridehome://back").every((link) => link.inHeader && link.label === "Back")).toBe(true);
      expect(links.filter((link) => !link.inHeader).map((link) => link.href)).toEqual(["nouridehome://home"]);
    }
    expect(seen.menu!.find((link) => !link.inHeader)).toMatchObject({ words: "Back to Nouride Home", label: null });
    expect(seen.folded!.find((link) => !link.inHeader)).toMatchObject({ words: "Exit", label: "Back to Nouride Home" });
  });
});

/** Every link to the address the app catches, with where it is (in what scrolls the page, above its `<main>`) and its words. */
const closes = (host: HTMLElement) =>
  [...host.ownerDocument.body.querySelectorAll<HTMLAnchorElement>(`a[href="${HOME_APP_BACK}"]`)].map((link) => ({
    words: (link.textContent ?? "").trim(),
    label: link.getAttribute("aria-label"),
    // In what scrolls the page: the element that scrolls, outside the page's own `<main>`.
    scrolls: link.closest('[class~="overflow-y-auto"]') !== null && link.closest("main") === null,
  }));

describe("the menu's way out", () => {
  useMountHarness();
  afterEach(() => dom.happyDOM.setViewport({ width: 1024, height: 768 }));

  // The back gesture walks the dashboard's history: after a while of moving about, leaving took as many presses.
  test("from a laptop's width: the menu's last row, inside the app and nowhere else", async () => {
    let inside: ReturnType<typeof closes> = [];
    let outside: ReturnType<typeof closes> = [];
    answer({});
    await asTheApp(async () => {
      await renderPage("/", async (host) => {
        await eventually(() => closes(host).some((link) => link.words === "Back to Nouride Home"), 3_000, "the menu's row");
        inside = closes(host);
      });
    });
    await renderPage("/", async (host) => {
      await eventually(() => (host.textContent ?? "").includes("Nouride"), 3_000, "the page");
      outside = closes(host);
    });
    expect(inside).toContainEqual({ words: "Back to Nouride Home", label: null, scrolls: false });
    expect(outside).toEqual([]);
  });

  test("folded beside Chats, the same, as a tile", async () => {
    let seen: ReturnType<typeof closes> = [];
    answer({});
    await asTheApp(async () => {
      await renderPage("/chat", async (host) => {
        await eventually(() => closes(host).length > 0, 3_000, "the folded menu's tile");
        seen = closes(host);
      });
    });
    expect(seen).toContainEqual({ words: "Exit", label: "Back to Nouride Home", scrolls: false });
  });
});
