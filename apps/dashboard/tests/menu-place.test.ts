/**
 * Every dropdown stays inside the window: the Add Connection menu, 208 px wide and tied to the
 * right edge of a button that sat at the left of a 393 px phone, opened off the screen.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { offScreen, placeMenu, scrolledOut } from "@/commons/lib/menu-place";

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

  test("one that says how tall it is opens where it is seen whole: the list of a step's kinds under a button low in the window", () => {
    const view = { width: 1649, height: 932 };
    // As it was found: the button 608 px down, 300 px under it, and a list of 504 px cut off there with 590 px above.
    const low = placeMenu(at(688, 586, 124, 44), view, { width: 340, maxHeight: 560, height: 504 }, "center");
    expect(low).toEqual({ left: 580, width: 340, bottom: 932 - 586 + 6, maxHeight: 560 });
    // High in the window it opens under its button, whole.
    const high = placeMenu(at(688, 255, 124, 44), view, { width: 340, maxHeight: 560, height: 504 }, "center");
    expect(high).toEqual({ left: 580, width: 340, top: 305, maxHeight: 560 });
    // Seen whole on neither side: the side with more room, cut to that room, where it scrolls in itself.
    const middle = placeMenu(at(688, 400, 124, 44), view, { width: 340, maxHeight: 560, height: 504 }, "center");
    expect(middle).toEqual({ left: 580, width: 340, top: 450, maxHeight: 932 - 444 - 6 - 8 });
    const short = placeMenu(at(688, 400, 124, 44), { width: 1649, height: 600 }, { width: 340, maxHeight: 560, height: 504 }, "center");
    expect(short.top).toBeUndefined();
    expect(short.maxHeight).toBe(400 - 6 - 8);
    // Without a height the old rule stands: 240 px under the button is room enough, whatever the list holds.
    expect(placeMenu(at(688, 586, 124, 44), view, { width: 340, maxHeight: 560 }, "center").top).toBe(636);
  });

  test("lined up with its button's middle, and still kept inside the window", () => {
    expect(placeMenu(at(100, 100, 40), phone, { width: 120, maxHeight: 300 }, "center").left).toBe(60);
    expect(placeMenu(at(10, 100, 40), phone, { width: 120, maxHeight: 300 }, "center").left).toBe(8);
    expect(placeMenu(at(350, 100, 40), phone, { width: 120, maxHeight: 300 }, "center").left).toBe(393 - 8 - 120);
  });

  test("a menu whose button scrolled out of the card it is in closes: under the card's edge is out of sight", () => {
    const card = { top: 140, bottom: 900 };
    // In the card, and at its very edges still showing.
    expect(scrolledOut(at(1100, 400), [card])).toBe(false);
    expect(scrolledOut(at(1100, 110), [card])).toBe(false);
    expect(scrolledOut(at(1100, 880), [card])).toBe(false);
    // Scrolled up under its head, or down past its foot.
    expect(scrolledOut(at(1100, 90), [card])).toBe(true);
    expect(scrolledOut(at(1100, 904), [card])).toBe(true);
    // In sight in its own list, and that list scrolled out of the card around it.
    expect(scrolledOut(at(1100, 60), [{ top: 40, bottom: 120 }, card])).toBe(true);
    expect(scrolledOut(at(1100, 400), [])).toBe(false);
  });

  test("a menu whose button scrolled out of the window closes, rather than float over the page", () => {
    expect(offScreen(at(16, -60), phone)).toBe(true);
    expect(offScreen(at(16, 820), phone)).toBe(true);
    expect(offScreen(at(16, -20), phone)).toBe(false);
    expect(offScreen(at(16, 300), phone)).toBe(false);
  });

  test("no menu is a daisyUI dropdown tied to a button any more", () => {
    for (const file of ["modules/agents/components/GatewayList.tsx", "modules/chat/components/AgentHeader.tsx", "modules/chat/components/RoomHeader.tsx", "modules/chat/components/StartMenu.tsx"]) {
      const source = readFileSync(join(import.meta.dir, "../src", file), "utf8");
      expect(source).not.toContain("dropdown-content");
      expect(source).toContain("<DropdownMenu");
    }
    for (const file of ["commons/components/ui/Combobox.tsx", "modules/memories/graph/multi-select.tsx"]) {
      expect(readFileSync(join(import.meta.dir, "../src", file), "utf8")).toContain("placeMenu(");
    }
  });
});
