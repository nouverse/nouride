/**
 * The site's command reference shows only what the CLI takes.
 *
 * Since 0.7.10 every command refuses, with exit 2, a flag it does not read — and the reference, in English and in
 * Indonesian, still showed `nouride service uninstall [--dir <path>]` (exit 2), so a person copying the line got a refusal
 * instead of what the page promised. Each `nouride` line of both pages, in a code block or in backticks, is run
 * through the CLI's own grammar (`apps/cli/src/grammar.ts`): a command `main.ts` dispatches, an action that
 * command has, and only the flags that action reads. The pages' notation is read as a person reads it — `[…]` is
 * optional, and each side of an `a|b` is tried on its own.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_ALIASES, GRAMMAR, unreadFlag } from "../../../cli/src/grammar.ts";

const DOCS = join(import.meta.dir, "../../../../apps/site/src/content/docs");
const PAGES = ["en/docs/cli/reference.md", "id/docs/cli/reference.md"];

const isFlag = (token: string): boolean => /^--?[a-zA-Z]/.test(token);

/** Each `nouride …` the page shows: a code line, or a span in backticks. */
function commandLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  markdown.split("\n").forEach((line, i) => {
    const code = /^\s*(nouride\s[^#\n]*)/.exec(line);
    if (code) out.push({ line: i + 1, text: code[1]!.trim() });
    for (const m of line.matchAll(/`(nouride\s[^`]+)`/g)) out.push({ line: i + 1, text: m[1]!.trim() });
  });
  return out;
}

/** What is wrong with one line, by the grammar: an unknown command, an action it lacks, or a flag it refuses. */
function problems(text: string): string[] {
  const tokens = text.replace(/[[\]]/g, " ").split(/\s+/).filter(Boolean).slice(1);
  const command = tokens[0];
  if (!command || !/^[a-z]/.test(command)) return [];
  const name = COMMAND_ALIASES[command] ?? command;
  const grammar = GRAMMAR[name];
  if (!grammar) return [`no command \`${command}\``];
  const rest = tokens.slice(1);
  const cut = rest.findIndex((t) => t === "--" || isFlag(t));
  const words = cut < 0 ? rest : rest.slice(0, cut);
  const flags = rest.slice(words.length);
  const found: string[] = [];
  for (const first of (words[0] ?? "").split("|")) {
    const asked = [first, ...words.slice(1)].filter(Boolean);
    const action = [2, 1].map((depth) => asked.slice(0, depth).join(" ")).find((key) => key && asked.length && grammar.forms[key]);
    if (!action && asked.length > 0 && !grammar.forms["*"]) found.push(`\`${name}\` has no action \`${asked[0]}\``);
    // Each alternative of an `--a|--b` on its own: the page offers either.
    const tries = flags.reduce<string[][]>((all, token) => all.flatMap((prefix) => (isFlag(token) ? token.split("|") : [token]).map((t) => [...prefix, t])), [[]]);
    for (const attempt of tries) {
      const refused = unreadFlag(command, [...asked, ...attempt]);
      if (refused) found.push(`\`${name}${action ? ` ${action}` : ""}\` refuses ${refused}`);
    }
  }
  return [...new Set(found)];
}

describe("the site's command reference", () => {
  for (const page of PAGES) {
    const lines = commandLines(readFileSync(join(DOCS, page), "utf8"));

    test(`${page} is read whole`, () => {
      // An extractor that stopped matching would check nothing and pass.
      expect(lines.length).toBeGreaterThan(100);
    });

    test(`${page} shows no command, action or flag the CLI refuses`, () => {
      const wrong = lines.flatMap(({ line, text }) => problems(text).map((what) => `${page}:${line}  ${what} — ${text}`));
      expect(wrong).toEqual([]);
    });
  }

  test("a line is judged the way the CLI judges it", () => {
    expect(problems("nouride service uninstall [--dir <path>] [--kind systemd|launchd]")).toEqual(["`service uninstall` refuses --dir"]);
    expect(problems("nouride cron update <id> [--at|--every|--cron …] [--tz <zone>]")).toEqual([]);
    expect(problems("nouride pkg install|remove <name…>")).toEqual([]);
    expect(problems("nouride memory tags tidy --apply --frobnicate")).toEqual(["`memory tags tidy` refuses --frobnicate"]);
    expect(problems("nouride warp-drive on")).toEqual(["no command `warp-drive`"]);
    expect(problems("nouride agent explode <id>")).toEqual(["`agent` has no action `explode`"]);
  });
});
