/**
 * Less motion, for whoever asked their system for it (dash-practice-dead-animation-classes).
 *
 * `prefers-reduced-motion` appeared nowhere in the dashboard: the status dots and the streaming caret pulsed
 * forever and every press shrank what it touched, for everyone — while the design rules require motion to respect
 * it. `main.css` now has one rule for it. This loads that rule into a DOM that can be told the system's preference,
 * beside the utilities as Tailwind writes them, and reads what the browser would apply. Then it checks that every
 * class in `src` that moves on a press or a hover is one the rule reaches, and that the rule takes nothing that
 * places an element.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Window } from "happy-dom";

const SRC = join(dirname(import.meta.path), "..", "src");
const css = readFileSync(join(SRC, "styles", "main.css"), "utf8");

/** The `@media (prefers-reduced-motion: reduce)` block, braces balanced — main.css's rule, as written. */
function reducedMotionBlock(): string {
  const start = css.search(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/);
  if (start < 0) return "";
  let depth = 0;
  for (let at = css.indexOf("{", start); at < css.length; at += 1) {
    if (css[at] === "{") depth += 1;
    if (css[at] === "}" && --depth === 0) return css.slice(start, at + 1);
  }
  return "";
}
const rule = reducedMotionBlock();

/**
 * The utilities the pages use, as Tailwind 4 emits them: the individual `scale`/`translate`/`rotate` properties,
 * and the animations in longhand so a DOM can read them back. A press is a state a DOM cannot hold, so the
 * pressed-state utilities are written here as if held down.
 */
const UTILITIES = `
  .animate-pulse { animation-name: pulse; animation-duration: 2s; animation-iteration-count: infinite; }
  .animate-spin { animation-name: spin; animation-duration: 1s; animation-iteration-count: infinite; }
  .transition-all { transition-property: all; transition-duration: 150ms; }
  .active\\:scale-95 { scale: 95% 95%; }
  .group-hover\\:translate-x-1 { translate: 0.25rem; }
  .group-hover\\:rotate-12 { rotate: 12deg; }
  .-translate-y-1\\/2 { translate: 0 -50%; }
  .rotate-180 { rotate: 180deg; }
`;

/** What a browser applies to an element with these classes, with the system asking for `motion`. */
function computed(motion: "reduce" | "no-preference", className: string, property: string): string {
  const window = new Window({ settings: { device: { prefersReducedMotion: motion } } } as ConstructorParameters<typeof Window>[0]);
  try {
    window.document.head.innerHTML = `<style>${UTILITIES}\n${rule}</style>`;
    const element = window.document.createElement("span");
    element.className = className;
    window.document.body.appendChild(element);
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } finally {
    void window.happyDOM.close();
  }
}

describe("a system that asks for less motion", () => {
  test("main.css answers it", () => {
    expect(rule).not.toBe("");
  });

  test("gets no pulse: a status dot or the streaming caret goes once and rests", () => {
    expect(computed("no-preference", "animate-pulse", "animation-iteration-count")).toBe("infinite");
    expect(computed("reduce", "animate-pulse", "animation-iteration-count")).toBe("1");
    expect(computed("reduce", "animate-pulse", "animation-duration")).toBe("0.01ms");
  });

  test("gets no transition — cut to nothing rather than removed, so whatever waits for it to end still hears it", () => {
    expect(computed("no-preference", "transition-all", "transition-duration")).toBe("150ms");
    expect(computed("reduce", "transition-all", "transition-duration")).toBe("0.01ms");
  });

  test("gets no press that shrinks and no hover that nudges or tilts", () => {
    expect(computed("no-preference", "active:scale-95", "scale")).toBe("95% 95%");
    expect(computed("reduce", "active:scale-95", "scale")).toBe("none");
    expect(computed("reduce", "group-hover:translate-x-1", "translate")).toBe("none");
    expect(computed("reduce", "group-hover:rotate-12", "rotate")).toBe("none");
  });

  test("keeps what places an element and what says its state", () => {
    expect(computed("reduce", "-translate-y-1/2", "translate")).toBe("0 -50%");
    expect(computed("reduce", "rotate-180", "rotate")).toBe("180deg");
  });

  test("keeps the spinners turning: in place, and the one sign a wait is still a wait", () => {
    expect(computed("reduce", "animate-spin", "animation-iteration-count")).toBe("infinite");
    expect(computed("reduce", "animate-spin", "animation-duration")).toBe("1s");
  });
});

/**
 * The motion `main.css` adds: each `--animate-*` in its `@theme`, as `name duration easing [fill]`, written as the
 * utility Tailwind emits for it — in longhand, as above, so a DOM reads it back.
 */
const MOTIONS = [...css.matchAll(/^\s*--animate-([\w-]+):\s*([^;]+);/gm)].map((m) => {
  const [name, duration, easing, fill] = m[2]!.trim().split(/\s+/);
  return { utility: `animate-${m[1]}`, name: name!, duration: duration!, easing: easing!, fill: fill ?? "none" };
});
const MOTION_UTILITIES = MOTIONS.map(
  (motion) =>
    `.${motion.utility} { animation-name: ${motion.name}; animation-duration: ${motion.duration}; animation-timing-function: ${motion.easing}; animation-fill-mode: ${motion.fill}; }`,
).join("\n");

/** As `computed`, with main.css's own motion as the utilities. */
function computedMotion(motion: "reduce" | "no-preference", className: string, property: string): string {
  const window = new Window({ settings: { device: { prefersReducedMotion: motion } } } as ConstructorParameters<typeof Window>[0]);
  try {
    window.document.head.innerHTML = `<style>${MOTION_UTILITIES}\n${rule}</style>`;
    const element = window.document.createElement("span");
    element.className = className;
    window.document.body.appendChild(element);
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } finally {
    void window.happyDOM.close();
  }
}

describe("the motion main.css adds", () => {
  test("is read from it, each in the shape this test writes out — opacity and transform in 150 to 250 ms, easing out", () => {
    expect(MOTIONS.map(({ utility }) => utility)).toContain("animate-fade");
    for (const motion of MOTIONS) {
      expect(motion.easing).toBe("ease-out");
      expect(motion.duration).toMatch(/^\d+ms$/);
      expect(Number.parseInt(motion.duration, 10)).toBeGreaterThanOrEqual(150);
      expect(Number.parseInt(motion.duration, 10)).toBeLessThanOrEqual(250);
    }
  });

  test("plays for whoever did not ask for less motion", () => {
    for (const motion of MOTIONS) expect(computedMotion("no-preference", motion.utility, "animation-duration")).toBe(motion.duration);
  });

  test("is cut to nothing for whoever did, each one: it ends where it would have, at once", () => {
    for (const motion of MOTIONS) {
      expect(computedMotion("reduce", motion.utility, "animation-duration")).toBe("0.01ms");
      expect(computedMotion("reduce", motion.utility, "animation-iteration-count")).toBe("1");
    }
  });

  test("is the only motion a page names, beside the spinner and the pulse checked above", () => {
    const names = new Set(["animate-spin", "animate-pulse", ...MOTIONS.map(({ utility }) => utility)]);
    const used = literals().flatMap(({ file, words }) =>
      words.map((word) => word.slice(word.lastIndexOf(":") + 1)).filter((word) => word.startsWith("animate-")).map((word) => ({ file, word })),
    );
    expect(used.map(({ word }) => word)).toContain("animate-fade");
    expect(used.filter(({ word }) => !names.has(word)).map(({ file, word }) => `${file}: ${word}`)).toEqual([]);
  });
});

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

/** `scale`, `translate` or `rotate` when the word is one of those utilities, behind variants or not. */
const transformOf = (word: string) => /^-?(scale|translate|rotate)-/.exec(word.slice(word.lastIndexOf(":") + 1))?.[1];
/** A press, a hover or a focus: what puts a transform on an element while somebody touches it. */
const INTERACTION = /(^|:|-)(hover|active|focus|focus-visible|focus-within):/;

describe("every class that moves on a press or a hover", () => {
  const all = literals();
  /** The substrings the rule's attribute selectors match on — read from the rule, so a narrowed rule shows here. */
  const reached = [...rule.matchAll(/\[class\*="([^"]+)"\]/g)].map((m) => m[1]!);

  test("the scan reads the class names, so finding nothing means something", () => {
    expect(all.flatMap(({ words }) => words)).toContain("active:scale-95");
    expect(reached.length).toBeGreaterThan(0);
  });

  test("is one the rule reaches", () => {
    const moving = all.flatMap(({ file, words }) => words.filter((word) => transformOf(word) && INTERACTION.test(word)).map((word) => ({ file, word })));
    expect(moving.length).toBeGreaterThan(50);
    expect(moving.filter(({ word }) => !reached.some((part) => word.includes(part))).map(({ file, word }) => `${file}: ${word}`)).toEqual([]);
  });

  test("sits on nothing that is also placed by the same property, which the rule would undo", () => {
    // `-translate-y-1/2 group-hover:translate-x-1` on one element would lose its centring under the rule.
    const clashes = all.flatMap(({ file, words }) => {
      const touched = new Set(words.filter((word) => transformOf(word) && reached.some((part) => word.includes(part))).map(transformOf));
      return words.filter((word) => !word.includes(":") && touched.has(transformOf(word))).map((word) => `${file}: ${word}`);
    });
    expect(clashes).toEqual([]);
  });
});
