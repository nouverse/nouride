/**
 * The build keeps only the woff2 of a stylesheet's fonts (`apps/dashboard/scripts/woff2-only.ts`), read on KaTeX's own stylesheet:
 * every face still has its woff2, none has a woff or a ttf, and a stylesheet that no longer has that shape stops the
 * build rather than being copied whole.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { woff2Only } from "../scripts/woff2-only.ts";

const SHEET = "katex/dist/katex.min.css";
const path = createRequire(import.meta.url).resolve(SHEET);
const transform = (code: string, id: string) => (woff2Only([SHEET]).transform as (code: string, id: string) => { code: string } | null)(code, id);

describe("a stylesheet's fonts, woff2 only", () => {
  test("KaTeX's twenty faces keep their woff2 and lose their woff and ttf", () => {
    const original = readFileSync(path, "utf8");
    const kept = transform(original, path)!.code;
    const faces = kept.match(/@font-face\{[^}]*\}/g) ?? [];
    expect(faces.length).toBe(20);
    expect(faces.every((face) => (face.match(/url\(/g) ?? []).length === 1 && /url\(fonts\/KaTeX_[\w-]+\.woff2\) format\("woff2"\)/.test(face))).toBe(true);
    expect(kept).not.toMatch(/\.(woff|ttf)\)/);
    // Nothing else of the sheet changed.
    expect(kept.replace(/@font-face\{[^}]*\}/g, "")).toBe(original.replace(/@font-face\{[^}]*\}/g, ""));
  });

  test("another stylesheet is left alone, and this one in another shape stops the build", () => {
    expect(transform("a{b:c}", "/x/other.css")).toBeNull();
    expect(() => transform("@font-face{src:url(a.woff2) format(\"woff2\")}", path)).toThrow(/no longer names its fonts/);
  });
});
