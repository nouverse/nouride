/**
 * What can be pressed shows the hand. Tailwind 4 leaves a `<button>` the arrow and daisyUI gives the hand to `.btn`
 * alone, so a button that is a card, a chip or a round face (the floating chat's) looked like nothing could be done
 * with it. `main.css` has one rule for it, in the base layer, where a class that says a cursor still wins. This reads
 * that rule out of the stylesheet and applies it in a DOM, to what it must and must not reach.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Window } from "happy-dom";

const SRC = join(dirname(import.meta.path), "..", "src");
const css = readFileSync(join(SRC, "styles", "main.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The base layer's own text, braces balanced. */
function baseLayer(): string {
  const start = css.indexOf("@layer base {");
  let depth = 0;
  for (let at = css.indexOf("{", start); start >= 0 && at < css.length; at += 1) {
    if (css[at] === "{") depth += 1;
    if (css[at] === "}" && --depth === 0) return css.slice(start, at + 1);
  }
  return "";
}

test("an enabled button, a thing with a button's role and a summary show the hand; one that cannot be pressed does not", () => {
  const rule = /([^{}]+)\{\s*cursor:\s*pointer;\s*\}/.exec(baseLayer());
  expect(rule?.[1]?.trim()).toBeTruthy();
  const window = new Window();
  const document = window.document;
  document.head.innerHTML = `<style>${rule![1]} { cursor: pointer; }</style>`;
  document.body.innerHTML = `
    <button id="plain">a card</button>
    <button id="off" disabled>off</button>
    <div id="role" role="button">a row</div>
    <div id="role-off" role="button" aria-disabled="true">a row</div>
    <details><summary id="summary">Why</summary></details>
    <div id="text">words</div>`;
  const cursor = (id: string) => window.getComputedStyle(document.getElementById(id)!).cursor;
  expect([cursor("plain"), cursor("role"), cursor("summary")]).toEqual(["pointer", "pointer", "pointer"]);
  for (const id of ["off", "role-off", "text"]) expect(cursor(id)).not.toBe("pointer");
});

test("the floating chat's button is a button of its own, with no cursor of its own to say otherwise", () => {
  const chat = readFileSync(join(SRC, "commons", "components", "floating-chat", "FloatingChat.tsx"), "utf8");
  const button = /<button\s+ref=\{button\}[\s\S]*?<\/button>/.exec(chat)?.[0] ?? "";
  expect(button).toContain('type="button"');
  expect(button).not.toMatch(/cursor-(?!pointer)/);
});
