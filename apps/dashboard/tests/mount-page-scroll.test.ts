/**
 * How a page scrolls: as a page. Lists used to scroll inside a card inside a page held to the window, with rows cut at
 * an edge nobody could see and a band kept clear under them; only Chat, Logs, Files and the Workspace keep a list that
 * scrolls inside the window. What a person reaches for halfway down a page (its tabs, its filter, its search) is one
 * row that stays at the top of the window.
 */

import { describe, expect, test } from "bun:test";
import { renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

describe("how a page scrolls", () => {
  // A list scrolling inside a card inside a page was two things to scroll, with rows cut at an edge nobody could see
  // and a band kept clear under it. Only where the page is one thing to read down (a file, a folder) is it kept.
  test("a page scrolls as a page: only Files and the Workspace keep a list that scrolls inside the window", async () => {
    const HELD = "mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-2 sm:px-6 sm:pt-4 lg:h-full lg:p-8";
    for (const path of ["/agents", "/skills", "/mcp", "/people", "/groups", "/missions", "/jobs", "/models", "/users", "/access", "/memories"]) {
      const html = await renderPage(path);
      expect({ path, held: html.includes(HELD), inner: /lg:overflow-y-auto/.test(html) }).toEqual({ path, held: false, inner: false });
    }
    for (const path of ["/files", "/workspace"]) expect({ path, held: (await renderPage(path)).includes(HELD) }).toEqual({ path, held: true });
  });

  test("a page's tabs, its filter and its search are one row that stays at the top of the window", async () => {
    const bar = async (path: string) => {
      let found = { tabs: false, search: false, sticky: false };
      await renderPage(path, async (host) => {
        await eventually(() => host.querySelector("[data-sticky-bar]") !== null, 3_000, `${path}: the row`);
        const row = host.querySelector("[data-sticky-bar]")!;
        found = { tabs: row.querySelector('[role="tablist"]') !== null, search: row.querySelector('input[type="search"]') !== null, sticky: (row.getAttribute("class") ?? "").split(/\s+/).includes("sticky") };
      });
      return found;
    };
    expect(await bar("/missions")).toEqual({ tabs: true, search: true, sticky: true });
    expect(await bar("/jobs")).toMatchObject({ tabs: true, sticky: true });
    expect(await bar("/access")).toEqual({ tabs: true, search: true, sticky: true });
    expect(await bar("/models")).toMatchObject({ tabs: true, sticky: true });
    expect(await bar("/mcp")).toMatchObject({ tabs: true, sticky: true });
    expect(await bar("/memories")).toMatchObject({ tabs: true, sticky: true });
    expect(await bar("/agents")).toMatchObject({ tabs: true, sticky: true });
    // An agent's own tabs stay too: the row is the page's, not the header's it used to leave with.
    expect(await bar("/agents/nouva/model")).toMatchObject({ sticky: true });
  });

  test("Memory: Agent notes, Proposals and Timeline are lists as long as they are, under tabs that stay", async () => {
    for (const tab of ["Agent notes", "Proposals", "Timeline"]) {
      const html = await renderPage("/memories", async (host) => {
        ([...host.querySelectorAll('[role="tab"]')].find((entry) => entry.textContent?.includes(tab)) as HTMLElement).click();
        await eventually(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes(tab) === true, 2_000, `${tab} to be chosen`);
        // The tabs are in the row that stays at the top of the window.
        expect(host.querySelector('[data-sticky-bar] [role="tablist"]')).not.toBeNull();
      });
      expect(html).not.toMatch(/max-h-\[32rem\] overflow-y-auto/);
    }
  });
});
