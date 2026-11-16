/**
 * Inside Nouride Home (the Android app), the dashboard's own header has the way back to the app, so the app needs no
 * second bar above it, and the phone's back gesture is not the only way out.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_APP_BACK, inHomeApp } from "@/commons/lib/home-app";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
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

describe("on the pages that have no header", () => {
  useMountHarness();

  test("the sign-in page and the welcome have the same button in the app, in the corner the header's stands in", async () => {
    const seen: Record<string, { links: number; href: string | null; classes: string[] }> = {};
    await asTheApp(async () => {
      answer({ "/auth/me": { status: 401, body: { error: "unauthorized" } } });
      await renderPage("/login", async (host) => {
        await eventually(() => host.querySelector("input") !== null, 3_000, "the sign-in page");
        seen.login = { links: back(host).length, href: back(host)[0]?.getAttribute("href") ?? null, classes: (back(host)[0]?.getAttribute("class") ?? "").split(/\s+/) };
      });
      answer({});
      await renderPage("/welcome", async (host) => {
        await eventually(() => (host.textContent ?? "").length > 40, 3_000, "the welcome page");
        seen.welcome = { links: back(host).length, href: back(host)[0]?.getAttribute("href") ?? null, classes: (back(host)[0]?.getAttribute("class") ?? "").split(/\s+/) };
      });
    });
    for (const page of ["login", "welcome"]) {
      // One, never a second beside a header's: these pages draw no header.
      expect(seen[page]!.links).toBe(1);
      expect(seen[page]!.href).toBe(HOME_APP_BACK);
      // The header's own look and size, held to the window's corner over the page.
      expect(seen[page]!.classes).toEqual(expect.arrayContaining(["btn", "btn-ghost", "btn-square", "size-11", "text-secondary", "fixed", "left-3", "z-30"]));
    }
  });

  test("a browser that is not the app has none there, and a signed-in page in the app has the header's alone", async () => {
    let outside = -1;
    answer({ "/auth/me": { status: 401, body: { error: "unauthorized" } } });
    await renderPage("/login", async (host) => {
      await eventually(() => host.querySelector("input") !== null, 3_000, "the sign-in page");
      outside = back(host).length;
    });
    expect(outside).toBe(0);
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
  });
});
