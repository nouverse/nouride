/**
 * The parser's own decisions, read off the tree it builds rather than off one platform's rendering of it.
 *
 * `markdown.test.ts` and `whatsapp-format.test.ts` hold the rendered output; each case here is a mutant of
 * `commons/markdown.ts` the 0.7.11 mutation sweep found neither catching — mostly because a renderer drops what was
 * wrong (a heading's level), or because the input that tells the two apart was never written: text on both sides of a
 * fence, a line after a quote, a table with one column.
 */

import { describe, expect, test } from "bun:test";
import { parseMarkdown, toPlainText } from "../src/commons/markdown.ts";
import { toTelegramHtml } from "../src/channels/telegram/html.ts";
import { toWhatsAppText } from "../src/channels/whatsapp/format.ts";

const text = (value: string) => ({ type: "text", value });
const parse = (source: string): unknown[] => parseMarkdown(source);
const types = (source: string) => parseMarkdown(source).map((node) => node.type);

describe("fences", () => {
  test("text on both sides of a fence stays where it was, once", () => {
    expect(parse("before\n```\ncode\n```\nafter")).toEqual([text("before"), { type: "pre", value: "code" }, text("after")]);
  });

  test("the language loses trailing blanks, and an indented closing fence still closes", () => {
    expect(parse("```ts   \nx\n  ```\nafter")).toEqual([{ type: "pre", value: "x", lang: "ts" }, text("after")]);
  });

  test("backticks in the middle of a line, or followed by more backticks, are not a fence", () => {
    expect(types("use ``` to fence")).toEqual(["text"]);
    expect(types("```js``` hi")).not.toContain("pre");
  });
});

describe("headings and quotes", () => {
  test("a heading keeps its level", () => {
    expect(parse("## Title")).toEqual([{ type: "heading", level: 2, children: [text("Title")] }]);
  });

  test("a quote takes its own lines and no others, with or without the space after `>`", () => {
    expect(parse("para\n>one\n> two\nafter")).toEqual([
      text("para"),
      text("\n"),
      { type: "quote", children: [text("one\ntwo")] },
      text("\n"),
      text("after"),
    ]);
  });
});

describe("tables", () => {
  test("one column is not a table, and nor is a line after the header that is not a delimiter", () => {
    expect(types("| only |\n| --- | --- |\n| a | b |")).not.toContain("table");
    expect(types("a | b\nnext line")).not.toContain("table");
    for (const delimiter of ["c | d", "| --- | x |", "| a--- | --- |", "| ---x | --- |", "| :: | :: |"]) {
      expect(types(`a | b\n${delimiter}`)).not.toContain("table");
    }
  });

  test("a header with no rows ends at its delimiter, and the line after it is prose", () => {
    expect(toPlainText(parseMarkdown("| A | B |\n| --- | --- |\nprose"))).toBe("A · B\nprose");
  });

  test("an indented row still splits on its pipes, and every escaped pipe stays in its cell", () => {
    const rows = parseMarkdown("  | Cmd | Note |\n  | --- | --- |\n  | a \\| b \\| c | x |");
    expect(rows[0]?.type).toBe("table");
    expect(toPlainText(rows)).toBe("Cmd · Note\n\na | b | c: x");
  });

  test("a two-column row with nothing in its value is the name alone — marks around nothing are nothing", () => {
    expect(toWhatsAppText(parseMarkdown("| Kota | Suhu |\n|---|---|\n| Jakarta | |\n| Bogor | ** ** |"))).toBe(
      "*Kota · Suhu*\n\n*Jakarta*\n*Bogor*",
    );
  });

  test("a wide row skips a cell that is only marks around nothing", () => {
    expect(toPlainText(parseMarkdown("| N | A | B |\n|---|---|---|\n| x | ** ** | 2 |"))).toBe("x\nB: 2");
  });

  test("a header of blank labels draws no empty caption on Telegram", () => {
    expect(toTelegramHtml(parseMarkdown("| | |\n|---|---|\n| Jakarta | 31 |"))).toBe("<b>Jakarta</b>: 31");
  });

  test("a header cell's own padding inside its marks is not part of the caption", () => {
    expect(toPlainText(parseMarkdown("| ** Kota ** | Suhu |\n|---|---|\n| Jakarta | 31 |"))).toBe("Kota · Suhu\n\nJakarta: 31");
  });
});

describe("inline", () => {
  test("empty backticks are text, an empty link text is still a link, and an empty target is not one", () => {
    expect(parse("a `` b")).toEqual([text("a `` b")]);
    expect(parse("[](https://example.invalid)")).toEqual([{ type: "link", href: "https://example.invalid", children: [] }]);
    expect(types("[a]()")).toEqual(["text"]);
    expect(parse("[a](https://example.invalid/f())")).toEqual([
      { type: "link", href: "https://example.invalid/f()", children: [text("a")] },
    ]);
  });

  test("the leftmost construct wins where two overlap, whichever rule is listed first", () => {
    expect(parse("*a `b* c`")).toEqual([{ type: "italic", children: [text("a `b")] }, text(" c`")]);
  });

  test("plain text keeps a fenced block's contents", () => {
    expect(toPlainText(parseMarkdown("see\n```\nls -la\n```"))).toBe("seels -la");
  });
});
