/**
 * A `mermaid` block drawn as its diagram (`commons/components/ui/viewers/mermaid.tsx`): Mermaid in its strict mode, its
 * labels SVG text and never HTML, no error box of its own, the theme's colours; a diagram it cannot read is the code it
 * was.
 *
 * What is held here and what is not. happy-dom lays nothing out and its DOMPurify, which Mermaid's strict mode runs, drops
 * an `<svg>` whole (and keeps an `onerror`), so a diagram cannot be drawn here as a browser draws it. The settings that
 * make it safe are read here; the diagram drawn, a label holding markup that runs nothing and a click directive that
 * does nothing are seen in a real browser (the release's browser round).
 */

import { describe, expect, test } from "bun:test";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

describe("a mermaid block", () => {
  test("is drawn in strict mode, its labels as text, with no error box of Mermaid's own", async () => {
    const { configFor } = await import("@/commons/components/ui/viewers/mermaid");
    const config = configFor(true);
    expect(config.securityLevel).toBe("strict");
    expect(config.htmlLabels).toBe(false);
    expect(config.flowchart?.htmlLabels).toBe(false);
    expect(config.suppressErrorRendering).toBe(true);
    expect(config.startOnLoad).toBe(false);
  });

  test("in the theme's colours, read off the page", async () => {
    const root = dom.document.documentElement;
    root.style.setProperty("--color-base-200", "#123456");
    root.style.setProperty("--color-base-content", "#ABCDEF");
    root.style.setProperty("--color-primary", "#f0a");
    try {
      const { configFor } = await import("@/commons/components/ui/viewers/mermaid");
      const config = configFor(false);
      expect(config.theme).toBe("base");
      expect(config.themeVariables).toMatchObject({ primaryColor: "#123456", primaryTextColor: "#abcdef", lineColor: "#abcdef", primaryBorderColor: "#ff00aa", darkMode: false });
    } finally {
      for (const name of ["--color-base-200", "--color-base-content", "--color-primary"]) root.style.removeProperty(name);
    }
  });

  test("a diagram Mermaid cannot read is the code it was, with no error box", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { CodeBlock } = await import("@/commons/components/ui/CodeBlock");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    const broken = "graph TD\n  A --> (((";
    // The block is code while the viewer loads, so what it was shown as is followed: the drawing tried, then the code.
    const shown: string[] = [];
    const watch = new dom.MutationObserver(() => {
      const now = host.querySelector("[data-viewer]")?.getAttribute("data-viewer");
      if (now && shown.at(-1) !== now) shown.push(now);
    });
    watch.observe(host as never, { subtree: true, childList: true, attributes: true });
    root.render(React.createElement(CodeBlock, { lang: "mermaid", text: broken }));
    try {
      await eventually(() => shown.includes("picture") && shown.at(-1) === "code", 10_000, "the drawing tried and given up");
      expect(host.querySelector("pre code")?.textContent).toBe(broken);
      expect(host.querySelector('[role="group"]')).toBeNull();
      expect(dom.document.body.textContent).not.toMatch(/syntax error|parse error/i);
    } finally {
      watch.disconnect();
      root.unmount();
      host.remove();
    }
  });
});
