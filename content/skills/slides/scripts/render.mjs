#!/usr/bin/env node
// render.mjs - render an HTML deck to a PDF and one PNG per slide, measure what can be measured on every slide, and
// print the findings. Part of the slides skill.
//
//   node render.mjs DECK.html --browser-dir DIR [--out DIR] [--only 2,5] [--no-pdf] [--chromium PATH]
//
// --browser-dir is the browser-automation skill's folder (the one holding node_modules/playwright-core and
// .playwright/cli.config.json); this script borrows its Playwright and its browser, so nothing is installed twice.
// --chromium PATH uses that browser instead of Playwright's own (a system Chromium, e.g. on Alpine).
//
// Writes into --out (default: a folder named after the deck, beside it):
//   deck.pdf            every slide, one page each, 1280x720
//   slide-01.png ...    each slide at 1280x720
//   check-03.png ...    a slide with findings, each outlined in red and numbered as in the list
//   sheet.png           every slide small, 4 to a row - the whole deck in one picture
//   notes.md            the speaker notes, slide by slide
//   check.json          the findings, for a program
// and prints, per slide: its title, its word count, and each finding. Exit 0 when nothing was found, 4 when something
// was (the files are written either way), 1 bad arguments, 2 the deck cannot be loaded, 3 Playwright or a browser missing.
//
// Measured on every slide:
//   overflow  text or a picture outside the slide, cut off by its own box (overflow hidden, text-overflow), or a
//             template area (.body, .cols, .panel, .figure) holding more than its height
//   margin    text within 32px of the slide's edge
//   crowded   body text in the bottom 44px, where the source line goes
//   small     text under 20px (14px for .source, .caption, .meta and footers)
//   overlap   text over other text, or over a picture (not over a full-slide background)
//   contrast  text against its background under 4.5:1 (3:1 for 30px+ or 24px+ bold)
//   words     more than 60 words on the slide, or more than 6 bullets in one list
//   alone     a heading whose last line holds one word
//   image     a picture that did not load
//   empty     nothing on the slide
// And once for the deck: which of the fonts the deck asks for are not on this machine (the next one in the list is used).

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const W = 1280, H = 720;

function usage(msg, code = 1) {
  if (msg) console.error(`render.mjs: ${msg}`);
  console.error("usage: node render.mjs DECK.html --browser-dir DIR [--out DIR] [--only 2,5] [--no-pdf] [--chromium PATH]");
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
const opt = { deck: null, out: null, browserDir: null, only: null, pdf: true, chromium: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out") opt.out = args[++i];
  else if (a === "--browser-dir") opt.browserDir = args[++i];
  else if (a === "--only") opt.only = new Set(String(args[++i]).split(",").map((n) => parseInt(n, 10)));
  else if (a === "--no-pdf") opt.pdf = false;
  else if (a === "--chromium") opt.chromium = args[++i];
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else if (!opt.deck) opt.deck = a;
  else usage(`one deck at a time (got ${a} too)`);
}
if (!opt.deck) usage("no deck given");
const deck = resolve(opt.deck);
if (!existsSync(deck)) usage(`no file at ${deck}`, 2);
const out = resolve(opt.out ?? join(dirname(deck), basename(deck).replace(/\.html?$/i, "") + "-render"));
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

const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message).split("\n")[0]));
page.on("requestfailed", (r) => pageErrors.push(`could not load ${r.url().replace(pathToFileURL(dirname(deck)).href + "/", "")}`));
try {
  await page.goto(pathToFileURL(deck).href, { waitUntil: "load", timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
} catch (e) {
  console.error(`render.mjs: the deck did not load: ${String(e.message).split("\n")[0]}`);
  await browser.close();
  process.exit(2);
}

// ------------------------------------------------------------------ measuring, inside the page
const results = await page.evaluate(({ W, H }) => {
  const SMALL_OK = ".source, .caption, .meta, footer, .footer, .who";
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;   // a gradient or picture: judged by eye
      const c = parse(s.backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const shown = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) < 0.15) return false;
    }
    return true;
  };
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const band = (b) => ({ x: b.x, y: b.y + b.h / 4, w: b.w, h: b.h / 2 });

  const slides = [...document.querySelectorAll("section.slide")];
  return slides.map((slide, idx) => {
    const o = slide.getBoundingClientRect();
    const rel = (r) => ({ x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height });
    const found = [];
    const add = (kind, what, box) => found.push({ kind, what, box });
    const title = (slide.querySelector("h1, h2")?.textContent ?? "").replace(/\s+/g, " ").trim();
    const lines = [];
    let words = 0;
    const range = document.createRange();
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || !el || el.closest(".notes") || !shown(el)) continue;
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1).map(rel);
      if (!rects.length) continue;
      const cs = getComputedStyle(el);
      const px = parseFloat(cs.fontSize);
      const short = text.slice(0, 50);
      if (!el.closest(SMALL_OK)) words += text.split(" ").length;
      for (const b of rects) lines.push({ el, box: b, text: short });
      const all = { x: Math.min(...rects.map((b) => b.x)), y: Math.min(...rects.map((b) => b.y)), w: 0, h: 0 };
      all.w = Math.max(...rects.map((b) => b.x + b.w)) - all.x; all.h = Math.max(...rects.map((b) => b.y + b.h)) - all.y;
      const min = el.closest(SMALL_OK) ? 14 : 20;
      if (px < min - 0.5) add("small", `${Math.round(px)}px text (under ${min}): "${short}"`, all);
      if (rects.some((b) => b.x < -1 || b.y < -1 || b.x + b.w > W + 1 || b.y + b.h > H + 1)) add("overflow", `text runs off the slide: "${short}"`, all);
      else if (!el.closest(SMALL_OK) && rects.some((b) => b.x < 32 || b.y < 32 || b.x + b.w > W - 32 || b.y + b.h > H - 32)) add("margin", `text within 32px of the edge: "${short}"`, all);
      // Cut off by an ancestor that hides its overflow.
      for (let a = el; a && a !== slide; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (/(hidden|clip|auto|scroll)/.test(s.overflow + s.overflowX + s.overflowY) && (a.scrollHeight > a.clientHeight + 2 || a.scrollWidth > a.clientWidth + 2)) {
          add("overflow", `text cut off inside its box (${a.scrollHeight - a.clientHeight}px too tall): "${short}"`, rel(a.getBoundingClientRect()));
          break;
        }
        if (s.textOverflow === "ellipsis" && a.scrollWidth > a.clientWidth + 1) { add("overflow", `text ends in "...": "${short}"`, rel(a.getBoundingClientRect())); break; }
      }
      const fg = parse(cs.color), bg = bgOf(el);
      if (fg && bg) {
        const r = ratio(fg, bg);
        const large = px >= 30 || (px >= 24 && parseInt(cs.fontWeight, 10) >= 700);
        if (r < (large ? 3 : 4.5)) add("contrast", `contrast ${r.toFixed(1)}:1 (needs ${large ? 3 : 4.5}): "${short}"`, all);
      }
      // A heading's last line holding one word.
      if (/^H[1-3]$/.test(el.tagName) && rects.length > 1) {
        const ws = [...node.textContent.matchAll(/\S+/g)].map((m) => { range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length); return { w: m[0], top: rel(range.getBoundingClientRect()).y }; });
        const last = Math.max(...ws.map((x) => x.top));
        const onLast = ws.filter((x) => Math.abs(x.top - last) < px / 2);
        if (onLast.length === 1) add("alone", `"${onLast[0].w}" alone on the last line of the heading`, all);
      }
    }
    // Overlap: two lines of different elements, or a line over a picture.
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (inter(band(a.box), band(b.box)) > 4) add("overlap", `"${a.text.slice(0, 30)}" over "${b.text.slice(0, 30)}"`, a.box);
    }
    const pics = [...slide.querySelectorAll("img, svg, canvas, video")].filter((p) => shown(p) && !p.closest(".notes"));
    for (const p of pics) {
      const box = rel(p.getBoundingClientRect());
      if (p.tagName === "IMG" && (!p.complete || p.naturalWidth === 0)) add("image", `picture did not load: ${p.getAttribute("src")}`, box);
      if (box.x < -1 || box.y < -1 || box.x + box.w > W + 1 || box.y + box.h > H + 1) add("overflow", `picture runs off the slide: ${p.getAttribute("src") ?? p.tagName}`, box);
      if (box.w >= W * 0.95 && box.h >= H * 0.95) continue;           // a background
      for (const l of lines) if (!p.contains(l.el) && inter(band(l.box), box) > 4) { add("overlap", `text over a picture: "${l.text.slice(0, 30)}"`, l.box); break; }
    }
    // An area holding more than it has room for: the template's .body, .cols, .panel and .figure are flex boxes that
    // let content run past their bottom without clipping it - into the source line, or off the slide.
    for (const area of slide.querySelectorAll(".body, .cols, .panel, .figure, .cols > div")) {
      if (area.scrollHeight > area.clientHeight + 2) add("overflow", `content ${area.scrollHeight - area.clientHeight}px taller than its area (.${[...area.classList].join(".") || area.tagName.toLowerCase()}) - cut words, split the slide, or drop a bullet`, rel(area.getBoundingClientRect()));
    }
    // Body text in the bottom band, where the source line sits.
    for (const l of lines) {
      if (!l.el.closest(SMALL_OK) && l.box.y + l.box.h > H - 44 && l.box.y + l.box.h <= H + 1) { add("crowded", `text reaches the bottom band kept for the source line: "${l.text.slice(0, 40)}"`, l.box); break; }
    }
    for (const list of slide.querySelectorAll("ul, ol")) {
      const n = list.querySelectorAll(":scope > li").length;
      if (n > 6) add("words", `${n} bullets in one list (6 at most; split the slide)`, rel(list.getBoundingClientRect()));
    }
    if (words > 60) add("words", `${words} words on the slide (60 at most; move the rest to the notes)`, { x: 0, y: 0, w: W, h: H });
    if (!lines.length && !pics.length) add("empty", "nothing on this slide", { x: 0, y: 0, w: W, h: H });
    const notes = (slide.querySelector(".notes")?.innerText ?? slide.querySelector(".notes")?.textContent ?? "").trim();
    // One finding per kind and text: the same line can trip a check on each of its line boxes.
    const seen = new Set();
    const unique = found.filter((f) => { const k = f.kind + f.what; if (seen.has(k)) return false; seen.add(k); return true; });
    return { n: idx + 1, title, words, notes, findings: unique };
  });
}, { W, H });

if (!results.length) {
  console.error('render.mjs: no <section class="slide"> in the deck - start from the slides skill\'s templates/deck.html');
  await browser.close();
  process.exit(2);
}

// Fonts the deck names that this machine does not have: a canvas measures the same text in "Font, generic" and in
// the generic alone - equal widths under three generics means the font is not there. document.fonts.check() cannot
// tell: it answers true for a font that is simply not installed.
const fonts = await page.evaluate(() => {
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "inherit", "initial"]);
  const asked = new Set();
  for (const el of document.querySelectorAll("section.slide *")) {
    for (const f of getComputedStyle(el).fontFamily.split(",")) { const n = f.trim().replace(/^["']|["']$/g, ""); if (n && !generic.has(n.toLowerCase())) asked.add(n); }
  }
  const ctx = document.createElement("canvas").getContext("2d");
  const sample = "mmmmmmmmmmlli1WQ@#Ag";
  const has = (fam) => ["monospace", "serif", "sans-serif"].some((g) => { ctx.font = `72px ${g}`; const w0 = ctx.measureText(sample).width; ctx.font = `72px "${fam}", ${g}`; return ctx.measureText(sample).width !== w0; });
  const first = getComputedStyle(document.querySelector("section.slide") ?? document.body).fontFamily.split(",").map((f) => f.trim().replace(/^["']|["']$/g, ""));
  return { missing: [...asked].filter((f) => !has(f)), used: first.find((f) => generic.has(f.toLowerCase()) || has(f)) ?? "a default" };
});

// ------------------------------------------------------------------ pictures
const pad = (n) => String(n).padStart(2, "0");
const handles = await page.$$("section.slide");
for (const r of results) {
  if (opt.only && !opt.only.has(r.n)) continue;
  const h = handles[r.n - 1];
  await h.scrollIntoViewIfNeeded();
  await h.screenshot({ path: join(out, `slide-${pad(r.n)}.png`) });
  if (r.findings.length) {
    await page.evaluate(({ i, findings }) => {
      const s = document.querySelectorAll("section.slide")[i];
      findings.forEach((f, k) => {
        const d = document.createElement("div");
        d.className = "__check";
        Object.assign(d.style, { position: "absolute", left: `${f.box.x - 3}px`, top: `${f.box.y - 3}px`, width: `${f.box.w + 6}px`, height: `${f.box.h + 6}px`, outline: "3px solid #FF1744", zIndex: 9999, pointerEvents: "none" });
        const tag = document.createElement("span");
        tag.textContent = String(k + 1);
        Object.assign(tag.style, { position: "absolute", left: "-3px", top: "-26px", background: "#FF1744", color: "#fff", font: "bold 18px sans-serif", padding: "1px 6px" });
        d.appendChild(tag);
        s.appendChild(d);
      });
    }, { i: r.n - 1, findings: r.findings });
    await h.screenshot({ path: join(out, `check-${pad(r.n)}.png`) });
    await page.evaluate(() => document.querySelectorAll(".__check").forEach((e) => e.remove()));
  }
}

// The PDF is printed, not screenshotted: a difference only print makes (a page break, a margin, a slide taller under
// @media print) puts one slide on two pages while every picture above looks right. So its pages are counted.
let pdfPages = null;
if (opt.pdf) {
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: join(out, "deck.pdf"), width: `${W}px`, height: `${H}px`, printBackground: true, preferCSSPageSize: true });
  await page.emulateMedia({ media: "screen" });
  pdfPages = (readFileSync(join(out, "deck.pdf")).toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

// Contact sheet: every slide small, built from the PNGs just written.
if (!opt.only) {
  const cols = 4, tw = 320, th = 180, gap = 8;
  const rows = Math.ceil(results.length / cols);
  const cells = results.map((r) => `<figure><img src="slide-${pad(r.n)}.png"><figcaption>${r.n}${r.findings.length ? ` · ${r.findings.length} finding(s)` : ""}</figcaption></figure>`).join("");
  const sheet = await browser.newPage({ viewport: { width: cols * (tw + gap) + gap, height: rows * (th + 30 + gap) + gap } });
  // Loaded from a file beside the PNGs: a page set from a string is about:blank and may not show file:// pictures.
  const sheetHtml = join(out, ".sheet.html");
  writeFileSync(sheetHtml, `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:${gap}px;background:#777;display:grid;grid-template-columns:repeat(${cols},${tw}px);gap:${gap}px;font:14px sans-serif}figure{margin:0}img{width:${tw}px;height:${th}px;display:block}figcaption{color:#fff;padding:4px 0}</style>${cells}`);
  await sheet.goto(pathToFileURL(sheetHtml).href, { waitUntil: "load" });
  await sheet.screenshot({ path: join(out, "sheet.png"), fullPage: true });
  await sheet.close();
  rmSync(sheetHtml, { force: true });
}
await browser.close();

writeFileSync(join(out, "notes.md"), results.map((r) => `## ${r.n}. ${r.title || "(no title)"}\n\n${r.notes || "(no notes)"}\n`).join("\n"));
writeFileSync(join(out, "check.json"), JSON.stringify(results.map(({ n, title, words, findings }) => ({ n, title, words, findings: findings.map(({ kind, what }) => ({ kind, what })) })), null, 1));

// ------------------------------------------------------------------ the report
let total = 0;
console.log(`${results.length} slide(s) from ${deck}`);
console.log(`wrote ${out}/: ${opt.pdf ? "deck.pdf, " : ""}slide-NN.png${opt.only ? "" : ", sheet.png"}, notes.md, check.json`);
for (const r of results) {
  if (opt.only && !opt.only.has(r.n)) continue;
  const head = `slide ${r.n} "${r.title.slice(0, 60) || "(no title)"}" - ${r.words} words${r.notes ? "" : ", no notes"}`;
  if (!r.findings.length) { console.log(`${head}: nothing measured wrong`); continue; }
  console.log(`${head}: ${r.findings.length} finding(s), outlined in check-${pad(r.n)}.png`);
  r.findings.forEach((f, k) => console.log(`  ${k + 1}. ${f.kind}: ${f.what}`));
  total += r.findings.length;
}
if (pdfPages !== null && pdfPages !== results.length) {
  console.log(`pdf: deck.pdf has ${pdfPages} pages for ${results.length} slides - in print a slide runs onto another page (a page break, a margin, a style under @media print). Find it: pdftoppm -png -r 30 ${join(out, "deck.pdf")} ${join(out, "pdf-page")}, read the pages, fix the deck`);
  total += 1;
}
if (fonts.missing.length) console.log(`fonts not on this machine: ${fonts.missing.join(", ")} - the slides use ${fonts.used}. Fine if that is what you saw in the pictures; otherwise name an installed font first in --font`);
for (const e of [...new Set(pageErrors)].slice(0, 8)) console.log(`page: ${e}`);
console.log(total ? `${total} finding(s): fix them in the deck and render again` : "nothing measured wrong - now look at the pictures for what cannot be measured");
// Named one by one: in a live test a small model read only the contact sheet, where 28px text is 7px and nothing can
// be judged.
const shown = results.filter((r) => !opt.only || opt.only.has(r.n));
console.log(`next: read ${opt.only ? "" : join(out, "sheet.png") + " and "}every slide at full size, in one read call: ${shown.map((r) => join(out, `slide-${pad(r.n)}.png`)).join(", ")}` +
  `${shown.some((r) => r.findings.length) ? " (and the check-NN.png beside each slide with findings)" : ""} - then write the round's list (SKILL.md step 5)`);
process.exit(total ? 4 : 0);
