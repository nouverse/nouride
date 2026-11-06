/**
 * The People page, mounted (0.8.0): a person's morning line and where it goes — one of their chat accounts, never the
 * dashboard's, or wherever they last wrote from. In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { describe, expect, test } from "bun:test";
import { answer, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });

describe("a person's morning line", () => {
  test("where a morning line goes: one of their chat accounts, never the dashboard's, or where they last wrote from (0.8.0)", async () => {
    answer({ "/people": ok({ people: [{ key: "alex", name: "Alex", ids: ["discord:214", "telegram:555", "web:usr_1"], morning: "06:30" }] }) });
    let sent: { path: string; body: unknown }[] = [];
    let offered: string[] = [];
    await renderPage("/people", async (host) => {
      await eventually(() => host.querySelector('select[aria-label="Where Alex\'s morning line goes"]') !== null, 2_000, "the choice");
      const select = host.querySelector('select[aria-label="Where Alex\'s morning line goes"]') as HTMLSelectElement;
      offered = [...select.options].map((option) => option.textContent ?? "");
      // Shrinks to its cell on a phone rather than running past the card's edge (seen live, 0.8.0).
      expect(select.className).toContain("max-w-full");
      const record = recordPosts({ "/people/alex/morning": { status: 200, body: { ok: true, at: "06:30", to: "telegram:555" } } });
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")!.set!.call(select, "telegram:555");
      select.dispatchEvent(new (host.ownerDocument.defaultView as unknown as typeof globalThis).Event("change", { bubbles: true }));
      await eventually(() => record.posts.length > 0, 2_000, "the save");
      record.restore();
      sent = record.posts;
    });
    expect(offered).toEqual(["where they last wrote from", "Discord · 214", "Telegram · 555"]);
    expect(sent).toEqual([{ path: "/people/alex/morning", body: { at: "06:30", to: "telegram:555" } }]);
  });

  test("on a phone each person is a card of their own, the table from sm up — an account id had a column a few letters wide (0.8.0)", async () => {
    answer({ "/people": ok({ people: [{ key: "alex", name: "Alex", ids: ["discord:214777000111222333", "telegram:5550001111"] }] }) });
    let head = "";
    let row = "";
    let cells: string[] = [];
    await renderPage("/people", async (host) => {
      await eventually(() => host.textContent?.includes("discord:214777000111222333") === true, 2_000, "the people");
      head = host.querySelector("thead")?.className ?? "";
      const tr = [...host.querySelectorAll("tbody tr")][0] as HTMLElement;
      row = tr.className;
      cells = [...tr.querySelectorAll(":scope > td")].map((td) => td.className);
    });
    expect(head).toContain("hidden sm:table-header-group");
    expect(row).toContain("block");
    expect(row).toContain("sm:table-row");
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cell).toMatch(/\bblock\b.*\bsm:table-cell\b/);
    // Without the table's line under each cell, or one person read as four rows.
    for (const cell of cells) expect(cell).toContain("max-sm:border-0");
  });
});
