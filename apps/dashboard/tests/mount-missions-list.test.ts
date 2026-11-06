/**
 * The Missions list, mounted (0.8.0): its header's Limits button reads Close limits while the limits are open, as New
 * mission reads Close while its form is — it read Limits either way; and its missions are cards in the Knowledge tab's
 * grid (0.8.20). In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { buttons, press, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

test("the Limits button says Close limits while they are open, and closes them", async () => {
  let open: string[] = [];
  await renderPage("/missions", async (host) => {
    press(host, "Limits");
    await eventually(() => host.textContent?.includes("of work before it asks to go on") === true, 2_000, "the limits");
    open = buttons(host);
    press(host, "Close limits");
    await eventually(() => host.textContent?.includes("of work before it asks to go on") === false, 2_000, "the limits closed");
  });
  expect(open).toContain("Close limits");
  expect(open).not.toContain("Limits");
});

test("what finished is the last 3, 7, 14 or 30 days — 3 unless chosen, no further, and never all (0.8.8)", async () => {
  // The owner: "filternya 7 hari terbaru aja, terus max 1 bulan … jangan ditampilin semua".
  const asked: string[] = [];
  const harness = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.includes("/api/control/missions")) asked.push(url);
    return harness(input, init);
  }) as typeof fetch;
  let options: string[] = [];
  let chosen = "";
  try {
    await renderPage("/missions", async (host) => {
      await eventually(() => host.querySelector('select[aria-label="Finished in"]') !== null, 2_000, "the span filter");
      const span = host.querySelector<HTMLSelectElement>('select[aria-label="Finished in"]')!;
      options = [...span.options].map((option) => option.textContent ?? "");
      chosen = span.value;
      span.value = "30";
      span.dispatchEvent(new Event("change", { bubbles: true }));
      await eventually(() => asked.some((url) => url.includes("days=30")), 2_000, "the month asked for");
    });
  } finally {
    globalThis.fetch = harness;
  }
  expect(options).toEqual(["Last 3 days", "Last 7 days", "Last 14 days", "Last 30 days"]);
  expect(chosen).toBe("3");
  expect(asked[0]).toContain("days=3");
  expect(asked.some((url) => url.includes("days=30"))).toBe(true);
});

// The owner, 2026-11-06: missions as cards, laid out as the Knowledge tab lays out its collections.
test("the list is cards in the Knowledge tab's grid, each with its status, steps, now line and Open", async () => {
  const html = await renderPage("/missions");
  const working = html.slice(html.indexOf('aria-label="Working"'), html.indexOf('aria-label="Finished"'));
  expect(working).toContain('<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">');
  const card = /<a[^>]*href="\/dashboard\/missions\/msn_1"[^>]*>([\s\S]*?)<\/a>/.exec(html);
  expect(card?.[0]).toContain("rounded-2xl border p-5");
  for (const words of ["Write a report on the disk usage of the build box", "1 of 3 steps", "Write report.md", "Open"]) expect(card?.[1]).toContain(words);
});
