/**
 * A `nouride` line in a doc, a skill or a comment is one the CLI runs: each word and flag after the verb is one that
 * command reads.
 *
 * Since 0.7.10 the CLI refuses a flag a command does not read, and since 0.7.11 a word, with exit 2 (`cli/grammar.ts`)
 * — so a doc that shows `nouride service uninstall --dir <path>` (exit 2) hands whoever copies it, a person or an agent, a
 * refusal instead of what it promised. `lint:cli` holds the grammar to the code and to `nouride help` and reads no doc;
 * this reads the docs, with the CLI's own rule: `normalizeArgv`, `--json` and `--help` taken as every command takes
 * them, then `unreadWord` and `unreadFlag`. The site's CLI reference documented `--dir` on `service uninstall` for a
 * release after the CLI stopped reading it.
 *
 * Read: a backticked `` `nouride <verb> …` `` anywhere, and in a markdown file a line of a fenced block that runs
 * `nouride` (after a `$ `, a `sudo`, variables or a path to the binary). A line that shows a refusal on purpose says
 * `exit 2` on it. A usage line's notation is read as usage: `a|b` is either, each checked; `[…]` is optional; and a
 * placeholder — `<id>`, `…` — where an action goes leaves the words unjudged, since any action could stand there.
 */

import { normalizeArgv } from "../../apps/engine/src/cli/args.ts";
import { COMMAND_ALIASES, GRAMMAR, unreadFlag, unreadWord } from "../../apps/engine/src/cli/grammar.ts";

export interface CommandLine {
  /** Offset of the line in the text it was read from. */
  at: number;
  verb: string;
  /** What follows the verb, up to the end of the span, a shell operator or a comment. */
  rest: string;
  /** The line it is on, for its `exit 2`. */
  line: string;
}

const SPAN = /`nouride ([a-z][a-z-]*)([^`\n]*)`/g;
/** A line of a fenced block that runs `nouride` — one space before the verb, so a column of a file listing is not one. */
const RUN = /^[ \t]*(?:\$\s+)?(?:sudo\s+(?:-u\s+\S+\s+)?)?(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:[\w.~/-]*\/)?nouride ([a-z][a-z-]*)(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** Every `nouride` line in `text`: backticked spans, and in markdown the lines of a fenced block that run it. */
export function commandLines(text: string, markdown: boolean): CommandLine[] {
  const lineAround = (at: number): string => text.slice(text.lastIndexOf("\n", at - 1) + 1, (text.indexOf("\n", at) + 1 || text.length + 1) - 1);
  const out: CommandLine[] = [...text.matchAll(SPAN)].map((m) => ({ at: m.index!, verb: m[1]!, rest: m[2]!, line: lineAround(m.index!) }));
  if (!markdown) return out;
  let fenced = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    else if (fenced) {
      const m = RUN.exec(line);
      if (m && !line.includes("`nouride ")) out.push({ at: offset, verb: m[1]!, rest: m[2]!.replace(/(?:^|\s)#.*$/, ""), line });
    }
    offset += line.length + 1;
  }
  return out;
}

/** Shell words, quotes kept together, up to the first operator — what the shell would hand `nouride`. */
export function shellWords(rest: string): string[] {
  const words: string[] = [];
  for (const m of rest.replace(/\\\|/g, "|").matchAll(/"[^"]*"|'[^']*'|\S+/g)) {
    const word = m[0];
    if (/^(?:\||\|\||&&?|;|[0-9]?>{1,2}.*|<.*)$/.test(word)) break;
    words.push(word);
  }
  return words;
}

const PLACEHOLDER = /^(?:<[^>]*>|…|\.\.\.|\S*…)$/;

/** The argument lists a usage line stands for: `[` `]` dropped, and each `a|b` read as either. At most 64. */
export function variants(words: readonly string[]): string[][] {
  let out: string[][] = [[]];
  for (const raw of words) {
    const word = raw.startsWith("<") ? raw : raw.replace(/^[[(]+|[\]),.;:]+$/g, "");
    if (word === "") continue;
    const options = !/^["']/.test(word) && word.includes("|") && !word.startsWith("<") ? word.split("|").filter(Boolean) : [word];
    out = out.flatMap((args) => options.map((option) => [...args, option])).slice(0, 64);
  }
  return out;
}

/** What the CLI would refuse in `line`, said for a reader — or null when it runs, or says `exit 2` because it should not. */
export function commandProblem(line: CommandLine, verbs: ReadonlySet<string>): string | null {
  if (!verbs.has(line.verb)) return `\`nouride ${line.verb}\` is not a command cli/main.ts dispatches`;
  if (/\bexit 2\b/.test(line.line) || !(GRAMMAR[COMMAND_ALIASES[line.verb] ?? line.verb])) return null;
  for (const listed of variants(shellWords(line.rest))) {
    const head = normalizeArgv(listed);
    const end = head.indexOf("--");
    const options = end === -1 ? head : head.slice(0, end);
    if (options.includes("--help") || options.includes("-h")) continue;
    const args = head.filter((word, i) => word !== "--json" || (end !== -1 && i > end));
    const words = args.slice(0, Math.max(0, args.findIndex((word) => /^-/.test(word))) || args.length);
    const word = words.some((w) => PLACEHOLDER.test(w)) ? null : unreadWord(line.verb, args);
    if (word !== null) return `\`nouride ${line.verb}\` has no "${word}" — the CLI refuses it with exit 2`;
    const flag = unreadFlag(line.verb, args);
    if (flag !== null) return `\`nouride ${line.verb}\` does not read ${flag} here — the CLI refuses it with exit 2`;
  }
  return null;
}
