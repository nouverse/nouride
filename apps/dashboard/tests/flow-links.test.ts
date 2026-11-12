/**
 * The jumps of a flow, drawn over it (`FlowLinks`): a curved line at the side from where each one leaves to the step it
 * lands on. The geometry is `lib/flow-path.ts`'s, tested on its own; the picture is mounted over anchors given the
 * places a browser's layout would give them, and read back as the paths it drew.
 */

import { describe, expect, test } from "bun:test";
import { arrowHead, jumpPath, lanes } from "@/commons/lib/flow-path";
import { useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

describe("the line of a jump", () => {
  test("out to the side, a rounded turn down, a rounded turn back, and in to where it lands", () => {
    expect(jumpPath({ x: 200, y: 100 }, { x: 600, y: 400 }, 640, 14)).toBe("M 200 100 H 626 Q 640 100 640 114 V 386 Q 640 400 626 400 H 600");
  });

  test("the corners are as round as the room allows: a short jump is still a curve, and never overshoots", () => {
    // Ten pixels down: each corner takes half of it.
    expect(jumpPath({ x: 200, y: 100 }, { x: 600, y: 110 }, 640, 14)).toBe("M 200 100 H 635 Q 640 100 640 105 V 105 Q 640 110 635 110 H 600");
    // The side four pixels past where it lands: no corner is wider than that.
    expect(jumpPath({ x: 200, y: 100 }, { x: 636, y: 400 }, 640, 14)).toBe("M 200 100 H 636 Q 640 100 640 104 V 396 Q 640 400 636 400 H 636");
  });

  test("the arrow's head points in at the step from the side", () => {
    expect(arrowHead({ x: 607, y: 400 }, 6)).toBe("M 607 400 l 6 -4.199999999999999 v 8.399999999999999 z");
  });

  test("two jumps whose stretches overlap get a lane each; one that ends before the next begins shares its lane", () => {
    const span = (key: string, from: number, to: number) => ({ key, from: { x: 0, y: from }, to: { x: 0, y: to } });
    expect(Object.fromEntries(lanes([span("a", 100, 500), span("b", 300, 500)]))).toEqual({ a: 0, b: 1 });
    expect(Object.fromEntries(lanes([span("a", 100, 200), span("b", 300, 500)]))).toEqual({ a: 0, b: 0 });
    // Whatever order they are given in: by where they start.
    expect(Object.fromEntries(lanes([span("c", 400, 900), span("b", 300, 500), span("a", 100, 350)]))).toEqual({ a: 0, b: 1, c: 0 });
    expect(lanes([]).size).toBe(0);
  });
});

/** An element given the place a layout would give it, in its offset parent. */
function placed(element: HTMLElement, box: { left: number; top: number; width: number; height: number }, parent: HTMLElement): void {
  for (const [name, value] of Object.entries({ offsetLeft: box.left, offsetTop: box.top, offsetWidth: box.width, offsetHeight: box.height, offsetParent: parent })) {
    Object.defineProperty(element, name, { configurable: true, get: () => value });
  }
}

async function mounted() {
  const { createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { FLOW_SIDE, FlowLinks } = await import("@/commons/components/ui/FlowLinks");
  const control: { set?: (next: { active: string | null; version: number; taken: boolean }) => void } = {};
  function Flow() {
    const [state, setState] = useState({ active: null as string | null, version: 0, taken: false });
    control.set = setState;
    return createElement(
      "div",
      { "data-flow": "edit", className: FLOW_SIDE },
      createElement("div", { "data-flow-anchor": "exit:a", ref: (el: HTMLElement | null) => el?.parentElement && placed(el, { left: 60, top: 90, width: 140, height: 20 }, el.parentElement) }),
      createElement("div", { "data-flow-anchor": "exit:b", ref: (el: HTMLElement | null) => el?.parentElement && placed(el, { left: 60, top: 290, width: 140, height: 20 }, el.parentElement) }),
      createElement("div", { "data-flow-anchor": "step:z", ref: (el: HTMLElement | null) => el?.parentElement && placed(el, { left: 0, top: 500 + state.version * 100, width: 600, height: 80 }, el.parentElement) }),
      createElement(FlowLinks, {
        links: [
          { key: "a", from: "exit:a", to: "step:z", taken: state.taken },
          { key: "b", from: "exit:b", to: "step:z" },
          { key: "nowhere", from: "exit:a", to: "step:gone" },
        ],
        active: state.active,
        version: state.version,
      }),
    );
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(Flow));
  const drawn = () => [...host.querySelectorAll("[data-flow-link]")].map((link) => ({ key: link.getAttribute("data-flow-link"), state: link.getAttribute("data-state"), d: link.querySelector("path")?.getAttribute("d") }));
  return { host, drawn, set: (next: { active: string | null; version: number; taken: boolean }) => control.set?.(next), done: () => (root.unmount(), host.remove()) };
}

describe("the picture over a flow", () => {
  test("is drawn as the flow is first drawn: a line a jump whose two ends are there, each in a lane of its own", async () => {
    const flow = await mounted();
    try {
      await eventually(() => flow.drawn().length === 2, 2_000, "the two jumps");
      // From the middle of where each leaves (200, 100 and 200, 300) to the head of the card (607, 530); the first lane
      // 18 past the card's edge, the second 11 further.
      expect(flow.drawn()).toEqual([
        { key: "a", state: "idle", d: jumpPath({ x: 200, y: 100 }, { x: 607, y: 530 }, 625) },
        { key: "b", state: "idle", d: jumpPath({ x: 200, y: 300 }, { x: 607, y: 530 }, 636) },
      ]);
      // Over the flow and out of the pointer's way, and not on a phone, where the chips' words are the whole of it.
      const layer = flow.host.querySelector("[data-flow] > div[aria-hidden]")!;
      expect(layer.getAttribute("class")).toContain("pointer-events-none");
      expect(layer.getAttribute("class")).toContain("max-md:hidden");
    } finally {
      flow.done();
    }
  });

  test("the jump under the pointer is lit, one a run took is drawn as taken, and a card that moved is measured again", async () => {
    const flow = await mounted();
    try {
      await eventually(() => flow.drawn().length === 2, 2_000, "the two jumps");
      flow.set({ active: "b", version: 0, taken: true });
      await eventually(() => flow.drawn()[1]?.state === "active", 2_000, "b lit");
      expect(flow.drawn().map((link) => link.state)).toEqual(["taken", "active"]);
      // The pointer wins over a run: the lit one is the one being asked about.
      flow.set({ active: "a", version: 0, taken: true });
      await eventually(() => flow.drawn()[0]?.state === "active", 2_000, "a lit");
      flow.set({ active: null, version: 1, taken: false });
      await eventually(() => flow.drawn()[0]?.d === jumpPath({ x: 200, y: 100 }, { x: 607, y: 630 }, 625), 2_000, "the card's new place");
    } finally {
      flow.done();
    }
  });
});
