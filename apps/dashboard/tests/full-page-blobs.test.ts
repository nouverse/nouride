/**
 * The full pages a person meets signed out (sign-in, welcome, setup) cannot be scrolled sideways. They had blurred
 * circles behind them, and `overflow-hidden` hid the circles but left a scroll box 482 px wide on a 393 px phone, which
 * a browser scrolls to show a field that takes the focus: on Nouride Home, opening the setup wizard's model picker slid
 * the whole page 89 px to the left with the keyboard. `overflow-clip` clips the same and is no
 * scroll box. The soft look (0.8.24) draws no circles, and the root keeps its clip for whatever is wider next.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGES = ["setup/index.page.tsx", "welcome/index.page.tsx", "login/index.page.tsx"];

describe("a full page a person meets signed out", () => {
  for (const page of PAGES) {
    test(`${page} clips what is wider without becoming a scroll box, and draws no glow of the old look`, () => {
      const source = readFileSync(join(import.meta.dir, "../src/modules", page), "utf8");
      expect(source).not.toContain("blur-3xl");
      const root = source.split("\n").find((line) => line.includes("min-h-dvh")) ?? "";
      expect(root).toContain("overflow-clip");
      expect(root).not.toContain("overflow-hidden");
    });
  }
});
