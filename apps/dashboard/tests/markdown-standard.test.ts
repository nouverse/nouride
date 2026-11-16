/**
 * An agent's text drawn as the Markdown a person knows from GitHub and from the chat apps (`Markdown`, read by
 * `commons/lib/markdown/lex.ts`).
 *
 * The reader before this one took a line at a time and knew headings, flat lists, one level of quote, tables, code,
 * bold, italic and links. Three replies of an agent asked to write "everything a chat should draw" showed the rest as
 * the characters written: `***`, `~~`, `<kbd>`, a list inside a list, a task's `[x]`, `> [!NOTE]`, a table's `:---:`,
 * a picture, a footnote, `<details>`, an escape, an underline under a heading, a link by reference, code under a list
 * item, an `<svg>` with no fence. Those replies are the fixtures here, and each case below is one of their numbers.
 *
 * What must not change is here too: an amount in dollars, a name with underscores, and nothing of what an agent
 * wrote becoming markup of the page.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/commons/components/ui/Markdown";
import { fenceClosed, lex, type Tokens } from "@/commons/lib/markdown/lex";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const draw = (source: string) => renderToStaticMarkup(Markdown({ source }));
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "markdown", `${name}.md`), "utf8");
/** What a page's source says of a character it had to write by another name. */
const unescaped = (html: string) => html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** The words of what was drawn, with no tags. */
const words = (html: string) => unescaped(html.replace(/<[^>]+>/g, ""));
/**
 * The words of the first block of code, whatever colours they are drawn in: the highlighter is a chunk another test's
 * page may have brought, and a block drawn after it is drawn in pieces.
 */
const codeOf = (html: string) => words(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] ?? "");
/** How many tokens of each kind a text is read as, at any depth. */
function kinds(source: string): Record<string, number> {
  const seen: Record<string, number> = {};
  const walk = (tokens: readonly { type: string }[]) => {
    for (const token of tokens) {
      seen[token.type] = (seen[token.type] ?? 0) + 1;
      const inside = (token as { items?: { type: string }[]; tokens?: { type: string }[] }).items ?? (token as { tokens?: { type: string }[] }).tokens;
      if (inside) walk(inside);
    }
  };
  walk(lex(source));
  return seen;
}

describe("words in a line", () => {
  test("bold inside italic, struck out, marked, and the tags that only say how words look", () => {
    const html = draw("***bold italic***, ~~gone~~, ==marked==, <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <u>under</u>");
    expect(html).toMatch(/<em[^>]*><strong[^>]*>bold italic<\/strong><\/em>/);
    expect(html).toMatch(/<del[^>]*>gone<\/del>/);
    expect(html).toMatch(/<mark[^>]*>marked<\/mark>/);
    expect(html.match(/<kbd[^>]*>(Ctrl|C)<\/kbd>/g)).toHaveLength(2);
    expect(html).toContain("H<sub>2</sub>O");
    expect(html).toContain("x<sup>2</sup>");
    expect(html).toContain("<u>under</u>");
    // None of them is left as the characters written.
    expect(words(html)).toBe("bold italic, gone, marked, Ctrl+C, H2O, x2, under");
  });

  test("underscores mark as stars do, and a name that holds them is left alone", () => {
    const html = draw("_italic underscore_, __bold underscore__, nama_variabel_snake_case");
    expect(html).toMatch(/<em[^>]*>italic underscore<\/em>/);
    expect(html).toMatch(/<strong[^>]*>bold underscore<\/strong>/);
    expect(html).toContain("nama_variabel_snake_case");
  });

  test("a character escaped is that character, and makes nothing", () => {
    const html = draw("\\*bukan italic\\*, \\`bukan code\\`, 1\\. bukan list");
    expect(words(html)).toBe("*bukan italic*, `bukan code`, 1. bukan list");
    expect(html).not.toMatch(/<em|<code|<ol|<li/);
  });

  test("a line's end is a line's end, with two spaces before it or none", () => {
    const html = draw("Baris satu\nBaris dua\nBaris tiga  \nBaris empat");
    expect(html).toMatch(/Baris satu<br\/?>Baris dua<br\/?>Baris tiga<br\/?>Baris empat/);
    expect(html.match(/<p /g)).toHaveLength(1);
  });

  test("an amount in dollars stays text, and a formula beside it is one", () => {
    const source = "Harganya $5 dan $10, total $15. Lalu $x^2$.";
    expect(words(draw(source))).toContain("Harganya $5 dan $10, total $15.");
    expect(kinds(source).mathInline).toBe(1);
    expect(kinds("Harganya $5 dan $10, total $15.").mathInline).toBeUndefined();
  });

  test("a comment is not drawn, and the words around it are joined", () => {
    expect(words(draw("Sebelum<!-- ini komentar tersembunyi -->sesudah"))).toBe("Sebelumsesudah");
    expect(words(draw("Atas\n\n<!-- sendiri di barisnya -->\n\nBawah"))).toBe("AtasBawah");
  });

  test("a name for a character is that character; one nobody knows stays as written", () => {
    expect(words(draw("Tom &amp; Jerry &copy; 2024 &#8594; &#x1F98A; &bogus;"))).toBe("Tom & Jerry © 2024 → 🦊 &bogus;");
  });
});

describe("links", () => {
  test("in angle brackets, by reference, a mail's address, and one whose address holds a bracket", () => {
    const html = draw("<https://nouride.com>, [reference link][ref], hello@example.com, https://en.wikipedia.org/wiki/Fox_(disambiguation)\n\n[ref]: https://nouride.com/docs");
    expect(html).toContain('href="https://nouride.com"');
    expect(html).toMatch(/<a href="https:\/\/nouride\.com\/docs"[^>]*><span>reference link<\/span>/);
    expect(html).toContain('href="mailto:hello@example.com"');
    expect(html).toContain('href="https://en.wikipedia.org/wiki/Fox_(disambiguation)"');
    // The brackets and the line that says where `ref` leads are not drawn.
    expect(words(html)).toBe("https://nouride.com, reference link, hello@example.com, https://en.wikipedia.org/wiki/Fox_(disambiguation)");
  });

  test("a tag that links is held to the rule every link is held to", () => {
    expect(draw('<a href="https://example.com/x">out</a>')).toContain('href="https://example.com/x"');
    const refused = draw('<a href="javascript:alert(1)">run</a> <a onclick="alert(1)" href="/api/control/secrets">read</a>');
    expect(refused).not.toContain("href=");
    expect(refused).not.toContain("onclick");
    expect(words(refused)).toBe("run read");
  });
});

describe("lists", () => {
  test("a list inside a list, bullets and numbers, each under its item", () => {
    const html = draw("- Level 1\n  - Level 2\n    - Level 3\n1. Satu\n2. Dua\n   1. Dua-a\n   2. Dua-b");
    expect(html).toMatch(/<ul[^>]*><li>Level 1<div[^>]*><ul[^>]*><li>Level 2<div[^>]*><ul[^>]*><li>Level 3<\/li><\/ul><\/div><\/li><\/ul><\/div><\/li><\/ul>/);
    expect(html).toMatch(/<ol[^>]*><li>Satu<\/li><li>Dua<div[^>]*><ol[^>]*><li>Dua-a<\/li><li>Dua-b<\/li><\/ol><\/div><\/li><\/ol>/);
  });

  test("a task has its box, ticked or not, and no bracket", () => {
    const html = draw("- [x] Udah\n- [ ] Belum");
    const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(boxes).toHaveLength(2);
    expect(boxes.map((box) => / checked=""/.test(box))).toEqual([true, false]);
    // What the agent wrote, not something to press.
    expect(boxes.every((box) => box.includes("readOnly") || box.includes("readonly"))).toBe(true);
    expect(boxes.every((box) => box.includes("pointer-events-none") && box.includes('tabindex="-1"'))).toBe(true);
    expect(words(html)).toBe("UdahBelum");
    // Its own boxes are its marks: no bullet beside them.
    expect(html).not.toContain("list-disc");
  });

  test("a list that starts at five counts from five", () => {
    expect(draw("5. List mulai dari 5\n6. Lanjut 6")).toMatch(/<ol start="5"[^>]*><li>List mulai dari 5<\/li><li>Lanjut 6<\/li><\/ol>/);
  });

  test("code under an item is the item's, written from its own margin, and the next item goes on counting", () => {
    const html = draw("1. Jalanin ini:\n   ```bash\n   bun install && bun test\n   ```\n2. Terus cek hasilnya");
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toMatch(/<li>Jalanin ini:<div[^>]*><div[^>]*data-viewer="code"/);
    // Its words from the block's own margin, whatever colours they are drawn in.
    expect(codeOf(html)).toBe("bun install && bun test");
    expect(html).toMatch(/<\/li><li>Terus cek hasilnya<\/li><\/ol>/);
  });

  test("a line at the margin under a list is the next thing said, never the last item's own words", () => {
    const html = draw("Two helpers ran:\n- Helper 1\n- Helper 2\nAccept: /mission accept msn_1");
    expect(html).toMatch(/<li>Helper 2<\/li><\/ul><p [^>]*>Accept: \/mission accept msn_1<\/p>/);
    // One indented under the item stays the item's.
    expect(draw("- Helper 1\n  and what it did")).toMatch(/<li>Helper 1<br\/?>and what it did<\/li>/);
  });
});

describe("quotes and notes", () => {
  test("a quote inside a quote, and code inside one", () => {
    expect(draw("> Quote biasa\n>> Quote di dalam quote")).toMatch(/<blockquote[^>]*><p [^>]*>Quote biasa<\/p><blockquote[^>]*><p [^>]*>Quote di dalam quote<\/p><\/blockquote><\/blockquote>/);
    const fenced = draw('> ```json\n> { "inside": "quote" }\n> ```');
    expect(fenced).toMatch(/<blockquote[^>]*><div[^>]*data-viewer="code"/);
    expect(words(fenced)).toContain('{ "inside": "quote" }');
    expect(words(fenced)).not.toContain("```");
  });

  test("a note as GitHub writes one is a box that says which, with no bracket", () => {
    const html = draw("> [!NOTE]\n> Callout ala GitHub\n\n> [!WARNING]\n> Callout warning\n\n> [!tip]\n> Kecil juga");
    expect(html.match(/role="note"/g)).toHaveLength(3);
    expect(words(html)).toBe(" NoteCallout ala GitHub WarningCallout warning TipKecil juga");
    expect(html).not.toContain("<blockquote");
    // A quote that only talks about one is a quote.
    expect(draw("> See [!NOTE] in the docs")).toContain("<blockquote");
  });
});

describe("tables", () => {
  test("each column's words are set to the side the line under the head says", () => {
    const html = draw("| Kiri | Tengah | Kanan |\n|:---|:---:|---:|\n| a | b | 1 |");
    const sides = (tag: string) => [...html.matchAll(new RegExp(`<${tag} class="([^"]*)"`, "g"))].map((cell) => cell[1]!.split(" ").find((name) => /^text-(left|center|right)$/.test(name)) ?? null);
    expect(sides("th")).toEqual(["text-left", "text-center", "text-right"]);
    expect(sides("td")).toEqual(["text-left", "text-center", "text-right"]);
    // A column with no side said has none.
    expect(draw("| A | B |\n|---|---|\n| 1 | 2 |")).not.toMatch(/text-(left|center|right)/);
  });

  test("a bar escaped in a cell is the cell's, and a cell's words are drawn as words are", () => {
    const html = draw("| Perintah | Arti |\n|---|---|\n| `a \\| b` | pipe |\n| **bold** dan [link](https://nouride.com) | format |");
    expect(html.match(/<th /g)).toHaveLength(2);
    expect(html.match(/<td /g)).toHaveLength(4);
    expect(html).toMatch(/<code[^>]*>a \| b<\/code>/);
    expect(html).toMatch(/<strong[^>]*>bold<\/strong> dan <a href="https:\/\/nouride\.com"/);
  });
});

describe("headings, rules and code", () => {
  test("a heading underlined is a heading, and a rule under a heading is a rule", () => {
    const html = draw("Heading pakai garis =\n===\n\nHeading pakai garis -\n---\n\n## Garis\n---");
    expect(html).toMatch(/<h1[^>]*>Heading pakai garis =<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>Heading pakai garis -<\/h2>/);
    expect(html.match(/<hr/g)).toHaveLength(1);
    expect(words(html)).not.toContain("===");
  });

  test("code written four spaces in is code", () => {
    const html = draw('Before\n\n    echo "indented code"\n\nAfter');
    expect(codeOf(html)).toBe('echo "indented code"');
  });

  test("a word longer than its line is broken where it must be: a hash ran out of the box it was in", () => {
    expect(draw("a3f9c2e8b7d14f6a9e0c5b2d8f1a7e4c3b9d6f2a8e5c1b7d4f0a3e9c6b2d8f5a1e7c4b0d3f9a6e2c8b5d1f7a4e0c3b9d6f2a8e5c1")).toMatch(/^<div class="\[overflow-wrap:anywhere\] /);
  });

  test("a fence still open is the block being written, and one with a language nobody draws is its code", () => {
    expect(codeOf(draw("```ts\nconst a = 1"))).toBe("const a = 1");
    // Told to the block, which draws no picture of half a picture: `fenceClosed` is what says so.
    const [open, closed] = [lex("```svg\n<svg></svg>")[0], lex("```svg\n<svg></svg>\n```")[0]] as [Tokens.Code, Tokens.Code];
    expect([fenceClosed(open), fenceClosed(closed)]).toEqual([false, true]);
    expect(fenceClosed(lex("~~~~\ncode\n~~~")[0] as Tokens.Code)).toBe(false);
    expect(fenceClosed(lex("    indented")[0] as Tokens.Code)).toBe(true);
    const other = draw("```dot\ndigraph { A -> B }\n```\n\n```plantuml\n@startuml\nAlice -> Bob: hi\n@enduml\n```");
    expect(other.match(/data-viewer="code"/g)).toHaveLength(2);
  });
});

describe("what Markdown does not have", () => {
  test("a footnote is its number where it is said, and its words at the text's end", () => {
    const html = draw("Kalimat ini punya catatan kaki[^1], dan satu lagi[^dua].\n\n[^1]: Ini isi catatan kakinya.\n[^dua]: Yang kedua, **tebal**.\n\nPenutup[^tiada].");
    expect(html.match(/<sup><a [^>]*aria-label="Footnote (\d)"[^>]*>\d<\/a><\/sup>/g)).toHaveLength(2);
    expect(html).toMatch(/<ol aria-label="Footnotes"[^>]*><li id="[^"]+-note-1">Ini isi catatan kakinya\.<\/li><li id="[^"]+-note-2">Yang kedua, <strong[^>]*>tebal<\/strong>\.<\/li><\/ol>/);
    // Where it is said leads to where it is written, and a name no note has stays as written.
    const said = /<a href="#([^"]+)"[^>]*aria-label="Footnote 1"/.exec(html)![1]!;
    expect(html).toContain(`<li id="${said}">`);
    expect(words(html)).toContain("Penutup[^tiada].");
    expect(words(html)).not.toContain("[^1]");
  });

  test("a term with its definition under it", () => {
    expect(draw("Nouride\n: Daemon agent multi-platform\n: Dan satu lagi")).toMatch(/<dl[^>]*><dt[^>]*>Nouride<\/dt><dd[^>]*>Daemon agent multi-platform<\/dd><dd[^>]*>Dan satu lagi<\/dd><\/dl>/);
    // A list's item, or a sentence that only has a colon after it, is no term.
    expect(draw("- item\n: bukan")).not.toContain("<dl");
    const heading = draw("## Judul\n: bukan definisi");
    expect(heading).toMatch(/<h2[^>]*>Judul<\/h2>/);
    expect(heading).not.toContain("<dl");
    expect(draw("Catatan:\nbaris berikut")).not.toContain("<dl");
  });

  test("what folds is drawn as what folds, its inside read as Markdown, and none of its tags as words", () => {
    const html = draw("<details>\n<summary>Klik buat buka</summary>\n\nIsi yang **tersembunyi**.\n\n- satu\n</details>\n\nSesudah");
    expect(html).toMatch(/<details[^>]*><summary[^>]*>.*Klik buat buka.*<\/summary><div[^>]*><p [^>]*>Isi yang <strong[^>]*>tersembunyi<\/strong>\.<\/p><ul[^>]*><li>satu<\/li><\/ul><\/div><\/details><p [^>]*>Sesudah<\/p>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(words(html)).not.toMatch(/<\/?details>|<\/?summary>/);
    // No page is made of it: a page is for HTML that is one.
    expect(html).not.toContain('data-viewer="code"');
    // Written open, it is open; still being written, it is open so that what comes is seen.
    expect(draw("<details open>\n<summary>S</summary>\n\nx\n</details>")).toMatch(/<details[^>]* open/);
    expect(draw("<details>\n<summary>S</summary>\n\nmasih ditulis")).toMatch(/<details[^>]* open/);
  });

  test("HTML that is a page is still a block of its own, never markup of this page", () => {
    const html = draw("<div style=\"color:red\" onclick=\"alert(1)\">\n<b>card</b>\n</div>\n\nA <script>alert(1)</script> in a sentence, and <img src=x onerror=alert(1)>.");
    expect(html).toContain('data-viewer="code"');
    // What it wrote is words in a block of code and in a sentence: no element of this page is its.
    expect(html).not.toMatch(/<(div style|script|img)/);
    expect(words(html)).toContain("A <script>alert(1)</script> in a sentence");
  });
});

describe("pictures", () => {
  test("one whose address is the picture itself is drawn at once", () => {
    const html = draw("![dot](data:image/png;base64,iVBORw0KGgo=) and ![svg data uri](data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><circle cx='50' cy='50' r='40' fill='%2322c55e'/></svg>)");
    const drawn = [...html.matchAll(/<img src="([^"]+)" alt="([^"]*)"/g)].map((img) => [img[1]!, img[2]!]);
    expect(drawn.map(([, alt]) => alt)).toEqual(["dot", "svg data uri"]);
    expect(drawn[0]![0]).toBe("data:image/png;base64,iVBORw0KGgo=");
    // Written whole as an address holds it, its `%23` read back to the `#` it stood for.
    expect(decodeURIComponent(unescaped(drawn[1]![0]!).split(",")[1]!)).toBe("<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><circle cx='50' cy='50' r='40' fill='#22c55e'/></svg>");
    expect(words(html)).toBe(" and ");
  });

  test("one on the web is held until it is pressed: where it is from is said, and nothing is asked of that place", () => {
    const html = draw("![Google favicon](https://www.google.com/favicon.ico)");
    expect(html).not.toContain("<img");
    expect(html).toContain('data-picture="held"');
    expect(words(html)).toContain("Google favicon from www.google.com");
    expect(html).toMatch(/<button[^>]*>Show picture<\/button>/);
    expect(html).toContain('href="https://www.google.com/favicon.ico"');
  });

  test("one that is neither is its words: a script's address, a page, a file's path", () => {
    for (const address of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://insecure.example/x.png", "/api/control/secrets"]) {
      const html = draw(`![the words](${address})`);
      expect(html, address).not.toContain("<img");
      expect(html, address).not.toContain("href=");
    }
  });
});

describe("an svg written with no fence", () => {
  test("is a block of its own, as one in a fence is, and nothing of it is markup", () => {
    const tokens = lex(fixture("svg"));
    expect(tokens.filter((token) => token.type === "svgBlock")).toHaveLength(3);
    const html = draw('<svg onload="alert(\'svg-xss\')" width="50" height="50"><circle cx="25" cy="25" r="20" fill="red"/></svg>');
    expect(html).not.toMatch(/<svg onload|<circle/);
    // Its code until the picture's viewer has loaded, the picture once it has: which one a run sees depends on whether
    // another test loaded the viewer first, as the whole suite on Linux did.
    expect(html).toMatch(/data-viewer="(code|picture)"/);
  });

  test("in a page, each is drawn as a picture and its handler is no part of the page", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    root.render(React.createElement(Markdown, { source: fixture("svg") }));
    try {
      await eventually(() => host.querySelectorAll('[data-viewer="picture"] img').length === 4, 5_000, "the four pictures");
      const pictures = [...host.querySelectorAll<HTMLImageElement>('[data-viewer="picture"] img')].map((img) => decodeURIComponent(img.getAttribute("src")!.split(",")[1]!));
      expect(pictures[0]).toContain("Nouride 🦊");
      expect(pictures[2]).toContain("<animate ");
      expect(pictures[3]).toContain("onload=");
      // Drawn as pictures: the handler is inside an address, and no element of the page carries it.
      expect(host.querySelector("[onload], circle, animate")).toBeNull();
      // The one given as a picture's address is a picture too.
      expect(host.querySelector('img[alt="svg data uri"]')?.getAttribute("src")).toStartWith("data:image/svg+xml;charset=utf-8,");
    } finally {
      root.unmount();
      host.remove();
    }
  });
});

describe("a block still being written", () => {
  test("a picture's fence not closed yet stays its code while one that is closed is drawn", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const picture = "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='20'><rect width='40' height='20'/></svg>";
    const mounted = ["```svg\n" + picture, "```svg\n" + picture + "\n```"].map((source) => {
      const host = dom.document.createElement("div") as unknown as HTMLElement;
      dom.document.body.appendChild(host as never);
      const root = createRoot(host);
      root.render(React.createElement(Markdown, { source }));
      return { host, root };
    });
    try {
      // The whole one is drawn: by then the one still open has had its turn, and was not.
      await eventually(() => mounted[1]!.host.querySelector('[data-viewer="picture"] img') !== null, 5_000, "the closed block's picture");
      expect(mounted[0]!.host.querySelector("[data-viewer]")?.getAttribute("data-viewer")).toBe("code");
      expect(mounted[0]!.host.querySelector("img")).toBeNull();
    } finally {
      for (const { host, root } of mounted) {
        root.unmount();
        host.remove();
      }
    }
  });
});

describe("an emoji by its name", () => {
  test("is its character once the list of names is here; a name the list does not have stays as written", async () => {
    const source = "Selesai :tada: :rocket: jam 10:30:45, :bukan_emoji: dan `:smile:` di dalam kode.";
    // Until the list is here, as written.
    expect(words(draw(source))).toBe("Selesai :tada: :rocket: jam 10:30:45, :bukan_emoji: dan :smile: di dalam kode.");
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    root.render(React.createElement(Markdown, { source }));
    try {
      await eventually(() => (host.textContent ?? "").includes("🎉"), 5_000, "the list of names");
      expect(host.textContent).toBe("Selesai 🎉 🚀 jam 10:30:45, :bukan_emoji: dan :smile: di dalam kode.");
    } finally {
      root.unmount();
      host.remove();
    }
  });
});

describe("the three replies, whole", () => {
  test("every numbered case of the first is drawn, and none of its marks is left as written", () => {
    const html = draw(fixture("standard"));
    const text = words(html);
    for (const left of ["***", "~~", "<kbd>", "<sub>", "<sup>", "[x]", "[ ]", "[!NOTE]", "[!WARNING]", ":---", "![Google", "[^1]", "<details>", "</details>", "<summary>", "\\*", "\\`", "1\\."]) expect(text, left).not.toContain(left);
    expect(html.match(/<h2/g)).toHaveLength(15);
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html.match(/role="note"/g)).toHaveLength(2);
    expect(kinds(fixture("standard"))).toMatchObject({ mathInline: 3, mathBlock: 2, footnoteRef: 1, footnoteDef: 1, details: 1, table: 1, image: 1 });
    expect(text).toContain("*bukan italic*, `bukan code`, 1. bukan list");
  });

  test("every numbered case of the second is drawn, and its three traps are left alone", () => {
    const html = draw(fixture("edges"));
    const text = words(html);
    for (const left of ["__bold", "_italic", "===", "[ref]", "<https://", "```", "\\|", "==teks", "<!--", "\n: Daemon", "<svg"]) expect(text, left).not.toContain(left);
    expect(kinds(fixture("edges")).emoji).toBe(2);
    expect(text).toContain("nama_variabel_snake_case");
    expect(text).toContain("Harganya $5 dan $10, total $15.");
    expect(text).toContain("Sebelumsesudah");
    expect(kinds(fixture("edges")).mathInline).toBeUndefined();
    expect(kinds(fixture("edges"))).toMatchObject({ svgBlock: 1, defList: 1, mark: 1, def: 1 });
    expect(html.match(/<table/g)).toHaveLength(2);
    expect(html.match(/<dl/g)).toHaveLength(1);
  });
});
