/**
 * A table on a phone, by one rule written once (`FOLD`): Groups, People, Users, the audit log and Home's use by route.
 * Four of them folded their columns into the row below a phone's width, each with its own copy of the classes; Home's
 * five columns only scrolled sideways in their box. A table in an agent's reply is not one of them: its columns are the
 * agent's, and it scrolls.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FOLD } from "@/commons/components/ui/fold-table";
import { UsageRoutes } from "@/modules/home/components/UsageRoutes";

const SRC = join(dirname(import.meta.path), "..", "src");
const RULE = join("commons", "components", "ui", "fold-table.ts");
/** An agent's reply: its own table, which scrolls (`Markdown.tsx`). */
const REPLY = join("commons", "components", "ui", "Markdown.tsx");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

describe("the rule", () => {
  test("below a phone's width: no header, each row a block of lines, a whole cell a line of its own, the names said", () => {
    expect(FOLD.table.split(" ")).toEqual(expect.arrayContaining(["table", "max-sm:block"]));
    expect(FOLD.head.split(" ")).toContain("max-sm:hidden");
    expect(FOLD.body.split(" ")).toContain("max-sm:block");
    expect(FOLD.row.split(" ")).toEqual(expect.arrayContaining(["max-sm:flex", "max-sm:flex-wrap"]));
    expect(FOLD.whole.split(" ")).toEqual(expect.arrayContaining(["max-sm:basis-full", "max-sm:min-w-0"]));
    expect(FOLD.cell.split(" ")).not.toContain("max-sm:basis-full");
    expect(FOLD.label.split(" ")).toContain("sm:hidden");
  });

  test("every table of the dashboard's own is drawn by it, and none folds another way", () => {
    const tables = sources(SRC).filter((path) => readFileSync(path, "utf8").includes("<table") && relative(SRC, path) !== REPLY);
    expect(tables.map((path) => relative(SRC, path)).sort()).toEqual([
      "modules/groups/index.page.tsx",
      "modules/home/components/UsageRoutes.tsx",
      "modules/logs/components/AuditLog.tsx",
      "modules/people/index.page.tsx",
      "modules/users/index.page.tsx",
    ]);
    for (const path of tables) {
      const text = readFileSync(path, "utf8");
      expect({ path: relative(SRC, path), drawn: /<table className=\{cn\(FOLD\.table/.test(text), head: /<thead className=\{[^}]*FOLD\.head/.test(text), body: /<tbody className=\{[^}]*FOLD\.body/.test(text), row: /<tr[^>]*FOLD\.row/.test(text) }).toEqual({ path: relative(SRC, path), drawn: true, head: true, body: true, row: true });
    }
    // The folding of a table written by hand: `sm:table-cell` and its kin, or a table made a block below a phone's width.
    const elsewhere = sources(SRC)
      .filter((path) => relative(SRC, path) !== RULE)
      .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/\bsm:table(-[a-z-]+)?\b|<t(able|body|r)[^>]*className="[^"]*max-sm:(block|flex)/g)].map((m) => `${relative(SRC, path)}: ${m[0]}`));
    expect(elsewhere).toEqual([]);
  });
});

describe("Home's use by route, on a phone", () => {
  const html = renderToStaticMarkup(
    createElement(UsageRoutes, { days: 7, routes: [{ provider: "nougate", model: "antigravity:gemini-3.8-flash", requests: 1234, inputTokens: 1, cachedShare: 0.94, usdPerMillion: 0.3 }], warnings: [] }),
  );

  test("folds: the header goes, the provider and the model a line each, the numbers named", () => {
    expect(html).toMatch(/<thead class="max-sm:hidden">/);
    expect(html).toContain(`<tr class="${FOLD.row}">`);
    expect(html).toMatch(/<td class="[^"]*max-sm:basis-full[^"]*">nougate<\/td><td class="[^"]*max-sm:basis-full[^"]*">antigravity:gemini-3\.8-flash<\/td>/);
    for (const name of ["calls ", "cached ", "$ / M in "]) expect(html).toContain(`<span class="text-base-content/65 sm:hidden">${name}</span>`);
  });
});
