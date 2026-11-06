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

/** The assets in `files` that no text in `texts` names in a string. */
function unused(files: readonly string[], texts: readonly string[]): string[] {
  return files.filter((file) => {
    const named = new RegExp(`(?:@brand/|${ASSETS}/)${file.replace(/[.]/g, "\\.")}["'\`]`);
    return !texts.some((text) => named.test(code(text)));
  });
}

describe("brand assets", () => {
  const assets = readdirSync(join(ROOT, ASSETS)).filter((name) => !name.startsWith("."));
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

  test("read from the whole tree — a walk that found nothing would find every asset unused, or with no assets, pass", () => {
    expect(texts.length).toBeGreaterThan(500);
  });
});
