/**
 * No Sign out in a session a device's token made. Nouride Home on the machine Nouride runs on signs itself
 * in with that token, so a Sign out there only flashed the sign-in page before the app traded the token again. The
 * dashboard tells such a session from the account's answer (`Principal.device`), never from the browser: a browser on
 * the same phone, signed in with a password, keeps its Sign out.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { answer, dom, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

/** The account's answer as the daemon gives it for a password's session, and the same account in a device's. */
const TYPED = WIRE["/auth/me"] as Record<string, unknown>;
const DEVICE = { ...TYPED, device: true };

const signOuts = () => [...dom.document.body.querySelectorAll('button[aria-label="Sign out"]')].length;
const named = (host: HTMLElement, words: string) => [...host.querySelectorAll("button")].filter((button) => (button.textContent ?? "").trim() === words).length;
const moreButton = () => ([...dom.document.body.querySelectorAll('nav[aria-label="Tabs"] button')] as unknown as HTMLElement[]).find((button) => (button.textContent ?? "").trim() === "More");

/** How many Sign out buttons each place draws, for the account answered with. */
async function seen(me: Record<string, unknown>) {
  const count = { menu: -1, folded: -1, sheet: -1, sheetRows: 0, account: -1 };
  answer({ "/auth/me": { status: 200, body: me } });
  await renderPage("/", async (host) => {
    await eventually(() => host.querySelector('button[aria-label^="Switch to the"]') !== null, 3_000, "the menu's foot");
    count.menu = signOuts();
  });
  await renderPage("/chat", async (host) => {
    await eventually(() => host.querySelector('button[aria-label="Expand the menu"]') !== null, 3_000, "the folded menu");
    count.folded = signOuts();
  });
  await renderPage("/account", async (host) => {
    await eventually(() => (host.textContent ?? "").includes("My Account"), 3_000, "the account's page");
    count.account = named(host, "Sign Out");
  });
  dom.happyDOM.setViewport({ width: 390, height: 844 });
  await renderPage("/", async () => {
    await eventually(() => moreButton() !== undefined, 3_000, "the tab bar");
    moreButton()!.click();
    const sheet = () => dom.document.body.querySelector("[data-sheet][data-open]");
    await eventually(() => sheet()?.querySelector('button[aria-label^="Switch to the"]') != null, 3_000, "More's sheet");
    count.sheet = signOuts();
    // The sheet's foot still holds who is signed in and the look: taking Sign out away leaves no empty row.
    count.sheetRows = sheet()!.querySelectorAll('button[aria-label^="Switch to the"]').length;
  });
  return count;
}

describe("Sign out, by the session", () => {
  useMountHarness();
  afterEach(() => dom.happyDOM.setViewport({ width: 1024, height: 768 }));

  test("a password's session has it in the menu, the folded menu, More's sheet and My Account", async () => {
    expect("device" in TYPED).toBe(false);
    expect(await seen(TYPED)).toEqual({ menu: 1, folded: 1, sheet: 1, sheetRows: 1, account: 1 });
  });

  test("a device's session has it nowhere, on a laptop and on a phone", async () => {
    expect(await seen(DEVICE)).toEqual({ menu: 0, folded: 0, sheet: 0, sheetRows: 1, account: 0 });
  });

  test("the browser's name decides nothing: a password's session inside Nouride Home keeps its Sign out", async () => {
    const before = Object.getOwnPropertyDescriptor(navigator, "userAgent");
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36 NourideHome/1", configurable: true });
    try {
      answer({ "/auth/me": { status: 200, body: TYPED } });
      let count = -1;
      await renderPage("/", async (host) => {
        await eventually(() => host.querySelector('button[aria-label^="Switch to the"]') !== null, 3_000, "the menu's foot");
        count = signOuts();
      });
      expect(count).toBe(1);
    } finally {
      if (before) Object.defineProperty(navigator, "userAgent", before);
      else delete (navigator as unknown as { userAgent?: string }).userAgent;
    }
  });
});
