/**
 * A page opened from Settings has its way back (0.8.24, the owner on the box): "Settings" over each of its pages, those
 * that scroll as a document and those that hold the window (Logs), and over no page Settings does not list.
 */

import { expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
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
  // Signed in as an admin, as the harness is: Logs and Update are tabs of System for them, in the menu, so no way back
  // over either.
  expect(seen).toEqual({ "/models": 1, "/logs": 0, "/account": 1, "/update": 0, "/agents": 0, "/work": 0, "/settings": 0 });
});

test("over Logs for someone who is not an admin, the page that holds the window: it is one of Settings' pages for them", async () => {
  const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
  answer({ "/auth/me": { status: 200, body: { ...me, role: "operator", user: { ...me.user, role: "operator" } } } });
  let seen = -1;
  await renderPage("/logs", async (host) => {
    await eventually(() => back(host) > 0, 3_000, "the way back over Logs");
    seen = back(host);
  });
  expect(seen).toBe(1);
});

test("over Update for someone who is not an admin, with its card under Settings; an admin has neither", async () => {
  const me = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
  const cards = (host: HTMLElement) => [...host.querySelectorAll('main a[href="/dashboard/update"]')].filter((a) => a.textContent?.includes("The newest version of Nouride")).length;
  answer({ "/auth/me": { status: 200, body: { ...me, role: "operator", user: { ...me.user, role: "operator" } } } });
  let seen = { back: -1, tabs: -1, card: -1 };
  await renderPage("/update", async (host) => {
    await eventually(() => back(host) > 0, 3_000, "the way back over Update");
    seen = { ...seen, back: back(host), tabs: host.querySelectorAll('main a[href="/dashboard/files"], main a[href="/dashboard/system"]').length };
  });
  await renderPage("/settings", async (host) => {
    await eventually(() => cards(host) > 0, 3_000, "Update among Settings' cards");
    seen = { ...seen, card: cards(host) };
  });
  expect(seen).toEqual({ back: 1, tabs: 0, card: 1 });
  // An admin has it in the menu, a tab of System: not a second time under Settings.
  answer({});
  let admins = -1;
  await renderPage("/settings", async (host) => {
    await eventually(() => host.querySelector('main a[href="/dashboard/models"]') !== null, 3_000, "Settings' cards");
    admins = cards(host);
  });
  expect(admins).toBe(0);
});

test("a page under one of them is that page's own, not Settings'", () => {
  expect(fromSettings("/models")).toBe(true);
  expect(fromSettings("/models/")).toBe(true);
  // Connectors is in the menu, under Skills: not one of Settings' pages.
  expect(fromSettings("/mcp")).toBe(false);
  expect(fromSettings("/agents/nix/model")).toBe(false);
  expect(fromSettings("/models-old")).toBe(false);
  // Logs is a Settings page for everyone but an admin, who has it as a tab of System: no way back to Settings over it.
  expect(fromSettings("/logs")).toBe(true);
  expect(fromSettings("/logs", true)).toBe(false);
  // And so is Update.
  expect(fromSettings("/update")).toBe(true);
  expect(fromSettings("/update", true)).toBe(false);
  expect(fromSettings("/models", true)).toBe(true);
});
