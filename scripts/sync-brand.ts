#!/usr/bin/env bun
/**
 * Copy the shared favicon and the app's icons into each app's `public/`, because a favicon cannot be imported.
 *
 * Everything else about the brand is an import: the dashboard resolves `@brand/mascot/standing/01-waving.webp`
 * through a Vite alias, the docs site does the same and its MDX heroes use a relative path. Those all end up
 * hashed into the app's own output from one file in `packages/shared/assets`.
 *
 * A favicon cannot work that way. `index.html` says `href="/favicon.png"` and Starlight's `favicon`
 * option takes a path under `public/` — neither goes through the bundler, so the bytes have to be
 * *there*. The choice is a committed copy per app or a generated one, and a committed copy is how
 * this repo ended up with the same PNG five times, byte-identical, so that a brand change meant five
 * edits and four chances to miss one.
 *
 * So the copies are generated and gitignored. One source of truth, and nothing to keep in step by
 * hand. Each app's `build` runs this first; `bun run sync:brand` does it on demand for `dev`.
 *
 * **Two marks, not one.** This used to copy a single file to both, and the result was two tabs a
 * person could not tell apart — the dashboard and the manual are open beside each other constantly,
 * and both showed the same cat. They now get different sources on purpose: the chibi is the app, the
 * full logo is the site. Same brand, and distinguishable at 16 pixels, which is the only size that
 * matters here.
 */

import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

/**
 * Which mark each app wears, and where it has to be a real file rather than an import.
 *
 * `favicon-site.png` is the full logo at 256 px and no larger: a favicon is fetched on every cold
 * page load, and the wordmark it carries is unreadable below about 64 pixels anyway.
 *
 * The dashboard's is the chibi at 64 px, 7 KB: a tab draws it at 16 to 32 CSS pixels, so 64 covers a 2x
 * screen. It was `favicon.png` itself, 256 px and 65 KB, the second-largest file on a cold load; that one
 * stays for the site, which uses it as its touch icon too. Made with `magick favicon.png -filter Lanczos
 * -resize 64x64 -strip -define png:compression-level=9 favicon-64.png`.
 */
const COPIES = [
  { from: "packages/shared/assets/favicon-64.png", to: "apps/dashboard/public/favicon.png" },
  { from: "packages/shared/assets/favicon-site.png", to: "apps/site/public/favicon.png" },
  /**
   * The dashboard's app icons, for a phone's home screen and an installed app: the favicon's head, the mascot's own
   * (`mascot/standing/12-head.webp`, 512px), cut without the sparks beside it. Two to show, clear around the head as the
   * favicon is; one to be masked and the iPhone's, on the night theme's lavender to every edge, since a mask cuts its own
   * shape and an iPhone fills anything clear with black. Made with `magick 12-head.webp -crop 395x512+20+0 +repage -trim
   * +repage -background none -gravity center -extent "%[fx:max(w,h)]x%[fx:max(w,h)]" head.png`, then `magick head.png
   * -filter Lanczos -resize <head>x<head> -background <none|#a99af0> -gravity center -extent <size>x<size>`: 176 in 192,
   * 472 in 512, 300 in the masked 512 (inside the circle every mask keeps), 150 in the iPhone's 180.
   */
  { from: "packages/shared/assets/app-icons/icon-192.png", to: "apps/dashboard/public/icons/icon-192.png" },
  { from: "packages/shared/assets/app-icons/icon-512.png", to: "apps/dashboard/public/icons/icon-512.png" },
  { from: "packages/shared/assets/app-icons/icon-maskable-512.png", to: "apps/dashboard/public/icons/icon-maskable-512.png" },
  { from: "packages/shared/assets/app-icons/apple-touch-icon.png", to: "apps/dashboard/public/icons/apple-touch-icon.png" },
];

for (const { from } of COPIES) {
  if (await Bun.file(join(ROOT, from)).exists()) continue;
  console.error(`✗ ${from} is missing — the brand assets live in packages/shared/assets`);
  process.exit(1);
}

for (const { from, to } of COPIES) {
  const path = join(ROOT, to);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(join(ROOT, from), path);
}

console.log(`✓ brand marks synced: ${COPIES.length} files`);
