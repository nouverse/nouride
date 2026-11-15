/**
 * A stylesheet that names a font three ways keeps only the `.woff2`.
 *
 * KaTeX's stylesheet gives each of its twenty faces as woff2, woff and ttf. Every browser the dashboard runs in reads
 * woff2 and never asks for the other two, but the build would still copy them: 816 KB of files on disk beside the
 * binary that nothing loads. Only the stylesheets listed are read, and one that no longer has the shape this expects
 * fails the build rather than being copied whole.
 */

import type { Plugin } from "vite";

/** `, url(x.woff) format("woff")` and `, url(x.ttf) format("truetype")`, after the woff2 of the same face. */
const OLDER = /,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\(["'](?:woff|truetype)["']\)/g;

export function woff2Only(stylesheets: string[]): Plugin {
  return {
    name: "nouride:woff2-only",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      const path = id.split("?")[0] ?? id;
      if (!stylesheets.some((sheet) => path.endsWith(sheet))) return null;
      const kept = code.replace(OLDER, "");
      if (kept === code || /\.(?:woff|ttf)\)/.test(kept)) throw new Error(`woff2-only: ${sheet(path)} no longer names its fonts as woff2, woff, ttf`);
      return { code: kept, map: null };
    },
  };
}

const sheet = (path: string) => path.slice(path.lastIndexOf("/") + 1);
