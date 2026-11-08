#!/usr/bin/env bun
/**
 * No named function grows past `MAX_FUNCTION_LINES` lines of code.
 *
 * The size check holds a file and says nothing of what is inside it: the executor's `run` reached 535 lines in a file
 * under its cap, `runDaemon` 744 and `runTurn` 825, and each was where every new feature went because it already held
 * everything. A function that long is one nobody reads whole before adding to it.
 *
 * ## What is a function here
 *
 * One with a name a person would look it up by: a function declaration, a method, a constructor or an accessor, and an
 * arrow function or function expression given to a variable, a class field or an object's key. A callback handed to a
 * call (`test(…, () => {…})`, a route's handler) has no name of its own and is part of its caller. A function inside
 * another is named after it (`outer.inner`, a method `Class.method`), and counts in its own lines and its parent's.
 *
 * Lines of **code**, as the size check counts them: a line with a token on it, so a comment or a blank line costs
 * nothing, and a function that explains itself is not punished for it.
 *
 * ## A ratchet, like the size budgets
 *
 * The functions over the cap when the rule began are recorded in `function-lengths.ts` at their length then, each with
 * the reason it stays whole. A recorded one may not grow; one that shrinks has its record lowered, or it could grow
 * back unseen; one back under the cap, or gone, leaves the list. Anything not recorded is held to the cap.
 */

import { join, relative } from "node:path";
import ts from "typescript";
import { isGenerated, MAX_WHY, sizedFiles } from "./check-size.ts";
import { LONG_FUNCTIONS } from "./function-lengths.ts";
import { PRO } from "./lint-sources.ts";
import type { Budget } from "./size-budgets.ts";

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * Set at 150, as the review of the code's shape proposed when it counted 136 functions over 100 lines and 40 over 200;
 * 77 named ones were over 150 lines of code when this rule began.
 */
const MAX_FUNCTION_LINES = 150;

/** How far over its function a record may sit: a few lines for the next small change, not room to grow back into. */
const HEADROOM = 5;

/** A named function over the cap, where it starts and how long it is. */
interface LongFunction {
  name: string;
  line: number;
  lines: number;
}

interface Finding {
  file: string;
  line: number;
  rule: "function-too-long" | "function-grew" | "record-under-cap" | "record-slack" | "stale-record" | "record-why";
  detail: string;
}

const isFunction = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node);

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : "[computed]";
}

/** The name a function is looked up by, or null for a callback handed to a call. */
function ownName(node: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "default";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return propertyName(node.name);
  // An arrow function or a function expression: named by what holds it, through any parentheses, `as` or `satisfies`.
  let holder: ts.Node = node.parent;
  while (ts.isParenthesizedExpression(holder) || ts.isAsExpression(holder) || ts.isSatisfiesExpression(holder)) holder = holder.parent;
  if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
  if ((ts.isPropertyDeclaration(holder) || ts.isPropertyAssignment(holder)) && holder.initializer !== undefined) return propertyName(holder.name);
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  return null;
}

/** The lines of `node` with a token on them: its code, without its comments and blank lines. */
function codeLines(node: ts.Node, source: ts.SourceFile): number {
  const lines = new Set<number>();
  const visit = (child: ts.Node): void => {
    if (child.kind >= ts.SyntaxKind.FirstJSDocNode && child.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = child.getChildren(source);
    if (children.length > 0) return children.forEach(visit);
    if (child.getEnd() === child.getStart(source)) return;
    const from = source.getLineAndCharacterOfPosition(child.getStart(source)).line;
    const to = source.getLineAndCharacterOfPosition(child.getEnd()).line;
    for (let line = from; line <= to; line += 1) lines.add(line);
  };
  visit(node);
  return lines.size;
}

/**
 * Every named function in `text` longer than `cap` lines of code, in source order. Two of one name in a file are told
 * apart by their order (`harness`, `harness#2`), so each has a record of its own.
 */
export function longFunctions(rel: string, text: string, cap = MAX_FUNCTION_LINES): LongFunction[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: LongFunction[] = [];
  const seen = new Map<string, number>();
  const visit = (node: ts.Node, path: readonly string[]): void => {
    let inside = path;
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) inside = [...path, node.name.text];
    if (isFunction(node)) {
      const own = ownName(node);
      if (own !== null) {
        inside = [...path, own];
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        // The span first: no function shorter than the cap in all its lines can be longer in its code.
        if (source.getLineAndCharacterOfPosition(node.getEnd()).line - start + 1 > cap) {
          const lines = codeLines(node, source);
          if (lines > cap) {
            const name = inside.join(".");
            const count = (seen.get(name) ?? 0) + 1;
            seen.set(name, count);
            found.push({ name: count === 1 ? name : `${name}#${count}`, line: start + 1, lines });
          }
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(source, []);
  return found;
}

/** What one file's long functions say against its records, both ways of the ratchet. */
export function functionFindings(
  rel: string,
  long: readonly LongFunction[],
  records: Readonly<Record<string, Budget>> = {},
  cap = MAX_FUNCTION_LINES,
): Finding[] {
  const findings: Finding[] = [];
  const at = (line: number, rule: Finding["rule"], detail: string) => findings.push({ file: rel, line, rule, detail });
  for (const { name, line, lines } of long) {
    const record = records[name];
    if (record === undefined) {
      at(line, "function-too-long", `\`${name}\` is ${lines} lines of code, over the ${cap} cap. Split it on a seam (its phases, a helper per concern), or record it in \`LONG_FUNCTIONS\` (scripts/function-lengths.ts) at ${lines} with the reason it stays whole`);
    } else if (lines > record.lines) {
      at(line, "function-grew", `\`${name}\` is ${lines} lines of code, over its record of ${record.lines}. Split it, or raise its record in \`LONG_FUNCTIONS\` with today's reason`);
    } else if (record.lines - lines > HEADROOM) {
      at(line, "record-slack", `\`${name}\` is ${lines} lines of code against a record of ${record.lines}: lower it to ${lines} in \`LONG_FUNCTIONS\`, or it may grow back unseen`);
    }
  }
  for (const [name, record] of Object.entries(records)) {
    if (!long.some((fn) => fn.name === name)) {
      at(0, "record-under-cap", `\`${name}\` is recorded at ${record.lines} and is no longer over the ${cap} cap, or no longer here: remove it from \`LONG_FUNCTIONS\``);
    }
    if (record.why.trim() === "" || record.why.length > MAX_WHY) {
      at(0, "record-why", `\`${name}\`'s \`why\` in \`LONG_FUNCTIONS\` is ${record.why.length} characters; say the one reason it stays whole, in 1 to ${MAX_WHY}`);
    }
  }
  return findings;
}

/** Everything the check finds in the tree at `root` against `records`. */
export async function checkFunctions(
  root: string,
  records: Readonly<Record<string, Readonly<Record<string, Budget>>>> = LONG_FUNCTIONS,
): Promise<{ files: number; long: number; findings: Finding[] }> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let long = 0;
  for (const path of await sizedFiles(root)) {
    const rel = relative(root, path);
    if (isGenerated(rel)) continue;
    seen.add(rel);
    const found = longFunctions(rel, await Bun.file(path).text());
    long += found.length;
    findings.push(...functionFindings(rel, found, records[rel]));
  }
  // The Pro code's records stay in a public clone, where the submodule is not checked out and its files are not gone.
  const pro = await Bun.file(join(root, PRO, "package.json")).exists();
  for (const rel of Object.keys(records)) {
    if (seen.has(rel) || (!pro && rel.startsWith(PRO))) continue;
    findings.push({ file: rel, line: 0, rule: "stale-record", detail: "has functions in `LONG_FUNCTIONS` and no longer exists: remove its entry" });
  }
  return { files: seen.size, long, findings };
}

async function main(): Promise<void> {
  const { files, long, findings } = await checkFunctions(ROOT);
  if (findings.length === 0) {
    console.log(`✓ no function over ${MAX_FUNCTION_LINES} lines of code but the ${long} recorded, in ${files} files`);
    return;
  }
  console.error(`✗ ${findings.length} finding(s):\n`);
  for (const f of findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line)) {
    console.error(`  ${f.file}${f.line > 0 ? `:${f.line}` : ""}  [${f.rule}]`);
    console.error(`    ${f.detail}\n`);
  }
  process.exit(1);
}

if (import.meta.main) await main();
