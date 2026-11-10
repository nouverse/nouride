/**
 * Layout on a phone (0.8.12), the rules an iPhone found broken, read from the source:
 * - every page ends above the browser's toolbar and the home indicator: its container carries `PAGE_BOTTOM`, past the
 *   safe area, which the viewport reports only with `viewport-fit=cover` — and the layout keeps clear of a notch then;
 * - a grid that sets its columns at a breakpoint sets the phone's too: without `grid-cols-1` its one track is as wide as
 *   its widest unbreakable line, and a job's name in a cut-off line pushed Overview past the screen's edge;
 * - a button a finger can hit: one held to 20–24px by its own height is 32px or more there.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(import.meta.path), "..");
const SRC = join(ROOT, "src");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

/** Every string literal in `src`'s code, each as its words — where class names live. */
function literals(): { file: string; words: string[] }[] {
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
    });
  })(SRC);
  return files.flatMap((path) => {
    const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    return [...code.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`]*)`/g)].map((m) => ({
      file: relative(SRC, path),
      words: (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean),
    }));
  });
}

describe("the bottom of a page", () => {
  const constant = (name: string) => new RegExp(`export const ${name} = "([^"]+)"`).exec(read("commons/components/ui/ScrollCard.tsx"))?.[1] ?? "";
  const PAGE_BOTTOM = constant("PAGE_BOTTOM");
  const HELD_BOTTOM = constant("HELD_BOTTOM");
  /** The rems a class gives the foot below a laptop's width, past the safe area. */
  const phoneRem = (classes: string) => Number(/(?:^|\s)pb-\[calc\((\d+(?:\.\d+)?)rem\+env\(safe-area-inset-bottom\)\)\]/.exec(classes)?.[1] ?? Number.NaN);
  /** The tab bar's reach up from the screen's foot, as the layout keeps clear of it (`TAB_BAR_SPACE`). */
  const BAR_REM = Number(/export const TAB_BAR_SPACE = "max-lg:pb-\[calc\((\d+(?:\.\d+)?)rem/.exec(read("commons/components/layout/TabBar.tsx"))?.[1] ?? Number.NaN);

  // The last line of a page sat a finger's width above the tab bar and read as under it; a laptop's page ended 2rem
  // above the window's foot.
  test("on a phone is the tab bar's reach and room to see the last card clear of it; from a laptop up, a page that scrolls ends well above the window's foot", () => {
    expect(BAR_REM).toBeGreaterThan(0);
    // 4rem of air or more past the bar.
    expect(phoneRem(PAGE_BOTTOM)).toBeGreaterThanOrEqual(BAR_REM + 4);
    expect(PAGE_BOTTOM.split(" ")).toContain("lg:pb-20");
  });

  test("a page held to the window from a laptop up keeps the page's own margin there, and a phone's room", () => {
    expect(phoneRem(HELD_BOTTOM)).toBe(phoneRem(PAGE_BOTTOM));
    expect(HELD_BOTTOM.split(" ")).toContain("lg:pb-8");
  });

  test("is under every page: the document's, the one held to the window, System Logs and Secrets", () => {
    const layout = read("commons/components/layout/RootLayout.tsx");
    const containers = [...layout.matchAll(/<div className=\{`mx-auto [^`]*`\}>/g)].map((m) => m[0]);
    expect(containers.length).toBe(2);
    const [held, document] = [containers.find((one) => one.includes("lg:h-full"))!, containers.find((one) => !one.includes("lg:h-full"))!];
    expect(held).toContain("${HELD_BOTTOM}");
    expect(document).toContain("${PAGE_BOTTOM}");
    // No `sm:p-*` or `p-*` after it that would set the bottom back below a laptop's width.
    for (const container of containers) expect(container).not.toMatch(/\s(sm:)?p-\d/);
    for (const page of ["modules/logs/index.page.tsx", "modules/secrets/index.page.tsx"]) expect(read(page)).toContain("${HELD_BOTTOM}");
  });

  test("Home's last card ends above its floating Chat button, not under it", () => {
    const button = read("modules/home/components/NewChatButton.tsx");
    // Where the button's top is, up from the safe area: its place and its height (`h-12` is 3rem).
    const place = Number(/bottom-\[calc\((\d+(?:\.\d+)?)rem\+env\(safe-area-inset-bottom\)\)\]/.exec(button)?.[1] ?? Number.NaN);
    expect(button).toMatch(/\bh-12\b/);
    const top = place + 3;
    // What Home adds under its last card: `max-lg:pb-N`, a quarter of a rem a step.
    const room = Number(/export const CHAT_BUTTON_ROOM = "max-lg:pb-(\d+)"/.exec(button)?.[1] ?? Number.NaN) / 4;
    expect(read("modules/home/index.page.tsx")).toContain("${CHAT_BUTTON_ROOM}");
    // The last card's foot, up from the safe area, against the button's top: 2rem of air or more, as cards have
    // between them and the bar.
    expect(phoneRem(PAGE_BOTTOM) + room).toBeGreaterThanOrEqual(top + 2);
  });

  test("the chat's composer, which sits at the bottom, keeps clear of the home indicator", () => {
    expect(read("modules/chat/components/Composer.tsx")).toContain("pb-[max(0.75rem,env(safe-area-inset-bottom))]");
  });

  test("the viewport reports the safe area, and keeps its zoom", () => {
    const meta = /<meta name="viewport" content="([^"]+)"/.exec(readFileSync(join(ROOT, "index.html"), "utf8"))?.[1] ?? "";
    expect(meta).toContain("viewport-fit=cover");
    expect(meta).not.toMatch(/user-scalable=no|maximum-scale=1/);
  });

  test("covered, the layout keeps its header and sides clear of a notch", () => {
    const layout = read("commons/components/layout/RootLayout.tsx");
    for (const inset of ["pl-[env(safe-area-inset-left)]", "pr-[env(safe-area-inset-right)]", "pt-[env(safe-area-inset-top)]"]) expect(layout).toContain(inset);
  });
});

describe("a small button on a phone", () => {
  test("held under daisyUI's xs height by its own is a finger's size there — `btn-xs` alone is lifted in main.css", () => {
    const held = literals().filter(({ words }) => words.includes("btn-xs") && words.some((w) => /^(h|size)-[4-6]$/.test(w)));
    expect(held.length).toBeGreaterThan(5);
    const small = held.filter(({ words }) => !words.some((w) => /^max-sm:(h-(8|9|10)|size-(7|8|9|10))$/.test(w)));
    expect(small.map(({ file, words }) => `${file}: ${words.join(" ")}`)).toEqual([]);
  });
});

describe("a grid on a phone", () => {
  test("that sets its columns at a breakpoint sets the phone's too", () => {
    const all = literals();
    const grids = all.filter(({ words }) => words.includes("grid") && words.some((w) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(w)));
    expect(grids.length).toBeGreaterThan(40);
    const bare = grids.filter(({ words }) => !words.some((w) => /^grid-cols-/.test(w)));
    expect(bare.map(({ file, words }) => `${file}: ${words.join(" ")}`)).toEqual([]);
  });
});

describe("a skill draft's row", () => {
  test("its words hold 16rem before Keep and delete share their line — on a phone those go under", () => {
    // Live, 0.8.12: beside the buttons, a draft's description was a column a third of the screen wide on a phone.
    const row = read("modules/skills/drafts.panel.tsx");
    expect(row).toContain('<div className="flex flex-wrap items-start gap-3">');
    expect(row).toContain('<div className="min-w-0 flex-1 basis-64">');
    expect(row).toContain('<div className="ml-auto flex shrink-0 gap-1">');
  });
});
