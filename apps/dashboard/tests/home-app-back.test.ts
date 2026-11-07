/**
 * Inside Nouride Home (the Android app), the dashboard's own header has the way back to the app, so the app needs no
 * second bar above it, and the phone's back gesture is not the only way out (the owner, 2026-11-07).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_APP_BACK, inHomeApp } from "@/commons/lib/home-app";

describe("the way back to Nouride Home", () => {
  test("only the app's WebView is taken for the app", () => {
    expect(inHomeApp("Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36 NourideHome/1")).toBe(true);
    expect(inHomeApp("Mozilla/5.0 (Linux; Android 15; wv) Chrome/131.0 Mobile Safari/537.36")).toBe(false);
    expect(inHomeApp("Mozilla/5.0 (Macintosh) Safari/605.1.15")).toBe(false);
  });

  test("the header links to the address the app catches, and only inside it", () => {
    expect(HOME_APP_BACK).toBe("nouridehome://home");
    const header = readFileSync(join(import.meta.dir, "../src/commons/components/layout/RootLayout.tsx"), "utf8");
    expect(header).toContain("{inHomeApp() && (");
    expect(header).toContain("href={HOME_APP_BACK}");
    expect(header).toContain('aria-label="Back to Nouride Home"');
  });
});
