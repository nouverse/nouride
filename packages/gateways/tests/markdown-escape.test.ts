/**
 * Backslash escapes (0.8.7): `escapeMarkdown` makes free text literal, and the parser reads `\*` as a star — so an
 * approval's reason or a CLI's title with underscores or backticks renders as itself on Telegram and WhatsApp, as
 * Discord already does with the same backslashes.
 */

import { describe, expect, test } from "bun:test";
import { toTelegramHtml } from "../src/channels/telegram/html.ts";
import { escapeMarkdown, parseMarkdown, toPlainText } from "../src/commons/markdown.ts";

describe("escaped markdown", () => {
  test("escaped free text parses back to itself, as plain text nodes only", () => {
    const raw = "# _a_ **b** ~~c~~ `d` > e | f \\ g [h](i) my_file_name.py";
    const nodes = parseMarkdown(escapeMarkdown(raw));
    expect(toPlainText(nodes)).toBe(raw);
    expect(nodes.every((node) => node.type === "text")).toBe(true);
  });

  test("on Telegram, an escaped underscore opens no italic", () => {
    expect(toTelegramHtml(parseMarkdown(`Why: ${escapeMarkdown("edit _x_ now")}.`))).toBe("Why: edit _x_ now.");
  });

  test("a backslash inside inline code stays a backslash", () => {
    expect(parseMarkdown("`a\\_b`")).toEqual([{ type: "code", value: "a\\_b" }]);
  });
});
