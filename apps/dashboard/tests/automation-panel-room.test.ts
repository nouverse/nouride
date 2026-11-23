/**
 * How tall the panel beside an automation's canvas may be (`lib/panel-room.ts`): measured from where it stands to the
 * window's foot. It was "the window less 13rem", which left a hand's width of nothing under it once the page was
 * scrolled, with its own fields cut off above that.
 */

import { expect, test } from "bun:test";
import { PANEL_MARGIN, panelRoom } from "@/modules/automations/lib/panel-room";

const panel = { left: 1121, right: 1497 };
const view = (rowTop: number, more: Partial<Parameters<typeof panelRoom>[0]> = {}) => panelRoom({ rowTop, viewHeight: 932, panel, chat: null, ...more });

test("at the page's top it runs from under the page's head to a margin over the window's foot", () => {
  expect(view(144)).toBe(932 - 16 - 144);
});

test("with the page scrolled it stays a margin under the window's top, and is as tall as the window less both margins", () => {
  expect(view(40)).toBe(932 - 16 - 40);
  expect(view(16)).toBe(900);
  expect(view(-600)).toBe(900);
  expect(PANEL_MARGIN).toBe(16);
});

test("where the chat's button floats over its corner it ends over the button, since Done is at that corner", () => {
  const chat = { left: 1440, right: 1496, top: 860 };
  expect(view(144, { chat })).toBe(860 - 12 - 144);
  expect(view(-600, { chat })).toBe(860 - 12 - 16);
  // Beside the panel, not over it: the button takes nothing from it.
  expect(view(144, { chat: { left: 1577, right: 1633, top: 860 } })).toBe(932 - 16 - 144);
  expect(view(144, { chat: { left: 1000, right: 1056, top: 860 } })).toBe(932 - 16 - 144);
});

test("in a window too short for a few fields it keeps a least height, and the page scrolls to the rest", () => {
  expect(panelRoom({ rowTop: 144, viewHeight: 380, panel, chat: null })).toBe(280);
});
