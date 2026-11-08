/**
 * Every brand asset is used by something.
 *
 * `packages/shared/assets` held byte-identical copies and a 2 MB sheet nothing read until the orphan-brand-images
 * cleanup, and nothing would say when the next one goes stale: an image is not an import `lint:deadcode` can follow.
 * A use is the asset named in code — `@brand/<file>`, which the dashboard and the site resolve, or
 * `packages/shared/assets/<file>`, which the build scripts read — in a string, not in a comment saying it once was.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const ASSETS = "packages/shared/assets";

/** Source that can name an asset: code, pages and styles, outside dependencies and build output. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx|mjs|js|astro|mdx|css|html)$/.test(entry.name) ? [path] : [];
  });
}

/** Comments out — line and block comments in code, HTML comments in pages: a mention there is history. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * The assets in `files` (paths under the assets, a folder's included) that no text in `texts` names in a string. A
 * query after the name is still the name: `?inline` builds the file into the bundle (the mascot's offline pose).
 */
function unused(files: readonly string[], texts: readonly string[]): string[] {
  return files.filter((file) => {
    const named = new RegExp(`(?:@brand/|${ASSETS}/)${file.replace(/[.]/g, "\\.")}(?:\\?[\\w=&]*)?["'\`]`);
    return !texts.some((text) => named.test(code(text)));
  });
}

/** Every file under `dir`, by its path from it: a folder of assets is its files, each needing a use of its own. */
function files(dir: string, under = ""): string[] {
  return readdirSync(join(dir, under), { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .flatMap((entry) => (entry.isDirectory() ? files(dir, join(under, entry.name)) : [join(under, entry.name)]));
}

describe("brand assets", () => {
  // The mascot's poses are a folder (0.8.24): each pose a page draws is here, named by the code that draws it; the rest
  // of the set waits in docs/design/mascot until one is.
  const assets = files(join(ROOT, ASSETS));
  const texts = ["apps", "packages", "scripts"].flatMap((top) => sources(join(ROOT, top))).map((path) => readFileSync(path, "utf8"));

  test("each is named by code that uses it", () => {
    expect(assets.length).toBeGreaterThan(5);
    expect(unused(assets, texts)).toEqual([]);
  });

  test("a mention in a comment is not a use, and a string is", () => {
    expect(unused(["a.png"], ['// It was `@brand/a.png`, once.\nconst x = 1;'])).toEqual(["a.png"]);
    expect(unused(["a.png"], ["/** see packages/shared/assets/a.png' */"])).toEqual(["a.png"]);
    expect(unused(["a.png"], ['import a from "@brand/a.png";'])).toEqual([]);
    expect(unused(["a.png"], ["const SRC = `${ROOT}/packages/shared/assets/a.png`;"])).toEqual([]);
    expect(unused(["a.png"], ['import a from "@brand/a.png.bak";'])).toEqual(["a.png"]);
  });

  test("a file in a folder is named by its path, built in or fetched; its folder's or a sibling's name is not it", () => {
    expect(unused(["mascot/states/01-error.webp"], ['import offline from "@brand/mascot/states/01-error.webp?inline";'])).toEqual([]);
    expect(unused(["mascot/standing/01-waving.webp"], ['import waving from "@brand/mascot/standing/01-waving.webp";'])).toEqual([]);
    expect(unused(["mascot/standing/01-waving.webp"], ['import x from "@brand/mascot/standing/02-thumbs-up.webp";'])).toEqual(["mascot/standing/01-waving.webp"]);
    expect(unused(["mascot/standing/01-waving.webp"], ['const dir = "@brand/mascot";'])).toEqual(["mascot/standing/01-waving.webp"]);
    expect(files(join(ROOT, ASSETS)).some((file) => file.includes("/"))).toBe(true);
  });

  test("read from the whole tree — a walk that found nothing would find every asset unused, or with no assets, pass", () => {
    expect(texts.length).toBeGreaterThan(500);
  });
});
