/**
 * An agent's text read as Markdown: what its lines and its words are, before anything is drawn.
 *
 * The reading is `marked`'s lexer, CommonMark with GitHub's additions: nested lists, tasks, quotes inside quotes, a
 * table's alignment and a bar escaped in a cell, headings underlined, links by reference, escapes. A reader written
 * here by hand, a line at a time, knew a third of that, and what it did not know it drew as the characters written.
 * Only the tokens are taken: nothing of the library's HTML is ever made, and what is drawn is drawn from the tokens
 * by `Markdown`, as elements, so nothing an agent wrote is markup of the page.
 *
 * What Markdown does not have, read here before its own rules:
 * - a formula, as a writer of TeX writes one (`$..$`, `\(..\)`, `$$..$$`, and as a block `$$` or `\[` alone on a line
 *   up to the line that ends in `$$` or `\]`): a dollar opens one only followed by no space, its closing one preceded
 *   by no space and followed by no digit, so "$5 and $10" stays text;
 * - a footnote and where it is said, words marked `==so==`, a term with its definition under it (`: ..`), an emoji by
 *   the name GitHub gives it (`:rocket:`);
 * - `<details>` up to its end, drawn as what folds, its inside read as Markdown again; an `<svg>` written straight into
 *   the text, drawn as a `svg` block is; and any other HTML written with no fence, a page of its own (`html-run.ts`);
 * - a picture given as a `data:` address that holds an SVG as it is written, spaces and all, which no link may hold.
 */

import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { htmlRunEnd, opensHtmlRun } from "@/commons/lib/html-run";

export type { Token, Tokens };

/** A formula on lines of its own. `closed` is false while it is still being written. */
export interface MathBlock extends Tokens.Generic {
  type: "mathBlock";
  text: string;
  closed: boolean;
}
/** A formula in a line, with the characters it was written in. */
export interface MathInline extends Tokens.Generic {
  type: "mathInline";
  text: string;
}
/** `<details>`: what its `<summary>` says, and its inside. */
export interface Details extends Tokens.Generic {
  type: "details";
  summary: Token[];
  tokens: Token[];
  open: boolean;
  closed: boolean;
}
/** An `<svg>` written with no fence, or HTML written with none: `text` is the lines as they were written. */
export interface RawBlock extends Tokens.Generic {
  type: "svgBlock" | "htmlRun";
  text: string;
}
export interface FootnoteDef extends Tokens.Generic {
  type: "footnoteDef";
  id: string;
  tokens: Token[];
}
export interface FootnoteRef extends Tokens.Generic {
  type: "footnoteRef";
  id: string;
}
/** Words marked `==so==`. */
export interface Highlighted extends Tokens.Generic {
  type: "mark";
  tokens: Token[];
}
export interface DefList extends Tokens.Generic {
  type: "defList";
  term: Token[];
  defs: Token[][];
}

/** Where a line that `opens` begins in `src`, past its first character, or -1: where a paragraph before it must end. */
function lineStart(src: string, opens: RegExp): number {
  const found = opens.exec(src);
  return found ? found.index + (found[0].startsWith("\n") ? 1 : 0) : -1;
}

const DETAILS_OPEN = /^ {0,3}<details(\s[^>]*)?>/i;
const SUMMARY = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i;

const details: TokenizerAndRendererExtension = {
  name: "details",
  level: "block",
  start: (src) => lineStart(src, /(?:^|\n) {0,3}<details(?=[\s>])/i),
  tokenizer(src) {
    const opened = DETAILS_OPEN.exec(src);
    if (!opened) return undefined;
    // Its own end, past any it holds.
    const tag = /<(\/?)details(?:\s[^>]*)?>/gi;
    tag.lastIndex = opened[0].length;
    let depth = 1;
    let end = -1;
    let closer = 0;
    for (let found = tag.exec(src); found; found = tag.exec(src)) {
      depth += found[1] ? -1 : 1;
      if (depth === 0) {
        end = tag.lastIndex;
        closer = found[0].length;
        break;
      }
    }
    const closed = end >= 0;
    const rest = closed ? (/^[ \t]*(?:\n|$)/.exec(src.slice(end))?.[0] ?? "") : "";
    const inside = closed ? src.slice(opened[0].length, end - closer) : src.slice(opened[0].length);
    const said = SUMMARY.exec(inside);
    const body = (said ? inside.slice(said[0].length) : inside).replace(/^[ \t]*\n/, "");
    const top = this.lexer.state.top;
    this.lexer.state.top = true;
    const tokens = this.lexer.blockTokens(body, []);
    this.lexer.state.top = top;
    const token: Details = { type: "details", raw: closed ? src.slice(0, end) + rest : src, summary: this.lexer.inline((said?.[1] ?? "").trim()), tokens, open: /\sopen\b/i.test(opened[1] ?? ""), closed };
    return token;
  },
};

const svgBlock: TokenizerAndRendererExtension = {
  name: "svgBlock",
  level: "block",
  start: (src) => lineStart(src, /(?:^|\n) {0,3}<svg(?=[\s>])/i),
  tokenizer(src) {
    const whole = /^ {0,3}(<svg(?=[\s>])[\s\S]*?<\/svg>)[ \t]*(?:\n|$)/i.exec(src);
    if (!whole) return undefined;
    const token: RawBlock = { type: "svgBlock", raw: whole[0], text: whole[1]! };
    return token;
  },
};

const htmlRun: TokenizerAndRendererExtension = {
  name: "htmlRun",
  level: "block",
  start(src) {
    let at = src.indexOf("\n");
    while (at >= 0) {
      const next = src.indexOf("\n", at + 1);
      if (opensHtmlRun(src.slice(at + 1, next < 0 ? undefined : next))) return at + 1;
      at = next;
    }
    return -1;
  },
  tokenizer(src) {
    const first = src.indexOf("\n");
    if (!opensHtmlRun(first < 0 ? src : src.slice(0, first))) return undefined;
    const lines = src.split("\n");
    const end = htmlRunEnd(lines, 0);
    const text = lines.slice(0, end + 1).join("\n");
    const token: RawBlock = { type: "htmlRun", raw: end + 1 < lines.length ? `${text}\n` : text, text };
    return token;
  },
};

const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  start: (src) => lineStart(src, /(?:^|\n) *(?:\$\$|\\\[)/),
  tokenizer(src) {
    const whole = /^ *\$\$(.+)\$\$[ \t]*(?:\n|$)/.exec(src);
    if (whole && whole[1]!.trim()) {
      const token: MathBlock = { type: "mathBlock", raw: whole[0], text: whole[1]!.trim(), closed: true };
      return token;
    }
    const opened = /^ *(\$\$|\\\[)[ \t]*(?:\n|$)/.exec(src);
    if (!opened) return undefined;
    const ends = opened[1] === "$$" ? "$$" : "\\]";
    const lines = src.slice(opened[0].length).split("\n");
    const said: string[] = [];
    let taken = opened[0].length;
    for (const [index, line] of lines.entries()) {
      taken += line.length + (index < lines.length - 1 ? 1 : 0);
      if (line.trim().endsWith(ends)) {
        said.push(line.trim().slice(0, -ends.length));
        const token: MathBlock = { type: "mathBlock", raw: src.slice(0, taken), text: said.join("\n").trim(), closed: true };
        return token;
      }
      said.push(line);
    }
    // Still being written: all of what is there.
    const token: MathBlock = { type: "mathBlock", raw: src, text: said.join("\n"), closed: false };
    return token;
  },
};

const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start: (src) => src.search(/\$|\\\(/),
  tokenizer(src) {
    const found = /^\$\$([^$\n]+?)\$\$/.exec(src) ?? /^\\\((.+?)\\\)/.exec(src) ?? /^\$(?=[^\s$])([^$\n`]*?[^\s$\\])\$(?!\d)/.exec(src);
    if (!found) return undefined;
    const token: MathInline = { type: "mathInline", raw: found[0], text: found[1]! };
    return token;
  },
};

const footnoteDef: TokenizerAndRendererExtension = {
  name: "footnoteDef",
  level: "block",
  start: (src) => lineStart(src, /(?:^|\n) {0,3}\[\^[^\]\s]+\]:/),
  tokenizer(src) {
    const found = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?: {2,}|\t)[^\n]+)*)(?:\n|$)/.exec(src);
    if (!found) return undefined;
    const token: FootnoteDef = { type: "footnoteDef", raw: found[0], id: found[1]!, tokens: this.lexer.inline(found[2]!.replace(/\n\s+/g, " ").trim()) };
    return token;
  },
};

const footnoteRef: TokenizerAndRendererExtension = {
  name: "footnoteRef",
  level: "inline",
  start: (src) => src.indexOf("[^"),
  tokenizer(src) {
    const found = /^\[\^([^\]\s]+)\]/.exec(src);
    if (!found) return undefined;
    const token: FootnoteRef = { type: "footnoteRef", raw: found[0], id: found[1]! };
    return token;
  },
};

const mark: TokenizerAndRendererExtension = {
  name: "mark",
  level: "inline",
  start: (src) => src.indexOf("=="),
  tokenizer(src) {
    const found = /^==(?=\S)([^\n]*?\S)==/.exec(src);
    if (!found) return undefined;
    const token: Highlighted = { type: "mark", raw: found[0], tokens: this.lexer.inlineTokens(found[1]!) };
    return token;
  },
};

/** What begins a block of Markdown's own: a line that is one of these is no term of a definition. */
const BLOCK_MARK = /^[ \t]*(?:[-*+>#|<:]|\d+[.)]|`{3}|~{3}|\$\$|\\\[|\[\^)/;

const defList: TokenizerAndRendererExtension = {
  name: "defList",
  level: "block",
  start: (src) => {
    const found = /\n([^\n]+)\n:[ \t]+\S/.exec(src);
    return found && !BLOCK_MARK.test(found[1]!) ? found.index + 1 : -1;
  },
  tokenizer(src) {
    const found = /^([^\n]+)\n((?::[ \t]+[^\n]+(?:\n|$))+)/.exec(src);
    if (!found || BLOCK_MARK.test(found[1]!) || found[1]!.trim() === "") return undefined;
    const defs = found[2]!.split("\n").filter((line) => line.trim() !== "").map((line) => this.lexer.inline(line.replace(/^:[ \t]+/, "").trim()));
    const token: DefList = { type: "defList", raw: found[0], term: this.lexer.inline(found[1]!.trim()), defs };
    return token;
  },
};

/** An emoji by its name, `:rocket:`. Whether there is such a name is asked where it is drawn (`markdown/emoji.ts`). */
const emojiName: TokenizerAndRendererExtension = {
  name: "emoji",
  level: "inline",
  start: (src) => src.search(/:[a-z0-9_+-]{1,40}:/),
  tokenizer(src) {
    const found = /^:([a-z0-9_+-]{1,40}):/.exec(src);
    if (!found) return undefined;
    return { type: "emoji", raw: found[0], name: found[1]! };
  },
};

const dataPicture: TokenizerAndRendererExtension = {
  name: "dataPicture",
  level: "inline",
  start: (src) => src.indexOf("!["),
  tokenizer(src) {
    const found = /^!\[([^\]]*)\]\(\s*data:image\/svg\+xml[^,)]*,\s*(<svg[\s\S]*?<\/svg>)\s*\)/i.exec(src);
    if (!found) return undefined;
    // Written as an address would be, a `#` as `%23`: read back first, then written whole as an address holds it.
    let svg = found[2]!;
    try {
      svg = decodeURIComponent(svg);
    } catch {
      // A `%` that is no escape: the picture as it was written.
    }
    const token: Tokens.Image = { type: "image", raw: found[0], href: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, title: null, text: found[1]!, tokens: [] };
    return token;
  },
};

// Tried newest first: the last named here is asked first. `<details>` and an `<svg>` come before the rule for HTML
// with no fence, which would take either for a page, and a formula before a footnote's bracket.
const reader = new Marked({ gfm: true, breaks: true }).use({ extensions: [defList, htmlRun, svgBlock, details, footnoteDef, mathBlock, emojiName, mark, footnoteRef, dataPicture, mathInline] });

/**
 * A text with a blank line put before each line that Markdown would add to the list item or the quote over it though
 * it is written at the margin (a "lazy" line). In a chat such a line is the next thing said: a notice's "Accept: .."
 * under its list of helpers was drawn inside the last bullet. A line indented under an item stays the item's.
 */
function apart(source: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let over: "list" | "quote" | null = null;
  for (const line of source.split("\n")) {
    const fenced = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence !== null) {
      out.push(line);
      if (fenced !== null && fenced[0] === fence[0] && fenced.length >= fence.length && line.trim() === fenced) fence = null;
      continue;
    }
    const blank = line.trim() === "";
    const entry = /^\s*(?:[-*+]|\d{1,9}[.)])\s/.test(line);
    const quoted = /^ {0,3}>/.test(line);
    const under = /^(?: {2,}|\t)/.test(line);
    if (!blank && fenced === null && ((over === "list" && !entry && !under) || (over === "quote" && !quoted))) out.push("");
    out.push(line);
    if (fenced !== null) fence = fenced;
    else over = blank ? null : entry || (over === "list" && under) ? "list" : quoted ? "quote" : null;
  }
  return out.join("\n");
}

/** The tokens of a text. */
export function lex(source: string): Token[] {
  return reader.lexer(apart(source));
}

/** Whether a fenced block's own fence is closed: one still open is a block being written. */
export function fenceClosed(code: Tokens.Code): boolean {
  if (code.codeBlockStyle === "indented") return true;
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(code.raw);
  if (!fence) return true;
  const sign = fence[1]![0] === "`" ? "`" : "~";
  return new RegExp(`\\n {0,3}\\${sign}{${fence[1]!.length},}[ \\t]*$`).test(code.raw.trimEnd());
}
