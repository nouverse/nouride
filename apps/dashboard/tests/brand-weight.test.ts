/**
 * The brand images the dashboard imports are sized for where they are drawn.
 *
 * The avatar was the 1254 px, 922 KB chibi PNG, drawn at 24 to 56 CSS pixels: 43% of a cold dashboard
 * load, more than the whole script gzipped (dash-dead-mascot-asset-weight). The source stays in
 * `packages/shared/assets` for the docs site's social banner, which renders it at 460 px; the
 * dashboard imports a 128 px copy. This keeps the next `@brand/` import from being a source file.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = join(dirname(import.meta.path), "..", "src");
const BRAND = join(SRC, "..", "..", "..", "packages", "shared", "assets");

/** The same ceiling `brand-marks.test.ts` gives a favicon, for the same reason: every cold load pays it. */
const MAX_BYTES = 200_000;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|css)$/.test(name) ? [path] : [];
  });
}

const imports = sources(SRC).flatMap((path) =>
  [...readFileSync(path, "utf8").matchAll(/["']@brand\/([^"']+)["']/g)].map((m) => ({ from: relative(SRC, path), file: m[1]! })),
);

describe("brand images in the dashboard", () => {
  test("there is at least one, so the check below reads something", () => {
    expect(imports.length).toBeGreaterThan(0);
  });

  test("each is small enough to be fetched on a cold load", () => {
    const heavy = imports
      // `?inline` is how the file is built in, not part of its name.
      .map(({ from, file }) => ({ from, file, bytes: statSync(join(BRAND, file.replace(/\?.*$/, ""))).size }))
      .filter(({ bytes }) => bytes > MAX_BYTES)
      .map(({ from, file, bytes }) => `${from}: @brand/${file} is ${bytes} B`);
    expect(heavy).toEqual([]);
  });

  test("one picture alone is built into the script, the one the waiting screen shows with the daemon gone (0.8.24)", () => {
    // Each `?inline` is a `data:` URL in the bundle every page loads, a third larger than the file: the mascot's other
    // poses are fetched by the page that draws one.
    expect(imports.filter(({ file }) => file.endsWith("?inline"))).toEqual([{ from: "commons/components/brand/Mascot.tsx", file: "mascot/states/01-error.webp?inline" }]);
  });
});

/**
 * The tab's icon is sized for a tab (dashboard-theme-saves-system-choice).
 *
 * It was the 256 px chibi, 65 KB: after the script, the largest file a cold load fetched, for a mark a tab draws
 * at 16 to 32 CSS pixels. 64 px covers that on a 2x screen. A favicon cannot be imported, so `sync-brand.ts`
 * copies it into `public/`; the size is read from the file that script names.
 */
describe("the favicon", () => {
  const script = readFileSync(join(SRC, "..", "..", "..", "scripts", "sync-brand.ts"), "utf8");
  const source = /from:\s*"packages\/shared\/assets\/([^"]+)",\s*to:\s*"apps\/dashboard\/public\/favicon\.png"/.exec(script)?.[1];

  test("is a PNG of at most 64 px and 10 KB", () => {
    expect(source).toBeDefined();
    const bytes = readFileSync(join(BRAND, source!));
    // The PNG signature, then the IHDR chunk: width and height are its first two 32-bit fields.
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    const side = Math.max(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    expect(side).toBeGreaterThanOrEqual(32);
    expect(side).toBeLessThanOrEqual(64);
    expect(bytes.byteLength).toBeLessThanOrEqual(10_000);
  });
});
