#!/usr/bin/env node
// render.mjs - draw a mockup's screens in a real browser at a desktop's and a phone's width, measure what can be
// measured on each, and print the findings. Part of the mockup-design skill.
//
//   node render.mjs SCREEN.html [MORE.html ...] --browser-dir DIR [--out DIR] [--only desktop|mobile] [--also tablet]
//                   [--dark] [--frame [--bg COLOUR|transparent]] [--chromium PATH]
//
// A screen is an HTML file, or an address (http://127.0.0.1:8787/checkout) for a mockup that is served.
// --browser-dir is the browser-automation skill's folder (the one holding node_modules/playwright-core and
// .playwright/cli.config.json); this script borrows its Playwright and its browser, so nothing is installed twice.
// --chromium PATH uses that browser instead of Playwright's own (a system Chromium, e.g. on Alpine).
// --dark draws each screen a second time as a device set to dark does (prefers-color-scheme: dark), named -dark.
// --frame also puts each screen's first window inside a phone and a laptop, in the same run and the same browser:
// NAME-phone.png, NAME-laptop.png, NAME-devices.png (frame.mjs beside this file says what they are, and --bg).
//
// Writes into --out (default: a folder named render, beside the first screen), for a screen named home:
//   home-desktop.png, home-mobile.png          the whole page at each width: what the person is sent
//   home-desktop-1.png, -2.png ...             the same page one window at a time: what you read, since a whole
//   home-mobile-1.png, -2.png ...              page in one picture is too small to judge. -1 is what a frame holds
//   home-desktop-check.png                     the page with each finding outlined in red and numbered as in the list
//   check.json                                 the findings, for a program
// and prints, per screen and width, each finding. Exit 0 when nothing was found, 4 when something was (the files are
// written either way), 1 bad arguments, 2 a screen cannot be loaded, 3 Playwright or a browser missing.
//
// What is measured, and why each number, is in judge.mjs beside this file. None of it is about how a page looks.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { drawFrames, isColour } from "./frame.mjs";
import { FIXES, VIEWPORTS, judge, whereInFile } from "./judge.mjs";

/** A page taller than this is not drawn whole: a picture that long is read by nobody. */
const TALLEST = 12_000;
/** The most windows of one page that are cut out for reading. */
const MOST_WINDOWS = 8;

function usage(msg, code = 1) {
  if (msg) console.error(`render.mjs: ${msg}`);
  console.error("usage: node render.mjs SCREEN.html [MORE.html ...] --browser-dir DIR [--out DIR] [--only desktop|mobile] [--also tablet] [--dark] [--frame [--bg COLOUR|transparent]] [--chromium PATH]");
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const opt = { screens: [], out: null, browserDir: null, widths: ["desktop", "mobile"], dark: false, chromium: null, frame: false, bg: undefined };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") opt.out = args[++i];
  else if (a === "--browser-dir") opt.browserDir = args[++i];
  else if (a === "--only") opt.widths = [args[++i]];
  else if (a === "--also") opt.widths.push(args[++i]);
  else if (a === "--dark") opt.dark = true;
  else if (a === "--frame") opt.frame = true;
  else if (a === "--bg") opt.bg = args[++i];
  else if (a === "--chromium") opt.chromium = args[++i];
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else opt.screens.push(a);
}
if (!opt.screens.length) usage("no screen given");
for (const width of opt.widths) if (!VIEWPORTS[width]) usage(`no width called ${width} (one of ${Object.keys(VIEWPORTS).join(", ")})`);
if (opt.bg !== undefined && !isColour(opt.bg)) usage("--bg is one CSS colour (a hex value, an rgb value, a name) or transparent");
if (opt.bg !== undefined && !opt.frame) usage("--bg is what the devices stand on: it goes with --frame");

const isAddress = (screen) => /^https?:\/\//i.test(screen);
const screens = opt.screens.map((screen) => {
  if (isAddress(screen)) {
    const at = new URL(screen);
    return { name: (at.pathname.replace(/\/$/, "").split("/").pop() || at.hostname).replace(/\.html?$/i, "").replace(/[^\w.-]+/g, "-") || "page", url: at.href, from: at.href };
  }
  const file = resolve(screen);
  if (!existsSync(file)) usage(`no file at ${file}`, 2);
  return { name: basename(file).replace(/\.html?$/i, ""), url: pathToFileURL(file).href, from: file };
});
const twice = screens.map((screen) => screen.name).find((name, i, all) => all.indexOf(name) !== i);
if (twice) usage(`two screens are both named ${twice}: give each file its own name`);
const out = resolve(opt.out ?? join(isAddress(opt.screens[0]) ? process.cwd() : dirname(resolve(opt.screens[0])), "render"));
mkdirSync(out, { recursive: true });

// Playwright from the browser-automation folder (or anywhere Node can find it).
let chromium, launch = {};
{
  const tries = [];
  if (opt.browserDir) tries.push(join(resolve(opt.browserDir), "package.json"));
  tries.push(join(process.cwd(), "package.json"), import.meta.url);
  for (const base of tries) {
    try { chromium = createRequire(base)("playwright-core").chromium; break; } catch { /* next */ }
  }
  if (!chromium) {
    console.error("render.mjs: playwright-core not found. Set up the browser-automation skill (its steps 1 and 2) and pass its folder: --browser-dir <private>/browser");
    process.exit(3);
  }
  const cfg = opt.browserDir && join(resolve(opt.browserDir), ".playwright", "cli.config.json");
  if (cfg && existsSync(cfg)) {
    try { launch = JSON.parse(readFileSync(cfg, "utf8"))?.browser?.launchOptions ?? {}; } catch { /* the defaults */ }
  }
  if (opt.chromium) launch.executablePath = opt.chromium;
}

let browser;
try {
  browser = await chromium.launch({ ...launch, headless: true });
} catch (e) {
  console.error(`render.mjs: the browser did not start: ${String(e.message).split("\n")[0]}`);
  console.error("Install it from the browser folder: npx playwright-cli install-browser chromium --only-shell (browser-automation step 2), or pass --chromium PATH");
  process.exit(3);
}

// ------------------------------------------------------------------ measuring, inside the page
/** The facts judge.mjs decides from, in the page's own coordinates. Runs in the browser: it can use nothing outside itself. */
function collect() {
  const parse = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const sx = window.scrollX, sy = window.scrollY;
  const rel = (r) => ({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });
  const styles = new WeakMap();
  const style = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s); } return s; };
  const ids = new WeakMap();
  let last = 0;
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, ++last); return ids.get(el); };
  const shown = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = style(a);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.15) return false;
    }
    return true;
  };
  // What is behind a piece of text: the nearest background that is a plain colour. A picture or a gradient is null:
  // that is judged by eye.
  const bgOf = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = style(a);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = parse(s.backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const pinned = (el) => { for (let a = el; a; a = a.parentElement) { const p = style(a).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  // What cuts a piece of text, and by how much: the nearest box above it that hides what runs past it and holds more
  // than it has room for. Named, because the text is not where the fix is: the box is.
  const cutBy = (el) => {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = style(a);
      const hidesY = /hidden|clip/.test(s.overflowY), hidesX = /hidden|clip/.test(s.overflowX);
      const clamped = s.webkitLineClamp && s.webkitLineClamp !== "none";
      if (hidesY && !clamped && a.scrollHeight > a.clientHeight + 2 && a !== document.body) return { how: "height", by: tagged(a), handle: handle(a), holds: a.scrollHeight, room: a.clientHeight };
      if (hidesX && s.textOverflow !== "ellipsis" && !clamped && a.scrollWidth > a.clientWidth + 2 && a !== document.body) return { how: "width", by: tagged(a), handle: handle(a), holds: a.scrollWidth, room: a.clientWidth };
    }
    return null;
  };
  // The part of the page a piece of text can be seen in: every box above it that hides or scrolls what runs past it.
  // A line hidden there is not on the page, and is no line to find over another.
  const seenIn = (el) => {
    let box = null;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = style(a);
      if (!/hidden|clip|auto|scroll/.test(s.overflowX + s.overflowY) || a === document.body) continue;
      const r = rel(a.getBoundingClientRect());
      box = box ? { x: Math.max(box.x, r.x), y: Math.max(box.y, r.y), w: Math.min(box.x + box.w, r.x + r.w) - Math.max(box.x, r.x), h: Math.min(box.y + box.h, r.y + r.h) - Math.max(box.y, r.y) } : r;
    }
    return box;
  };
  const within = (line, box) => {
    const x = Math.max(line.x, box.x), y = Math.max(line.y, box.y);
    return { x, y, w: Math.min(line.x + line.w, box.x + box.w) - x, h: Math.min(line.y + line.h, box.y + box.h) - y };
  };
  const words = (el, n = 40) => (el.getAttribute?.("aria-label") || el.textContent || el.getAttribute?.("placeholder") || el.getAttribute?.("value") || "").replace(/\s+/g, " ").trim().slice(0, n);
  // An element as its tag, its id and its first two classes: what a person searches their file for.
  const tagged = (el) => { const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""; return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}>`; };
  const named = (el) => { const said = words(el, 30); return `${tagged(el)}${said ? ` "${said}"` : ""}`; };
  // The word of an element that is likeliest to stand once in the file: its id, else its first class.
  const handle = (el) => el.id || (typeof el.className === "string" && el.className.trim() ? el.className.trim().split(/\s+/)[0] : "");

  const texts = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && texts.length < 4000; node = walker.nextNode()) {
    const el = node.parentElement;
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE|OPTION)$/.test(el.tagName) || !shown(el)) continue;
    range.selectNodeContents(node);
    const frame = seenIn(el);
    const lines = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).map(rel).map((line) => (frame ? within(line, frame) : line)).filter((line) => line.w > 1 && line.h > 1);
    if (!lines.length) continue;
    const box = { x: Math.min(...lines.map((b) => b.x)), y: Math.min(...lines.map((b) => b.y)), w: 0, h: 0 };
    box.w = Math.max(...lines.map((b) => b.x + b.w)) - box.x;
    box.h = Math.max(...lines.map((b) => b.y + b.h)) - box.y;
    const s = style(el);
    const path = [];
    for (let a = el.parentElement; a; a = a.parentElement) path.push(idOf(a));
    texts.push({ id: idOf(el), path, text: text.slice(0, 80), el: tagged(el), handle: handle(el), px: parseFloat(s.fontSize), weight: parseInt(s.fontWeight, 10) || 400, color: parse(s.color), bg: bgOf(el), box, lines, cut: cutBy(el), pinned: pinned(el) });
  }

  const controls = [];
  for (const el of document.querySelectorAll('a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary, [onclick]')) {
    if (!shown(el) || el.disabled) continue;
    let r = el.getBoundingClientRect();
    // A tick box is pressed by its label too: the two together are what a finger has to hit.
    if (el.tagName === "INPUT" && /^(checkbox|radio)$/.test(el.type)) {
      const label = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      if (label) { const l = label.getBoundingClientRect(); r = { left: Math.min(r.left, l.left), top: Math.min(r.top, l.top), width: Math.max(r.right, l.right) - Math.min(r.left, l.left), height: Math.max(r.bottom, l.bottom) - Math.min(r.top, l.top) }; }
    }
    if (r.width < 1 || r.height < 1) continue;
    // A link in the middle of a sentence is read, not aimed at: its line is its size.
    const around = (el.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim().length;
    const own = (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
    const inline = el.tagName === "A" && style(el).display === "inline" && around > own + 8;
    controls.push({ what: named(el), handle: handle(el), said: words(el, 40), box: rel(r), inline });
  }

  const fields = [];
  for (const el of document.querySelectorAll("input, select, textarea")) {
    if (!shown(el) || /^(hidden|checkbox|radio|range|color|file|submit|button|image|reset)$/.test(el.type ?? "")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    fields.push({ what: named(el), handle: handle(el), said: words(el, 40), px: parseFloat(style(el).fontSize), box: rel(r) });
  }

  const pictures = [];
  for (const el of document.querySelectorAll("img")) {
    if (!shown(el)) continue;
    pictures.push({ src: (el.getAttribute("src") ?? "").slice(0, 120), handle: el.getAttribute("src") ?? "", loaded: el.complete && el.naturalWidth > 0, box: rel(el.getBoundingClientRect()) });
  }
  const drawn = document.querySelectorAll("svg, canvas, video").length;

  // What makes a page wider than its window: the innermost things whose right edge passes it, outside any box that
  // scrolls sideways on purpose.
  const windowWide = document.documentElement.clientWidth;
  const wide = [];
  const scrollsItself = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (/auto|scroll|hidden|clip/.test(style(a).overflowX)) return true; return false; };
  for (const el of document.body.querySelectorAll("*")) {
    if (wide.length >= 12) break;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.right <= windowWide + 1 || !shown(el) || scrollsItself(el)) continue;
    if ([...el.children].some((child) => child.getBoundingClientRect().right >= r.right - 1)) continue;
    wide.push({ what: named(el), handle: handle(el), said: words(el, 40), box: rel(r) });
  }

  return {
    page: {
      title: document.title,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      hasViewportMeta: /width\s*=\s*device-width/i.test(document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? ""),
    },
    texts, controls, fields, pictures: drawn ? [...pictures, ...Array.from({ length: drawn }, () => ({ src: "(drawn)", loaded: true, box: { x: 0, y: 0, w: 0, h: 0 } }))] : pictures, wide,
  };
}

/** Fonts the page names that this machine does not have: the page was drawn in the next one of its list. */
function missingFonts() {
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "inherit", "initial", "-apple-system", "blinkmacsystemfont", "emoji", "math"]);
  const asked = new Set();
  for (const el of [...document.body.querySelectorAll("*")].slice(0, 3000)) {
    for (const f of getComputedStyle(el).fontFamily.split(",")) { const n = f.trim().replace(/^["']|["']$/g, ""); if (n && !generic.has(n.toLowerCase())) asked.add(n); }
  }
  const ctx = document.createElement("canvas").getContext("2d");
  const sample = "mmmmmmmmmmlli1WQ@#Ag";
  const has = (fam) => ["monospace", "serif", "sans-serif"].some((g) => { ctx.font = `72px ${g}`; const w0 = ctx.measureText(sample).width; ctx.font = `72px "${fam}", ${g}`; return ctx.measureText(sample).width !== w0; });
  return [...asked].filter((f) => !has(f));
}

// ------------------------------------------------------------------ each screen, at each width
const results = [];
const pageLines = new Set();
const fontsMissing = new Set();
const passes = opt.widths.flatMap((width) => (opt.dark ? [{ width, dark: false }, { width, dark: true }] : [{ width, dark: false }]));
for (const screen of screens) {
  for (const pass of passes) {
    const viewport = VIEWPORTS[pass.width];
    const label = `${screen.name}-${pass.width}${pass.dark ? "-dark" : ""}`;
    // What an earlier round drew of this screen at this width goes first: a check picture left from a round with
    // findings stood beside a round with none, and a window of a page that has since become shorter stayed to be read.
    for (const name of readdirSync(out)) {
      if (name === `${label}.png` || name === `${label}-check.png` || (name.startsWith(`${label}-`) && /^\d+\.png$/.test(name.slice(label.length + 1)))) rmSync(join(out, name), { force: true });
    }
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.scale,
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
      colorScheme: pass.dark ? "dark" : "light",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => pageLines.add(`${screen.name}: ${String(e.message).split("\n")[0]}`));
    page.on("requestfailed", (r) => pageLines.add(`${screen.name}: could not load ${r.url().slice(0, 140)}`));
    try {
      await page.goto(screen.url, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
    } catch (e) {
      console.error(`render.mjs: ${screen.from} did not load: ${String(e.message).split("\n")[0]}`);
      await browser.close();
      process.exit(2);
    }
    const facts = await page.evaluate(collect);
    for (const font of await page.evaluate(missingFonts)) fontsMissing.add(font);
    const source = isAddress(screen.from) ? "" : readFileSync(screen.from, "utf8");
    const findings = judge({ viewport: { name: pass.width, ...viewport }, ...facts }).map((finding) => ({ ...finding, what: finding.what + whereInFile(source, basename(screen.from), finding) }));

    const tall = facts.page.scrollHeight;
    const drawnTall = Math.min(tall, TALLEST);
    const whole = { x: 0, y: 0, width: viewport.width, height: drawnTall };
    await page.screenshot({ path: join(out, `${label}.png`), fullPage: true, clip: whole });
    // One window at a time, each a whole window: the last one ends where the page ends and repeats a little of the one
    // before it, where a strip a few pixels high would be read as nothing. A page's last fifth of a window is in the
    // window before it already.
    let windows = Math.max(1, Math.ceil((drawnTall - 8) / viewport.height));
    if (windows > 1 && drawnTall - (windows - 1) * viewport.height < viewport.height / 5) windows -= 1;
    windows = Math.min(MOST_WINDOWS, windows);
    const read = [];
    for (let n = 0; n < windows; n++) {
      const last = n === windows - 1 && windows > 1 && windows < MOST_WINDOWS;
      const y = last ? Math.max(0, drawnTall - viewport.height) : n * viewport.height;
      const file = join(out, `${label}-${n + 1}.png`);
      await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y, width: viewport.width, height: Math.min(viewport.height, Math.max(1, drawnTall - y)) } });
      read.push(file);
    }
    let check = null;
    if (findings.length) {
      await page.evaluate((boxes) => {
        const layer = document.createElement("div");
        layer.id = "__mockup_check";
        Object.assign(layer.style, { position: "absolute", left: "0", top: "0", width: "0", height: "0", zIndex: "2147483647", pointerEvents: "none" });
        boxes.forEach((box, k) => {
          const d = document.createElement("div");
          Object.assign(d.style, { position: "absolute", left: `${box.x - 3}px`, top: `${box.y - 3}px`, width: `${Math.max(box.w, 4) + 6}px`, height: `${Math.max(box.h, 4) + 6}px`, outline: "3px solid #FF1744", boxSizing: "border-box" });
          const tag = document.createElement("span");
          tag.textContent = String(k + 1);
          Object.assign(tag.style, { position: "absolute", left: "-3px", top: box.y < 26 ? "100%" : "-24px", background: "#FF1744", color: "#fff", font: "bold 16px sans-serif", padding: "1px 6px", lineHeight: "20px" });
          d.appendChild(tag);
          layer.appendChild(d);
        });
        document.body.appendChild(layer);
      }, findings.map((f) => f.box));
      check = join(out, `${label}-check.png`);
      await page.screenshot({ path: check, fullPage: true, clip: { ...whole, width: Math.max(viewport.width, Math.min(facts.page.scrollWidth, viewport.width * 2)) } });
    }
    await context.close();
    results.push({ screen: screen.name, width: pass.width, dark: pass.dark, label, title: facts.page.title, tall, windows, read, check, findings, texts: facts.texts.length });
  }
}
// The devices, where they were asked for: each screen's first window at a phone's width and at a desktop's, as it
// was just drawn (not the dark pass), with the browser that drew it.
const framed = [];
/** Of each screen's frames, the one to read: the two devices together, or the one device that was drawn. */
const framedToRead = [];
if (opt.frame) {
  for (const screen of screens) {
    const first = (width) => results.find((r) => r.screen === screen.name && r.width === width && !r.dark)?.read[0] ?? null;
    const phone = first("mobile"), laptop = first("desktop");
    if (!phone && !laptop) continue;
    try {
      const wrote = await drawFrames(browser, { phone, laptop, out, name: screen.name, ...(opt.bg !== undefined ? { bg: opt.bg } : {}) });
      framed.push(...wrote);
      framedToRead.push(wrote.find((file) => file.endsWith("-devices.png")) ?? wrote[0]);
    } catch (e) {
      pageLines.add(`${screen.name}: its frames were not drawn: ${String(e.message).split("\n")[0]}`);
    }
  }
}
await browser.close();

writeFileSync(join(out, "check.json"), JSON.stringify(results.map(({ screen, width, dark, title, tall, findings }) => ({ screen, width, dark, title, tall, findings: findings.map(({ kind, what }) => ({ kind, what })) })), null, 1));

// ------------------------------------------------------------------ the report
let total = 0;
const kinds = new Set();
console.log(`${screens.length} screen(s), each at ${opt.widths.map((w) => `${w} ${VIEWPORTS[w].width}x${VIEWPORTS[w].height}`).join(" and ")}${opt.dark ? ", light and dark" : ""}`);
console.log(`wrote ${out}/: NAME-WIDTH.png (the whole page), NAME-WIDTH-N.png (one window each), check.json${framed.length ? ", NAME-phone.png, NAME-laptop.png, NAME-devices.png (the first window in a device)" : ""}`);
for (const r of results) {
  const head = `${r.screen} at ${r.width}${r.dark ? ", dark" : ""} (${VIEWPORTS[r.width].width} wide, ${r.tall}px tall)`;
  if (!r.findings.length) { console.log(`${head}: nothing measured wrong`); continue; }
  console.log(`${head}: ${r.findings.length} finding(s), outlined in ${basename(r.check)}`);
  r.findings.slice(0, 12).forEach((f, k) => console.log(`  ${k + 1}. ${f.kind}: ${f.what}`));
  if (r.findings.length > 12) console.log(`  and ${r.findings.length - 12} more, in check.json`);
  for (const f of r.findings) kinds.add(f.kind);
  total += r.findings.length;
}
if (kinds.size) {
  console.log("what to do about each:");
  for (const kind of kinds) console.log(`  ${kind}: ${FIXES[kind]}`);
}
for (const r of results) {
  if (r.tall > TALLEST) console.log(`${r.label}: the page is ${r.tall}px tall; its picture stops at ${TALLEST}px`);
  else if (Math.ceil((r.tall - 8) / VIEWPORTS[r.width].height) > MOST_WINDOWS) console.log(`${r.label}: ${MOST_WINDOWS} windows were cut out for reading; the page goes on below them (the whole of it is in ${r.label}.png)`);
}
if (fontsMissing.size) console.log(`fonts not on this machine or not loaded: ${[...fontsMissing].join(", ")} - the page was drawn in the next font of its list. A web font needs its <link> or @font-face and the network; otherwise name a font that is here`);
for (const line of [...pageLines].slice(0, 8)) console.log(`page: ${line}`);
console.log(total ? `${total} finding(s): fix them in the HTML and render again` : "nothing measured wrong - now look at the pictures for what cannot be measured");
// Named one by one: a model handed only the whole page reads a phone's text at a third of its size and judges nothing.
// The devices' picture is read too, and only when there is nothing left to fix: with findings it will be drawn again.
const devices = total ? [] : framedToRead.filter(Boolean);
console.log(`next: read these in one read call, then write the round's list (SKILL.md step 3): ${[...results.flatMap((r) => [...r.read, ...(r.check ? [r.check] : [])]), ...devices].join(", ")}`);
process.exit(total ? 4 : 0);
