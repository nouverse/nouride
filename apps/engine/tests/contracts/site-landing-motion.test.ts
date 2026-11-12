/**
 * The landing page moves: the cat rides into the hero, turns the dashboard's pages in the tour, rides along the
 * window's foot and wags its tail at the footer. What holds that together is spread over three components, two
 * dictionaries and two cut strips of frames, and nothing in a build says when they stop agreeing:
 *
 * - an animation written outside the reduced-motion block still plays for a reader who asked for none;
 * - a tab added to the tour with no words in one language renders `undefined`, and one with no `:checked` rule never
 *   shows its page;
 * - a strip recut with another number of frames slides half a cat past.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SITE = join(ROOT, "apps/site");
// The docs' corner cat is not the landing page's, and moves by the same rule: it is held to it here with the rest.
const COMPONENTS = [
  "src/components/Landing.astro",
  "src/components/landing/Tour.astro",
  "src/components/landing/Rider.astro",
  "src/components/landing/HeroRiding.astro",
  "src/components/DocsCat.astro",
] as const;
const read = (file: string) => readFileSync(join(SITE, file), "utf8");

/** A component's stylesheet. */
const styleOf = (text: string) => /<style>([\s\S]*)<\/style>/.exec(text)?.[1] ?? "";

/** Where each `@media (prefers-reduced-motion: no-preference)` block starts and ends in a stylesheet. */
function motionBlocks(css: string): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  for (const at of css.matchAll(/@media \(prefers-reduced-motion: no-preference\)\s*\{/g)) {
    let depth = 1;
    let i = at.index + at[0].length;
    for (; depth > 0 && i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") depth--;
    }
    blocks.push([at.index, i]);
  }
  return blocks;
}

/** The animations a stylesheet starts outside those blocks, as `animation: …` reads there. Turning one off is not one. */
function unguarded(css: string): string[] {
  const blocks = motionBlocks(css);
  return [...css.matchAll(/(?<![-\w])animation(?:-name)?\s*:\s*([^;]+);/g)]
    .filter((rule) => rule[1]!.trim() !== "none")
    .filter((rule) => !blocks.some(([from, to]) => rule.index > from && rule.index < to))
    .map((rule) => rule[0]);
}

/** A WebP's width and height, from its extended header: the strips carry alpha, so they have one. */
function webpSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  expect(bytes.toString("latin1", 12, 16)).toBe("VP8X");
  return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
}

describe("the landing page's motion", () => {
  test("every animation is inside the reduced-motion block", () => {
    for (const file of COMPONENTS) {
      const css = styleOf(read(file));
      expect(motionBlocks(css).length).toBeGreaterThan(0);
      expect({ file, unguarded: unguarded(css) }).toEqual({ file, unguarded: [] });
    }
  });

  test("an animation outside the block is found, one inside or turned off is not", () => {
    const inside = "@media (prefers-reduced-motion: no-preference) { .a { animation: wag 2s infinite; } }";
    expect(unguarded(inside)).toEqual([]);
    expect(unguarded(`${inside} .b { animation: wag 2s infinite; }`)).toEqual(["animation: wag 2s infinite;"]);
    expect(unguarded(".c { animation: none; } .d { animation-play-state: paused; animation-delay: 1s; }")).toEqual([]);
  });

  test("what a script moves, it leaves still for a reader who asked for that", () => {
    // The rider and the hero's cat are moved by script, which no stylesheet's media query stops.
    expect(read("src/components/landing/Rider.astro")).toContain("!matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(read("src/components/Landing.astro")).toContain("if (ride && !matchMedia('(prefers-reduced-motion: reduce)').matches)");
    expect(read("src/components/DocsCat.astro")).toContain("if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {");
    expect(read("src/components/landing/Tour.astro")).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches ||");
    expect(read("src/components/Landing.astro")).toContain("if (drift && chapter && !matchMedia('(prefers-reduced-motion: reduce)').matches)");
  });

  test("nothing is tied to the scroll by `animation-timeline`, which the build breaks", () => {
    // The minifier writes it into the `animation` shorthand (`animation: linear both ride view()`), which browsers
    // refuse whole: the chats chapter's cat was meant to ride with the scroll that way and stood still.
    for (const file of COMPONENTS) expect(styleOf(read(file))).not.toContain("animation-timeline");
  });
});

describe("the landing page's tour", () => {
  const tour = read("src/components/landing/Tour.astro");
  const ids = [...tour.matchAll(/\{ id: '(\w+)', shot: \w+, pose: \w+ \}/g)].map((tab) => tab[1]!);

  test("each tab has its words in both languages, under the dashboard's own name for the page", async () => {
    const { en, id } = (await import(join(SITE, "src/i18n/landing.mjs"))) as Record<"en" | "id", { tour: { tabs: Record<string, Record<string, string>> } }>;
    expect(ids.length).toBeGreaterThan(3);
    for (const copy of [en, id]) {
      expect(Object.keys(copy.tour.tabs)).toEqual(ids);
      for (const tab of Object.values(copy.tour.tabs)) {
        for (const key of ["label", "text", "alt"]) expect(tab[key]?.length ?? 0).toBeGreaterThan(3);
      }
    }
    for (const tab of ids) expect(id.tour.tabs[tab]!.label).toBe(en.tour.tabs[tab]!.label);
  });

  test("each tab has its rules: the tab lit, its focus ring, its page shown, its words shown", () => {
    const css = styleOf(tour);
    for (const tab of ids) {
      expect(css).toContain(`#tour-${tab}:checked ~ .tour-tabs .tour-tab-${tab}`);
      expect(css).toContain(`#tour-${tab}:focus-visible ~ .tour-tabs .tour-tab-${tab}`);
      expect(css).toContain(`#tour-${tab}:checked ~ .tour-view .tour-shot-${tab}`);
      expect(css).toContain(`#tour-${tab}:checked ~ .tour-view .tour-say-${tab}`);
    }
  });

  test("each page it shows is a screenshot on disk", () => {
    const shots = [...tour.matchAll(/from '(\.\.\/\.\.\/\.\.\/public\/media\/[\w-]+\.png)'/g)].map((shot) => shot[1]!);
    expect(shots).toHaveLength(ids.length);
    for (const shot of shots) expect(existsSync(join(SITE, "src/components/landing", shot))).toBe(true);
  });
});

describe("the mascot's strips of frames", () => {
  const MOTION = join(ROOT, "packages/shared/assets/mascot/motion");
  const frames = (file: string, name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(read(file))?.[1]);

  test("a strip is as many whole cells as the page steps through", () => {
    const idle = webpSize(join(MOTION, "idle.webp"));
    const ride = webpSize(join(MOTION, "ride.webp"));
    expect(frames("src/components/Landing.astro", "IDLE_FRAMES")).toBe(4);
    expect(frames("src/components/landing/Rider.astro", "FRAMES")).toBe(6);
    expect(idle.width % 4).toBe(0);
    expect(ride.width % 6).toBe(0);
    // A cell is taller than wide for the cat standing, and close to square on its scooter: a strip cut the other way
    // (frames stacked) or with another count would not be.
    expect(idle.width / 4).toBeLessThan(idle.height);
    expect(ride.width / 6 / ride.height).toBeGreaterThan(0.8);
    expect(ride.width / 6 / ride.height).toBeLessThan(1.1);
  });

  test("the script that cuts them is told the same counts, and reads sheets that are there", () => {
    const script = read("scripts/cut-mascot-motion.ts");
    expect(script).toContain("idleBoxes.length !== 4");
    expect(script).toContain("rideBoxes.length !== 6");
    for (const sheet of script.matchAll(/cut\("([\w-]+\.jpeg)"\)/g)) {
      expect(existsSync(join(ROOT, "docs/design/mascot/grids", sheet[1]!))).toBe(true);
    }
  });
});
