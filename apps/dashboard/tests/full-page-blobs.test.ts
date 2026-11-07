/**
 * The pages with soft blurred circles behind them (sign-in, welcome, setup) clip the circles, and cannot be scrolled
 * sideways. `overflow-hidden` hid them but left a scroll box 482 px wide on a 393 px phone, and a browser scrolls such
 * a box to show a field that takes the focus: on Nouride Home, opening the setup wizard's model picker slid the whole
 * page 89 px to the left with the keyboard (the owner, 2026-11-07). `overflow-clip` clips the same and is no scroll box.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGES = ["setup/index.page.tsx", "welcome/index.page.tsx", "login/index.page.tsx"];

describe("a full page with blurred circles behind it", () => {
  for (const page of PAGES) {
    test(`${page} clips them without becoming a scroll box`, () => {
      const source = readFileSync(join(import.meta.dir, "../src/modules", page), "utf8");
      expect(source).toContain("blur-3xl");
      const root = source.split("\n").find((line) => line.includes("min-h-screen")) ?? "";
      expect(root).toContain("overflow-clip");
      expect(root).not.toContain("overflow-hidden");
    });
  }
});
