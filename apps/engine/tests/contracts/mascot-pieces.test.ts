/**
 * The mascot's cut pieces and the pages that move them stay in step.
 *
 * Three poses are cut into parts (`apps/site/scripts/cut-mascot-pieces.ts`) and the site puts them back together
 * (`mascot/rigs.mjs`) for the hero's riding cat and the cat in the docs' corner. No build says when one of these
 * stops holding:
 *
 * - a piece on disk that is no longer what the cut writes (a line moved, a pose drawn again) is a seam or a hole;
 * - a rig that leaves out a piece the cut writes draws a cat with a part missing, and a joint whose pivot is off the
 *   canvas swings its part round nothing;
 * - the hero's waving cat and its riding cat change places on one clock: on two, both show or neither does;
 * - the corner cat drawn where there is no empty corner lies over the page, and one that hops for a reader who asked
 *   for stillness did not hear them.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SITE = join(ROOT, "apps/site");
const SCRIPT = join(SITE, "scripts/cut-mascot-pieces.ts");
const PIECES = join(ROOT, "packages/shared/assets/mascot/pieces");
const read = (file: string) => readFileSync(join(SITE, file), "utf8");

type Cut = { set: string; pose: string; crop?: readonly number[]; parts: ReadonlyArray<{ name: string; save?: false }> };
const { CUTS } = (await import(join(SITE, "scripts/mascot-piece-cuts.ts"))) as { CUTS: readonly Cut[] };
/** The pieces the cut writes for a set: its parts, less those it only takes pixels for. */
const written = (set: string) => (CUTS.find((cut) => cut.set === set)?.parts ?? []).filter((part) => part.save !== false).map((part) => part.name).sort();

/** A set's part of the rig table, as written: from its name to the next set's or the table's end. */
function rigOf(rigs: string, set: string): string {
  const from = rigs.indexOf(`\n  ${set}: {`);
  const next = rigs.slice(from + 1).search(/\n {2}\w+: \{|\n\};/);
  return from < 0 ? "" : rigs.slice(from, from + 1 + next);
}
/** A piece's name as the rig writes it, `wavingEarLeft`, as the cut does: `ear-left`. */
const kebab = (set: string, name: string) => name.slice(set.length).replace(/[A-Z]/g, (letter, at: number) => `${at ? "-" : ""}${letter.toLowerCase()}`);
/** The pieces a set's rig draws, each once. */
const drawn = (set: string, rig: string) => [...new Set([...rig.matchAll(/piece\((\w+)\)/g)].map((match) => kebab(set, match[1]!)))].sort();
/** The canvas a set's rig draws its pieces on. */
const canvasOf = (rig: string) => /canvas: \[(\d+), (\d+)\]/.exec(rig)?.slice(1).map(Number);
/** The rules of a stylesheet that mention `word`, by their selectors. A comment over a rule is not its selector. */
const selectorsOf = (css: string, word: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)].filter((rule) => rule[0].includes(word)).map((rule) => rule[1]!.trim());

describe("the mascot's pieces", () => {
  test(
    "the pieces on disk are what the cut writes, and laid over each other they are the pose",
    () => {
      const run = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      for (const cut of CUTS) {
        const files = readdirSync(join(PIECES, cut.set)).filter((file) => !file.startsWith(".")).sort();
        expect({ set: cut.set, files }).toEqual({ set: cut.set, files: written(cut.set).map((name) => `${name}.webp`) });
      }
    },
    60_000,
  );

  test("a rig draws every piece the cut writes and no other, on the pose's canvas, each joint about a point on it", () => {
    const rigs = read("src/components/mascot/rigs.mjs");
    expect(CUTS.map((cut) => cut.set).sort()).toEqual(["idle", "riding", "waving"]);
    for (const cut of CUTS) {
      const rig = rigOf(rigs, cut.set);
      expect(written(cut.set).length).toBeGreaterThan(5);
      expect({ set: cut.set, drawn: drawn(cut.set, rig) }).toEqual({ set: cut.set, drawn: written(cut.set) });
      // Each piece is named by its file, which is what makes it a brand asset somebody uses.
      for (const name of written(cut.set)) expect(rigs).toContain(`from '@brand/mascot/pieces/${cut.set}/${name}.webp';`);
      const [width, height] = canvasOf(rig) ?? [];
      expect({ set: cut.set, canvas: [width, height] }).toEqual({ set: cut.set, canvas: cut.crop ? [cut.crop[2], cut.crop[3]] : [512, 512] });
      const pivots = [...rig.matchAll(/joint\('[\w-]+', \[(-?[\d.]+), (-?[\d.]+)\]/g)].map((match) => [Number(match[1]), Number(match[2])] as const);
      expect(pivots.length).toBeGreaterThan(4);
      expect({ set: cut.set, off: pivots.filter(([x, y]) => !(x >= 0 && x <= width! && y >= 0 && y <= height!)) }).toEqual({ set: cut.set, off: [] });
    }
  });

  test("a piece the rig leaves out is found, and one it draws twice is one piece", () => {
    const rig = "\n  waving: {\n    canvas: [512, 512],\n    parts: [\n      joint('tail', [1, 2], [piece(wavingTail)]),\n      joint('sleeve', [3, 4], [piece(wavingEarLeft)]),\n      joint('sleeve', [3, 4], [piece(wavingEarLeft)]),\n    ],\n  },\n  riding: {\n    canvas: [369, 480],\n    parts: [piece(ridingRide)],\n  },\n};";
    expect(drawn("waving", rigOf(rig, "waving"))).toEqual(["ear-left", "tail"]);
    expect(drawn("riding", rigOf(rig, "riding"))).toEqual(["ride"]);
    expect(canvasOf(rigOf(rig, "riding"))).toEqual([369, 480]);
    expect(drawn("idle", rigOf(rig, "idle"))).toEqual([]);
  });
});

describe("the pages that move the pieces", () => {
  test("the hero draws the riding cat, and its waving cat is hidden only while that one is shown", () => {
    const landing = read("src/components/Landing.astro");
    expect(landing).toContain("<HeroRiding />");
    expect(read("src/components/landing/HeroRiding.astro")).toContain("<Fragment set:html={rigMarkup('riding')} />");
    const css = /<style>([\s\S]*)<\/style>/.exec(landing)?.[1] ?? "";
    // What hides the waving cat: the entrance that brings it in late, and the click that sends it off. Both are for
    // a page with its script running, where the riding cat's rules are too; without it the waving cat is all there is.
    const hides = selectorsOf(css, "hero-hello").filter((selector) => !selector.startsWith("@keyframes")).concat(selectorsOf(css, "opacity: 0;").filter((selector) => selector.includes(".hero-cat")));
    expect(hides).toHaveLength(2);
    expect(hides.filter((selector) => !selector.startsWith(":global(html.js) "))).toEqual([]);
  });

  test("the riding cat shows on the entrance's own clock, and holds still once it has stopped", () => {
    const riding = read("src/components/landing/HeroRiding.astro");
    const landing = read("src/components/Landing.astro");
    const clock = /\.hero-ride \{\s*animation: hero-in ([\d.]+s) [^;]*? ([\d.]+s) both;/.exec(landing);
    expect(clock).not.toBeNull();
    expect(riding).toContain(`:global(html.js) .hero-go {\n      animation: hero-go ${clock![1]} linear ${clock![2]} both;`);
    expect(landing).toContain(`animation: hero-hello ${clock![1]} linear ${clock![2]} both,`);
    expect(landing).toContain("if (event.animationName === 'hero-in') ride.classList.add('is-here');");
    expect(riding).toContain(":global(.hero-ride.is-here) .hero-go :global(g) {\n      animation-play-state: paused;");
  });

  test("the corner cat is drawn only where the corner is empty, and stands still for a reader who asked", () => {
    const cat = read("src/components/DocsCat.astro");
    const room = /const ROOM = '([^']+)';/.exec(cat)?.[1];
    expect(room).toBe("screen and (min-width: 72rem) and (min-height: 40rem)");
    const css = /<style>([\s\S]*)<\/style>/.exec(cat)?.[1] ?? "";
    expect(css).toContain(`.docs-cat {\n    display: none;\n  }\n  /* A screen: on paper it would be printed over every page's corner. */\n  @media ${room} {\n    .docs-cat {\n      display: block;`);
    // Its pieces wait in a template, so a narrow window fetches none; the script takes them out where there is room.
    expect(cat).toContain("<template><svg viewBox=");
    expect(cat).toContain("if (!room.matches || !waiting) return;");
    // The click and the pointer are listened for only without a reduced-motion preference.
    const script = /<script>([\s\S]*)<\/script>/.exec(cat)?.[1] ?? "";
    const guard = script.indexOf("if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {");
    expect(guard).toBeGreaterThan(0);
    expect(script.indexOf("addEventListener('click'")).toBeGreaterThan(guard);
    expect(script.indexOf("addEventListener('pointermove'")).toBeGreaterThan(guard);
    expect(read("src/components/DocsFooter.astro")).toContain("<DocsCat />");
  });

  test("the corner cat is the footer's cat, and a click makes it hop once", () => {
    const cat = read("src/components/DocsCat.astro");
    const [width, height] = CUTS.find((cut) => cut.set === "idle")!.crop!.slice(2);
    // Its view box is the idle frame's canvas with room above it for the hop, which goes no higher than that room.
    const box = /<svg viewBox="0 (-\d+) (\d+) (\d+)">/.exec(cat)?.slice(1).map(Number) ?? [];
    expect(box[1]).toBe(width!);
    expect(box[2]! + box[0]!).toBe(height!);
    expect(cat).toContain("<Fragment set:html={rigMarkup('idle')} />");
    const rise = Number(/@keyframes dc-hop \{[\s\S]*?translateY\(-(\d+)px\)/.exec(cat)?.[1]);
    expect(rise).toBeGreaterThan(60);
    expect(rise).toBeLessThanOrEqual(-box[0]!);
    expect(cat).toContain("cat.addEventListener('click', () => cat.classList.add('is-hop'));");
    expect(cat).toContain("if (event.animationName === 'dc-hop') cat.classList.remove('is-hop');");
    expect(cat).toContain(".docs-cat.is-hop :global(.j-cat) { animation: dc-hop ");
  });

  test("the corner cat looks at the page: mirrored, its letter turned back, its head still toward the pointer", () => {
    const css = /<style>([\s\S]*)<\/style>/.exec(read("src/components/DocsCat.astro"))?.[1] ?? "";
    // The frame looks to its right, the window's edge in that corner. Mirrored whole, the helmet's letter would read
    // the wrong way round and a head turned by an angle would look away from the pointer: each is turned back.
    expect(selectorsOf(css, "transform: scaleX(-1);")).toEqual([".docs-cat :global(svg)"]);
    expect(selectorsOf(css, "transform: skewX(17deg) scaleX(-1) skewX(-17deg);")).toEqual([".docs-cat :global(.j-mark)"]);
    expect(selectorsOf(css, "var(--look")).toEqual([".docs-cat :global(.j-head)"]);
    expect(css).toContain("rotate: calc(var(--look, 0deg) * -1);");
    expect(read("src/components/mascot/rigs.mjs")).toContain("joint('mark', [249, 86], [piece(idleMark)]),");
  });
});
