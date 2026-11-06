/**
 * Every dialog is drawn over the whole page (0.8.11). A card's glass — a backdrop filter — makes the card the containing
 * block of anything `fixed` inside it: `report.md`'s dialog, opened from a mission's Result card, was drawn inside the
 * card and cut off by it, and every dialog rendered inside a card could be. Each goes through `overPage`, a portal to
 * the body.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

/** Drawn by the layout itself, at the page's root — no card around it. */
const AT_THE_ROOT: Record<string, string> = {
  "commons/components/layout/RootLayout.tsx": "the phone's navigation drawer, the layout's own",
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".tsx") ? [path] : [];
  });
}

describe("a dialog over the page", () => {
  test("every one is drawn at the body, through overPage — none inside the card it was opened from", () => {
    const dialogs = files(SRC).filter((path) => /className="modal modal-open"|className="fixed inset-0\b/.test(readFileSync(path, "utf8")));
    const inside = dialogs.map((path) => relative(SRC, path)).filter((path) => !(path in AT_THE_ROOT) && !readFileSync(join(SRC, path), "utf8").includes("overPage("));
    expect(dialogs.length).toBeGreaterThanOrEqual(7);
    expect(inside).toEqual([]);
  });
});
