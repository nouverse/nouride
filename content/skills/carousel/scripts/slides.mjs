#!/usr/bin/env node
// slides.mjs - draw every slide of a carousel in a real browser at its exact size, measure what can be measured on
// each, and print the findings. Part of the carousel skill.
//
//   node slides.mjs SLIDES.html --browser-dir DIR [--size 4:5|1:1|3:4|9:16|WIDTHxHEIGHT] [--out DIR] [--pdf] [--chromium PATH]
//
// SLIDES.html is the carousel's one file: each slide is an element with the class "slide", in the order it is posted.
// --size is the shape it is posted in (4:5 when nothing is said): 4:5 is 1080x1350, 1:1 1080x1080, 3:4 1080x1440,
// 9:16 1080x1920. Any other size as WIDTHxHEIGHT.
// --browser-dir is the browser-automation skill's folder (the one holding node_modules/playwright-core and
// .playwright/cli.config.json); this script borrows its Playwright and its browser, so nothing is installed twice.
// --chromium PATH uses that browser instead of Playwright's own (a system Chromium, e.g. on Alpine).
// --pdf also writes carousel.pdf, a page a slide, for where a carousel is posted as a document.
//
// Writes into --out (default: a folder named out, beside the file):
//   slide-01.png, slide-02.png ...   each slide at its exact size: what is posted, in this order
//   sheet.png                         every slide in one picture, numbered: what you read each round
//   check-03.png                      a slide with findings, each outlined in red and numbered as in the list
//   carousel.pdf                      with --pdf
//   check.json                        the findings, for a program
// and prints, per slide, how many words it says, its largest text and each finding. Exit 0 when nothing was found, 4
// when something was (the files are written either way), 1 bad arguments, 2 the file cannot be loaded or holds no
// slide, 3 Playwright or a browser missing.
//
// What is measured, and why each number, is in judge.mjs beside this file. None of it is about how a slide looks.

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FIXES, SIZES, judge, sizeOf, whereInFile, wordsOn } from "./judge.mjs";

/** The most slides one file is drawn as: past it, it is two carousels. */
const MOST_SLIDES = 40;
/** How wide a slide is on the sheet. Four of them, and the gaps, are a picture a model reads whole. */
const ON_THE_SHEET = 432;

function usage(msg, code = 1) {
  if (msg) console.error(`slides.mjs: ${msg}`);
  console.error("usage: node slides.mjs SLIDES.html --browser-dir DIR [--size 4:5|1:1|3:4|9:16|WIDTHxHEIGHT] [--out DIR] [--pdf] [--chromium PATH]");
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const opt = { files: [], out: null, browserDir: null, size: "4:5", pdf: false, chromium: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") opt.out = args[++i];
  else if (a === "--browser-dir") opt.browserDir = args[++i];
  else if (a === "--size") opt.size = args[++i];
  else if (a === "--pdf") opt.pdf = true;
  else if (a === "--chromium") opt.chromium = args[++i];
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else opt.files.push(a);
}
if (opt.files.length !== 1) usage(opt.files.length ? "one file: every slide of a carousel is in it" : "no file given");
const size = sizeOf(opt.size);
if (!size) usage(`no size called ${opt.size} (one of ${Object.keys(SIZES).join(", ")}, or WIDTHxHEIGHT)`);
const file = resolve(opt.files[0]);
if (!existsSync(file)) usage(`no file at ${file}`, 2);
const out = resolve(opt.out ?? join(dirname(file), "out"));
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
    console.error("slides.mjs: playwright-core not found. Set up the browser-automation skill (its steps 1 and 2) and pass its folder: --browser-dir <private>/browser");
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
  console.error(`slides.mjs: the browser did not start: ${String(e.message).split("\n")[0]}`);
  console.error("Install it from the browser folder: npx playwright-cli install-browser chromium --only-shell (browser-automation step 2), or pass --chromium PATH");
  process.exit(3);
}

// ------------------------------------------------------------------ measuring, inside the page
/** The facts judge.mjs decides from, a slide at a time, each in its slide's own coordinates. Runs in the browser. */
function collect() {
  const parse = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
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
  // What is behind a piece of text: the nearest background that is a plain colour. A picture or a gradient is null.
  const bgOf = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = style(a);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = parse(s.backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const tagged = (el) => { const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""; return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}>`; };
  const handle = (el) => el.id || (typeof el.className === "string" && el.className.trim() ? el.className.trim().split(/\s+/)[0] : "");

  // A character with no glyph is drawn as the same empty box whatever it is: so is a character that can have none.
  const canvas = document.createElement("canvas");
  canvas.width = 96; canvas.height = 96;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const inked = (font, ch) => { ctx.clearRect(0, 0, 96, 96); ctx.font = `48px ${font}`; ctx.textBaseline = "top"; ctx.fillStyle = "#000"; ctx.fillText(ch, 8, 8); const d = ctx.getImageData(0, 0, 96, 96).data; let sum = 0, at = 0, n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) { sum += d[i]; at += i * (d[i] & 15); n++; } return `${n}:${sum}:${at}`; };
  const none = new Map();
  const tried = new Map();
  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  const glyphless = (text, font) => {
    const out = [];
    const marks = segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : [...text];
    for (const mark of marks) {
      // Letters and digits of the scripts a text face covers are its own to draw; what goes missing is a symbol, an arrow, an emoji.
      if (!/[←-⯿\u{1F000}-\u{1FAFF}]|\p{Extended_Pictographic}/u.test(mark)) continue;
      const key = `${font}|${mark}`;
      if (!tried.has(key)) {
        if (!none.has(font)) none.set(font, inked(font, "\u{10FFFF}"));
        const drawn = inked(font, mark);
        tried.set(key, drawn === none.get(font) || drawn.startsWith("0:"));
      }
      if (tried.get(key) && !out.includes(mark)) out.push(mark);
    }
    return out;
  };

  const slides = [...document.querySelectorAll(".slide")].filter((el) => !el.parentElement?.closest(".slide"));
  return slides.map((slide) => {
    const frame = slide.getBoundingClientRect();
    const rel = (r) => ({ x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height });
    // What cuts a piece of text inside the slide: a box that hides what runs past it and holds more than it has room
    // for. The slide's own edge is not one of these: text past it is `outside`.
    const cutBy = (el) => {
      for (let a = el; a && a !== slide; a = a.parentElement) {
        const s = style(a);
        const hidesY = /hidden|clip/.test(s.overflowY), hidesX = /hidden|clip/.test(s.overflowX);
        const clamped = s.webkitLineClamp && s.webkitLineClamp !== "none";
        if (hidesY && !clamped && a.scrollHeight > a.clientHeight + 2) return { how: "height", by: tagged(a), handle: handle(a), holds: a.scrollHeight, room: a.clientHeight };
        if (hidesX && s.textOverflow !== "ellipsis" && !clamped && a.scrollWidth > a.clientWidth + 2) return { how: "width", by: tagged(a), handle: handle(a), holds: a.scrollWidth, room: a.clientWidth };
      }
      return null;
    };
    const texts = [];
    const range = document.createRange();
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && texts.length < 600; node = walker.nextNode()) {
      const el = node.parentElement;
      const whole = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!whole || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName) || !shown(el)) continue;
      range.selectNodeContents(node);
      const lines = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).map(rel);
      if (!lines.length) continue;
      const box = { x: Math.min(...lines.map((b) => b.x)), y: Math.min(...lines.map((b) => b.y)), w: 0, h: 0 };
      box.w = Math.max(...lines.map((b) => b.x + b.w)) - box.x;
      box.h = Math.max(...lines.map((b) => b.y + b.h)) - box.y;
      const s = style(el);
      const path = [];
      for (let a = el.parentElement; a && a !== slide.parentElement; a = a.parentElement) path.push(idOf(a));
      texts.push({ id: idOf(el), path, text: whole.slice(0, 80), whole, el: tagged(el), handle: handle(el), px: parseFloat(s.fontSize), weight: parseInt(s.fontWeight, 10) || 400, color: parse(s.color), bg: bgOf(el), box, lines, cut: cutBy(el), glyphless: glyphless(whole, s.fontFamily) });
    }
    const pictures = [];
    for (const el of slide.querySelectorAll("img")) {
      if (!shown(el)) continue;
      pictures.push({ src: (el.getAttribute("src") ?? "").slice(0, 120), handle: el.getAttribute("src") ?? "", loaded: el.complete && el.naturalWidth > 0, box: rel(el.getBoundingClientRect()) });
    }
    return { slide: { x: frame.left + window.scrollX, y: frame.top + window.scrollY, w: frame.width, h: frame.height }, texts, pictures, drawn: slide.querySelectorAll("svg, canvas, video").length };
  });
}

/** Fonts the file names that this machine does not have: the slides were drawn in the next one of the list. */
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

// ------------------------------------------------------------------ the slides
const pageLines = new Set();
const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on("pageerror", (e) => pageLines.add(String(e.message).split("\n")[0]));
page.on("requestfailed", (r) => pageLines.add(`could not load ${r.url().slice(0, 140)}`));
try {
  await page.goto(pathToFileURL(file).href, { waitUntil: "load", timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
} catch (e) {
  console.error(`slides.mjs: ${file} did not load: ${String(e.message).split("\n")[0]}`);
  await browser.close();
  process.exit(2);
}
const collected = await page.evaluate(collect);
if (collected.length === 0) {
  console.error(`slides.mjs: ${basename(file)} holds no slide. Each slide is an element with class="slide", e.g. <section class="slide">, one after another in the order they are posted`);
  await browser.close();
  process.exit(2);
}
const fontsMissing = await page.evaluate(missingFonts);
const source = readFileSync(file, "utf8");
const name = basename(file);

// What an earlier round drew goes first: a carousel that became shorter left its last slides to be read and posted.
for (const old of readdirSync(out)) {
  if (/^(slide|check)-\d+\.png$/.test(old) || old === "sheet.png" || old === "carousel.pdf") rmSync(join(out, old), { force: true });
}

const nn = (n) => String(n).padStart(2, "0");
const results = [];
for (const [index, facts] of collected.slice(0, MOST_SLIDES).entries()) {
  const number = index + 1;
  const findings = judge({ size, ...facts }).map((finding) => ({ ...finding, what: finding.what + whereInFile(source, name, finding) }));
  const at = facts.slide;
  // The slide as it is posted: its own box, to the size asked for where it is that size.
  const clip = { x: at.x, y: at.y, width: Math.max(1, Math.round(at.w)), height: Math.max(1, Math.round(at.h)) };
  const picture = join(out, `slide-${nn(number)}.png`);
  await page.screenshot({ path: picture, fullPage: true, clip });
  let check = null;
  if (findings.length) {
    await page.evaluate(({ boxes, origin }) => {
      const layer = document.createElement("div");
      layer.id = "__carousel_check";
      Object.assign(layer.style, { position: "absolute", left: "0", top: "0", width: "0", height: "0", zIndex: "2147483647", pointerEvents: "none" });
      boxes.forEach((box, k) => {
        const d = document.createElement("div");
        Object.assign(d.style, { position: "absolute", left: `${origin.x + box.x - 4}px`, top: `${origin.y + box.y - 4}px`, width: `${Math.max(box.w, 6) + 8}px`, height: `${Math.max(box.h, 6) + 8}px`, outline: "5px solid #FF1744", boxSizing: "border-box" });
        const tag = document.createElement("span");
        tag.textContent = String(k + 1);
        Object.assign(tag.style, { position: "absolute", left: "-5px", top: box.y < 60 ? "100%" : "-50px", background: "#FF1744", color: "#fff", font: "bold 36px sans-serif", padding: "2px 12px", lineHeight: "44px" });
        d.appendChild(tag);
        layer.appendChild(d);
      });
      document.body.appendChild(layer);
    }, { boxes: findings.map((f) => f.box), origin: { x: at.x, y: at.y } });
    check = join(out, `check-${nn(number)}.png`);
    // A little past the slide on every side: what runs outside it is what the picture is for.
    const pad = Math.round(size.width * 0.06);
    await page.screenshot({ path: check, fullPage: true, clip: { x: Math.max(0, clip.x - pad), y: Math.max(0, clip.y - pad), width: clip.width + pad * 2, height: clip.height + pad * 2 } });
    await page.evaluate(() => document.getElementById("__carousel_check")?.remove());
  }
  results.push({ number, picture, check, findings, words: wordsOn(facts.texts), largest: Math.round(Math.max(0, ...facts.texts.map((t) => t.px))) });
}

// ------------------------------------------------------------------ every slide in one picture, and the document
// The pictures just written, inside the page itself: a page made here has no address, and may load no file by one.
const inPage = (picture) => `data:image/png;base64,${readFileSync(picture).toString("base64")}`;
const cells = results.map((r) => `<figure><img src="${inPage(r.picture)}"><figcaption class="${r.findings.length ? "bad" : ""}">${r.number}${r.findings.length ? ` · ${r.findings.length}` : ""}</figcaption></figure>`).join("");
const columns = Math.min(4, results.length);
const sheetPage = await context.newPage();
// As tall as one row: the picture is the whole page, and a window taller than its rows would leave them standing in empty grey.
await sheetPage.setViewportSize({ width: columns * (ON_THE_SHEET + 16) + 16, height: 100 });
await sheetPage.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:16px 0 0 16px;background:#6b6b6b;display:flex;flex-wrap:wrap;font:bold 22px sans-serif}figure{margin:0 16px 16px 0;position:relative}img{display:block;width:${ON_THE_SHEET}px;height:auto}figcaption{position:absolute;left:0;top:0;background:#111;color:#fff;padding:4px 12px}figcaption.bad{background:#FF1744}</style>${cells}`, { waitUntil: "load" });
const sheet = join(out, "sheet.png");
await sheetPage.screenshot({ path: sheet, fullPage: true });
await sheetPage.close();

let pdf = null;
if (opt.pdf) {
  // A page is the size of a slide and each picture fills one, so each falls on a page of its own.
  const doc = await context.newPage();
  await doc.setContent(`<!doctype html><meta charset="utf-8"><style>@page{size:${size.width}px ${size.height}px;margin:0}body{margin:0}img{display:block;width:${size.width}px;height:${size.height}px}</style>${results.map((r) => `<img src="${inPage(r.picture)}">`).join("")}`, { waitUntil: "load" });
  pdf = join(out, "carousel.pdf");
  await doc.pdf({ path: pdf, width: `${size.width}px`, height: `${size.height}px`, printBackground: true });
  await doc.close();
}
await browser.close();

writeFileSync(join(out, "check.json"), JSON.stringify(results.map(({ number, words, largest, findings }) => ({ slide: number, words, largest, findings: findings.map(({ kind, what }) => ({ kind, what })) })), null, 1));

// ------------------------------------------------------------------ the report
let total = 0;
const kinds = new Set();
console.log(`${results.length} slide(s) at ${size.width}x${size.height}${SIZES[size.name] ? ` (${size.name})` : ""}, from ${name}`);
console.log(`wrote ${out}/: slide-01.png to slide-${nn(results.length)}.png (what is posted, in this order), sheet.png (all of them, to read)${pdf ? ", carousel.pdf" : ""}, check.json`);
for (const r of results) {
  const head = `slide ${r.number}: ${r.words} word(s), largest text ${r.largest}px`;
  if (!r.findings.length) { console.log(`${head}: nothing measured wrong`); continue; }
  console.log(`${head}: ${r.findings.length} finding(s), outlined in ${basename(r.check)}`);
  r.findings.slice(0, 10).forEach((f, k) => console.log(`  ${k + 1}. ${f.kind}: ${f.what}`));
  if (r.findings.length > 10) console.log(`  and ${r.findings.length - 10} more, in check.json`);
  for (const f of r.findings) kinds.add(f.kind);
  total += r.findings.length;
}
if (kinds.size) {
  console.log("what to do about each:");
  for (const kind of kinds) console.log(`  ${kind}: ${FIXES[kind]}`);
}
if (collected.length > MOST_SLIDES) console.log(`the file holds ${collected.length} slides; the first ${MOST_SLIDES} were drawn. A carousel that long is two`);
if (fontsMissing.length) console.log(`fonts not on this machine or not loaded: ${fontsMissing.join(", ")} - the slides were drawn in the next font of the list. A web font needs its <link> or @font-face and the network; otherwise name a font that is here`);
for (const line of [...pageLines].slice(0, 8)) console.log(`page: ${line}`);
console.log(total ? `${total} finding(s): fix them in the HTML and render again` : "nothing measured wrong - now look at the sheet for what cannot be measured");
console.log(`next: read these in one read call, then write the round's list (SKILL.md step 4): ${[sheet, ...results.filter((r) => r.check).map((r) => r.check)].join(", ")}`);
process.exit(total ? 4 : 0);
