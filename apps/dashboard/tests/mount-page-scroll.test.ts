/**
 * How a page scrolls: as a page. Lists used to scroll inside a card inside a page held to the window, with rows cut at
 * an edge nobody could see and a band kept clear under them; only Chat, Logs, Files and the Workspace keep a list that
 * scrolls inside the window. What a person reaches for halfway down a page (its tabs, its filter, its search) is one
 * row that stays at the top of the window.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
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

  // Explore's search sat in its card and scrolled away with the first results; a list's search in the head of its
  // card left the same way. Wherever a page has a search, it is in the row that stays, and there once.
  test("a page's search is in the row that stays, wherever on the page its part is written", async () => {
    const search = async (path: string, label: string, tab?: string) => {
      let found = { inRow: false, drawn: 0, sticky: false };
      await renderPage(path, async (host) => {
        if (tab) {
          await eventually(() => [...host.querySelectorAll('[role="tab"]')].some((entry) => entry.textContent?.includes(tab)), 3_000, `${path}: its tabs`);
          ([...host.querySelectorAll('[role="tab"]')].find((entry) => entry.textContent?.includes(tab)) as HTMLElement).click();
        }
        await eventually(() => host.querySelector(`input[aria-label="${label}"]`) !== null, 3_000, `${path}: "${label}"`);
        const row = host.querySelector("[data-sticky-bar]");
        found = {
          inRow: row?.querySelector(`input[aria-label="${label}"]`) != null,
          drawn: host.querySelectorAll(`input[aria-label="${label}"]`).length,
          sticky: (row?.getAttribute("class") ?? "").split(/\s+/).includes("sticky"),
        };
      });
      return found;
    };
    const there = { inRow: true, drawn: 1, sticky: true };
    expect(await search("/skills", "Search skills", "Explore")).toEqual(there);
    expect(await search("/mcp", "Search the catalog", "Explore")).toEqual(there);
    expect(await search("/memories", "Search your documents")).toEqual(there);
    // An agent with skills to filter: its filter is in the agent's own row of tabs.
    const skill = { name: "pdf", description: "Read a PDF.", scope: "shared", path: "/skills/pdf", requires: [], missing: [], enabled: true, decided: false, toggleable: true };
    answer({ "/agents/nouva/skills": { status: 200, body: { skills: [skill, { ...skill, name: "docx", path: "/skills/docx" }], editable: true } } });
    expect(await search("/agents/nouva/skills", "Filter skills")).toEqual(there);
    answer({});
    expect(await search("/secrets", "Search secrets")).toEqual(there);
    expect(await search("/automations", "Find an automation")).toEqual(there);
    expect(await search("/settings", "Find a setting")).toEqual(there);
  });

  // The results were a box that scrolled inside the card, from when the page was held to the window. The page scrolls
  // as a page now, so the box no longer scrolled and still kept the wheel: with the pointer over the list nothing moved.
  test("Connectors' Explore: the results are part of the page, not a box that keeps the wheel", async () => {
    let results = "";
    const html = await renderPage("/mcp", async (host) => {
      ([...host.querySelectorAll('[role="tab"]')].find((entry) => entry.textContent?.includes("Explore")) as HTMLElement).click();
      await eventually(() => host.querySelector("[data-catalog-results]") !== null, 3_000, "the results");
      results = host.querySelector("[data-catalog-results]")!.getAttribute("class") ?? "";
    });
    expect(results).not.toMatch(/overflow|overscroll/);
    expect(html).not.toContain("overscroll-contain");
  });

  // It was the last thing on the page, under a list as long as the secrets are many: whether the backups hold the
  // secrets at all was a scroll nobody made.
  test("Secrets: the backup password is above the list, with what is needed and not set", async () => {
    const html = await renderPage("/secrets", async (host) => {
      await eventually(() => (host.textContent ?? "").includes("Your secrets") && (host.textContent ?? "").includes("Backup password"), 3_000, "the page");
    });
    const at = (words: string) => html.indexOf(words);
    expect(at("Backup password")).toBeGreaterThan(-1);
    expect(at("Backup password")).toBeLessThan(at("Your secrets"));
    expect(at("Backup password")).toBeLessThan(at('aria-label="Search secrets"'));
    // Once on the page.
    expect(html.split(">Backup password<").length - 1).toBe(1);
  });

  // Asked on its button, as Skills' Explore is: a request a letter was what this page once spent.
  test("Connectors' Explore: words typed are not a search, Search asks them, and Search with none is the list again", async () => {
    const said: string[] = [];
    await renderPage("/mcp", async (host) => {
      ([...host.querySelectorAll('[role="tab"]')].find((entry) => entry.textContent?.includes("Explore")) as HTMLElement).click();
      await eventually(() => host.querySelector('input[aria-label="Search the catalog"]') !== null, 3_000, "the search");
      const input = () => host.querySelector('input[aria-label="Search the catalog"]') as HTMLInputElement;
      const label = () => host.querySelector("[data-catalog-results] p")?.textContent ?? "";
      const type = (text: string) => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input()), "value")!.set!.call(input(), text);
        input().dispatchEvent(new (input().ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
      };
      const search = () => (host.querySelector('[data-sticky-bar] button[type="submit"]') as HTMLButtonElement).click();
      said.push(label());
      type("github");
      await eventually(() => input().value === "github", 2_000, "the words typed");
      said.push(label());
      search();
      await eventually(() => label().includes("github"), 2_000, "the search asked");
      said.push(label());
      type("");
      await eventually(() => input().value === "", 2_000, "the words cleared");
      said.push(label());
      search();
      await eventually(() => label() === "Nouverse's picks", 2_000, "the list again");
      said.push(label());
    });
    expect(said).toEqual(["Nouverse's picks", "Nouverse's picks", "Matching “github”", "Matching “github”", "Nouverse's picks"]);
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
