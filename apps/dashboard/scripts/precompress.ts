/**
 * Brotli and gzip copies of the build's text assets, written beside them.
 *
 * The daemon served every script and stylesheet raw: the main script went over the wire at its full
 * size to a browser that would have taken a quarter of it compressed, from a Pi over Wi-Fi. Compressing
 * per request would spend that Pi's CPU on every cold load, and brotli at its best setting is far too
 * slow for that, so the build does it once. `apps/engine/src/modules/web/dashboard-files.ts` sends the
 * copy a browser accepts, with `Vary: Accept-Encoding`.
 *
 * From the files on disk, once Vite has written them, and not from the bundle in `generateBundle`. The
 * first version read the bundle there, and Vite was still to replace its `__VITE_PRELOAD__` placeholder
 * in that same hook: every `.br` held a script that threw "__VITE_PRELOAD__ is not defined", which a
 * browser taking brotli got instead of the working one. What is compressed is now exactly what is served.
 *
 * Only `assets/*`: they are named by their content, so a copy can never disagree with its original. A
 * file under 1 KB is left alone (the headers cost more than the bytes saved), and so is any copy that
 * would not be smaller.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

const TEXT = /\.(js|mjs|css|svg|json|txt|map)$/;
const MIN_BYTES = 1024;

/** The encodings written, as `dashboard-files.ts` names them: the suffix and the `Content-Encoding`. */
const ENCODINGS = [
  {
    suffix: ".br",
    compress: (bytes: Uint8Array) =>
      brotliCompressSync(bytes, {
        params: {
          [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
          [constants.BROTLI_PARAM_QUALITY]: 11,
          [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
        },
      }),
  },
  { suffix: ".gz", compress: (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }) },
] as const;

/** Write the copies for every text file in `<outDir>/assets`. Separate from the plugin so a test can hand it a directory. */
export function precompressAssets(outDir: string): void {
  const assets = join(outDir, "assets");
  for (const name of readdirSync(assets)) {
    if (!TEXT.test(name)) continue;
    const bytes = readFileSync(join(assets, name));
    if (bytes.byteLength < MIN_BYTES) continue;
    for (const { suffix, compress } of ENCODINGS) {
      const compressed = compress(bytes);
      if (compressed.byteLength < bytes.byteLength) writeFileSync(join(assets, `${name}${suffix}`), compressed);
    }
  }
}

export function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "nouride:precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // After every file is on disk, whatever the other plugins did to it on the way.
    writeBundle: {
      order: "post",
      handler() {
        precompressAssets(outDir);
      },
    },
  };
}
