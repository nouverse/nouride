#!/usr/bin/env node
// frame.mjs - put a mockup's pictures inside a phone and a laptop, for a person who asked to see it as it would sit
// on a device. Part of the mockup-design skill.
//
//   node frame.mjs --browser-dir DIR --out DIR [--name NAME] [--phone SHOT.png] [--laptop SHOT.png]
//                  [--bg COLOUR|transparent] [--chromium PATH]
//
// --phone is a picture of the mockup at a phone's width, --laptop one at a desktop's: render.mjs's NAME-mobile-1.png
// and NAME-desktop-1.png, the first window of each. A longer picture is held from its top: a device shows one screen.
// On the phone the mockup starts under the band a phone keeps for its clock, so nothing of it is behind the pill.
// Writes NAME-phone.png, NAME-laptop.png, and NAME-devices.png (the two together) when both were given.
// --bg is what the devices stand on: any CSS colour, taken from the mockup's own colours so the picture belongs to
// it, or `transparent`. With none it is a plain light grey, which says nothing about the mockup.
//
// The devices are drawn here, in HTML and CSS: a phone and a laptop of no make, with no logo and no picture of a
// real product. Nothing inside the screen is changed: the mockup is shown as it was drawn.
// Exit 0 done, 1 bad arguments, 2 a picture cannot be read, 3 Playwright or a browser missing.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The screens the devices hold, in CSS pixels: the windows render.mjs draws a mockup in. */
const PHONE = { width: 390, height: 844 };
/** The height of the band at the top of a phone's screen. */
const STATUS = 54;
const LAPTOP = { width: 1440, height: 900 };
/** How wide the laptop's screen is drawn: its picture is scaled to it. */
const LAPTOP_SHOWN = 1000;
const NEUTRAL = "#ECECEF";

/**
 * The page the devices are drawn on: `#phone`, `#laptop` and `#devices`, each a box to take a picture of. `phone` and
 * `laptop` are addresses of the mockup's pictures (file:// here); either may be left out.
 */
export function frameHtml({ phone, laptop, bg = NEUTRAL }) {
  const backdrop = bg === "transparent" ? "transparent" : bg;
  const lapHigh = Math.round((LAPTOP_SHOWN * LAPTOP.height) / LAPTOP.width);
  const attr = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const phoneBody = phone
    ? `<div class="phone"><div class="screen"><i class="status" style="background-image: url(&quot;${attr(phone)}&quot;)"></i><img src="${attr(phone)}" alt=""></div><i class="island"></i><i class="key k1"></i><i class="key k2"></i><i class="key k3"></i></div>`
    : "";
  const laptopBody = laptop
    ? `<div class="laptop"><div class="lid"><i class="lens"></i><div class="screen"><img src="${attr(laptop)}" alt=""></div></div><div class="deck"><i class="lip"></i></div></div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; }
  .stage { display: inline-flex; align-items: flex-end; justify-content: center; padding: 72px; background: ${backdrop}; }
  .screen { overflow: hidden; background: #fff; }
  .screen img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top center; }

  /* A phone of no make: a dark body, a round-cornered screen, a pill at its top, three keys on its sides. */
  .phone { position: relative; padding: 13px; border-radius: 62px; background: #0D0D0F; box-shadow: inset 0 0 0 2px #2C2C31, inset 0 0 0 4px #0D0D0F, 0 30px 60px -18px rgba(0, 0, 0, 0.38), 0 12px 24px -12px rgba(0, 0, 0, 0.28); }
  .phone .screen { display: flex; flex-direction: column; width: ${PHONE.width}px; height: ${PHONE.height}px; border-radius: 50px; }
  .phone .screen img { flex: 1; min-height: 0; }
  /* The band a phone keeps for its clock, where the pill is: the mockup starts under it, as a page does on a phone.
     Its colour is the mockup's own top-left corner, drawn a hundred times its size, so the band belongs to the page. */
  .phone .status { flex: 0 0 ${STATUS}px; background-repeat: no-repeat; background-position: 0 0; background-size: ${PHONE.width * 100}px auto; image-rendering: pixelated; }
  .phone .island { position: absolute; top: 25px; left: 50%; width: 112px; height: 32px; margin-left: -56px; border-radius: 16px; background: #000; }
  .phone .key { position: absolute; width: 4px; border-radius: 2px; background: #1B1B1F; }
  .phone .k1 { left: -3px; top: 178px; height: 62px; }
  .phone .k2 { left: -3px; top: 256px; height: 62px; }
  .phone .k3 { right: -3px; top: 214px; height: 98px; }

  /* A laptop of no make: a dark lid around the screen with a lens above it, on a metal deck with a lip to open it by. */
  .laptop { display: flex; flex-direction: column; align-items: center; filter: drop-shadow(0 28px 34px rgba(0, 0, 0, 0.26)); }
  .laptop .lid { position: relative; padding: 22px 14px 14px; border-radius: 20px 20px 0 0; background: #0D0D0F; box-shadow: inset 0 0 0 2px #2C2C31; }
  .laptop .screen { width: ${LAPTOP_SHOWN}px; height: ${lapHigh}px; border-radius: 4px; }
  .laptop .lens { position: absolute; top: 8px; left: 50%; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; background: #26262B; }
  .laptop .deck { position: relative; width: ${LAPTOP_SHOWN + 196}px; height: 18px; border-radius: 3px 3px 16px 16px; background: linear-gradient(#D9DBE0, #B4B7BE 55%, #8D9098); }
  .laptop .lip { position: absolute; top: 0; left: 50%; width: 168px; height: 7px; margin-left: -84px; border-radius: 0 0 9px 9px; background: #9A9DA5; }

  /* The two together: the phone in front of the laptop's right corner, at its size beside a laptop. */
  .together { position: relative; }
  .together .laptop { margin-right: 150px; }
  .together .phone { position: absolute; right: 60px; bottom: 60px; zoom: 0.54; }
</style></head><body>
${phone ? `<div id="phone" class="stage">${phoneBody}</div>` : ""}
${laptop ? `<div id="laptop" class="stage">${laptopBody}</div>` : ""}
${phone && laptop ? `<div id="devices" class="stage together">${laptopBody}${phoneBody}</div>` : ""}
</body></html>`;
}

function usage(msg, code = 1) {
  if (msg) console.error(`frame.mjs: ${msg}`);
  console.error("usage: node frame.mjs --browser-dir DIR --out DIR [--name NAME] [--phone SHOT.png] [--laptop SHOT.png] [--bg COLOUR|transparent] [--chromium PATH]");
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return 0;
  }
  const opt = { phone: null, laptop: null, out: null, name: null, bg: NEUTRAL, browserDir: null, chromium: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--phone") opt.phone = args[++i];
    else if (a === "--laptop") opt.laptop = args[++i];
    else if (a === "--out") opt.out = args[++i];
    else if (a === "--name") opt.name = args[++i];
    else if (a === "--bg") opt.bg = args[++i];
    else if (a === "--browser-dir") opt.browserDir = args[++i];
    else if (a === "--chromium") opt.chromium = args[++i];
    else usage(`unknown argument ${a}`);
  }
  if (!opt.phone && !opt.laptop) usage("give --phone, --laptop, or both");
  if (!opt.out) usage("no --out folder");
  if (!opt.bg || /[<>"{};]/.test(opt.bg)) usage("--bg is one CSS colour (#1b2a4a, rgb(27 42 74), a name) or transparent");
  for (const shot of [opt.phone, opt.laptop]) {
    if (!shot) continue;
    if (!existsSync(resolve(shot))) usage(`no picture at ${resolve(shot)}`, 2);
    if (!/\.(png|jpe?g|webp)$/i.test(shot)) usage(`${shot} is not a picture (png, jpg or webp): frame a screen render.mjs drew, e.g. NAME-mobile-1.png`, 2);
  }
  const out = resolve(opt.out);
  mkdirSync(out, { recursive: true });
  const name = (opt.name ?? basename(opt.phone ?? opt.laptop).replace(/-(mobile|desktop|tablet)(-dark)?(-\d+)?\.\w+$/i, "").replace(/\.\w+$/, "")) || "mockup";

  let chromium, launch = {};
  const tries = [];
  if (opt.browserDir) tries.push(join(resolve(opt.browserDir), "package.json"));
  tries.push(join(process.cwd(), "package.json"), import.meta.url);
  for (const base of tries) {
    try { chromium = createRequire(base)("playwright-core").chromium; break; } catch { /* next */ }
  }
  if (!chromium) {
    console.error("frame.mjs: playwright-core not found. Set up the browser-automation skill (its steps 1 and 2) and pass its folder: --browser-dir <private>/browser");
    return 3;
  }
  const cfg = opt.browserDir && join(resolve(opt.browserDir), ".playwright", "cli.config.json");
  if (cfg && existsSync(cfg)) {
    try { launch = JSON.parse(readFileSync(cfg, "utf8"))?.browser?.launchOptions ?? {}; } catch { /* the defaults */ }
  }
  if (opt.chromium) launch.executablePath = opt.chromium;

  let browser;
  try {
    browser = await chromium.launch({ ...launch, headless: true });
  } catch (e) {
    console.error(`frame.mjs: the browser did not start: ${String(e.message).split("\n")[0]}`);
    return 3;
  }
  // Loaded from a file beside the pictures it writes: a page set from a string is about:blank and may not show
  // file:// pictures.
  const sheet = join(out, `.${name}-frame.html`);
  const address = (shot) => (shot ? pathToFileURL(resolve(shot)).href : null);
  writeFileSync(sheet, frameHtml({ phone: address(opt.phone), laptop: address(opt.laptop), bg: opt.bg }));
  const wrote = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 1300 }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(sheet).href, { waitUntil: "load" });
    const broken = await page.evaluate(() => [...document.images].filter((img) => !img.complete || img.naturalWidth === 0).map((img) => img.getAttribute("src")));
    if (broken.length) {
      console.error(`frame.mjs: could not read ${[...new Set(broken)].join(", ")}`);
      return 2;
    }
    for (const id of ["phone", "laptop", "devices"]) {
      const box = page.locator(`#${id}`);
      if ((await box.count()) === 0) continue;
      const file = join(out, `${name}-${id}.png`);
      await box.screenshot({ path: file, omitBackground: opt.bg === "transparent" });
      wrote.push(file);
    }
  } finally {
    await browser.close();
    rmSync(sheet, { force: true });
  }
  console.log(`wrote ${wrote.join(", ")}`);
  console.log(`next: read ${wrote.length > 1 ? "them" : "it"} before sending: the screen filled, nothing of the mockup cut that matters, the backdrop belonging to it`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
