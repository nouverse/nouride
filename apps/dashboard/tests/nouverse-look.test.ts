/**
 * The dashboard's look, held to what the Nouverse design rules ask of it (dash-practice-design-language-divergence).
 *
 * 0.7.10 decided that the Nouverse rules govern how the dashboard looks, and 0.7.11 re-themed it: paper and ink,
 * one colour for signals and actions, Manrope and DM Mono — green until 0.7.16 made it the mascot's blue, with navy
 * ink. These hold the parts a diff does not
 * show: that every pair of colours that can carry text reads in both themes, that the faces come from the daemon
 * rather than a font CDN, and that no glow is a colour of its own again.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(import.meta.path), "..");
const SRC = join(ROOT, "src");
const STYLES = join(SRC, "styles");
const css = readFileSync(join(STYLES, "main.css"), "utf8");

type RGB = [number, number, number];

/** Each `@plugin "daisyui/theme"` block: its name, and its colours by daisyUI name (`base-100`, `primary-content`). */
const themes = [...css.matchAll(/@plugin\s+"daisyui\/theme"\s*\{([\s\S]*?)\n\}/g)].map((m) => {
  const block = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
  return {
    name: /\bname:\s*"([^"]+)"/.exec(block)?.[1] ?? "",
    colours: Object.fromEntries([...block.matchAll(/^\s*--color-([\w-]+):\s*([^;]+);/gm)].map((v) => [v[1]!, v[2]!.trim()])) as Record<string, string>,
  };
});

const rgb = (hex: string): RGB => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as RGB;
const linear = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: RGB) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
/** WCAG 2's contrast ratio. */
const contrast = (a: RGB, b: RGB) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};
/** `top` at `alpha` over `under` — a `bg-warning/10` on the card it sits on. */
const over = (top: RGB, alpha: number, under: RGB): RGB => top.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as RGB;

/** WCAG AA for body text. */
const AA = 4.5;
/** The colours a page writes text in as well as fills with: `text-warning` on `bg-warning/10`, say. */
const TEXT_COLOURS = ["primary", "secondary", "accent", "info", "success", "warning", "error"];
/** Every colour that has a `-content` to be written on it. */
const FILLS = [...TEXT_COLOURS, "neutral"];
/** The tints pages put a colour's own text on, up to the strongest any page uses (`bg-warning/20`). */
const TINTS = [0.05, 0.1, 0.15, 0.2];

describe("the palette", () => {
  test("is two themes, and each names every colour", () => {
    // The fail-open shape: no themes found would make every check below pass on nothing.
    expect(themes.map((theme) => theme.name).sort()).toEqual(["nouride", "nouride-light"]);
    for (const theme of themes) expect(Object.keys(theme.colours).sort()).toEqual(["base-100", "base-200", "base-300", "base-content", ...FILLS.flatMap((fill) => [fill, `${fill}-content`])].sort());
  });

  test("every colour is #rrggbb, which the memory graph reads off the page for its canvas and adds an alpha to", () => {
    for (const theme of themes) {
      const other = Object.entries(theme.colours).filter(([, value]) => !/^#[0-9a-f]{6}$/i.test(value));
      expect({ theme: theme.name, other }).toEqual({ theme: theme.name, other: [] });
    }
  });

  for (const { name, colours } of themes) {
    test(`${name}: every pair that can carry text reads at WCAG AA`, () => {
      const colour = (key: string) => rgb(colours[key]!);
      // RootLayout's `bg-base-200/50` over the root's base-100: the page behind every card.
      const page = over(colour("base-200"), 0.5, colour("base-100"));
      const surfaces: [string, RGB][] = [["base-100", colour("base-100")], ["base-200", colour("base-200")], ["the page", page]];
      const low: string[] = [];
      const need = (pair: string, ratio: number) => {
        if (ratio < AA) low.push(`${pair}: ${ratio.toFixed(2)}:1`);
      };

      for (const [surface, under] of [...surfaces, ["base-300", colour("base-300")] as [string, RGB]]) need(`base-content on ${surface}`, contrast(colour("base-content"), under));
      for (const fill of FILLS) need(`${fill}-content on ${fill}`, contrast(colour(`${fill}-content`), colour(fill)));
      for (const text of TEXT_COLOURS) {
        for (const [surface, under] of surfaces) {
          need(`text-${text} on ${surface}`, contrast(colour(text), under));
          for (const alpha of TINTS) need(`text-${text} on ${text}/${alpha * 100} over ${surface}`, contrast(colour(text), over(colour(text), alpha, under)));
        }
      }
      expect(low).toEqual([]);
    });
  }
});

/** Every `@font-face` in the stylesheet: its family, weight and the file it names. */
const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => ({
  family: /font-family:\s*"([^"]+)"/.exec(m[1]!)?.[1] ?? "",
  weight: /font-weight:\s*([^;]+);/.exec(m[1]!)?.[1]?.trim() ?? "",
  url: /src:\s*url\("([^"]+)"\)/.exec(m[1]!)?.[1] ?? "",
  ranged: /unicode-range:/.test(m[1]!),
}));

function sources(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path, pattern);
    return pattern.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

describe("the faces", () => {
  test("Manrope is the sans, DM Mono the mono and Fredoka the headings' face, each before its fallbacks", () => {
    const theme = /@theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(/--font-sans:\s*"Manrope",/.test(theme)).toBe(true);
    expect(/--font-mono:\s*"DM Mono",/.test(theme)).toBe(true);
    expect(/--font-display:\s*"Fredoka",/.test(theme)).toBe(true);
    // Every heading in it, at the one weight there is a file for: a `font-bold` on one is not emboldened by the browser.
    const headings = /h1,\s*h2,\s*h3\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(headings).toContain("font-family: var(--font-display)");
    expect(headings).toContain("font-weight: 500");
    expect(headings).toContain("font-synthesis-weight: none");
  });

  test("every face is a woff2 file beside the stylesheet, Latin split from Latin Extended", () => {
    expect(faces.map((face) => `${face.family} ${face.weight}`).sort()).toEqual([
      "DM Mono 400",
      "DM Mono 400",
      "DM Mono 500",
      "DM Mono 500",
      "Fredoka 500",
      "Fredoka 500",
      "Manrope 200 800",
      "Manrope 200 800",
    ]);
    for (const face of faces) {
      expect(face.url).toMatch(/^\.\/fonts\/[\w-]+\.woff2$/);
      const bytes = readFileSync(join(STYLES, face.url));
      // `wOF2`: a woff2 file and not, say, an HTML error page saved under the name.
      expect({ file: face.url, magic: bytes.subarray(0, 4).toString("latin1") }).toEqual({ file: face.url, magic: "wOF2" });
      // Fetched only for a page that draws a character in the file's range.
      expect({ file: face.url, ranged: face.ranged }).toEqual({ file: face.url, ranged: true });
    }
  });

  test("each family's licence ships beside it", () => {
    for (const licence of ["OFL-Manrope.txt", "OFL-DMMono.txt", "OFL-Fredoka.txt"]) {
      const path = join(STYLES, "fonts", licence);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
  });

  test("nothing asks another origin for a font: an offline box reaches none, and the CSP refuses it", () => {
    const files = [join(ROOT, "index.html"), ...sources(SRC, /\.(css|ts|tsx|html)$/)];
    const found = files.flatMap((path) => {
      const text = readFileSync(path, "utf8");
      return [/fonts\.googleapis\.com/, /fonts\.gstatic\.com/, /@import\s+url\(\s*["']?https?:/, /url\(\s*["']?https?:[^)]*\.(woff2?|ttf|otf)/].filter((pattern) => pattern.test(text)).map((pattern) => `${relative(ROOT, path)}: ${pattern}`);
    });
    expect(files.length).toBeGreaterThan(100);
    expect(found).toEqual([]);
  });
});

describe("glows and tints", () => {
  /** Every whitespace-separated word inside a string literal in `src`'s code — where class names live. */
  const words = sources(SRC, /\.(ts|tsx)$/).flatMap((path) => {
    const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    return [...code.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`]*)`/g)].flatMap((m) =>
      (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/).filter(Boolean).map((word) => ({ file: relative(SRC, path), word })),
    );
  });

  test("the scan reads class names, so finding none means something", () => {
    expect(words.some(({ word }) => word === "status-success")).toBe(true);
    expect(words.length).toBeGreaterThan(3000);
  });

  test("no class carries a colour of its own: a glow or a tint is a theme colour, so a theme can change it", () => {
    // `shadow-[0_0_8px_rgba(34,197,94,0.6)]` was the status dots' glow: Tailwind's green, whatever the theme said.
    const literal = /\[[^\]\s]*(?:#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|oklab\()[^\]\s]*\]/i;
    expect(words.filter(({ word }) => literal.test(word)).map(({ file, word }) => `${file}: ${word}`)).toEqual([]);
  });
});

describe("DM Mono for what is technical (dashboard-text-contrast-and-mono)", () => {
  /** Every one-line string literal in `src` that is a list of classes, with where it is. */
  const lists = sources(SRC, /\.(ts|tsx)$/).flatMap((path) => {
    const code = readFileSync(path, "utf8");
    return [...code.matchAll(/"([^"\n]*)"|`([^`\n$]*)`/g)].map((m) => ({ file: relative(SRC, path), words: (m[1] ?? m[2] ?? "").split(/\s+/).filter(Boolean) }));
  });

  test("labels and badges are in it: an uppercase label, a badge, a status", () => {
    const wanting = lists.filter(({ words }) => words.includes("uppercase") || words.includes("badge"));
    // The fail-open shape: no labels found would pass on nothing.
    expect(wanting.length).toBeGreaterThan(100);
    expect(wanting.filter(({ words }) => !words.includes("font-mono")).map(({ file, words }) => `${file}: ${words.join(" ")}`)).toEqual([]);
  });

  test("so are the page tabs and a connection's status; the menu is in the interface's face (0.8.24)", () => {
    const read = (file: string) => readFileSync(join(SRC, file), "utf8");
    // The soft look's menu reads as words, not identifiers, as its mockup has it: every item, the manual's link too, is
    // the one `ITEM` list, and the current one adds only its colour and weight (its mark is the highlight).
    const nav = read("commons/components/layout/nav.tsx");
    const item = /const ITEM = "([^"]+)"/.exec(nav)?.[1] ?? "";
    expect(item).toContain("rounded-[14px]");
    expect(item).not.toContain("font-mono");
    expect(nav.match(/cn\(ITEM/g)?.length).toBe(2);
    expect(read("commons/components/ui/SegmentedTabs.tsx")).toMatch(/segmentClass[\s\S]*font-mono/);
    expect(read("commons/components/ui/ui.tsx")).toMatch(/export function StatusDot[\s\S]*rounded-full font-mono/);
  });
});

/**
 * Where the JSX opening tag around `at` starts and ends, and its name — or null where `at` is not inside one (a
 * constant, a child's text). Brace depth is followed so an arrow's `=>` or a `{cond ? "a" : "b"}` does not end it.
 */
function enclosingTag(text: string, at: number): { start: number; end: number; name: string } | null {
  let depth = 0;
  let i = at;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth += 1;
    else if (c === "{") depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === ";") return null;
    else if (depth === 0 && c === ">" && text[i - 1] !== "=") return null;
    else if (depth === 0 && c === "<" && /[A-Za-z]/.test(text[i + 1] ?? "")) break;
  }
  if (i < 0) return null;
  const name = /^<([A-Za-z][\w.]*)/.exec(text.slice(i))![1]!;
  let quote: string | null = null;
  depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (quote) {
      if (c === quote && text[j - 1] !== "\\") quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (depth === 0 && c === ">" && text[j - 1] !== "=") return { start: i, end: j, name };
  }
  return null;
}

/** What draws an icon in a file: every name it imports from lucide-react or our icons, and the usual icon props. */
function iconNames(text: string): Set<string> {
  const names = new Set(["NovaAppIcon", "NougateGlyph", "Icon"]);
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](lucide-react|@\/commons\/components\/icons\/[\w/-]+)["']/g)) {
    for (const part of m[1]!.split(",")) names.add(part.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, ""));
  }
  return names;
}

describe("muted text (dashboard-text-contrast-and-mono)", () => {
  /**
   * The faintest ink that still reads at AA, in steps of five, in both themes and on every surface text sits on —
   * the cards, the page, the wells (`base-200`) and the deepest fill (`base-300`). 65 with this palette: `/60` is
   * 4.48:1 on paper's base-200, `/50` 3.30:1.
   */
  const floor = (() => {
    for (let alpha = 5; alpha <= 100; alpha += 5) {
      const passes = themes.every(({ colours }) => {
        const colour = (key: string) => rgb(colours[key]!);
        const ink = colour("base-content");
        const surfaces = [colour("base-100"), colour("base-200"), colour("base-300"), over(colour("base-200"), 0.5, colour("base-100"))];
        return surfaces.every((under) => contrast(over(ink, alpha / 100, under), under) >= AA);
      });
      if (passes) return alpha;
    }
    return 100;
  })();

  test("the floor is computed from the palette, and is a tint of the ink rather than all of it", () => {
    expect(floor).toBeGreaterThan(30);
    expect(floor).toBeLessThan(100);
  });

  test("no words are fainter than the floor: icons, spinners, switched-off controls and aria-hidden decoration aside", () => {
    const token = /(?<![\w:/-])(placeholder:)?(text-base-content\/|opacity-)(\d+)\b/g;
    const faint: string[] = [];
    let checked = 0;
    for (const path of sources(SRC, /\.(ts|tsx)$/)) {
      const text = readFileSync(path, "utf8");
      const icons = iconNames(text);
      for (const m of text.matchAll(token)) {
        const value = Number(m[3]);
        if (value === 0 || value >= floor) continue;
        checked += 1;
        const tag = enclosingTag(text, m.index!);
        const tagText = tag ? text.slice(tag.start, tag.end + 1) : "";
        // Not words: an icon, something marked decorative, a spinner, or a control that is switched off.
        if (tag && (icons.has(tag.name) || /aria-hidden/.test(tagText))) continue;
        if (m[2] === "opacity-" && /\bloading\b|cursor-not-allowed|\bdisabled\b/.test(tagText)) continue;
        faint.push(`${relative(SRC, path)}:${text.slice(0, m.index!).split("\n").length} ${m[0]}${tag ? ` on <${tag.name}>` : ""}`);
      }
    }
    // The fail-open shape: a scan that met nothing below the floor would pass on nothing.
    expect(checked).toBeGreaterThan(20);
    expect(faint).toEqual([]);
  });
});
