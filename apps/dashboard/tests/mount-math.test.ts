/**
 * Formulas in an agent's text, typeset with KaTeX (`viewers/math.tsx`, a chunk of its own): inline `$..$`, `\(..\)` and
 * `$$..$$`; a block in `$$..$$`, `\[..\]` or a fence named `math` or `latex`.
 *
 * Strict about what opens one: amounts in dollars stay text, a formula inside code stays code, a formula KaTeX cannot
 * read is the text as written, and one still being written is code. Nothing a formula says makes a link.
 */

import { describe, expect, test } from "bun:test";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

async function draw(source: string, ready: (host: HTMLElement) => boolean) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Markdown } = await import("@/commons/components/ui/Markdown");
  const host = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.appendChild(host as never);
  const root = createRoot(host);
  root.render(React.createElement(Markdown, { source }));
  try {
    await eventually(() => ready(host), 5_000, "the formulas");
    return {
      inline: [...host.querySelectorAll('[data-formula="inline"]')].map((formula) => formula.querySelector("annotation")?.textContent ?? ""),
      blocks: [...host.querySelectorAll('[data-formula="block"]')].map((formula) => formula.querySelector("annotation")?.textContent ?? ""),
      code: [...host.querySelectorAll("pre code, p code")].map((code) => code.textContent ?? ""),
      text: host.textContent ?? "",
      displays: host.querySelectorAll(".katex-display").length,
      links: host.querySelectorAll("a").length,
      classed: host.querySelectorAll(".btn").length,
    };
  } finally {
    root.unmount();
    host.remove();
  }
}

const typeset = (count: number) => (host: HTMLElement) => host.querySelectorAll("[data-formula] .katex").length === count;

describe("formulas in the line", () => {
  test("$..$, \\(..\\) and $$..$$ are typeset, each from what it says", async () => {
    const seen = await draw("Area $\\pi r^2$, sum \\(a+b\\), and $$e^{i\\pi}+1=0$$ here; one letter $x$.", typeset(4));
    expect(seen.inline).toEqual(["\\pi r^2", "a+b", "e^{i\\pi}+1=0", "x"]);
    expect(seen.text).not.toContain("$");
  });

  test("amounts in dollars stay text", async () => {
    const line = "It costs $5 and $10, or US$5-$10 a month; $ 3 $ is not one, nor is $4$5.";
    const seen = await draw(`${line}\n\nAnd $y$ is.`, typeset(1));
    expect(seen.inline).toEqual(["y"]);
    expect(seen.text).toContain(line);
  });

  test("a formula inside code stays code", async () => {
    const seen = await draw(["Run `echo $x$` and:", "", "```bash", "echo $HOME$ $$y$$", "```", "", "```text", "$$", "a^2", "$$", "```", "", "then $z$."].join("\n"), typeset(1));
    expect(seen.inline).toEqual(["z"]);
    expect(seen.blocks).toEqual([]);
    expect(seen.code).toEqual(["echo $x$", "echo $HOME$ $$y$$", "$$\na^2\n$$"]);
  });

  test("one KaTeX cannot read is the text as written", async () => {
    const seen = await draw("Broken $\\frac{1$ and fine $q$.", typeset(1));
    expect(seen.inline).toEqual(["q"]);
    expect(seen.text).toContain("Broken $\\frac{1$ and");
  });

  test("nothing a formula says makes a link or a class of its own", async () => {
    const seen = await draw("A $\\href{javascript:alert(1)}{x}$, $\\url{https://example.com}$ and $\\htmlClass{btn}{y}$; $w$.", (host) => host.querySelectorAll("[data-formula] .katex").length >= 1 && (host.textContent ?? "").includes("w"));
    expect(seen.links).toBe(0);
    expect(seen.classed).toBe(0);
  });
});

describe("formulas as blocks", () => {
  test("$$ and \\[ blocks, a whole line in $$, and fences named math and latex", async () => {
    const source = ["$$", "\\sum_{i=1}^n i", "$$", "", "\\[", "a^2 + b^2 = c^2", "\\]", "", "$$ E = mc^2 $$", "", "```math", "\\frac{a}{b}", "```", "", "```latex", "\\sqrt{2}", "```"].join("\n");
    const seen = await draw(source, typeset(5));
    expect(seen.blocks).toEqual(["\\sum_{i=1}^n i", "a^2 + b^2 = c^2", "E = mc^2", "\\frac{a}{b}", "\\sqrt{2}"]);
    expect(seen.displays).toBe(5);
    expect(seen.code).toEqual([]);
  });

  test("a block still being written is code", async () => {
    const seen = await draw(["Before $v$.", "", "$$", "\\int_0^1 x"].join("\n"), typeset(1));
    expect(seen.blocks).toEqual([]);
    expect(seen.code).toEqual(["\\int_0^1 x"]);
  });

  test("a line that only starts with $$ is text", async () => {
    const seen = await draw("$$5 is the price, $u$.", typeset(1));
    expect(seen.inline).toEqual(["u"]);
    expect(seen.text).toContain("$$5 is the price");
  });
});
