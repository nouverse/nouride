#!/usr/bin/env node
// Read a page its own scripts build, as Markdown - what web_fetch gets empty. Part of the browser-automation skill.
//
//   node read_page.mjs URL --browser-dir DIR [--wait-for TEXT] [--max N] [--out FILE] [--shot FILE]
//
// Opens the page in the headless browser from the browser folder (SKILL.md steps 1 and 2), lets it settle - and waits
// for --wait-for TEXT when the content comes late - then prints its title, its address and its main content as
// Markdown: headings, paragraphs, lists, tables, links. Pictures, scripts, buttons and, on a page without a <main>,
// its menus and footer are left out. Prints up to --max characters (default 20000); --out FILE writes all of it.
//
// A bot check in the way - "Just a moment", "Verify you are human", a CAPTCHA - is reported, never fought: exit 4,
// with a screenshot to show the person. Exit: 0 read; 1 wrong arguments; 2 the page did not load (its HTTP status or
// the error); 3 no Playwright or browser in --browser-dir; 4 a bot check.

import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

/**
 * A page's main content as Markdown. Runs inside the page (page.evaluate sends it as source, so it uses nothing from
 * outside itself) and in a test, on stand-in nodes: it reads only nodeType, tagName, childNodes, textContent and
 * getAttribute.
 */
export function pageToMarkdown({ root, base }) {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "TEMPLATE", "IFRAME", "OBJECT", "BUTTON", "INPUT",
    "SELECT", "OPTION", "TEXTAREA", "IMG", "PICTURE", "VIDEO", "AUDIO", "MAP"]);
  const CHROME = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "FIGURE", "FIGCAPTION", "DL", "DT",
    "DD", "ADDRESS", "DETAILS", "SUMMARY", "FORM", "FIELDSET", "LEGEND"]);
  if (!root) {
    const body = document.body;
    const main = document.querySelector("main, [role=main], article");
    const size = (el) => (el?.textContent || "").replace(/\s+/g, " ").length;
    // A <main> that holds most of the text is the content; a stub one (a cookie notice, an app shell) is not.
    root = main && size(main) >= 0.3 * size(body) ? main : body;
  }
  const chrome = root.tagName?.toUpperCase() === "BODY";
  const flat = (s) => String(s || "").replace(/\s+/g, " ");
  const tag = (n) => String(n.tagName || "").toUpperCase();
  const kids = (n) => Array.from(n.childNodes || []);
  const styled = typeof getComputedStyle === "function";
  const hidden = (el) => {
    if (el.getAttribute?.("hidden") != null || el.getAttribute?.("aria-hidden") === "true") return true;
    if (!styled) return false;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  };
  // A <span> the site's CSS shows as a block is a block: two of them side by side are two lines, not "thinking.by".
  const block = (el, t) => BLOCK.has(t) || (styled && /^(block|flex|grid|list-item|table)$/.test(getComputedStyle(el).display));
  const link = (href) => {
    try { return new URL(href, base).href; } catch { return href; }
  };
  const rows = (n, out = []) => {
    for (const c of kids(n)) {
      if (c.nodeType !== 1) continue;
      if (tag(c) === "TR") out.push(c);
      else if (["THEAD", "TBODY", "TFOOT"].includes(tag(c))) rows(c, out);
    }
    return out;
  };
  const list = (n, depth) => {
    const ordered = tag(n) === "OL";
    let i = 0;
    return "\n" + kids(n).filter((c) => c.nodeType === 1 && tag(c) === "LI" && !hidden(c)).map((li) => {
      const inner = kids(li).map((c) => (c.nodeType === 1 && ["UL", "OL"].includes(tag(c)) ? list(c, depth + 1) : md(c, depth))).join("");
      const [first, ...rest] = inner.replace(/\n{2,}/g, "\n").trim().split("\n");
      i += 1;
      return `${"  ".repeat(depth)}${ordered ? `${i}.` : "-"} ${flat(first).trim()}${rest.length ? "\n" + rest.join("\n") : ""}`;
    }).join("\n") + "\n";
  };
  const table = (n) => {
    const grid = rows(n).map((tr) => kids(tr).filter((c) => c.nodeType === 1 && ["TD", "TH"].includes(tag(c)))
      .map((cell) => flat(md(cell, 0)).trim().replace(/\|/g, "\\|")));
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (!width) return "";
    const line = (r) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? "").join(" | ")} |`;
    return `\n\n${line(grid[0])}\n| ${Array(width).fill("---").join(" | ")} |\n${grid.slice(1).map(line).join("\n")}\n\n`;
  };
  function md(n, depth) {
    if (n.nodeType === 3) return flat(n.textContent);
    if (n.nodeType !== 1) return "";
    const t = tag(n);
    if (SKIP.has(t) || hidden(n) || (chrome && CHROME.has(t))) return "";
    const inner = () => kids(n).map((c) => md(c, depth)).join("");
    if (/^H[1-6]$/.test(t)) return `\n\n${"#".repeat(Number(t[1]))} ${flat(inner()).trim()}\n\n`;
    switch (t) {
      case "BR": return "\n";
      case "HR": return "\n\n---\n\n";
      case "A": {
        const text = flat(inner()).trim();
        const href = n.getAttribute?.("href") || "";
        return !text || !href || href.startsWith("#") || /^javascript:/i.test(href) ? text : `[${text}](${link(href)})`;
      }
      case "STRONG": case "B": { const s = flat(inner()).trim(); return s ? `**${s}**` : ""; }
      case "EM": case "I": { const s = flat(inner()).trim(); return s ? `_${s}_` : ""; }
      case "CODE": return "`" + flat(n.textContent).trim() + "`";
      case "PRE": return "\n\n```\n" + String(n.textContent || "").replace(/\n+$/, "") + "\n```\n\n";
      case "UL": case "OL": return list(n, depth);
      case "TABLE": return table(n);
      case "BLOCKQUOTE": return "\n\n" + inner().trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
      default: return block(n, t) || t === "LI" ? `\n\n${inner()}\n\n` : inner();
    }
  }
  // A list item keeps its indent (that is its nesting); every other line is trimmed, and runs of spaces become one.
  const tidy = (l) => (/^\s*(?:[-|>]|\d+\.)\s/.test(l) ? l.match(/^ */)[0] : "") + l.trim().replace(/ {2,}/g, " ");
  return md(root, 0).split("\n").map(tidy).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A bot check rather than the page: what to say about it, or null. A page with real content and a small CAPTCHA on its
 * form is a page; a short one whose title or text asks to prove you are human is not. */
export function botWall({ title = "", text = "", frames = [] }) {
  const short = String(text).replace(/\s+/g, " ").length < 2000;
  if (/just a moment|attention required|verify you are human|are you a robot|checking your browser|access denied/i.test(title)) {
    return `the page's title is "${title}"`;
  }
  const frame = frames.find((u) => /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha|captcha/i.test(u));
  if (frame && short) return `a check in a frame from ${(() => { try { return new URL(frame).host; } catch { return frame; } })()}`;
  if (short && /verify you are human|are you a robot|enable javascript and cookies to continue|checking if the site connection is secure/i.test(text)) {
    return "the page asks to prove you are human";
  }
  return null;
}

function usage(msg, code = 1) {
  if (msg) console.error(`read_page.mjs: ${msg}`);
  console.error("usage: node read_page.mjs URL --browser-dir DIR [--wait-for TEXT] [--max N] [--out FILE] [--shot FILE]");
  process.exit(code);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return;
  }
  const opt = { url: null, browserDir: null, waitFor: null, max: 20000, out: null, shot: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--browser-dir") opt.browserDir = args[++i];
    else if (a === "--wait-for") opt.waitFor = args[++i];
    else if (a === "--max") opt.max = Number(args[++i]);
    else if (a === "--out") opt.out = args[++i];
    else if (a === "--shot") opt.shot = args[++i];
    else if (a.startsWith("--")) usage(`unknown option ${a}`);
    else if (!opt.url) opt.url = a;
    else usage(`one page at a time (got ${a} too)`);
  }
  if (!opt.url) usage("no URL given");
  if (!/^https?:\/\//i.test(opt.url)) usage(`${opt.url} is not an http(s) address`);
  if (!Number.isFinite(opt.max) || opt.max < 500) usage("--max takes a number of characters, 500 or more");

  // Playwright from the browser-automation folder, as slides' render.mjs finds it.
  let chromium;
  let launch = {};
  for (const base of [opt.browserDir && join(resolve(opt.browserDir), "package.json"), join(process.cwd(), "package.json")].filter(Boolean)) {
    try { chromium = createRequire(base)("playwright-core").chromium; break; } catch { /* next */ }
  }
  if (!chromium) {
    console.error("read_page.mjs: playwright-core not found. Set the browser up (SKILL.md steps 1 and 2) and pass its folder: --browser-dir <private>/browser");
    process.exit(3);
  }
  const cfg = opt.browserDir && join(resolve(opt.browserDir), ".playwright", "cli.config.json");
  if (cfg && existsSync(cfg)) {
    try { launch = JSON.parse(readFileSync(cfg, "utf8"))?.browser?.launchOptions ?? {}; } catch { /* the defaults */ }
  }
  let browser;
  try {
    browser = await chromium.launch({ ...launch, headless: true });
  } catch (e) {
    console.error(`read_page.mjs: the browser did not start: ${String(e.message).split("\n")[0]} - install it from the browser folder (SKILL.md step 2)`);
    process.exit(3);
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Pictures, video and fonts are not read: leaving them out makes a heavy page load in a fraction of the time.
    await context.route("**/*", (r) => (["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    const page = await context.newPage();
    let response;
    try {
      response = await page.goto(opt.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (e) {
      console.log(`the page did not load: ${String(e.message).split("\n")[0]}`);
      return 2;
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    if (opt.waitFor) {
      await page.getByText(opt.waitFor).first().waitFor({ timeout: 20_000 })
        .catch(() => console.log(`note: "${opt.waitFor}" did not appear within 20 s - reading what is there`));
    }
    const seen = await page.evaluate(() => ({
      title: document.title,
      text: document.body?.innerText ?? "",
      frames: Array.from(document.querySelectorAll("iframe")).map((f) => f.src).filter(Boolean),
    }));
    const wall = botWall(seen);
    if (wall || opt.shot) {
      const shot = resolve(opt.shot ?? join(tmpdir(), `read-page-${Date.now()}.png`));
      await page.screenshot({ path: shot }).catch(() => {});
      if (wall) {
        console.log(`a bot check is in the way (${wall}) at ${page.url()}: stop here and show the person ${shot} - do not try to get round it`);
        return 4;
      }
      console.log(`screenshot: ${shot}`);
    }
    const status = response?.status() ?? 0;
    if (status >= 400) {
      console.log(`the page answered HTTP ${status} ("${seen.title}") at ${page.url()}`);
      return 2;
    }
    const markdown = await page.evaluate(pageToMarkdown, { base: page.url() });
    const whole = `# ${seen.title || "(no title)"}\n${page.url()}\n\n${markdown}\n`;
    if (opt.out) {
      writeFileSync(opt.out, whole);
      console.log(`wrote ${resolve(opt.out)} (${whole.length} characters)`);
    }
    if (whole.length > opt.max) {
      console.log(whole.slice(0, opt.max));
      console.log(`[cut at ${opt.max} of ${whole.length} characters${opt.out ? `: all of it is in ${opt.out}` : " - --out FILE keeps all of it"}]`);
    } else {
      console.log(whole);
    }
  } finally {
    await browser.close();
  }
  return 0;
}

const isMain = (() => {
  try { return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url; } catch { return false; }
})();
if (isMain) process.exitCode = await main();
