#!/usr/bin/env bun
/**
 * The 1200x630 social preview (WhatsApp, X, Discord, LinkedIn), in the site's soft look (0.8.24): the landing's
 * greeting on cream, Fredoka over Manrope, the waving cat, and the address on a peach pill.
 *
 * Drawn by a headless Chrome from an HTML card rather than by sharp: sharp's SVG text takes the system's faces, so the
 * banner came out in Helvetica whatever it named, and the brand's faces are woff2, which its text renderer does not
 * read. Chrome draws the page exactly as the site does, with the same font files and the same picture. Run it by hand
 * when the banner should change (`bun run og`); the PNG is committed, so a build needs no browser.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../../..");
const FONTS = join(ROOT, "apps/dashboard/src/styles/fonts");
const MASCOT = join(ROOT, "packages/shared/assets/mascot/standing/01-waving.webp");
const OUTPUT = join(HERE, "../public/og.png");

/** The first Chrome, Chromium or Edge found, or one named by `CHROME`. */
function browser(): string {
  const candidates = [
    process.env.CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("no Chrome, Chromium or Edge found: set CHROME to one to draw og.png");
  return found;
}

const font = (file: string) => pathToFileURL(join(FONTS, file)).href;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face { font-family: "Fredoka"; font-weight: 500; src: url("${font("fredoka-500-latin.woff2")}") format("woff2"); }
@font-face { font-family: "Manrope"; font-weight: 200 800; src: url("${font("manrope-latin.woff2")}") format("woff2"); }
* { margin: 0; box-sizing: border-box; }
html, body { width: 1200px; height: 630px; }
body {
  font-family: "Manrope", sans-serif;
  color: #221e2e;
  background:
    radial-gradient(52rem 30rem at 100% 0%, rgba(140, 122, 230, 0.16), transparent 70%),
    radial-gradient(40rem 26rem at 0% 100%, rgba(240, 138, 108, 0.12), transparent 70%),
    #faf7f2;
  display: flex; align-items: center; padding: 0 0 0 84px; overflow: hidden;
}
.copy { flex: 1; display: flex; flex-direction: column; gap: 26px; padding-right: 8px; }
.brand { display: flex; align-items: center; gap: 12px; font-family: "Fredoka"; font-weight: 500; font-size: 34px; letter-spacing: -0.01em; }
.brand span { color: #5e48b0; }
h1 { font-family: "Fredoka"; font-weight: 500; font-size: 74px; line-height: 1; letter-spacing: -0.02em; white-space: nowrap; }
p { font-size: 27px; line-height: 1.42; color: #4a4558; max-width: 600px; font-weight: 500; }
.pill { align-self: flex-start; background: #f08a6c; color: #221e2e; font-family: "Fredoka"; font-weight: 500; font-size: 28px;
  padding: 12px 30px; border-radius: 999px; box-shadow: 0 10px 26px rgba(240, 138, 108, 0.35); }
img { width: 470px; height: 470px; margin-right: 24px; margin-bottom: -30px; }
</style></head>
<body>
  <div class="copy">
    <div class="brand">Nouride</div>
    <h1>AI agents that live<br>on your box</h1>
    <p>Chat with them on Telegram, Discord, WhatsApp or right in your browser.</p>
    <div class="pill">nouride.com</div>
  </div>
  <img src="${pathToFileURL(MASCOT).href}" alt="">
</body></html>`;

const work = mkdtempSync(join(tmpdir(), "nouride-og-"));
try {
  const page = join(work, "og.html");
  writeFileSync(page, html);
  const chrome = spawnSync(browser(), [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--allow-file-access-from-files",
    "--force-device-scale-factor=1",
    "--window-size=1200,630",
    "--virtual-time-budget=3000",
    `--user-data-dir=${join(work, "profile")}`,
    `--screenshot=${OUTPUT}`,
    pathToFileURL(page).href,
  ]);
  if (!existsSync(OUTPUT) || chrome.status !== 0) throw new Error(`Chrome did not draw og.png: ${String(chrome.stderr ?? "").slice(0, 400)}`);
  console.log(`✓ og.png drawn (1200x630) at ${OUTPUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
