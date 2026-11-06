/**
 * Type on a phone (0.8.12). The owner's iPhone zoomed into the login form the moment a field was focused — iOS does
 * that to a field whose text is under 16px, and every field here was 12–14px — and read the rest at 10–11px. `main.css`
 * has two rules for it: every field 16px on a phone or to a finger, and nothing under 12px on a phone. This loads them
 * into a DOM that can be told the window's width, beside the utilities as Tailwind writes them, and reads what a browser
 * would apply. Then it checks that every arbitrary size under 12px in `src` is one the rule names, and that no text is
 * written smaller for a phone than for a desktop.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Window } from "happy-dom";

const SRC = join(dirname(import.meta.path), "..", "src");
const css = readFileSync(join(SRC, "styles", "main.css"), "utf8");

/** Every `@media` block in main.css that names a phone's width, braces balanced. */
function phoneBlocks(): string {
  const blocks: string[] = [];
  for (const match of css.matchAll(/@media[^{]*max-width:\s*639px[^{]*\{/g)) {
    let depth = 0;
    for (let at = css.indexOf("{", match.index); at < css.length; at += 1) {
      if (css[at] === "{") depth += 1;
      if (css[at] === "}" && --depth === 0) {
        blocks.push(css.slice(match.index, at + 1));
        break;
      }
    }
  }
  return blocks.join("\n");
}
const rules = phoneBlocks();

/** The utilities a field and a line of meta text wear, as Tailwind 4 emits them. */
const UTILITIES = `
  .text-xs { font-size: 0.75rem; }
  .text-sm { font-size: 0.875rem; }
  .text-\\[10px\\] { font-size: 10px; }
  .text-\\[11px\\] { font-size: 11px; }
`;

/** What a browser applies to `<tag class>` in a window `width` wide — its font size unless another property is named. */
function fontSize(width: number, tag: string, className: string, type?: string, property = "font-size"): string {
  const window = new Window({ width, height: 844 });
  try {
    window.document.head.innerHTML = `<style>${UTILITIES}\n${rules}</style>`;
    const element = window.document.createElement(tag);
    element.className = className;
    if (type) element.setAttribute("type", type);
    window.document.body.appendChild(element);
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } finally {
    void window.happyDOM.close();
  }
}

describe("a field on a phone", () => {
  test("main.css has the rules", () => {
    expect(rules).toContain("font-size: 16px");
    expect(rules).toContain("font-size: 12px");
  });

  test("is 16px, so iOS does not zoom the page onto it — whatever size the field asked for", () => {
    expect(fontSize(390, "input", "input input-sm text-xs")).toBe("16px");
    expect(fontSize(390, "select", "select select-sm text-xs")).toBe("16px");
    expect(fontSize(390, "textarea", "textarea text-sm")).toBe("16px");
    expect(fontSize(375, "input", "input text-sm", "password")).toBe("16px");
  });

  test("keeps its own size on a desktop", () => {
    expect(fontSize(1440, "input", "input input-sm text-xs")).toBe("12px");
    expect(fontSize(1440, "textarea", "textarea text-sm")).toBe("14px");
  });

  test("is 16px to a finger on a wider screen too — an iPad zooms as an iPhone does", () => {
    const fields = /input:not\(\[type="checkbox"\][^{]*,\s*select,\s*textarea\s*\{\s*font-size: 16px !important;/;
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(coarse).toMatch(fields);
    expect(rules).toMatch(fields);
  });
});

describe("meta text on a phone", () => {
  test("is 12px where a desktop draws it at 10 or 11 — a tab's count in daisyUI's smallest badge too", () => {
    expect(fontSize(390, "span", "text-[10px]")).toBe("12px");
    expect(fontSize(390, "span", "text-[11px]")).toBe("12px");
    expect(fontSize(390, "span", "badge badge-xs")).toBe("12px");
    expect(fontSize(1440, "span", "text-[10px]")).toBe("10px");
  });

  test("and the smallest button is 32px tall there, where daisyUI's is 24", () => {
    expect(fontSize(390, "button", "btn btn-xs", undefined, "--size")).toBe("2rem");
    expect(fontSize(1440, "button", "btn btn-xs", undefined, "--size")).toBe("");
  });
});

/** Every string literal in `src`'s code, each as its words — where class names live. */
function words(): { file: string; word: string }[] {
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
    });
  })(SRC);
  return files.flatMap((path) => {
    const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    return [...code.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`]*)`/g)].flatMap((m) =>
      (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/).filter(Boolean).map((word) => ({ file: relative(SRC, path), word })),
    );
  });
}

describe("every size in src", () => {
  const all = words();

  test("under 12px is one the phone rule lifts", () => {
    const tiny = all.filter(({ word }) => {
      const px = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(word)?.[1];
      return px !== undefined && Number(px) < 12;
    });
    expect(tiny.length).toBeGreaterThan(100);
    const missed = tiny.filter(({ word }) => !rules.includes(`.${word.replace(/[[\]]/g, (c) => `\\${c}`)}`));
    expect(missed.map(({ file, word }) => `${file}: ${word}`)).toEqual([]);
  });

  test("in em, below 1em, is one the phone rule floors at 12px — inline code was 10.2px in a 12px line", () => {
    const relative = all.filter(({ word }) => {
      const em = /^text-\[(\d*\.\d+)em\]$/.exec(word)?.[1];
      return em !== undefined && Number(em) < 1;
    });
    expect(relative.length).toBeGreaterThan(0);
    const missed = relative.filter(({ word }) => !rules.includes(`.${word.replace(/[[\].]/g, (c) => `\\${c}`)} {\n    font-size: max(`));
    expect(missed.map(({ file, word }) => `${file}: ${word}`)).toEqual([]);
  });

  test("is never smaller on a phone than on a desktop for copy — 12px there was body text read on a phone", () => {
    const shrunk = all
      .map(({ file, word }, i) => ({ file, word, next: all[i + 1]?.file === file ? all[i + 1]!.word : "" }))
      .filter(({ word, next }) => /^text-(xs|\[\d+px\])$/.test(word) && /^(sm|md|lg):text-(sm|base|lg)$/.test(next));
    expect(shrunk.map(({ file, word, next }) => `${file}: ${word} ${next}`)).toEqual([]);
  });
});
