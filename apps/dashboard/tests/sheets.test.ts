/**
 * Every sheet on a phone is one component (`Sheet`), with a head: its name and a button that closes it, a finger's
 * size. It closes by that button, by Escape, by a press on the shade and by a swipe down on the head past a short
 * distance; a shorter drag springs back; the focus goes back to what opened it. "Add a step" was a sheet under a grab
 * line that was only drawn, closed by nothing a thumb finds, and a swipe did nothing; the app's More was markup of its
 * own; the chat's sheet had its own head. The scan below finds a sheet made any other way.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { answer, dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";
import { SWIPE_CLOSE_PX, dragOffset, swipeCloses } from "@/commons/lib/sheet-swipe";

useMountHarness();

const SRC = join(dirname(import.meta.path), "..", "src");
const THE_SHEET = join("commons", "components", "ui", "Sheet.tsx");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

/** Each way a sheet from the foot was made by hand before, and could be again. */
const HAND_MADE: [what: string, pattern: RegExp][] = [
  ["a sheet's top corners", /rounded-t-\[/],
  ["a grab line drawn by hand", /h-1\.5 w-10/],
  ["the sheet's own classes", /\bSHEET_(BOX|PLACE)\b/],
  ["daisyUI's bottom sheet", /\bmodal-bottom\b/],
  ["a drawer from the foot", /side=["']bottom["']/],
];

const phone = () => dom.happyDOM.setViewport({ width: 390, height: 844 });
afterEach(() => {
  dom.happyDOM.setViewport({ width: 1024, height: 768 });
});

describe("one sheet", () => {
  test("the scan reads the sheet itself, so a clean result means something", () => {
    const sheet = readFileSync(join(SRC, THE_SHEET), "utf8");
    for (const [what, pattern] of HAND_MADE.slice(0, 3)) expect({ what, found: pattern.test(sheet) }).toEqual({ what, found: true });
  });

  test("no sheet is made but by the component", () => {
    const found = sources(SRC)
      .filter((path) => relative(SRC, path) !== THE_SHEET)
      .flatMap((path) => {
        const text = readFileSync(path, "utf8");
        return HAND_MADE.filter(([, pattern]) => pattern.test(text)).map(([what]) => `${relative(SRC, path)}: ${what}`);
      });
    expect(found).toEqual([]);
  });
});

describe("the swipe", () => {
  test("down past a short distance closes; a shorter, slow drag springs back; a quick flick closes", () => {
    expect(swipeCloses({ dy: SWIPE_CLOSE_PX, ms: 600 })).toBe(true);
    expect(swipeCloses({ dy: 200, ms: 1500 })).toBe(true);
    expect(swipeCloses({ dy: SWIPE_CLOSE_PX - 1, ms: 600 })).toBe(false);
    expect(swipeCloses({ dy: 10, ms: 5 })).toBe(false);
    expect(swipeCloses({ dy: 40, ms: 50 })).toBe(true);
    expect(swipeCloses({ dy: -200, ms: 100 })).toBe(false);
  });

  test("the sheet follows the finger down and never rises above where it rests", () => {
    expect(dragOffset(50)).toBe(50);
    expect(dragOffset(-50)).toBe(0);
  });
});

/** A sheet drawn alone, open, with a button that opened it and holds the focus first. */
async function drawSheet(extra: Record<string, unknown> = {}) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { Sheet } = await import("@/commons/components/ui/Sheet");
  const holder = dom.document.createElement("div");
  dom.document.body.appendChild(holder as never);
  const opener = dom.document.createElement("button");
  opener.textContent = "Open";
  dom.document.body.appendChild(opener as never);
  opener.focus();
  const root = createRoot(holder as never);
  let closed = 0;
  const draw = (open: boolean) =>
    flushSync(() =>
      root.render(
        React.createElement(Sheet, {
          open,
          onClose: () => {
            closed += 1;
          },
          label: "Add a step",
          children: React.createElement("p", null, "the kinds of step"),
          ...extra,
        }),
      ),
    );
  draw(true);
  const panel = dom.document.querySelector('[data-sheet][aria-label="Add a step"]') as unknown as HTMLElement;
  return {
    panel,
    opener,
    draw,
    closed: () => closed,
    grab: panel.querySelector("[data-sheet-grab]") as HTMLElement,
    shade: dom.document.querySelector("[data-sheet-shade]") as unknown as HTMLElement,
    gone: () => {
      flushSync(() => root.unmount());
      holder.remove();
      opener.remove();
    },
  };
}

const pointer = (target: unknown, type: string, clientY: number) =>
  (target as EventTarget).dispatchEvent(new dom.PointerEvent(type, { bubbles: true, cancelable: true, clientY, pointerId: 7, isPrimary: true, button: 0 }) as never);

describe("a sheet", () => {
  test("is a dialog at the body, its head its name and a close button a finger's size", async () => {
    const sheet = await drawSheet();
    try {
      expect(sheet.panel.getAttribute("role")).toBe("dialog");
      expect(sheet.panel.parentElement).toBe(dom.document.body as never);
      expect(sheet.grab.querySelector("h2")?.textContent).toBe("Add a step");
      const close = sheet.grab.querySelector('button[aria-label="Close Add a step"]')!;
      expect(close.getAttribute("class")!.split(" ")).toContain("size-11");
    } finally {
      sheet.gone();
    }
  });

  test("closes by its button, by Escape and by a press on the shade", async () => {
    const sheet = await drawSheet();
    try {
      (sheet.grab.querySelector('button[aria-label="Close Add a step"]') as HTMLElement).click();
      expect(sheet.closed()).toBe(1);
      dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
      expect(sheet.closed()).toBe(2);
      sheet.shade.click();
      expect(sheet.closed()).toBe(3);
    } finally {
      sheet.gone();
    }
  });

  test("closes on a swipe down its head; a shorter drag springs back, and a press on the body drags nothing", async () => {
    const sheet = await drawSheet();
    try {
      // Shorter than a flick: it follows the finger, then goes back to rest.
      pointer(sheet.grab, "pointerdown", 100);
      pointer(dom.window, "pointermove", 120);
      expect(sheet.panel.style.translate).toBe("0 20px");
      pointer(dom.window, "pointerup", 120);
      expect(sheet.closed()).toBe(0);
      expect(sheet.panel.style.translate).toBe("");
      // From the body, not the head: nothing moves.
      pointer(sheet.panel.querySelector("p")!, "pointerdown", 100);
      pointer(dom.window, "pointermove", 300);
      expect(sheet.panel.style.translate).toBe("");
      pointer(dom.window, "pointerup", 300);
      expect(sheet.closed()).toBe(0);
      // Down past the distance: put away.
      pointer(sheet.grab, "pointerdown", 100);
      pointer(dom.window, "pointermove", 200);
      pointer(dom.window, "pointerup", 200);
      expect(sheet.closed()).toBe(1);
    } finally {
      sheet.gone();
    }
  });

  test("gives the focus back to what opened it as it closes", async () => {
    const sheet = await drawSheet();
    try {
      expect(dom.document.activeElement).toBe(sheet.panel as never);
      sheet.draw(false);
      expect(dom.document.activeElement).toBe(sheet.opener as never);
    } finally {
      sheet.gone();
    }
  });

  test("with a head of its own (the chat's), it draws the grab line alone and a swipe starts on that head too", async () => {
    const React = await import("react");
    const sheet = await drawSheet({ head: false, children: React.createElement("header", { "data-sheet-grab": "" }, "Minimize") });
    try {
      expect(sheet.grab.querySelector("h2")).toBeNull();
      const own = sheet.panel.querySelector("header")!;
      pointer(own, "pointerdown", 100);
      pointer(dom.window, "pointermove", 250);
      pointer(dom.window, "pointerup", 250);
      expect(sheet.closed()).toBe(1);
    } finally {
      sheet.gone();
    }
  });
});

describe("on a phone", () => {
  test("a press on an agent's row opens its card in a sheet, and nothing under the row", async () => {
    phone();
    const seen = { sheet: "", inRow: true, haspopup: "", afterClose: "" };
    await renderPage("/agents", async (host) => {
      await eventually(() => host.querySelector('[data-agent-row="nouva"] button') !== null, 4_000, "the rows");
      const row = host.querySelector<HTMLElement>('[data-agent-row="nouva"] button')!;
      seen.haspopup = row.getAttribute("aria-haspopup") ?? "";
      row.click();
      const sheet = () => dom.document.querySelector('[data-sheet][data-open] [data-agent-sheet="nouva"]');
      await eventually(() => sheet() !== null, 2_000, "the agent's sheet");
      seen.sheet = sheet()!.closest("[data-sheet]")!.getAttribute("aria-label") ?? "";
      seen.inRow = host.querySelector('[data-agent-row="nouva"]')!.children.length > 1;
      (dom.document.querySelector('[data-sheet][data-open] button[aria-label="Close Nouva"]') as unknown as HTMLElement).click();
      await eventually(() => dom.document.querySelector('[data-sheet][data-open] [data-agent-sheet]') === null, 2_000, "the sheet put away");
      seen.afterClose = "closed";
    });
    expect(seen.haspopup).toBe("dialog");
    expect(seen.sheet).toBe("Nouva");
    expect(seen.inRow).toBe(false);
    expect(seen.afterClose).toBe("closed");
  });

  test("from a tablet up the row still opens under itself, and no sheet is drawn", async () => {
    answer({});
    let seen = { expanded: "", sheet: true };
    await renderPage("/agents", async (host) => {
      await eventually(() => host.querySelector('[data-agent-row="nouva"] button') !== null, 4_000, "the rows");
      const row = host.querySelector<HTMLElement>('[data-agent-row="nouva"] button')!;
      row.click();
      await eventually(() => row.getAttribute("aria-expanded") === "true", 2_000, "the row open");
      seen = { expanded: row.getAttribute("aria-expanded") ?? "", sheet: dom.document.querySelector("[data-agent-sheet]") !== null };
    });
    expect(seen.expanded).toBe("true");
    expect(seen.sheet).toBe(false);
  });
});
