/**
 * Explore's search hits run down the page (0.8.24): held to what the window left under the two cards above them, they
 * had the height of one hit on a laptop (the owner, 2026-11-08). The page scrolls; the list is not a box of its own.
 */

import { expect, test } from "bun:test";
import { renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

test("the hits are not a scroll box of their own, and their card does not take a share of the window", async () => {
  let seen = { list: "", card: "" };
  await renderPage("/skills", async (host) => {
    await eventually(() => [...host.querySelectorAll("button, [role=tab]")].some((el) => el.textContent?.trim().startsWith("Explore")), 3_000, "the tabs");
    ([...host.querySelectorAll("button, [role=tab]")].find((el) => el.textContent?.trim().startsWith("Explore")) as HTMLElement).click();
    await eventually(() => host.querySelector("[data-explore-hits]") !== null, 3_000, "Explore");
    const list = host.querySelector("[data-explore-hits]")!;
    seen = { list: list.getAttribute("class") ?? "", card: list.closest("section")?.getAttribute("class") ?? "" };
  });
  for (const word of ["overflow-y-auto", "flex-1", "min-h-0"]) expect(seen.list.split(" ")).not.toContain(word);
  expect(seen.card.split(" ")).not.toContain("flex-1");
  expect(seen.card).not.toMatch(/min-h-\[/);
});
