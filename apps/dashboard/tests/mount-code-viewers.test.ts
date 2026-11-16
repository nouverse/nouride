/**
 * A fenced block drawn by the viewer its language names (`commons/components/ui/viewers`): a picture, a formula, a
 * diagram, with the code a press away and the copy button kept.
 *
 * What it must never do is lose the block. A language with no viewer, a viewer that does not load, one that throws while
 * drawing and one that says it cannot draw the block all leave the code it was, with no error box; a block still being
 * written is code and asks for no viewer. The viewers here are the test's own, put in the same list the real ones are in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const loads: string[] = [];

async function mount(props: { lang?: string; text: string; growing?: boolean }) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { CodeBlock } = await import("@/commons/components/ui/CodeBlock");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  root.render(React.createElement(CodeBlock, props));
  await eventually(() => host.querySelector("[data-viewer]") !== null, 2_000, "the block");
  return { host, unmount: () => (root.unmount(), host.remove()) };
}

/** The test's viewers, in the real list. Each mount uses a fresh language name, so nothing is kept from another test. */
async function viewer(name: string, draw: (props: { text: string; onFail: () => void }) => unknown, load: "ok" | "reject" = "ok") {
  const React = await import("react");
  const { VIEWERS } = await import("@/commons/components/ui/viewers");
  VIEWERS[name] = {
    label: "Picture",
    load: async () => {
      loads.push(name);
      if (load === "reject") throw new Error("chunk did not load");
      return { default: (props) => React.createElement(React.Fragment, null, draw(props) as never) };
    },
  };
}

const shown = (host: HTMLElement) => host.querySelector("[data-viewer]")!.getAttribute("data-viewer");
const code = (host: HTMLElement) => host.querySelector("pre code")?.textContent ?? null;
const switches = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("[role=group] button")].map((button) => `${button.textContent}:${button.getAttribute("aria-pressed")}`);

afterEach(async () => {
  const { VIEWERS } = await import("@/commons/components/ui/viewers");
  for (const name of Object.keys(VIEWERS)) if (name.startsWith("t-")) delete VIEWERS[name];
  loads.length = 0;
});

describe("a fenced block and its viewer", () => {
  test("a language that names a viewer is drawn by it, with a switch to its code and the copy button kept", async () => {
    await viewer("t-draws", ({ text }) => `drawn:${text}`);
    const { host, unmount } = await mount({ lang: "t-draws title=x", text: "<a/>" });
    try {
      await eventually(() => shown(host) === "picture", 2_000, "the picture");
      expect(host.textContent).toContain("drawn:<a/>");
      expect(code(host)).toBeNull();
      expect(switches(host)).toEqual(["Picture:true", "Code:false"]);
      expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Copy")).toBe(true);
      ([...host.querySelectorAll<HTMLButtonElement>("[role=group] button")][1]!).click();
      await eventually(() => shown(host) === "code", 2_000, "the code");
      expect(code(host)).toBe("<a/>");
      expect(switches(host)).toEqual(["Picture:false", "Code:true"]);
    } finally {
      unmount();
    }
  });

  test("a language with no viewer is code, with no switch", async () => {
    const { host, unmount } = await mount({ lang: "t-nobody", text: "plain" });
    try {
      expect(shown(host)).toBe("code");
      expect(code(host)).toBe("plain");
      expect(switches(host)).toEqual([]);
    } finally {
      unmount();
    }
  });

  test("a viewer that does not load leaves the code, with no error, and the next block asks again", async () => {
    await viewer("t-gone", () => "never", "reject");
    const first = await mount({ lang: "t-gone", text: "kept" });
    try {
      await eventually(() => loads.length === 1, 2_000, "the load");
      // The next block asks again only once the failure was taken in: then the first has seen it too.
      const second = await mount({ lang: "t-gone", text: "kept too" });
      try {
        await eventually(() => loads.length === 2, 2_000, "the second load");
        for (const { host } of [first, second]) {
          expect(shown(host)).toBe("code");
          expect(switches(host)).toEqual([]);
          expect(host.textContent).not.toMatch(/error|did not load/i);
        }
        expect([code(first.host), code(second.host)]).toEqual(["kept", "kept too"]);
      } finally {
        second.unmount();
      }
    } finally {
      first.unmount();
    }
  });

  test("a viewer that throws while drawing leaves the code, with no error box", async () => {
    // React logs what a boundary caught; the harness puts `console.error` back after each test.
    console.error = () => {};
    await viewer("t-throws", () => {
      throw new Error("bad diagram");
    });
    const { host, unmount } = await mount({ lang: "t-throws", text: "graph ??" });
    try {
      await eventually(() => loads.includes("t-throws"), 2_000, "the load");
      await eventually(() => code(host) === "graph ??", 2_000, "the code back");
      expect(shown(host)).toBe("code");
      expect(switches(host)).toEqual([]);
      expect(host.textContent).not.toContain("bad diagram");
    } finally {
      unmount();
    }
  });

  test("a viewer that says it cannot draw the block leaves the code", async () => {
    await viewer("t-refuses", ({ onFail }) => {
      queueMicrotask(onFail);
      return "for a moment";
    });
    const { host, unmount } = await mount({ lang: "t-refuses", text: "x = ?" });
    try {
      await eventually(() => loads.includes("t-refuses"), 2_000, "the load");
      await eventually(() => code(host) === "x = ?", 2_000, "the code back");
      expect(shown(host)).toBe("code");
      expect(switches(host)).toEqual([]);
    } finally {
      unmount();
    }
  });

  test("a block still being written is code and asks for no viewer", async () => {
    await viewer("t-growing", () => "drawn");
    await viewer("t-whole", () => "drawn");
    const growing = await mount({ lang: "t-growing", text: "half", growing: true });
    // A whole block mounted after it, drawn: by then the growing block has had its turn to ask, and did not.
    const whole = await mount({ lang: "t-whole", text: "all" });
    try {
      await eventually(() => shown(whole.host) === "picture", 2_000, "the whole block drawn");
      expect(shown(growing.host)).toBe("code");
      expect(code(growing.host)).toBe("half");
      expect(loads).toEqual(["t-whole"]);
    } finally {
      growing.unmount();
      whole.unmount();
    }
  });
});
