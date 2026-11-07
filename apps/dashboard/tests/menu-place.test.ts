/**
 * Every dropdown stays inside the window (the owner, 2026-11-07): the Add Connection menu, 208 px wide and tied to the
 * right edge of a button that sat at the left of a 393 px phone, opened off the screen.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { offScreen, placeMenu } from "@/commons/lib/menu-place";

const phone = { width: 393, height: 800 };
const at = (left: number, top: number, width = 140, height = 36) => ({ left, right: left + width, top, bottom: top + height });

describe("where a dropdown goes", () => {
  test("lined up with its button's edge when there is room", () => {
    expect(placeMenu(at(200, 100), phone, { width: 120, maxHeight: 300 }, "end")).toEqual({ left: 220, width: 120, top: 142, maxHeight: 300 });
    expect(placeMenu(at(20, 100), phone, { width: 208, maxHeight: 300 }, "start").left).toBe(20);
  });

  test("pushed back inside the window, 8 px from the edge, rather than off it", () => {
    // Add Connection: the button at the left, the menu tied to its right edge.
    expect(placeMenu(at(16, 300), phone, { width: 208, maxHeight: 300 }, "end").left).toBe(8);
    // A menu near the right edge.
    const right = placeMenu(at(330, 300, 50), phone, { width: 256, maxHeight: 300 }, "start");
    expect(right.left + right.width).toBe(393 - 8);
  });

  test("never wider than the window", () => {
    const wide = placeMenu(at(0, 100), { width: 300, height: 800 }, { width: 400, maxHeight: 300 }, "start");
    expect(wide).toMatchObject({ left: 8, width: 284 });
  });

  test("opens upwards when there is no room below, and is cut to the room it has", () => {
    const low = placeMenu(at(100, 700), phone, { width: 200, maxHeight: 300 }, "start");
    expect(low.top).toBeUndefined();
    expect(low.bottom).toBe(800 - 700 + 6);
    expect(low.maxHeight).toBe(300);
    // Less room above than below: it stays below, cut to the room there.
    const cramped = placeMenu(at(100, 60), { width: 393, height: 260 }, { width: 200, maxHeight: 300 }, "start");
    expect(cramped.top).toBe(102);
    expect(cramped.maxHeight).toBe(260 - 96 - 6 - 8);
  });

  test("a menu whose button scrolled out of the window closes, rather than float over the page", () => {
    expect(offScreen(at(16, -60), phone)).toBe(true);
    expect(offScreen(at(16, 820), phone)).toBe(true);
    expect(offScreen(at(16, -20), phone)).toBe(false);
    expect(offScreen(at(16, 300), phone)).toBe(false);
  });

  test("no menu is a daisyUI dropdown tied to a button any more", () => {
    for (const file of ["modules/agents/components/GatewayList.tsx", "modules/chat/components/ChatHeader.tsx", "modules/chat/components/RoomBar.tsx"]) {
      const source = readFileSync(join(import.meta.dir, "../src", file), "utf8");
      expect(source).not.toContain("dropdown-content");
      expect(source).toContain("<DropdownMenu");
    }
    for (const file of ["commons/components/ui/Combobox.tsx", "modules/memories/graph/multi-select.tsx"]) {
      expect(readFileSync(join(import.meta.dir, "../src", file), "utf8")).toContain("placeMenu(");
    }
  });
});
