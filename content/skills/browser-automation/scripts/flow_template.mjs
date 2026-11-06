// A flow that works, as a script that runs again without a model. Part of the browser-automation skill (step 7).
//
// Copy it into <private>/browser/scripts/<name>.mjs, fill in steps(), and run it from that folder:
//   cd <private>/browser && node scripts/<name>.mjs
// It prints one line - JSON for a program to read, a sentence for a person - and nothing else, so a scheduled run
// sends just that. When a step fails it keeps what the page looked like in runs/<name>-<time>/: a screenshot, the
// page's HTML and its own errors. A site changes; the next look then starts from what the script saw, not a guess.

import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = basename(fileURLToPath(import.meta.url), ".mjs");
const LOGIN = "state/site.json";      // a login kept with `state-save state/site.json`; ignored while it is not there
const TIMEOUT = 30_000;               // every wait ends: a step that waits longer is a step that failed

async function steps(page) {
  // Locators by role, label, text or test id - never a ref (e13) or an id the site generates (#ember123).
  // Wait for what means "done", never for a number of seconds.
  await page.goto("https://example.com/item/42", { waitUntil: "domcontentloaded" });
  const price = page.getByTestId("price");
  await price.waitFor();
  // A frame:      page.locator('iframe[title="Payment"]').contentFrame().getByRole("textbox", { name: "Card number" })
  // A new tab:    const tab = page.waitForEvent("popup"); await link.click(); const popup = await tab;
  // A download:   const dl = page.waitForEvent("download"); await button.click(); await (await dl).saveAs(`downloads/${(await dl).suggestedFilename()}`);
  // A secret:     process.env.SHOP_PASS - filled, never printed
  return { price: (await price.textContent())?.trim() };
}

const config = ".playwright/cli.config.json";
const launch = existsSync(config) ? JSON.parse(readFileSync(config, "utf8"))?.browser?.launchOptions ?? {} : {};
const browser = await chromium.launch({ ...launch, headless: true });
const context = await browser.newContext(existsSync(LOGIN) ? { storageState: LOGIN } : {});
context.setDefaultTimeout(TIMEOUT);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message).split("\n")[0]));
try {
  console.log(JSON.stringify(await steps(page)));
} catch (e) {
  const dir = `runs/${NAME}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/page.png`, fullPage: true }).catch(() => {});
  writeFileSync(`${dir}/page.html`, await page.content().catch(() => ""));
  writeFileSync(`${dir}/errors.txt`, [String(e.message), ...pageErrors].join("\n"));
  console.log(`${NAME} failed at ${page.url()}: ${String(e.message).split("\n")[0]} - what it saw is in ${dir}/`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
