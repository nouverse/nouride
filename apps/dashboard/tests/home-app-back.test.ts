/**
 * Inside Nouride Home (the Android app), the dashboard's own header has the way back to the app, so the app needs no
 * second bar above it, and the phone's back gesture is not the only way out.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_APP_BACK, inHomeApp } from "@/commons/lib/home-app";
import { answer, dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

describe("the way back to Nouride Home", () => {
  test("only the app's WebView is taken for the app", () => {
    expect(inHomeApp("Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36 NourideHome/1")).toBe(true);
    expect(inHomeApp("Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36")).toBe(false);
    expect(inHomeApp("Mozilla/5.0 (Macintosh) Safari/605.1.15")).toBe(false);
  });

  test("the header links to the address the app catches, and only inside it", () => {
    expect(HOME_APP_BACK).toBe("nouridehome://home");
    const header = readFileSync(join(import.meta.dir, "../src/commons/components/layout/RootLayout.tsx"), "utf8");
    expect(header).toContain('{inHomeApp() && <HomeAppBack className="-mr-1" />}');
    expect(header).toContain("href={HOME_APP_BACK}");
    expect(header).toContain('aria-label="Back to Nouride Home"');
  });
});

/** The app's WebView for the length of `run`, then the browser the harness is again. */
async function asTheApp(run: () => Promise<void>): Promise<void> {
  const before = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36 NourideHome/1", configurable: true });
  try {
    await run();
  } finally {
    if (before) Object.defineProperty(navigator, "userAgent", before);
    else delete (navigator as unknown as { userAgent?: string }).userAgent;
  }
}

const back = (host: HTMLElement) => [...host.ownerDocument.body.querySelectorAll<HTMLAnchorElement>('a[aria-label="Back to Nouride Home"]')];

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

  test("a signed-in page in the app has the header's chevron alone, and it is not held to the window", async () => {
    let inside: string[][] = [];
    answer({});
    await asTheApp(async () => {
      await renderPage("/", async (host) => {
        await eventually(() => back(host).length > 0, 3_000, "the header's button");
        inside = back(host).map((link) => (link.getAttribute("class") ?? "").split(/\s+/));
      });
    });
    expect(inside).toHaveLength(1);
    expect(inside[0]).not.toContain("fixed");
    expect(inside[0]).toContain("btn-square");
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
