/**
 * The completion keyboard, which used to be two copies of itself.
 *
 * Both menus in the composer handled Arrow/Escape/Tab/Enter with the same eighty-five lines, and the
 * one difference between them is the interesting part: Enter on the slash menu must *send* `/status`
 * rather than swallow it, while Enter on the mention menu must complete `@no`. Those are the two
 * cases worth pinning, because a refactor that unified them by making one behave like the other
 * would look like a simplification and would be a regression.
 */

import { describe, expect, test } from "bun:test";
import { completionKey } from "../src/modules/chat/lib/completion.ts";

const press = (key: string, over: { count?: number; active?: number; startAt?: -1 | 0 } = {}) =>
  completionKey({
    event: { key },
    count: over.count ?? 3,
    active: over.active ?? -1,
    startAt: over.startAt ?? -1,
  });

describe("a closed menu owns no keys", () => {
  test("every key falls through when there is nothing to complete", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Escape", "Tab", "Enter"]) {
      expect(press(key, { count: 0 })).toBeNull();
    }
  });
});

describe("moving", () => {
  test("wraps at both ends, so holding an arrow does not stop", () => {
    expect(press("ArrowDown", { active: 2, count: 3 })).toEqual({ kind: "move", to: 0 });
    expect(press("ArrowUp", { active: 0, count: 3 })).toEqual({ kind: "move", to: 2 });
  });

  test("from nothing highlighted, down goes to the first row", () => {
    expect(press("ArrowDown", { active: -1 })).toEqual({ kind: "move", to: 0 });
  });
});

describe("Enter, which is where the two menus differ", () => {
  test("the slash menu sends `/status` rather than completing it", () => {
    /**
     * The regression this test exists to prevent. Nothing is highlighted until an arrow key says so,
     * so Enter is not the menu's — it belongs to the textarea, and the message goes.
     */
    expect(press("Enter", { startAt: -1, active: -1 })).toBeNull();
  });

  test("the slash menu does complete a row somebody moved to", () => {
    expect(press("Enter", { startAt: -1, active: 1 })).toEqual({ kind: "pick", index: 1 });
  });

  test("the mention menu completes, because `@no` reaches nobody as typed", () => {
    expect(press("Enter", { startAt: 0, active: 0 })).toEqual({ kind: "pick", index: 0 });
  });

  test("Shift+Enter is a newline in either menu", () => {
    for (const startAt of [-1, 0] as const) {
      expect(completionKey({ event: { key: "Enter", shiftKey: true }, count: 3, active: 0, startAt }))
        .toBeNull();
    }
  });
});

describe("Tab and Escape", () => {
  test("Tab takes the top match even with nothing highlighted", () => {
    // The shell habit: a half-typed command completes without arrowing to it first.
    expect(press("Tab", { active: -1 })).toEqual({ kind: "pick", index: 0 });
  });

  test("Escape dismisses rather than picking", () => {
    expect(press("Escape", { active: 1 })).toEqual({ kind: "dismiss" });
  });
});

describe("keys the composer keeps", () => {
  test("ordinary typing is never the menu's business", () => {
    for (const key of ["a", "@", "/", "Backspace", "ArrowLeft", "Home"]) {
      expect(press(key)).toBeNull();
    }
  });
});
