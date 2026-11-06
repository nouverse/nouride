/**
 * A command that prints its usage, or a ✗ line, and exits 0 (`lint-cli-exit-code-guard`) — `lint:cli`'s second rule.
 *
 * The exit code is how the `nouride` tool tells a model that a call failed, and how a script does: 0 done, 1 failed,
 * 2 asked wrongly (`cli/ui.ts`). 0.7.10 found about twenty paths that printed their usage or a refusal with `say` and
 * returned — "restart needs --then", "no such draft", "refusing a root unit" reached the agent as successes, and
 * `--json` said `ok: true` — and fixed each one with a test of its own. Nothing stopped the twenty-first; this does,
 * from the source:
 *
 * - **Usage said as the answer.** A `say` of a usage line — a `USAGE` constant, `usageFor(…)`, or text that opens with
 *   `nouride <command>` or `usage:` — that is the first thing its branch says. After a listing it is a footer, "what
 *   next", and fine; as the whole of a branch it is a call missing what it needs, which is `usageLines` or `usageError`
 *   (exit 2). Help a command gives on purpose says so: `emit({ help })` before it, as `nouride help` and `--help` do,
 *   which is also what `--json` answers with.
 * - **A ✗ line that is not a failure.** A `say` whose text opens with ✗, outside a loop, with nothing after it in its
 *   block that ends the command badly — `fail`, `usageError`, `usageLines`, `unknownAction`, `crashed`, or
 *   `process.exitCode = …`. Inside a loop a ✗ marks one item of a list — a run that failed, a file that did not
 *   index — and the list is the answer.
 *
 * "Its branch" is read up to the function: a statement before it in its block, or before the statement that holds it
 * in any block around it, said something when it holds a `say` that is not inside an `if`, a `switch` or a `try` —
 * those are other branches. A `say` in a loop is a listing, and counts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export interface CliExitFinding {
  file: string;
  line: number;
  detail: string;
}

const ROOT = new URL("../", import.meta.url).pathname;
const CLI = "apps/engine/src/cli";

/** What ends a command with a non-zero exit (`cli/ui.ts`, `cli/usage.ts`). */
const FAILS = new Set(["fail", "usageError", "usageLines", "unknownAction", "crashed"]);

/** The text a `say` opens with, as far as it is written down: the head of a template, or a string. */
function openingText(arg: ts.Expression): string[] {
  if (ts.isParenthesizedExpression(arg)) return openingText(arg.expression);
  if (ts.isConditionalExpression(arg)) return [...openingText(arg.whenTrue), ...openingText(arg.whenFalse)];
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [arg.text];
  if (ts.isTemplateExpression(arg)) {
    // Colour codes first — `${RED}✗${RESET} …` — so the text is what follows the leading interpolations that are colours.
    let text = arg.head.text;
    for (const span of arg.templateSpans) {
      if (text.trim() !== "" || !ts.isIdentifier(span.expression) || !/^[A-Z]+$/.test(span.expression.text)) break;
      text = span.literal.text;
    }
    return [text];
  }
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.PlusToken) return openingText(arg.left);
  return [];
}

/** Every literal part of what a `say` is handed, joined — what can be read of it without running it. */
function writtenText(arg: ts.Expression): string {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return [arg.head.text, ...arg.templateSpans.map((span) => span.literal.text)].join(" ");
  let text = "";
  ts.forEachChild(arg, (child) => void (text += ` ${ts.isExpression(child) ? writtenText(child) : ""}`));
  return text;
}

/**
 * A usage line: the command's `USAGE`, `usageFor(…)`, or text that opens with `nouride <command>` or `usage:` and
 * writes an argument the way usage does — `<id>`, `[file]`, `a|b`, `--flag`. Without one it is a heading: `nouride
 * doctor` over a report, `nouride chat → <url>` over a session.
 */
function isUsage(arg: ts.Expression): boolean {
  if (ts.isIdentifier(arg) && /usage/i.test(arg.text)) return true;
  // `usageFor(command)`, `wakeUpUsage(…)`: what a function named for usage returns is usage.
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && /usage/i.test(arg.expression.text)) return true;
  return openingText(arg).some((text) => /^\s*(nouride [a-z]|usage:)/i.test(text)) && /<[a-z.…]|\[[a-z.<-]|\w\|\w|\s--[a-z]/i.test(writtenText(arg));
}

const isFailureLine = (arg: ts.Expression): boolean => openingText(arg).some((text) => /^\s*✗/.test(text));

const calls = (node: ts.Node, test: (call: ts.CallExpression) => boolean): boolean => {
  let found = false;
  const visit = (at: ts.Node): void => {
    if (found || ts.isFunctionLike(at)) return;
    if (ts.isCallExpression(at) && test(at)) found = true;
    else ts.forEachChild(at, visit);
  };
  visit(node);
  return found;
};

const named = (call: ts.CallExpression, names: ReadonlySet<string> | string): boolean =>
  ts.isIdentifier(call.expression) && (typeof names === "string" ? call.expression.text === names : names.has(call.expression.text));

/** `emit({ help: … })` — help given on purpose. */
const emitsHelp = (call: ts.CallExpression): boolean =>
  named(call, "emit") &&
  call.arguments.some((arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === "help"));

/** A `say` with something in it — `say()` is a blank line, which says nothing. */
const saysSomething = (call: ts.CallExpression): boolean => {
  const [arg] = call.arguments;
  return named(call, "say") && arg !== undefined && !((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text === "");
};

/** Whether a statement before the one that holds a `say` said something on the way there (see the header). */
function saidSomething(statement: ts.Statement): boolean {
  if (ts.isIfStatement(statement) || ts.isSwitchStatement(statement) || ts.isTryStatement(statement)) return false;
  return calls(statement, (call) => saysSomething(call) || emitsHelp(call));
}

/** Whether `statement` ends the command badly: a failing call, or a non-zero exit code set. */
function failsAfter(statement: ts.Statement): boolean {
  if (calls(statement, (call) => named(call, FAILS))) return true;
  let sets = false;
  const visit = (at: ts.Node): void => {
    if (sets || ts.isFunctionLike(at)) return;
    if (
      ts.isBinaryExpression(at) &&
      at.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(at.left) &&
      at.left.name.text === "exitCode" &&
      !(ts.isNumericLiteral(at.right) && at.right.text === "0")
    ) {
      sets = true;
    } else ts.forEachChild(at, visit);
  };
  visit(statement);
  return sets;
}

/** The statement a node stands in, and the statements of the block or clause that holds it — null at a function's edge. */
function siblings(node: ts.Node): { statement: ts.Statement; list: readonly ts.Statement[] } | null {
  let at: ts.Node = node;
  while (at.parent && !ts.isFunctionLike(at.parent)) {
    const parent = at.parent;
    if ((ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) && ts.isStatement(at)) {
      return { statement: at, list: parent.statements };
    }
    at = parent;
  }
  return null;
}

function inLoop(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isFunctionLike(at); at = at.parent) {
    if (ts.isIterationStatement(at, false)) return true;
  }
  // A callback a list is walked with: `items.forEach((item) => say(…))`.
  const fn = ts.findAncestor(node, ts.isFunctionLike);
  const call = fn?.parent;
  return Boolean(call && ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ["forEach", "map", "flatMap"].includes(call.expression.name.text));
}

/**
 * A run that reads fewer `say` calls than this is a parser that stopped finding them, not a CLI that lost them: 0.7.11's
 * has about 580. Lower it when they really go — to a little under the count the run printed.
 */
export const MIN_SAYS = 450;

/** What is wrong with each `say` in one file, and how many it read. */
export function cliExitFindings(rel: string, text: string): { says: number; findings: CliExitFinding[] } {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const findings: CliExitFinding[] = [];
  let says = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && named(node, "say")) says += 1;
    if (ts.isCallExpression(node) && named(node, "say") && node.arguments[0]) {
      const arg = node.arguments[0];
      if (isUsage(arg) && !saidBefore(node)) {
        findings.push({
          file: rel,
          line: lineOf(node),
          detail: "prints a usage line as the whole answer, and exits 0 — a call missing what it needs is `usageLines(…)` (exit 2); help given on purpose says so with `emit({ help })` first",
        });
      } else if (isFailureLine(arg) && !inLoop(node) && !failsLater(node)) {
        findings.push({
          file: rel,
          line: lineOf(node),
          detail: "prints a ✗ line and exits 0 — end it with `fail(…)` (exit 1) or `usageError(…)` (exit 2), or set `process.exitCode`",
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { says, findings };
}

/** Whether anything was said before `say`, on its way from the top of its function (see the header). */
function saidBefore(say: ts.Node): boolean {
  for (let at: ts.Node = say; ; ) {
    const held = siblings(at);
    if (!held) return false;
    const index = held.list.indexOf(held.statement);
    if (held.list.slice(0, index).some(saidSomething)) return true;
    at = held.statement.parent;
  }
}

/** Whether the command ends badly after a ✗ line: in its block, or in a block around it once its own ends. */
function failsLater(say: ts.Node): boolean {
  const held = siblings(say);
  if (!held) return false;
  const index = held.list.indexOf(held.statement);
  // The statement itself — `if (x) { say(✗); process.exitCode = 1 }` written on one line counts as its block.
  return held.list.slice(index).some(failsAfter);
}

/** Every `.ts` file of the CLI, relative to `root`. */
function cliFiles(root: string): string[] {
  const dir = join(root, CLI);
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts"))
    .map((file) => relative(root, join(dir, file)))
    .sort();
}

/** The whole CLI, and how many `say` calls it read — a parser that stopped finding them would find nothing wrong. */
export function checkCliExits(root: string = ROOT): { says: number; findings: CliExitFinding[] } {
  let says = 0;
  const findings: CliExitFinding[] = [];
  for (const rel of cliFiles(root)) {
    const found = cliExitFindings(rel, readFileSync(join(root, rel), "utf8"));
    says += found.says;
    findings.push(...found.findings);
  }
  return { says, findings };
}
