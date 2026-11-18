#!/usr/bin/env node
// picture.mjs - render a diagram written as an HTML page to one PNG, measure what makes it hard to read, and print
// the findings. Part of the diagrams skill, for a machine where a browser is already set up.
//
//   node picture.mjs PAGE.html --browser-dir DIR [--out FILE.png] [--width 1200] [--chromium PATH]
//
// --browser-dir is the browser-automation skill's folder (the one holding node_modules/playwright-core and
// .playwright/cli.config.json); this script borrows its Playwright and its browser, so nothing is installed here.
// --chromium PATH uses that browser instead (a system Chromium, e.g. on Alpine).
//
// The page is laid out at --width (1200) and the picture is its `#picture` element, or its <body> where it has none,
// at twice that size so it stays sharp when a chat shrinks it. Writes FILE.png (default: beside the page, its name
// with .png) and, where something was found, FILE-check.png with each finding outlined in red and numbered.
//
// Measured:
//   cut       text cut off by its own box (overflow hidden, an ellipsis)
//   outside   an element that reaches past the picture's edge
//   overlap   text over other text
//   small     text under 14px
//   typed     an arrow typed as a character: blank on a machine whose font has no such glyph
//   contrast  text against its background under 4.5:1 (3:1 for 24px and up)
//   thin      a picture more than five times as wide as it is tall, or as tall as it is wide: it shrinks to nothing
//             on a phone (the same rule the Graphviz helper holds its own pictures to)
// Exit 0 when nothing was found, 4 when something was (the PNG is written either way), 1 bad arguments, 2 the page
// cannot be loaded, 3 Playwright or a browser missing.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function usage(why, code = 1) {
  console.error(`picture.mjs: ${why}`);
  console.error("usage: node picture.mjs PAGE.html --browser-dir DIR [--out FILE.png] [--width 1200] [--chromium PATH]");
  process.exit(code);
}

const opt = { width: 1200 };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--browser-dir") opt.browserDir = args[++i];
  else if (a === "--out") opt.out = args[++i];
  else if (a === "--width") opt.width = parseInt(args[++i], 10);
  else if (a === "--chromium") opt.chromium = args[++i];
  else if (a.startsWith("--")) usage(`unknown option ${a}`);
  else if (!opt.page) opt.page = a;
  else usage(`one page at a time (got ${a} too)`);
}
if (!opt.page) usage("no page given");
if (!Number.isInteger(opt.width) || opt.width < 320 || opt.width > 2400) usage("--width is a whole number of pixels, 320 to 2400");
const source = resolve(opt.page);
if (!existsSync(source)) usage(`no file at ${source}`, 2);
const out = resolve(opt.out ?? join(dirname(source), basename(source).replace(/\.html?$/i, "") + ".png"));

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
    console.error("picture.mjs: no browser is set up here (playwright-core not found). Draw it with Graphviz instead: this skill's steps 2 to 5. Do not set a browser up for a diagram.");
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
  console.error(`picture.mjs: the browser did not start: ${String(e.message).split("\n")[0]}`);
  console.error("Draw it with Graphviz instead: this skill's steps 2 to 5.");
  process.exit(3);
}

const page = await browser.newPage({ viewport: { width: opt.width, height: 800 }, deviceScaleFactor: 2 });
const failed = [];
page.on("pageerror", (e) => failed.push(String(e.message).split("\n")[0]));
page.on("requestfailed", (r) => failed.push(`could not load ${r.url().replace(pathToFileURL(dirname(source)).href + "/", "")}`));
try {
  await page.goto(pathToFileURL(source).href, { waitUntil: "load", timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
} catch (e) {
  console.error(`picture.mjs: the page did not load: ${String(e.message).split("\n")[0]}`);
  await browser.close();
  process.exit(2);
}

// What can be measured, in the page: each finding with the box to outline.
const measured = await page.evaluate(() => {
  const root = document.querySelector("#picture") ?? document.body;
  const frame = root.getBoundingClientRect();
  const findings = [];
  const say = (kind, what, el) => {
    const r = el.getBoundingClientRect();
    findings.push({ kind, what, box: { x: r.x, y: r.y, w: r.width, h: r.height } });
  };
  const words = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
  const shown = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
  };
  // An element that holds text of its own, not only through its children.
  const texts = [...root.querySelectorAll("*")].filter((el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0));

  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (color) => {
    const m = /rgba?\(([^)]+)\)/.exec(color);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { rgb: p.slice(0, 3), alpha: p.length > 3 ? p[3] : 1 };
  };
  // The first background behind an element that is not see-through; white where none is (the page's own).
  const behind = (el) => {
    for (let at = el; at; at = at.parentElement) {
      const s = getComputedStyle(at);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const bg = parse(s.backgroundColor);
      if (bg && bg.alpha > 0.5) return bg.rgb;
    }
    return [255, 255, 255];
  };

  for (const el of texts) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const size = parseFloat(s.fontSize);
    if (el.scrollWidth > el.clientWidth + 1 && (s.overflowX !== "visible" || s.textOverflow === "ellipsis")) say("cut", `"${words(el)}" is cut off by its own box`, el);
    else if (el.scrollHeight > el.clientHeight + 1 && s.overflowY !== "visible") say("cut", `"${words(el)}" is cut off by its own box`, el);
    if (r.right > frame.right + 1 || r.left < frame.left - 1 || r.bottom > frame.bottom + 1 || r.top < frame.top - 1) say("outside", `"${words(el)}" reaches past the picture's edge`, el);
    if (size < 14) say("small", `"${words(el)}" is ${Math.round(size)}px: under 14`, el);
    if (/[\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f\u25b6-\u25c5]/.test(el.textContent ?? "")) say("typed", `"${words(el)}" holds an arrow typed as a character, which is blank where the font has none: draw it (a line with a CSS triangle, or a small inline svg)`, el);
    const fg = parse(s.color);
    const bg = behind(el);
    if (fg && bg) {
      const [hi, lo] = [luminance(fg.rgb), luminance(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const need = size >= 24 ? 3 : 4.5;
      if (ratio < need) say("contrast", `"${words(el)}" is ${ratio.toFixed(1)}:1 against its background: under ${need}:1`, el);
    }
  }
  // Text over other text: two boxes of text that neither holds the other, sharing more than a sliver.
  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      if (texts[a].contains(texts[b]) || texts[b].contains(texts[a])) continue;
      const p = texts[a].getBoundingClientRect();
      const q = texts[b].getBoundingClientRect();
      const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (w > 4 && h > 4) say("overlap", `"${words(texts[a])}" is over "${words(texts[b])}"`, texts[b]);
    }
  }
  const shape = frame.width / Math.max(1, frame.height);
  if (shape > 5) findings.push({ kind: "thin", what: `the picture is ${shape.toFixed(1)} times as wide as it is tall: on a phone it shrinks to nothing. Stack it in rows`, box: null });
  if (shape < 1 / 5) findings.push({ kind: "thin", what: `the picture is ${(1 / shape).toFixed(1)} times as tall as it is wide: split it in two`, box: null });
  return { frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height }, findings, parts: texts.length };
});

const clip = { x: Math.max(0, measured.frame.x), y: Math.max(0, measured.frame.y), width: Math.max(1, measured.frame.w), height: Math.max(1, measured.frame.h) };
await page.setViewportSize({ width: opt.width, height: Math.ceil(clip.y + clip.height) + 1 });
await page.screenshot({ path: out, clip, type: "png" });

const findings = [...failed.map((what) => ({ kind: "page", what, box: null })), ...measured.findings];
if (findings.length > 0) {
  // The same picture with each finding outlined and numbered, for the one who fixes it.
  await page.evaluate((list) => {
    list.forEach((finding, at) => {
      if (!finding.box) return;
      const mark = document.createElement("div");
      mark.style.cssText = `position:absolute;left:${finding.box.x + scrollX - 2}px;top:${finding.box.y + scrollY - 2}px;width:${finding.box.w}px;height:${finding.box.h}px;border:2px solid #e11d48;z-index:2147483647;pointer-events:none`;
      const tag = document.createElement("span");
      tag.textContent = String(at + 1);
      tag.style.cssText = "position:absolute;left:-2px;top:-18px;background:#e11d48;color:#fff;font:700 12px/16px system-ui,sans-serif;padding:0 5px;border-radius:3px";
      mark.appendChild(tag);
      document.body.appendChild(mark);
    });
  }, findings);
  await page.screenshot({ path: out.replace(/\.png$/i, "-check.png"), clip, type: "png" });
}
await browser.close();

console.log(`${out}  ${Math.round(clip.width)}x${Math.round(clip.height)} (written at twice that), ${measured.parts} texts`);
if (findings.length === 0) {
  console.log("nothing found. Now read the PNG and look: a picture that measures clean can still read badly.");
  process.exit(0);
}
console.log(`${findings.length} finding(s), outlined in ${basename(out).replace(/\.png$/i, "-check.png")}:`);
findings.forEach((finding, at) => console.log(`  ${at + 1}. ${finding.kind}: ${finding.what}`));
process.exit(4);
