/**
 * HTML an agent wrote straight into its reply, with no code block around it (`commons/lib/html-run.ts`).
 *
 * Asked to write some HTML, an agent wrote a card, a table and a script as lines of tags in its reply. They were drawn
 * as prose, with nothing to press: "Preview" was on an `html` block alone. Held here: what begins such a run and what
 * is only a sentence, where a run ends, and which part of a reply is one, as its preview's address names it.
 */

import { describe, expect, test } from "bun:test";
import { htmlRunEnd, isHtmlRun, opensHtmlRun } from "@/commons/lib/html-run";

const CARD = ['<div style="padding:16px">', "  <h3>Render test</h3>", "  <button>A button</button>", "</div>"].join("\n");
const TABLE = "<table><tr><th>Tag</th></tr></table>";
const SCRIPT = "<script>alert('ran')</script>";
/** As the agent wrote it: prose, three pieces of HTML with a blank line between each, prose. */
const RUN = [CARD, "", TABLE, "", SCRIPT].join("\n");
const REPLY = ["Here it is, raw:", "", RUN, "", "What to check:", "- **The card**: whether its colours show."].join("\n");
const lines = (text: string) => text.split("\n");

describe("what begins a run of HTML", () => {
  test("an opening tag of a block's kind, whatever follows it, and a doctype", () => {
    for (const line of ["<div>", '<div style="padding:16px">', "<p>Hello</p>", "<h1>Title</h1> and words", "  <table>", "   <section class='a'>", "<script>", "<style>", "<pre>", "<!doctype html>", "<!DOCTYPE html>", "<html lang=en>", "<hr/>", "<ul>"]) {
      expect(opensHtmlRun(line), line).toBe(true);
    }
  });

  test("one opening tag of another kind, alone on its line", () => {
    for (const line of ['<img src="a.png">', '<svg viewBox="0 0 1 1">', "<br>", "<br/>", '<button class="x">', '<a href="/x">  ', "<span>"]) {
      expect(opensHtmlRun(line), line).toBe(true);
    }
  });

  test("not a sentence that begins with a tag, a link or a placeholder in angle brackets, a closing tag, a comment, or a line set in", () => {
    for (const line of [
      "<b>Note:</b> read this first",
      "<span>one</span> and two",
      '<img src="a.png"> and words',
      "<https://example.com>",
      "<nouva@example.com>",
      "<your-name>",
      "<T>",
      "</div>",
      "<!-- a note -->",
      "< 5 items",
      "<3",
      "    <div>",
      "Then <div> opens a box",
      "`<div>`",
      "- <div>",
      "<divider>",
      "",
    ]) {
      expect(opensHtmlRun(line), line).toBe(false);
    }
  });
});

describe("where a run ends", () => {
  test("pieces of HTML with a blank line between each are one run, and the prose after it is not in it", () => {
    expect(htmlRunEnd(lines(REPLY), 2)).toBe(lines(REPLY).indexOf(SCRIPT));
  });

  test("at the first blank line that prose follows, and at the text's end", () => {
    expect(htmlRunEnd(["<div>", "one", "</div>", "", "And prose."], 0)).toBe(2);
    expect(htmlRunEnd(["<div>", "one", "</div>", "", ""], 0)).toBe(2);
    expect(htmlRunEnd(["<div>"], 0)).toBe(0);
  });

  test("the lines right under it are its own, whatever they are, as in Markdown", () => {
    expect(htmlRunEnd(['<div align="center">', "**Title**", "</div>"], 0)).toBe(2);
  });

  test("past a blank line where markup follows: a tag, a closing one, a comment", () => {
    expect(htmlRunEnd(["<details>", "<summary>More</summary>", "", "</details>", "", "Prose."], 0)).toBe(3);
    expect(htmlRunEnd(["<div>a</div>", "", "", "  <span>b</span>", "", "<!-- end -->"], 0)).toBe(5);
  });

  test("a script, a style, a pre and a comment keep their blank lines until they are closed", () => {
    for (const [open, close] of [["<script>", "</script>"], ["<style>", "</style>"], ["<pre>", "</pre>"], ["<textarea>", "</textarea>"], ["<div><!-- a note", "that ends --></div>"]] as const) {
      expect(htmlRunEnd([open, "first", "", "second", close, "", "Prose."], 0), open).toBe(4);
    }
    // Closed on the line it opened on: a blank line then ends the run as anywhere.
    expect(htmlRunEnd(["<script>one()</script>", "", "Prose."], 0)).toBe(0);
  });

  test("a fence ends it, and one after a blank line is not gone past", () => {
    expect(htmlRunEnd(["<div>", "```js", "x", "```"], 0)).toBe(0);
    expect(htmlRunEnd(["<div>x</div>", "", "```html", "<p>y</p>", "```"], 0)).toBe(0);
    expect(htmlRunEnd(["<script>", "a", "", "```", "b"], 0)).toBe(1);
  });
});

describe("which part of a reply is a run", () => {
  const at = REPLY.indexOf(RUN);

  test("the run, from its first line to its last", () => {
    expect(isHtmlRun(REPLY, at, RUN.length)).toBe(true);
    // At the reply's very start and its very end.
    expect(isHtmlRun(RUN, 0, RUN.length)).toBe(true);
  });

  test("not the prose, a run entered or left inside a line, one begun at its closing tag, or one with the prose after it", () => {
    for (const [from, length, why] of [
      [0, "Here it is, raw:".length, "prose"],
      [at + 1, RUN.length - 1, "entered inside its first line"],
      [at, RUN.length - 3, "left inside its last line"],
      [REPLY.indexOf("</div>"), "</div>".length, "its closing tag alone"],
      [at, RUN.length + "\n\nWhat to check:".length, "with the prose after it"],
      [at, RUN.length + 1, "with the blank line after it"],
      [0, REPLY.length, "the whole reply"],
    ] as const) {
      expect(isHtmlRun(REPLY, from, length), why).toBe(false);
    }
  });

  test("not what is inside a code block, which is that block's; a run after a closed one is", () => {
    const inside = "```js\n<div>x</div>\n```";
    expect(isHtmlRun(inside, inside.indexOf("<div>"), "<div>x</div>".length)).toBe(false);
    const after = "```js\n1\n```\n<div>x</div>";
    expect(isHtmlRun(after, after.indexOf("<div>"), "<div>x</div>".length)).toBe(true);
    // A fence inside what is asked for is no part of a run.
    const across = "<div>x</div>\n```js\n1\n```";
    expect(isHtmlRun(across, 0, across.length)).toBe(false);
  });

  test("a place that is not one is nowhere: outside the reply, nothing long, or not a whole number", () => {
    for (const [from, length] of [[-1, 5], [at, 0], [at, -3], [REPLY.length, 1], [at, REPLY.length], [Number.NaN, RUN.length], [at, Number.NaN], [at + 0.5, RUN.length], [at, 1.5]] as const) {
      expect(isHtmlRun(REPLY, from, length), `${from},${length}`).toBe(false);
    }
  });
});
