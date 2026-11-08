/**
 * A page opened from Settings has its way back (0.8.24, the owner on the box): "Settings" over each of its pages, those
 * that scroll as a document and those that hold the window (Logs), and over no page Settings does not list.
 */

import { expect, test } from "bun:test";
import { renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";
import { fromSettings } from "@/commons/components/layout/SettingsBack";

useMountHarness();

const back = (host: HTMLElement) => [...host.querySelectorAll('main a[href="/dashboard/settings"]')].filter((a) => a.textContent?.trim() === "Settings").length;

test("over Settings' pages, and only those", async () => {
  const seen: Record<string, number> = {};
  for (const path of ["/models", "/logs", "/account", "/update", "/agents", "/work", "/settings"]) {
    await renderPage(path, async (host) => {
      await eventually(() => host.querySelector("main") !== null, 3_000, path);
      seen[path] = back(host);
    });
  }
  expect(seen).toEqual({ "/models": 1, "/logs": 1, "/account": 1, "/update": 1, "/agents": 0, "/work": 0, "/settings": 0 });
});

test("a page under one of them is that page's own, not Settings'", () => {
  expect(fromSettings("/models")).toBe(true);
  expect(fromSettings("/models/")).toBe(true);
  // Connectors is in the menu, under Skills: not one of Settings' pages.
  expect(fromSettings("/mcp")).toBe(false);
  expect(fromSettings("/agents/nix/model")).toBe(false);
  expect(fromSettings("/models-old")).toBe(false);
});
