/**
 * A `<link rel="preload">` for the interface font, written into `index.html` by the build.
 *
 * The page draws no text until React has run, and a browser asks for a font only when it first draws text in
 * it — so Manrope was requested after the whole script had downloaded and run, and the first paint was in the
 * fallback face, swapped for the real one a moment later. Preloaded, it downloads beside the stylesheet and the
 * script. Only Manrope's Latin file: every page draws it first. DM Mono and the Latin Extended files load when a
 * page needs them; a preload nothing uses is a console warning and bytes for nothing.
 *
 * Done here because the file's name is hashed by the build, so the tag cannot be written in `index.html` by hand.
 */

import type { Plugin } from "vite";

/** `file` is the font's own name, as `styles/main.css` imports it (`manrope-latin.woff2`). */
export function preloadFont(file: string): Plugin {
  let base = "/";
  return {
    name: "nouride:preload-font",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const asset = Object.values(context.bundle ?? {}).find(
          (output) => output.type === "asset" && output.names.some((name) => name === file),
        );
        // Loud, not skipped: a rename in main.css would otherwise drop the preload with nothing saying so.
        if (!asset) throw new Error(`preload-font: the build emitted no ${file} — is it still what styles/main.css imports?`);
        return [
          {
            tag: "link",
            attrs: { rel: "preload", href: `${base}${asset.fileName}`, as: "font", type: "font/woff2", crossorigin: "" },
            injectTo: "head",
          },
        ];
      },
    },
  };
}
