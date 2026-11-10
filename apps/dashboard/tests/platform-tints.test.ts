/**
 * Each app's colour on its tag (`platformTint`, `PlatformTag`): WhatsApp, Telegram and Discord were one lilac pill, so a
 * list of groups from three apps read as one app. Each app has its own colour now, drawn toward the text colour so one
 * value serves both themes, and its words read at WCAG AA on its own tint in both: computed here as the browser mixes
 * it, in OKLab, from the theme colours `main.css` declares.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PlatformTag } from "@/commons/components/chat/PlatformBadge";
import { platformTint } from "@/commons/lib/platform";

const ROOT = join(dirname(import.meta.path), "..");
const css = readFileSync(join(ROOT, "src", "styles", "main.css"), "utf8");
const badge = readFileSync(join(ROOT, "src", "commons", "components", "chat", "PlatformBadge.tsx"), "utf8");

type RGB = [number, number, number];

const themes = [...css.matchAll(/@plugin\s+"daisyui\/theme"\s*\{([\s\S]*?)\n\}/g)].map((m) => {
  const block = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
  return {
    name: /\bname:\s*"([^"]+)"/.exec(block)?.[1] ?? "",
    colours: Object.fromEntries([...block.matchAll(/^\s*--color-([\w-]+):\s*([^;]+);/gm)].map((v) => [v[1]!, v[2]!.trim()])) as Record<string, string>,
  };
});

const rgb = (hex: string): RGB => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as RGB;
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
/** sRGB to OKLab and back (Björn Ottosson's matrices, as CSS Color 4 gives them). */
function oklab([r, g, b]: RGB): RGB {
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function srgb([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const out = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return out.map((c) => Math.min(1, Math.max(0, gamma(c)))) as RGB;
}
/** `color-mix(in oklab, a share, b)`. */
const mix = (a: RGB, share: number, b: RGB): RGB => {
  const [A, B] = [oklab(a), oklab(b)];
  return srgb(A.map((v, i) => v * share + B[i]! * (1 - share)) as RGB);
};
/** `top` at `alpha` over `under`, as a translucent fill is drawn. */
const over = (top: RGB, alpha: number, under: RGB): RGB => top.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as RGB;
const luminance = ([r, g, b]: RGB) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: RGB, b: RGB) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/** A tint's hue and how much of it, read from what `platformTint` returns. */
const parts = (tint: string) => {
  const found = /color-mix\(in oklab, (#[0-9a-f]{6}) (\d+)%, var\(--color-base-content\)\)/.exec(tint);
  expect(found).not.toBeNull();
  return { hue: found![1]!, share: Number(found![2]) / 100 };
};
/** How much of the colour the tag's ground takes, as `PlatformBadge.tsx` writes it. */
const fill = Number(/color-mix\(in_oklab,var\(--tag\)_(\d+)%,transparent\)/.exec(badge)?.[1]) / 100;

const APPS = ["whatsapp", "telegram", "discord"];

describe("each app's colour", () => {
  test("WhatsApp, Telegram and Discord each have one, all three different, each drawn toward the text colour", () => {
    const tints = APPS.map((app) => platformTint(app));
    for (const tint of tints) expect(tint).toContain("var(--color-base-content)");
    expect(new Set(tints.map((tint) => parts(tint!).hue)).size).toBe(3);
    // A connection's id names its app: a History row passes `telegram:nestor`.
    expect(platformTint("telegram:nestor")).toBe(platformTint("telegram")!);
  });

  test("an app with no colour of its own has none", () => {
    expect(platformTint("web:dashboard")).toBeUndefined();
    expect(platformTint("slack")).toBeUndefined();
  });

  for (const app of APPS) {
    test(`${app}: its words read at AA on its own tint, in both themes, on every ground a tag sits on`, () => {
      // The fail-open shape: no themes found, or no fill read, would pass every check below on nothing.
      expect(themes.map((theme) => theme.name).sort()).toEqual(["nouride", "nouride-light"]);
      expect(fill).toBeGreaterThan(0);
      const { hue, share } = parts(platformTint(app)!);
      const low: string[] = [];
      for (const { name, colours } of themes) {
        const colour = (key: string) => rgb(colours[key]!);
        const words = mix(rgb(hue), share, colour("base-content"));
        const grounds: [string, RGB][] = [
          ["base-100", colour("base-100")],
          ["base-200", colour("base-200")],
          // The page between them (`bg-app`), where Chats' list sits.
          ["the page", mix(colour("base-200"), 0.5, colour("base-100"))],
          // A row that is open (`bg-secondary/10`).
          ["an open row", over(colour("secondary"), 0.1, colour("base-100"))],
        ];
        for (const [ground, under] of grounds) {
          const ratio = contrast(words, over(words, fill, under));
          if (ratio < 4.5) low.push(`${name} on ${ground}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(low).toEqual([]);
    });
  }
});

describe("the one tag that names an app", () => {
  const html = (props: Parameters<typeof PlatformTag>[0]) => renderToString(createElement(PlatformTag, props));
  const classes = (markup: string) => (/class="([^"]*)"/.exec(markup)?.[1] ?? "").split(" ");

  test("wears its app's colour, after a row's name and beside a header's", () => {
    for (const size of ["row", "header"] as const) {
      const tag = html({ platform: "whatsapp:nexa", size });
      expect(tag).toContain(`--tag:${platformTint("whatsapp")}`);
      expect(tag).toContain(">WhatsApp<");
      expect(classes(tag)).toEqual(expect.arrayContaining(["text-[color:var(--tag)]", "[background:color-mix(in_oklab,var(--tag)_14%,transparent)]"]));
    }
    // A header's words: the app's colour on "Discord channel".
    expect(html({ platform: "discord", children: "Discord channel" })).toContain(">Discord channel<");
    // A row's is as small as Orchestrator's pill, whatever the colour: the size is not merged away by it.
    expect(classes(html({ platform: "telegram", size: "row" }))).toEqual(expect.arrayContaining(["text-[10px]", "leading-none", "font-bold", "shrink-0", "whitespace-nowrap"]));
  });

  test("an app with no colour, and words that are no app, are the neutral tag", () => {
    const web = html({ platform: "web:dashboard", size: "row" });
    expect(web).not.toContain("--tag");
    expect(web).toContain(">Web<");
    expect(classes(web)).toEqual(expect.arrayContaining(["bg-base-content/[0.07]", "text-base-content/75"]));
    // Read-only keeps the outline it had.
    const readOnly = html({ children: "Read-only" });
    expect(readOnly).not.toContain("--tag");
    expect(classes(readOnly)).toEqual(expect.arrayContaining(["border", "border-base-content/15", "text-base-content/80", "text-[11px]", "leading-none"]));
  });
});
