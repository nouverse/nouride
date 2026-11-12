/**
 * Layout on a phone (0.8.12), the rules an iPhone found broken, read from the source:
 * - every page ends above the browser's toolbar and the home indicator: its container carries `PAGE_BOTTOM`, past the
 *   safe area, which the viewport reports only with `viewport-fit=cover` — and the layout keeps clear of a notch then;
 * - a grid that sets its columns at a breakpoint sets the phone's too: without `grid-cols-1` its one track is as wide as
 *   its widest unbreakable line, and a job's name in a cut-off line pushed Overview past the screen's edge;
 * - a button a finger can hit: one held to 20–24px by its own height is 32px or more there;
 * - a page is as tall as what is seen (`dvh`), never the screen with the browser's toolbar put away (`vh`).
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

  // It kept the page's own 2rem there while the floating chat's button was small enough to lie over its card's corner.
  test("a page held to the window from a laptop up ends where a page that scrolls does, and has a phone's room", () => {
    expect(phoneRem(HELD_BOTTOM)).toBe(phoneRem(PAGE_BOTTOM));
    expect(HELD_BOTTOM.split(" ")).toContain("lg:pb-20");
  });

  // Skills' Explore runs down the page, on a page held to the window: its last card ended flush with the window's foot,
  // because the layout's padding is inside the height the page is held to.
  test("a held page that runs past the window has a foot of its own, which takes nothing from a list that fills it", () => {
    const source = read("commons/components/ui/ScrollCard.tsx");
    const foot = (/const HELD_FOOT = "([^"]+)"/.exec(source)?.[1] ?? "").split(" ");
    const fill = /export const FILL_PAGE = `([^`]+)`/.exec(source)?.[1] ?? "";
    expect(fill).toContain("${HELD_FOOT}");
    // A step is a quarter of a rem. The foot is as tall as the layout's padding there, so it lies in it.
    const steps = (prefix: string, among: string[]) => Number(among.find((word) => word.startsWith(prefix))?.slice(prefix.length) ?? Number.NaN);
    expect(foot).toContain("lg:after:content-['']");
    expect(foot).toContain("lg:after:shrink-0");
    expect(steps("lg:after:h-", foot)).toBe(steps("lg:pb-", HELD_BOTTOM.split(" ")));
    // Its margins take back its own height and the gap before it: the list above it keeps every pixel.
    expect(steps("lg:after:-mb-", foot)).toBe(steps("lg:after:h-", foot));
    expect(steps("lg:after:-mt-", foot)).toBe(steps("gap-", fill.split(" ")));
  });

  test("a tab that runs down a held page ends with a scrolling page's room", () => {
    const source = read("commons/components/ui/ScrollCard.tsx");
    const steps = (pattern: RegExp, text: string) => Number(pattern.exec(text)?.[1] ?? Number.NaN);
    const runsDown = steps(/export const RUNS_DOWN = "lg:pb-(\d+)"/, source);
    expect(runsDown + steps(/lg:after:h-(\d+)/, source)).toBe(steps(/lg:pb-(\d+)/, PAGE_BOTTOM));
    // On a root as tall as what it holds: one held to what the window left (`flex-1 min-h-0`) keeps the room inside it,
    // above where its cards end.
    const root = /<div className=\{`([^`]*\$\{RUNS_DOWN\}[^`]*)`\}>/.exec(read("modules/skills/explore.panel.tsx"))?.[1] ?? "";
    expect(root).toContain("${RUNS_DOWN}");
    for (const word of ["flex-1", "min-h-0"]) expect(root.split(" ")).not.toContain(word);
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

  // The floating chat's button stands over the tab bar's right end on every page but Chats, where Home's "+ Chat" stood
  // on Home alone: so every page's foot leaves it the room Home's did.
  test("a page's last card ends above the floating chat's button, not under it; the button stands clear of the tab bar", () => {
    const place = (/const BUTTON_PLACE = "([^"]+)"/.exec(read("commons/components/floating-chat/FloatingChat.tsx"))?.[1] ?? "").split(" ");
    // Where the button's foot is, up from the safe area, below a laptop's width; and its height at every width
    // (`size-14` is 3.5rem: it was 2.75rem from a laptop up, and too small to find).
    const foot = Number(/^bottom-\[calc\((\d+(?:\.\d+)?)rem\+env\(safe-area-inset-bottom\)\)\]$/.exec(place.find((word) => word.startsWith("bottom-")) ?? "")?.[1] ?? Number.NaN);
    const tall = Number(/^size-(\d+)$/.exec(place.find((word) => word.startsWith("size-")) ?? "")?.[1] ?? Number.NaN) / 4;
    expect(tall).toBeGreaterThanOrEqual(3.5);
    expect(place.some((word) => /^(sm|md|lg|xl):size-/.test(word))).toBe(false);
    expect(foot).toBeGreaterThan(BAR_REM);
    // The last card's foot against the button's top: 2rem of air or more, as cards have between them and the bar.
    expect(phoneRem(PAGE_BOTTOM)).toBeGreaterThanOrEqual(foot + tall + 2);
    // From a laptop up it is in the window's corner, and a page's last card ends over it: one that scrolls, and one
    // held to the window, whose card's last row would lie under it.
    const corner = Number(/^lg:bottom-(\d+(?:\.\d+)?)$/.exec(place.find((word) => word.startsWith("lg:bottom-")) ?? "")?.[1] ?? Number.NaN) / 4;
    for (const bottom of [PAGE_BOTTOM, HELD_BOTTOM]) {
      const room = Number(/(?:^| )lg:pb-(\d+)(?: |$)/.exec(bottom)?.[1] ?? Number.NaN) / 4;
      expect(room).toBeGreaterThanOrEqual(corner + tall);
    }
  });

  test("a toast stands above the tab bar on a phone, where it lay over the tabs and took their taps", () => {
    const reach = Number(/export const TAB_BAR_SPACE = "max-lg:pb-\[calc\(([\d.]+)rem\+env\(safe-area-inset-bottom\)\)\]"/.exec(read("commons/components/layout/TabBar.tsx"))?.[1]);
    const stack = /className="(toast [^"]+)"/.exec(read("commons/components/ui/toast.tsx"))?.[1] ?? "";
    const lifted = Number(/(?:^| )max-lg:bottom-\[calc\(([\d.]+)rem\+env\(safe-area-inset-bottom\)\)\]!(?: |$)/.exec(stack)?.[1]);
    expect(reach).toBeGreaterThan(4);
    expect(lifted).toBeGreaterThanOrEqual(reach);
  });

  test("the chat's composer, which sits at the bottom, keeps clear of the home indicator", () => {
    expect(read("commons/components/chat/Composer.tsx")).toContain("pb-[max(0.75rem,env(safe-area-inset-bottom))]");
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

describe("the height of a page", () => {
  /** `md:!min-h-screen` is `min-h-screen`: a variant or `!` in front does not change what the class measures. */
  const bare = (word: string) => word.replace(/^(?:[^:\s[]+:)+/, "").replace(/^!/, "");

  test("is the screen as it is seen, never the screen with the browser's toolbar put away", () => {
    // Live, on a phone: the shell said `h-screen h-[100dvh]`, and in the stylesheet `h-screen` is written after the
    // other, so it won whatever the order of the two in the class. A phone browser's `100vh` is the screen without its
    // toolbar, taller than what is seen: the foot of the Chats list sat under the tab bar with nothing left to scroll,
    // and the document itself scrolled, which puts the toolbar away, after which the browser takes the next tap near
    // the screen's foot to bring it back, so a tab did nothing.
    const all = literals();
    expect(all.length).toBeGreaterThan(3000);
    const tall = all.flatMap(({ file, words }) => words.filter((w) => /^(h|min-h|max-h)-screen$/.test(bare(w)) || /\d(vh|lvh)\b/.test(w)).map((w) => `${file}: ${w}`));
    expect(tall).toEqual([]);
  });

  test("the shell, which holds every page to the window, is one of them", () => {
    const shell = /<div className="(bg-app flex [^"]+)"/.exec(read("commons/components/layout/RootLayout.tsx"))?.[1] ?? "";
    expect(shell.split(" ")).toContain("h-dvh");
    expect(shell.split(" ")).toContain("overflow-hidden");
  });

  test("a dialog's box is held to what is seen, under a class that says a height of its own", () => {
    // daisyUI holds `modal-box` to `100vh - 5em`. The rule here sits in a layer inside the utilities', which daisyUI's
    // is too: later than daisyUI's, so it wins there, and under the utilities themselves, so `max-h-[90dvh]` still does.
    const css = readFileSync(join(SRC, "styles", "main.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(/@layer utilities \{\s*@layer held \{\s*\.modal-box \{\s*max-height: calc\(100dvh - 5em\);\s*\}\s*\}\s*\}/);
    expect(css).not.toMatch(/\d(vh|lvh)\b/);
  });

  test("the check sees a tall class behind a variant, and leaves `dvh` alone", () => {
    expect(bare("md:!min-h-screen")).toBe("min-h-screen");
    expect(bare("h-[calc(100dvh-17rem)]")).toBe("h-[calc(100dvh-17rem)]");
    expect(/\d(vh|lvh)\b/.test("h-[calc(100dvh-17rem)]")).toBe(false);
    expect(/\d(vh|lvh)\b/.test("max-h-[85dvh]")).toBe(false);
    expect(/\d(vh|lvh)\b/.test("lg:h-[calc(100vh-4rem)]")).toBe(true);
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
