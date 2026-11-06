/**
 * Markdown as it reaches a chat platform.
 *
 * Two failure modes are worth more than the rest. A message that arrives with literal `**` in it looks
 * broken but is readable; a message that does not arrive at all is not, and on Telegram a malformed
 * document is exactly that — the API rejects the whole send. So the tests lean on what happens to
 * hostile and half-finished input, not on what happens to a tidy paragraph.
 */

import { describe, expect, test } from "bun:test";
import { toTelegramHtml } from "../src/channels/telegram/html.ts";
import { parseMarkdown, toPlainText } from "../src/commons/markdown.ts";
import { chunk, chunkRendered } from "../src/commons/text.ts";

const html = (source: string): string => toTelegramHtml(parseMarkdown(source));

describe("telegram html", () => {
  test("renders the marks a model actually writes", () => {
    expect(html("**bold** and *italic* and ~~gone~~")).toBe(
      "<b>bold</b> and <i>italic</i> and <s>gone</s>",
    );
    expect(html("__also bold__ and _also italic_")).toBe("<b>also bold</b> and <i>also italic</i>");
  });

  test("escapes the characters that would end an element early", () => {
    // The reason this exists: a model writing about HTML, or quoting a page that contains it.
    expect(html("use <div> & <span>")).toBe("use &lt;div&gt; &amp; &lt;span&gt;");
  });

  test("code is text, not markup", () => {
    expect(html("run `a < b && c` now")).toBe("run <code>a &lt; b &amp;&amp; c</code> now");
    // Asterisks inside code stay asterisks. Emphasis winning here would corrupt the one thing the
    // reader most needs verbatim.
    expect(html("`**not bold**`")).toBe("<code>**not bold**</code>");
  });

  test("a fenced block keeps its language and its contents", () => {
    const out = html('```ts\nconst x = "a<b";\n```');
    // Quotes are not escaped in text: Telegram does not need it, and a body full of &quot; is worse to
    // read than the character it replaced. Attribute values are escaped separately.
    expect(out).toBe('<pre><code class="language-ts">const x = "a&lt;b";</code></pre>');
  });

  test("an unterminated fence still renders as a block", () => {
    // A truncated model response produces exactly this, routinely.
    expect(html("```\nhalf a listing")).toBe("<pre>half a listing</pre>");
  });

  test("a code block keeps its line break before what follows — and adds none at the end", () => {
    // Without it Telegram dropped a line break further down: an approval prompt read "`/deny`This one always asks".
    expect(html("```\nrm -rf x\n```\nWhy I am asking.\n\n`/approve` · `/deny`\nThis one always asks.")).toBe(
      "<pre>rm -rf x</pre>\nWhy I am asking.\n\n<code>/approve</code> · <code>/deny</code>\nThis one always asks.",
    );
    expect(html("```\nlast\n```")).toBe("<pre>last</pre>");
  });

  test("…and the line break before it: the line above a block is not run into its first line (0.8.13)", () => {
    // A persona change's question in Telegram read "SOUL.md · +2 −2- [# SOUL › ## Rules] - Ask Gading…".
    expect(html("SOUL.md · +1 −1\n```diff\n- a\n+ b\n```")).toBe('SOUL.md · +1 −1\n<pre><code class="language-diff">- a\n+ b</code></pre>');
    // A blank line before it keeps the one break it always kept; a block that opens the message gets none.
    expect(html("Run:\n\n```\nls\n```")).toBe("Run:\n<pre>ls</pre>");
    expect(html("```\nfirst\n```\nthen")).toBe("<pre>first</pre>\nthen");
  });

  test("links render, and hostile schemes keep their words but lose the link", () => {
    expect(html("[docs](https://example.com/a?b=1)")).toBe(
      '<a href="https://example.com/a?b=1">docs</a>',
    );
    // A refused scheme keeps the words and loses the link, rather than dropping the sentence.
    expect(html("[click](javascript:alert(1))")).toBe("click");
    // A target containing spaces is not a link at all — the same as CommonMark, and the same as what
    // every other renderer the reader has seen will do with it.
    expect(html("[x](not a url)")).toBe("[x](not a url)");
  });

  test("a quote inside a link target cannot break out of the attribute", () => {
    // Asserted exactly: `not.toContain('"><')` passed with the escaping deleted (the 0.7.11 mutation sweep), because
    // the unescaped quote produces `/"">x`, which contains no `"><` — and a second attribute rides in the same way.
    expect(html('[x](https://e.com/")')).toBe('<a href="https://e.com/&quot;">x</a>');
    expect(html('[x](https://e.com/"onclick="alert(1))')).toBe('<a href="https://e.com/&quot;onclick=&quot;alert(1)">x</a>');
    expect(html('```ts"x\ncode\n```')).toBe('<pre><code class="language-ts&quot;x">code</code></pre>');
  });

  test("stray punctuation stays literal", () => {
    // `2 * 3 * 4` must not become italics, and prose with an underscore in a filename must survive.
    expect(html("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(html("see my_file_name.txt")).toBe("see my_file_name.txt");
  });

  test("plain text keeps the words and drops the marks", () => {
    // The fallback path when Telegram rejects a formatted send.
    expect(toPlainText(parseMarkdown("**bold** `code` [x](https://e.com)"))).toBe("bold code x");
  });
});

describe("chunking", () => {
  test("a short message is one part", () => {
    expect(chunk("hello", 100)).toEqual(["hello"]);
  });

  test("an empty message says so rather than sending nothing", () => {
    expect(chunk("", 100)).toEqual(["(empty response)"]);
  });

  test("splits on a paragraph boundary when it can", () => {
    const parts = chunk(`${"a".repeat(40)}\n\n${"b".repeat(40)}`, 50);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("a".repeat(40));
  });

  test("a code fence cut in half is closed and reopened", () => {
    // The bug this was written for. Without it, part one ends with an open fence: every platform
    // renders the rest as code, and the Telegram HTML path produces an unclosed <pre> that fails the
    // send outright.
    const body = Array.from({ length: 20 }, (_, i) => `line ${i} ....................`).join("\n");
    const parts = chunk("```ts\n" + body + "\n```", 200);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      const fences = (part.match(/^ {0,3}```/gm) ?? []).length;
      expect(fences % 2).toBe(0);
    }
    // The language survives the split, so the second half is not suddenly unhighlighted.
    expect(parts[1]).toContain("```ts");
  });

  test("every part of a split fenced message is valid html on its own", () => {
    const body = Array.from({ length: 30 }, (_, i) => `const line${i} = "value";`).join("\n");
    for (const part of chunk("```js\n" + body + "\n```", 300)) {
      const out = html(part);
      expect((out.match(/<pre>/g) ?? []).length).toBe((out.match(/<\/pre>/g) ?? []).length);
    }
  });

  test("parts stay within the limit even with a reopened fence", () => {
    // The reopened fence line is added to the next part, so the budget has to account for it or the
    // very message that needed splitting comes back over the limit.
    const body = Array.from({ length: 40 }, () => "x".repeat(30)).join("\n");
    for (const part of chunk("```\n" + body + "\n```", 200)) {
      expect(part.length).toBeLessThanOrEqual(200);
    }
  });

  test("text with no fences is unchanged by the fence handling", () => {
    const text = Array.from({ length: 20 }, (_, i) => `sentence number ${i} here`).join(" ");
    expect(chunk(text, 100).join(" ")).toBe(text);
  });

  test("the fence a part has to close is inside the budget, not past it", () => {
    // The earlier version of this reserved room for the fence it *reopens* with and forgot the one it
    // *closes* with, so a part cut inside a block came back `limit + 4` characters long. It only ever
    // showed up when a line boundary happened to land near the end of the window, which is why the
    // lines here are sized to land right on it.
    const body = Array.from({ length: 60 }, (_, i) => `line ${i} of an ascii diagram here`).join("\n");
    for (const part of chunk("```\n" + body + "\n```", 200)) {
      expect(part.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("chunking against the rendered length", () => {
  const render = (part: string): string => toTelegramHtml(parseMarkdown(part));

  test("a part that fits as markdown but not as html is cut again", () => {
    // The bug this exists for, from a live chat: a 4091-character part rendered to 4719 characters of
    // HTML, Telegram answered `message is too long`, the buffered retry failed identically and the
    // reply was dropped. Nothing in the source was over the limit, so nothing upstream noticed.
    const text = Array.from(
      { length: 90 },
      (_, i) => `**Point ${i}** — a *sentence* with [a link](https://example.com/${i}) in it.`,
    ).join("\n\n");

    expect(chunk(text, 4096).some((part) => render(part).length > 4096)).toBe(true);
    for (const part of chunkRendered(text, 4096, render)) {
      expect(render(part).length).toBeLessThanOrEqual(4096);
    }
  });

  test("what a re-cut leaves goes into the next part, not into a message of its own", () => {
    // From a live chat: a 21,154-character answer in prose, every part a few percent longer as HTML than as
    // markdown. Each part was cut again on its own, so it went out full and its overflow — 13 to 125 characters —
    // went out after it: eleven messages where six held it, each one paced a second behind the last.
    const text = Array.from(
      { length: 30 },
      (_, i) => `## Section ${i}\n\n${"A **paced** send waits for its turn, and *each* part is one message. ".repeat(10)}`,
    ).join("\n\n");
    const sizes = chunkRendered(text, 4096, render).map((part) => render(part).length);

    for (const size of sizes) expect(size).toBeLessThanOrEqual(4096);
    // Every part but the last is full: a scrap between two full parts is the bug.
    for (const size of sizes.slice(0, -1)) expect(size).toBeGreaterThan(4096 * 0.9);
  });

  test("a table counts as what it flattens into, not as its pipes", () => {
    // `flattenTable` turns one grid row into a labelled record, so the rendered text is longer than
    // the markdown that produced it — the plain-text fallback overflows for the same reason the HTML
    // does, which is how a rejected send became a dropped one rather than an unformatted one.
    const rows = Array.from({ length: 200 }, (_, i) => `| item-${i} | ${"v".repeat(40)} |`).join("\n");
    for (const part of chunkRendered(`| name | value |\n|---|---|\n${rows}`, 4096, render)) {
      expect(render(part).length).toBeLessThanOrEqual(4096);
      expect(toPlainText(parseMarkdown(part)).length).toBeLessThanOrEqual(4096);
    }
  });

  test("re-cutting loses no words", () => {
    const text = Array.from(
      { length: 60 },
      (_, i) => `**Heading ${i}**\n\nSome *emphasised* prose for section ${i}.`,
    ).join("\n\n");
    const joined = chunkRendered(text, 500, render).join("\n");
    expect(joined.replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
  });

  test("a message that already fits is left alone", () => {
    expect(chunkRendered("**hi**", 4096, render)).toEqual(["**hi**"]);
  });
});
