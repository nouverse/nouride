/**
 * A list moves where it changes, and only there (`useMotionList`): what it holds when first drawn with its data stays
 * still, what arrives after enters and keeps entering across redraws, what goes is kept where it was while it leaves and
 * then dropped — and enters again if it comes back. A filter that hides an item moves nothing. A card whose state changes
 * is lit for a moment (`Lit`), and so is one that arrives; one first drawn is not.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { LEAVE_MS } from "@/commons/lib/motion";
import { eventually } from "./wait.ts";

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"] as const;
let dom: Window;

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  for (const key of GLOBALS) (globalThis as unknown as Record<string, unknown>)[key] = (dom as unknown as Record<string, unknown>)[key];
});

interface Drawn {
  host: HTMLElement;
  /** Draw the list again, with these items (undefined: still loading), as these the filter shows, in this scope. */
  draw: (items: string[] | undefined, options?: { shown?: (item: string) => boolean; scope?: string }) => void;
  /** Each item drawn, in order, with its motion: `a`, `b+` (entering), `c-` (leaving). */
  rows: () => string[];
  unmount: () => void;
}

/** A list of names drawn through `useMotionList`, each an `<li>` with its motion as its class. */
async function list(items: string[] | undefined, options: { shown?: (item: string) => boolean; scope?: string } = {}): Promise<Drawn> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { ENTER, LEAVE, useMotionList } = await import("@/commons/hooks/use-motion-list");
  const List = ({ items: shown, options: given }: { items: string[] | undefined; options: { shown?: (item: string) => boolean; scope?: string } }) => {
    const rows = useMotionList(shown, (item) => item, given);
    return React.createElement(
      "ul",
      null,
      rows.map(({ key, item, motion }) => React.createElement("li", { key, className: motion, "data-motion": motion === ENTER ? "+" : motion === LEAVE ? "-" : "" }, item)),
    );
  };
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  const draw: Drawn["draw"] = (next, given = {}) => flushSync(() => root.render(React.createElement(List, { items: next, options: given })));
  draw(items, options);
  return {
    host,
    draw,
    rows: () => [...host.querySelectorAll("li")].map((li) => `${li.textContent}${li.getAttribute("data-motion")}`),
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

describe("a list's motion", () => {
  test("is none for what it holds when first drawn with its data — nor for what its first answer brings", async () => {
    const drawn = await list(["a", "b"]);
    const loading = await list(undefined);
    try {
      expect(drawn.rows()).toEqual(["a", "b"]);
      loading.draw(["a", "b"]);
      expect(loading.rows()).toEqual(["a", "b"]);
    } finally {
      drawn.unmount();
      loading.unmount();
    }
  });

  test("enters what arrives after — at the top too — and keeps it entering across redraws, so a redraw does not cut it", async () => {
    const drawn = await list(["a", "b"]);
    try {
      drawn.draw(["new", "a", "b"]);
      expect(drawn.rows()).toEqual(["new+", "a", "b"]);
      expect(drawn.host.querySelector("li")?.className).toBe("animate-enter");
      drawn.draw(["new", "a", "b"]);
      expect(drawn.rows()).toEqual(["new+", "a", "b"]);
    } finally {
      drawn.unmount();
    }
  });

  test("keeps what goes where it was, leaving and out of reach, for the leave's length, then drops it", async () => {
    const drawn = await list(["a", "b", "c"]);
    try {
      const gone = Date.now();
      drawn.draw(["a", "c"]);
      expect(drawn.rows()).toEqual(["a", "b-", "c"]);
      expect(drawn.host.querySelectorAll("li")[1]?.className).toBe("animate-leave pointer-events-none");
      await eventually(() => drawn.rows().join() === "a,c", 2_000, "b to be dropped");
      expect(Date.now() - gone).toBeGreaterThanOrEqual(LEAVE_MS - 5);
    } finally {
      drawn.unmount();
    }
  });

  test("enters what comes back after it left", async () => {
    const drawn = await list(["a", "b"]);
    try {
      drawn.draw(["a"]);
      await eventually(() => drawn.rows().join() === "a", 2_000, "b to be dropped");
      drawn.draw(["a", "b"]);
      expect(drawn.rows()).toEqual(["a", "b+"]);
    } finally {
      drawn.unmount();
    }
  });

  test("is none for what a filter hides and shows again: typing in a search moves nothing", async () => {
    const drawn = await list(["a", "b", "c"]);
    try {
      drawn.draw(["a", "b", "c"], { shown: (item) => item !== "b" });
      expect(drawn.rows()).toEqual(["a", "c"]);
      drawn.draw(["a", "b", "c"]);
      expect(drawn.rows()).toEqual(["a", "b", "c"]);
    } finally {
      drawn.unmount();
    }
  });

  test("starts over in another scope: what another conversation opens on is not new", async () => {
    const drawn = await list(["a"], { scope: "ses_1" });
    try {
      drawn.draw(["x", "y"], { scope: "ses_2" });
      expect(drawn.rows()).toEqual(["x", "y"]);
      drawn.draw(["x", "y", "z"], { scope: "ses_2" });
      expect(drawn.rows()).toEqual(["x", "y", "z+"]);
    } finally {
      drawn.unmount();
    }
  });
});

describe("a card's light", () => {
  async function card(state: string, arrived = false) {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { Lit } = await import("@/commons/components/ui/Lit");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const draw = (next: string) => flushSync(() => root.render(React.createElement(Lit, { state: next, arrived })));
    draw(state);
    return { host, draw, light: () => host.querySelector(".animate-lit"), unmount: () => (root.unmount(), host.remove()) };
  }

  test("is off as a card is first drawn, and lit when its state changes — anew at each change", async () => {
    const drawn = await card("running");
    try {
      expect(drawn.light()).toBeNull();
      drawn.draw("running");
      expect(drawn.light()).toBeNull();
      drawn.draw("completed");
      const first = drawn.light();
      expect(first?.className).toContain("animate-lit");
      expect(first?.className).toContain("pointer-events-none");
      drawn.draw("failed");
      expect(drawn.light()).not.toBe(first);
    } finally {
      drawn.unmount();
    }
  });

  test("is lit on a card that arrives: a mission that changed state is drawn anew in its new group", async () => {
    const drawn = await card("completed", true);
    try {
      expect(drawn.light()).not.toBeNull();
    } finally {
      drawn.unmount();
    }
  });
});
