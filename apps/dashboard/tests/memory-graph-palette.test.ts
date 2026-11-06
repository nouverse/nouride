/**
 * The memory graph's colours are the theme's (dash-practice-design-language-divergence).
 *
 * `palette.ts` repeated the theme's hex values, because a canvas cannot draw with `var(--…)`: the re-theme would
 * have changed every page and left the graph in the old neon. It now reads the variables off `<html>`. This runs
 * the hook in a DOM whose stylesheet carries the two themes exactly as `main.css` declares them, so a palette that
 * stopped reading them — or read them once and kept them across a theme switch — fails here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Window } from "happy-dom";
import type { Palette } from "@/modules/memories/graph/palette";
import { sleep } from "./wait.ts";

const css = readFileSync(join(dirname(import.meta.path), "..", "src", "styles", "main.css"), "utf8");

/** Each theme's `--color-*` declarations, from `main.css`. */
const themes = Object.fromEntries(
  [...css.matchAll(/@plugin\s+"daisyui\/theme"\s*\{([\s\S]*?)\n\}/g)].map((m) => {
    const block = m[1]!.replace(/\/\*[\s\S]*?\*\//g, "");
    const name = /\bname:\s*"([^"]+)"/.exec(block)![1]!;
    return [name, Object.fromEntries([...block.matchAll(/^\s*(--color-[\w-]+):\s*([^;]+);/gm)].map((v) => [v[1]!, v[2]!.trim()]))];
  }),
) as Record<string, Record<string, string>>;

/** The themes as the browser gets them: a rule per `data-theme`, plus one written short, as a minifier may. */
const STYLESHEET = [
  ...Object.entries(themes).map(([name, vars]) => `[data-theme="${name}"]{${Object.entries(vars).map(([key, value]) => `${key}:${value}`).join(";")}}`),
  `[data-theme="short"]{--color-info:#abc;--color-base-content:#123456}`,
  `html{font-family:"Manrope", ui-sans-serif, sans-serif}`,
].join("\n");

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle"] as const;
let dom: Window;
const before = new Map<string, unknown>();

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  dom.document.head.innerHTML = `<style>${STYLESHEET}</style>`;
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of GLOBALS) {
    if (key in globals) before.set(key, globals[key]);
    globals[key] = (dom as unknown as Record<string, unknown>)[key];
  }
});

afterAll(async () => {
  // React's last commit reads `window` after unmount; let it run before the globals go.
  await sleep(30);
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of GLOBALS) {
    if (before.has(key)) globals[key] = before.get(key);
    else delete globals[key];
  }
  await dom.happyDOM.close();
});

const tick = () => sleep(15);

/** Mount a component that holds the hook; `seen()` is what it last returned. */
async function mountPalette(): Promise<{ seen: () => Palette; unmount: () => void }> {
  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { usePalette } = await import("@/modules/memories/graph/palette");
  let last: Palette | undefined;
  const Probe = () => {
    last = usePalette();
    return null;
  };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  root.render(createElement(Probe));
  for (let i = 0; i < 3; i += 1) await tick();
  return {
    seen: () => last!,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}

/** What the palette should hold for a theme, from the theme's own declarations. */
const expected = (name: string) => {
  const value = (key: string) => themes[name]?.[key] ?? `${name} declares no ${key}`;
  return {
    kinds: {
      episode: value("--color-info"),
      person: value("--color-accent"),
      tag: value("--color-secondary"),
      agent: value("--color-primary"),
      // The knowledge layer (0.8.20): green for a collection, the page's ink for a document.
      collection: value("--color-success"),
      document: value("--color-base-content"),
    },
    text: value("--color-base-content"),
    backdrop: value("--color-base-200"),
  };
};

describe("the memory graph's palette", () => {
  test("is the theme's colours, and follows a switch of theme", async () => {
    expect(Object.keys(themes).sort()).toEqual(["nouride", "nouride-light"]);
    dom.document.documentElement.setAttribute("data-theme", "nouride");
    const graph = await mountPalette();
    try {
      const dark = graph.seen();
      expect({ kinds: dark.kinds, text: dark.text, backdrop: dark.backdrop }).toEqual(expected("nouride"));
      // The links and the faint labels are the ink with an alpha on it, so they change with it.
      expect(dark.link.startsWith(themes.nouride!["--color-base-content"]!)).toBe(true);
      expect(dark.muted).toMatch(/^#[0-9a-f]{8}$/);

      dom.document.documentElement.setAttribute("data-theme", "nouride-light");
      for (let i = 0; i < 3; i += 1) await tick();
      const light = graph.seen();
      expect({ kinds: light.kinds, text: light.text, backdrop: light.backdrop }).toEqual(expected("nouride-light"));
      // Not the same palette twice: the two themes do not share a single colour the graph draws with.
      for (const kind of Object.keys(light.kinds) as (keyof Palette["kinds"])[]) expect(light.kinds[kind]).not.toBe(dark.kinds[kind]);
    } finally {
      graph.unmount();
    }
  });

  test("reads a colour written short, as a minifier may write it, as the six digits the canvas needs", async () => {
    dom.document.documentElement.setAttribute("data-theme", "short");
    const graph = await mountPalette();
    try {
      expect(graph.seen().kinds.episode).toBe("#aabbcc");
      expect(graph.seen().related).toBe("#aabbcc40");
      expect(graph.seen().text).toBe("#123456");
    } finally {
      graph.unmount();
    }
  });

  test("labels in the page's face", async () => {
    dom.document.documentElement.setAttribute("data-theme", "nouride");
    const graph = await mountPalette();
    try {
      expect(graph.seen().font).toContain("Manrope");
    } finally {
      graph.unmount();
    }
  });
});
