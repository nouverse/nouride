/**
 * Markdown as it reaches a phone.
 *
 * Two things are being pinned here. The first is that WhatsApp gets WhatsApp's marks rather than
 * markdown's — the bug that put a literal `**bold**` in every reply the adapter ever sent. The
 * second is the block layer both mobile platforms share: a table stops being a grid, because a grid
 * on a phone is a column of fragments with no way to tell which row a number belongs to.
 */

import { describe, expect, test } from "bun:test";
import { toTelegramHtml } from "../src/channels/telegram/html.ts";
import { toWhatsAppText } from "../src/channels/whatsapp/format.ts";
import { parseMarkdown, toPlainText } from "../src/commons/markdown.ts";

const wa = (source: string): string => toWhatsAppText(parseMarkdown(source));
const html = (source: string): string => toTelegramHtml(parseMarkdown(source));

describe("whatsapp marks", () => {
  test("markdown emphasis becomes WhatsApp emphasis", () => {
    // The bug: every one of these arrived on the phone with its markdown markers intact.
    expect(wa("**bold** and *italic* and ~~gone~~")).toBe("*bold* and _italic_ and ~gone~");
    expect(wa("__also bold__ and _also italic_")).toBe("*also bold* and _also italic_");
  });

  test("code keeps its backticks and a fence keeps its lines", () => {
    expect(wa("run `a && b` now")).toBe("run `a && b` now");
    // The language tag is dropped: there is no highlighting, so `ts` would just be part of the
    // listing's first line.
    expect(wa('```ts\nconst x = 1;\n```')).toBe("```\nconst x = 1;\n```");
  });

  test("a link shows its target, because there is no anchor to hide it behind", () => {
    expect(wa("[docs](https://example.com/a)")).toBe("docs (https://example.com/a)");
    // Showing the URL twice is noise when the words already are the URL.
    expect(wa("[https://e.com](https://e.com)")).toBe("https://e.com");
    // A refused scheme keeps the words and loses the target, exactly as on Telegram.
    expect(wa("[click](javascript:alert(1))")).toBe("click");
    // No words at all: the target alone, not an empty pair of words before it.
    expect(wa("[](https://e.com)")).toBe("https://e.com");
  });

  test("a mark is never opened next to a space", () => {
    // WhatsApp will not open a mark followed by whitespace, so `* text *` draws as three literal
    // tokens. Markdown captures the padding happily, and a table cell is where it comes from.
    expect(wa("** padded **")).toBe(" *padded* ");
  });

  test("prose is passed through untouched", () => {
    expect(wa("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(wa("see my_file_name.txt")).toBe("see my_file_name.txt");
  });
});

describe("headings and quotes", () => {
  test("a heading becomes bold on both phones", () => {
    expect(html("## Ringkasan")).toBe("<b>Ringkasan</b>");
    expect(wa("## Ringkasan")).toBe("*Ringkasan*");
    // Closing hashes are a marker, not content.
    expect(wa("### Title ###")).toBe("*Title*");
  });

  test("a hash that is not a heading stays a hash", () => {
    expect(wa("#hashtag and C# too")).toBe("#hashtag and C# too");
  });

  test("the lines around a block survive it", () => {
    // The bug this exists for: lifting a block out of the run dropped the newlines on either side,
    // welding the heading to the sentence before and the sentence after.
    expect(wa("intro\n# Judul\nisi")).toBe("intro\n*Judul*\nisi");
    expect(html("intro\n# Judul\nisi")).toBe("intro\n<b>Judul</b>\nisi");
  });

  test("a quote is marked on every line, not just the first", () => {
    expect(wa("> satu\n> dua")).toBe("> satu\n> dua");
    expect(html("> satu\n> dua")).toBe("<blockquote>satu\ndua</blockquote>");
  });
});

describe("tables", () => {
  const wide = [
    "| Kota | Suhu | Kelembapan |",
    "| --- | ---: | :-: |",
    "| Jakarta | 31 | 78% |",
    "| Bandung | 24 | 85% |",
  ].join("\n");

  test("a wide table becomes one record per row, with no caption", () => {
    // No caption here: every value is labelled inline and the first column has become a heading that
    // names itself. The live reply that added one opened with a bare `*Dimensi*` floating above the
    // records, and the first thing it was asked was whether the message had been cut off.
    expect(wa(wide)).toBe(
      "*Jakarta*\nSuhu: 31\nKelembapan: 78%\n\n*Bandung*\nSuhu: 24\nKelembapan: 85%",
    );
  });

  test("the same layout is drawn with Telegram's marks", () => {
    // The decision is shared; only the marks differ. Two adapters disagreeing about the layout is
    // what putting `flattenTable` in the parser prevents.
    expect(html(wide)).toBe(
      "<b>Jakarta</b>\nSuhu: 31\nKelembapan: 78%\n\n<b>Bandung</b>\nSuhu: 24\nKelembapan: 85%",
    );
  });

  test("a two-column table is a key and its value on one line", () => {
    const table = ["| Field | Value |", "|---|---|", "| Nama | Gading |", "| Umur | 28 |"].join("\n");
    expect(wa(table)).toBe("*Field · Value*\n\n*Nama*: Gading\n*Umur*: 28");
  });

  test("the second column's label survives, because it is not always boilerplate", () => {
    // The bug this replaced: `| Kota | Suhu |` flattened to `*Jakarta*: 31` and left the reader to
    // guess what 31 was. One caption line covers the whole table however many rows arrive, which is
    // why it beats repeating the label on each of them.
    const table = ["| Kota | Suhu |", "|---|---|", "| Jakarta | 31 |", "| Bandung | 24 |"].join("\n");
    expect(wa(table)).toBe("*Kota · Suhu*\n\n*Jakarta*: 31\n*Bandung*: 24");
  });

  test("a comparison table's axis header does not become a floating word", () => {
    // The live regression, verbatim in shape: three columns whose first header is the boilerplate
    // name of the axis. It reads as a truncated message, not as a caption.
    const table = [
      "| Dimensi | Pi Agent | Nouride |",
      "| :--- | :--- | :--- |",
      "| **Engine Stack** | Node.js | Bun |",
    ].join("\n");
    expect(wa(table)).toBe("*Engine Stack*\nPi Agent: Node.js\nNouride: Bun");
  });

  test("an unlabelled header gets no caption rather than a stray separator", () => {
    const table = ["|  | Suhu |", "|---|---|", "| Jakarta | 31 |"].join("\n");
    expect(wa(table)).toBe("*Suhu*\n\n*Jakarta*: 31");
  });

  test("outer pipes are optional and cell formatting survives", () => {
    const table = ["Field | Value", "---|---", "**Nama** | `gading`"].join("\n");
    expect(wa(table)).toBe("*Field · Value*\n\n*Nama*: `gading`");
  });

  test("an escaped pipe stays inside its cell", () => {
    // A table of shell commands is a table a model writes often, and it is the one place this
    // matters.
    const table = ["| Cmd | What |", "|---|---|", "| `ps \\| wc` | count |"].join("\n");
    expect(wa(table)).toBe("*Cmd · What*\n\n*`ps | wc`*: count");
  });

  test("an empty cell is skipped rather than labelled with nothing", () => {
    const table = ["| A | B | C |", "|---|---|---|", "| one |  | three |"].join("\n");
    expect(wa(table)).toBe("*one*\nC: three");
  });

  test("a header with no rows still says what it had", () => {
    // What a truncated reply produces. Every label goes in, since no row is coming to show any of
    // them inline.
    expect(wa("| A | B |\n|---|---|")).toBe("*A · B*");
    expect(wa("| A | B | C |\n|---|---|---|")).toBe("*A · B · C*");
  });

  test("prose after a table is prose", () => {
    // Body rows run until a line with no pipe in it. A model writes a table and then keeps talking,
    // routinely with no blank line in between.
    expect(wa("| A | B |\n|---|---|\n| 1 | 2 |\nsegitu saja.")).toBe(
      "*A · B*\n\n*1*: 2\nsegitu saja.",
    );
  });

  test("a sentence containing a pipe is not a table", () => {
    expect(wa("run a | b to pipe it")).toBe("run a | b to pipe it");
    // A single column over a delimiter is legal markdown and never intentional.
    expect(wa("note | see below\n| --- |")).toBe("note | see below\n| --- |");
  });

  test("a table inside a fenced block is left alone", () => {
    // Inside a fence it is a listing, and a listing is quoted verbatim or it is wrong.
    const fenced = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    expect(wa(fenced)).toBe("```\n| A | B |\n|---|---|\n| 1 | 2 |\n```");
  });

  test("the plain-text fallback flattens too", () => {
    // The path Telegram takes when it rejects a formatted send. Falling back must not put the grid
    // back.
    expect(toPlainText(parseMarkdown(wide))).toBe(
      "Jakarta\nSuhu: 31\nKelembapan: 78%\n\nBandung\nSuhu: 24\nKelembapan: 85%",
    );
  });
});
