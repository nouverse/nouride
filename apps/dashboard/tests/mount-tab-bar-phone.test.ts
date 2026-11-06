/**
 * The tab bar on a phone (0.8.12): one row that scrolls sideways, where wrapped it left System Logs' "Background jobs"
 * alone on a second line and an agent's nine tabs in three rows. The tab you are on is scrolled into view, so only it
 * may say it is current — the router marked an agent's Files tab current on every one of its tabs, Files' route being
 * their parent, and the bar would have scrolled to Files.
 */

import { expect, test } from "bun:test";
import { renderPage, useMountHarness } from "./mount-harness.ts";
import { SEGMENTED_BAR } from "@/commons/components/ui/SegmentedTabs";

useMountHarness();

test("the bar is one row on a phone and wraps from sm up, as it did", () => {
  const words = SEGMENTED_BAR.split(" ");
  expect(words).toEqual(expect.arrayContaining(["flex-nowrap", "overflow-x-auto", "sm:flex-wrap"]));
  expect(words).not.toContain("flex-wrap");
});

test("an agent's tab bar says only the tab you are on is current", async () => {
  let current: string[] = [];
  await renderPage("/agents/nouva/skills", async (host) => {
    const bar = [...host.querySelectorAll("main div")].find((div) => div.getAttribute("class") === SEGMENTED_BAR);
    current = [...(bar?.querySelectorAll('a[aria-current="page"]') ?? [])].map((a) => a.textContent?.trim() ?? "");
  });
  expect(current).toEqual(["Skills"]);
});
