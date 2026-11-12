/**
 * The chat's composer row (0.8.12), as it looked on a desktop: the slash button a bold mono "/" that leaned and
 * sat lower than the paperclip beside it, the controls a few pixels under the line of text, and the placeholder running
 * on with the keys. Read from the source:
 * - one line of the box is 40px with its text on a fixed 22px line, centred at 20px; every 32px button in the row sits
 *   4px off the bottom (`mb-1`), centred at the same 20px — a 42px box at a 1.625 line height put the text 5px above;
 * - the slash button is an icon the size and colour of the paperclip;
 * - the placeholder names who is messaged and stops; the keys are said under the box, where there is room for them.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = join(dirname(import.meta.path), "..", "src");
const composer = readFileSync(join(SRC, "commons/components/chat/Composer.tsx"), "utf8");
const attach = readFileSync(join(SRC, "commons/components/ui/FileDrop.tsx"), "utf8");

test("one line of text and the buttons beside it share a centre", () => {
  expect(composer).toContain("min-h-10 px-3 py-[9px] text-sm leading-[22px]");
  expect(composer).not.toContain("min-h-[42px]");
  // Every button in the row: attach, slash, stop (both kinds), send.
  const buttons = [...composer.matchAll(/btn-sm btn-circle[^"`]*/g)].map((m) => m[0]);
  expect(buttons.length).toBeGreaterThanOrEqual(4);
  for (const button of buttons) {
    expect(button).toContain("mb-1");
    expect(button).not.toContain("mb-0.5");
  }
  expect(attach).toContain("btn btn-ghost btn-sm btn-circle shrink-0 text-base-content/65 hover:text-base-content disabled:opacity-30 mb-1");
});

test("the slash button is an icon like the paperclip, not a character", () => {
  expect(composer).toContain("<SquareSlash size={16} />");
  expect(attach).toContain("<Paperclip size={16} />");
  expect(composer).not.toMatch(/>\s*\/\s*<\/button>/);
  expect(composer).not.toContain("font-mono text-base font-bold");
});

test("the placeholder names who is messaged; the keys are said under the box", () => {
  expect(composer).toContain('`Message ${currentAgent?.displayName || "agent"}…`');
  expect(composer).not.toContain("(Enter to send, Shift+Enter for newline)");
  expect(composer).toContain('<span className="hidden shrink-0 sm:inline">Enter to send · Shift+Enter for a new line</span>');
});
