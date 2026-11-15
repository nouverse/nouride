/**
 * Save as PDF on a markdown preview (`MarkdownPreview`) prints what the viewers drew: an `svg` block as its picture, a
 * formula as MathML the browser sets on its own, a block that could not be drawn as its code, and no block's head
 * (its language, the switch, copy). The PDF itself is read in a real browser.
 */

import { describe, expect, test } from "bun:test";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const SOURCE = ["# Report", "", "Area $\\pi r^2$.", "", "```svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', "```", "", "$$", "E = mc^2", "$$", "", "```bash", "echo kept", "```"].join("\n");

describe("Save as PDF of a preview", () => {
  test("prints the pictures and formulas as drawn, the code as code, and no block's head", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { MarkdownPreview } = await import("@/commons/components/ui/MarkdownPreview");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    root.render(React.createElement(MarkdownPreview, { name: "report.md", source: SOURCE, onClose: () => {} }));
    try {
      const doc = dom.document as unknown as Document;
      await eventually(() => doc.querySelectorAll('[data-viewer="picture"]').length === 2 && doc.querySelectorAll("[data-formula] .katex").length === 2, 5_000, "the viewers");
      [...doc.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "Save as PDF")!.click();
      await eventually(() => doc.querySelector("iframe[data-print]") !== null, 2_000, "the print frame");
      const page = doc.querySelector("iframe[data-print]")!.getAttribute("srcdoc") ?? "";
      const printed = new dom.DOMParser().parseFromString(page, "text/html") as unknown as Document;
      const style = printed.querySelector("style")!.textContent ?? "";
      // The picture, the formulas as MathML with KaTeX's own layout left out, and the code.
      expect(printed.querySelector("img")!.getAttribute("src")!.startsWith("data:image/svg+xml")).toBe(true);
      expect([...printed.querySelectorAll("math annotation")].map((one) => one.textContent)).toEqual(["\\pi r^2", "E = mc^2"]);
      expect(style).toContain(".katex-html { display: none; }");
      expect(printed.querySelector("pre code")!.textContent).toBe("echo kept");
      // Every block's head is there in the markup, and the page leaves it out.
      expect(printed.querySelectorAll("[data-block-head]").length).toBe(3);
      expect(style).toContain("[data-block-head] { display: none; }");
    } finally {
      root.unmount();
      host.remove();
      for (const frame of dom.document.querySelectorAll("iframe[data-print]")) frame.remove();
    }
  });
});
