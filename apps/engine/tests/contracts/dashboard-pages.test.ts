/**
 * The dashboard's pages as an agent is told them (`modules/web/dashboard-pages.ts`) are the dashboard's own: every page
 * of its menu, by the name the menu gives it, and each one a route the dashboard has.
 *
 * Two lists of one thing, in two apps. Without this, a page added to the menu is one no agent can send a person to, and
 * a page renamed or moved is one an agent still links by its old address: a link in an answer that opens "not found".
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_PAGES, DASHBOARD_PAGES_OF_ONE, pagesNote } from "@/modules/web/dashboard-pages.ts";

const DASHBOARD = join(import.meta.dir, "..", "..", "..", "dashboard", "src");
const read = (...path: string[]) => readFileSync(join(DASHBOARD, ...path), "utf8");

/** A menu's items as its file writes them: `{ to: "/skills", label: "Skills"`. */
const itemsOf = (source: string): [path: string, name: string][] => [...source.matchAll(/\{ to: "([^"]+)", label: "([^"]+)"/g)].map((item) => [item[1]!, item[2]!]);

/** Not on every install (a paired Box, a build that carries the gateway): a link to one that is not there opens nothing. */
const NOT_EVERYWHERE = ["/box", "/llm-gateway"];

/** The menu, the Settings page's own list, and over them a section's tabs: a section's page goes by its tab's name. */
const menu = new Map([
  ...itemsOf(read("commons", "components", "layout", "nav.tsx")),
  ...itemsOf(read("modules", "settings", "index.page.tsx")),
  ...itemsOf(read("commons", "components", "layout", "SectionTabs.tsx")),
]);

/** The dashboard's routes, from its route files: `memories_.graph.tsx` is `/memories/graph`, `chat.index.tsx` is `/chat`. */
const routes = new Set(
  readdirSync(join(DASHBOARD, "routes"))
    .filter((file) => file.endsWith(".tsx") && !file.startsWith("__"))
    .map((file) => `/${file.replace(/\.tsx$/, "").split(".").map((part) => part.replace(/_$/, "")).filter((part) => part !== "index").join("/")}`),
);

describe("the pages an agent is told", () => {
  test("the menu is read: its files still write their items the way this reads them", () => {
    expect(menu.size).toBeGreaterThan(20);
    expect(menu.get("/work")).toBe("Waiting for you");
    expect(menu.get("/skills")).toBe("Skills");
    expect(menu.get("/update")).toBe("Update");
    expect(routes.has("/memories/graph")).toBe(true);
    expect(routes.has("/")).toBe(true);
  });

  test("every page of the menu is told, by the menu's name for it", () => {
    const told = new Map(DASHBOARD_PAGES.map(([name, path]) => [path, name]));
    for (const [path, name] of menu) {
      if (NOT_EVERYWHERE.includes(path)) continue;
      expect(told.get(path), `${path}, "${name}" in the menu`).toBe(name);
    }
    for (const path of NOT_EVERYWHERE) expect(told.has(path), path).toBe(false);
  });

  test("every page told is a page the dashboard has, and told once", () => {
    for (const [name, path] of DASHBOARD_PAGES) expect(routes.has(path), `${name} at ${path}`).toBe(true);
    expect(new Set(DASHBOARD_PAGES.map(([, path]) => path)).size).toBe(DASHBOARD_PAGES.length);
    // One thing's page: its id goes under the path, as the route takes it.
    for (const [what, under] of DASHBOARD_PAGES_OF_ONE) {
      expect([...routes].some((route) => route.startsWith(`${under}/$`) && !route.slice(under.length + 1).includes("/")), `one ${what} under ${under}`).toBe(true);
    }
  });

  test("the note says each page's path, how a link is written, and to link no other page", () => {
    const note = pagesNote();
    expect(note).toStartWith("(The dashboard's pages, each under /dashboard: Home /, Chats /chat,");
    for (const [name, path] of DASHBOARD_PAGES) expect(note).toContain(`${name} ${path}`);
    expect(note).toContain("one agent at /agents/<its id>, one automation at /automations/<its id>, one mission at /missions/<its id>.");
    expect(note).toContain("write a link they can click, as [Automations](/dashboard/automations)");
    expect(note).toContain("only to a page listed here or the one they have open");
    // One line, closed as it was opened: it is read as a note, and what follows it is the page that is open.
    expect(note).not.toContain("\n");
    expect(note).toEndWith(".)");
  });
});
