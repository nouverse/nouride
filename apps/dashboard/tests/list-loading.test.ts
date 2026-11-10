/**
 * What is loading is drawn as its shape where a spinner stood: the page does not jump when it comes, and the shape says
 * what is coming. A list is rows, or cards side by side (`ListLoading`); a page about one thing, a card and a file
 * being read have shapes of their own (`Skeleton.tsx`). Each pulses as one, in opacity, which the
 * reduced-motion rule stops (`reduced-motion.test.ts`). A spinner is left for one thing being done in a button, and for
 * the screen that waits for the daemon to come back.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const SRC = join(import.meta.dir, "..", "src");

/** Where a large spinner still stands, and why it is not something on its way. */
const NOT_A_SHAPE: Record<string, string> = {
  "commons/components/layout/Reconnecting.tsx": "the daemon coming back: nothing to draw until it has",
};

/** Words that stood where a shape now does: "Reading…" under a spinner, in the middle of a page. */
const WAITING_WORDS = /(Reading your box|Reading the skill|Reading the current version|Checking WhatsApp link status|Checking which accounts are signed in|Connecting to Nouride)…/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

/** A source with its comments out: a comment may say what stood there before. */
const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("what is loading", () => {
  test("is drawn as its shape: no large spinner is left but on the screen that waits for the daemon", () => {
    const spinning = files(SRC)
      .filter((path) => /loading-spinner loading-(md|lg)|<Loader2 size=\{(18|20|28)\}/.test(code(path)))
      .map((path) => relative(SRC, path));
    expect(spinning).toEqual(Object.keys(NOT_A_SHAPE));
  });

  test("and no page says it is reading or checking under a spinner", () => {
    expect(files(SRC).filter((path) => WAITING_WORDS.test(code(path))).map((path) => relative(SRC, path))).toEqual([]);
  });

  test("a mission's page is its shape: where it came from, its name, its cards", async () => {
    answer({ "/missions/msn_1": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("loading-spinner");
    // Three cards under the name, each a floating card's corners.
    expect(html.split("rounded-[22px] border border-base-content/[0.06] p-5").length - 1).toBe(3);
  });

  test("Home is its shape while it asks whether Nouride answers: the greeting's card, three cards, the agents'", async () => {
    answer({ "/health": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/", async (host) => {
      await eventually(() => host.querySelector('main [aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("Connecting to Nouride");
    expect(html).toContain("lg:grid-cols-3");
  });

  test("Secrets and Webhooks draw rows, not their empty list, until the answer says there is nothing", async () => {
    for (const [path, route, empty] of [["/secrets", "/secrets", "No secrets yet"], ["/webhooks", "/webhooks", "No webhooks yet"]] as const) {
      answer({ [route]: { status: 200, body: {}, hold: true } });
      const html = await renderPage(path, async (host) => {
        await eventually(() => host.querySelector('main [aria-busy="true"]') !== null, 4_000, `${path}'s shape`);
      });
      expect(html).toContain("animate-pulse");
      expect(html).not.toContain(empty);
    }
  });

  test("on Missions is cards side by side, as the missions will be, and no spinner", async () => {
    answer({ "/missions": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/missions", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("md:grid-cols-2");
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("loading-spinner loading-lg");
  });

  test("pulses inside its frame, which a page's section fades in: one element takes one animation", async () => {
    answer({ "/people": { status: 200, body: {}, hold: true } });
    let seen = { frame: [] as string[], inside: [] as string[], fades: false };
    await renderPage("/people", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
      const frame = host.querySelector('[aria-busy="true"]')!;
      seen = {
        frame: (frame.getAttribute("class") ?? "").split(/\s+/),
        inside: (frame.firstElementChild?.getAttribute("class") ?? "").split(/\s+/),
        fades: (frame.parentElement?.getAttribute("class") ?? "").split(/\s+/).includes("*:animate-fade"),
      };
    });
    expect(seen.fades).toBe(true);
    expect(seen.frame.filter((word) => word.startsWith("animate-"))).toEqual([]);
    expect(seen.inside).toContain("animate-pulse");
  });

  test("on People is rows, and the list takes their place once it comes", async () => {
    answer({ "/people": { status: 200, body: {}, hold: true } });
    const loading = await renderPage("/people", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(loading).toContain("animate-pulse");
    expect(loading).not.toContain("loading-spinner loading-lg");
    answer({});
    const loaded = await renderPage("/people", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') === null, 4_000, "the list");
    });
    expect(loaded).not.toContain('aria-busy="true"');
  });

  test("in System Logs is rows, where the daemon's lines will be", async () => {
    answer({ "/logs/stored": { status: 200, body: {}, hold: true } });
    const html = await renderPage("/logs", async (host) => {
      await eventually(() => host.querySelector('[aria-busy="true"]') !== null, 4_000, "the shape");
    });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("animate-spin text-primary/60");
  });
});
