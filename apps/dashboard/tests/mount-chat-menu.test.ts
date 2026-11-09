/**
 * The side menu on Chats: folded to its icons there, from a laptop's width up, so the list and the conversation fit;
 * every other page keeps its names; Expand is kept in this browser, so Chats opens the way it was left.
 */

import { describe, expect, test } from "bun:test";
import { dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const KEPT = "nouride-chat-menu-open";
const folded = (host: HTMLElement) => host.querySelector('button[aria-label="Expand the menu"]');

describe("the side menu on Chats", () => {
  test("folds to its icons on Chats, keeps every page's names elsewhere, and Expand is kept in this browser", async () => {
    const seen: Record<string, unknown> = {};
    try {
      await renderPage("/chat", async (host) => {
        await eventually(() => folded(host) !== null, 3_000, "the folded menu");
        seen.chats = true;
        (folded(host) as HTMLElement).click();
        await eventually(() => folded(host) === null, 2_000, "expanded");
        seen.kept = dom.localStorage.getItem(KEPT);
      });
      seen.again = (await renderPage("/chat")).includes('aria-label="Expand the menu"');
      seen.agents = (await renderPage("/agents")).includes('aria-label="Expand the menu"');
      dom.localStorage.removeItem(KEPT);
      seen.agentsFolded = (await renderPage("/agents")).includes('aria-label="Expand the menu"');
    } finally {
      dom.localStorage.removeItem(KEPT);
    }
    expect(seen.chats).toBe(true);
    expect(seen.kept).toBe("true");
    // Expanded once, Chats opens expanded; another page never folds.
    expect(seen.again).toBe(false);
    expect(seen.agents).toBe(false);
    expect(seen.agentsFolded).toBe(false);
  });

  test("folded, every page of the menu is still a link, named for whoever cannot see its icon", async () => {
    let names: string[] = [];
    await renderPage("/chat", async (host) => {
      await eventually(() => folded(host) !== null, 3_000, "the folded menu");
      const nav = folded(host)!.closest("div.flex.h-full")?.querySelector('nav[aria-label="Menu"]');
      names = [...(nav?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("aria-label") ?? "");
    });
    expect(names).toEqual(expect.arrayContaining(["Home", "Chats", "Work", "Agents", "Skills", "Memory", "Settings"]));
  });
});
