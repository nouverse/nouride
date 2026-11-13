/**
 * Code, split into the pieces a highlighter names: what `CodeBlock` colours.
 *
 * A module of its own so that it is a chunk of its own: the highlighter and its grammars are loaded when the first
 * code block with a language is drawn, and a page with none never asks for them.
 *
 * Two rules it keeps. A language is never guessed: a block that names none, or one not in the list below, is drawn as
 * it was written, because a guess colours a log as if it were a program. And what the highlighter returns is never
 * handed to the page as markup: it is read here into pieces of text with a name, so a fault in its escaping would show
 * as odd text in a code block, not run in the dashboard with the reader's session.
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** What agents here write most: shell and its sessions, config, the web's languages, and the ones this project is in. */
const LANGUAGES = { bash, css, diff, dockerfile, go, ini, javascript, json, markdown, nginx, python, rust, shell, sql, typescript, xml, yaml };
for (const [name, grammar] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, grammar);

/** A piece of code and what it is: a keyword, a string, a comment. No scope is plain code. */
export interface CodePiece {
  text: string;
  scope?: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };
const unescaped = (text: string): string => text.replace(/&(?:amp|lt|gt|quot|#x27);/g, (entity) => ENTITIES[entity] ?? entity);

/**
 * The highlighter's markup, read into pieces. It writes three things: text, with five characters escaped, a
 * `<span class="hljs-…">` that opens a scope, and a `</span>` that closes one. A piece takes the scope it stands
 * closest inside. Anything else that looks like a tag is not one it wrote, and is kept as the text it is.
 */
export function piecesOf(markup: string): CodePiece[] {
  const pieces: CodePiece[] = [];
  const open: (string | undefined)[] = [];
  const say = (text: string) => {
    if (!text) return;
    let scope: string | undefined;
    for (let depth = open.length - 1; depth >= 0 && scope === undefined; depth--) scope = open[depth];
    const last = pieces.at(-1);
    if (last && last.scope === scope) last.text += text;
    else pieces.push(scope ? { text, scope } : { text });
  };
  let at = 0;
  for (const tag of markup.matchAll(/<span class="([A-Za-z0-9_ -]*)">|<\/span>/g)) {
    say(unescaped(markup.slice(at, tag.index)));
    at = tag.index + tag[0].length;
    // A closing tag with nothing open closes nothing the highlighter opened: text, like any other tag it did not write.
    if (tag[0] === "</span>") open.length > 0 ? open.pop() : say(tag[0]);
    // `hljs-title function_` is a title; `language-xml` marks code of another language inside, which names no scope.
    else open.push(/^hljs-([a-z_-]+)/.exec(tag[1] ?? "")?.[1]);
  }
  say(unescaped(markup.slice(at)));
  return pieces;
}

/** The pieces of `code` in `language`, or null for a language that is not one of these: drawn plain, never guessed. */
export function pieces(language: string, code: string): CodePiece[] | null {
  // A fence may say more than its language ("ts title=…"): the first word is the language.
  const name = language.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!name || !hljs.getLanguage(name)) return null;
  return piecesOf(hljs.highlight(code, { language: name, ignoreIllegals: true }).value);
}
