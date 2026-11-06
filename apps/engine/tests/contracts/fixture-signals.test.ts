/**
 * A fake that ends itself on SIGTERM sets that handler before it prints anything. A test stops a fake as soon as it has
 * printed what the test waits for, and one stopped before its handler was set ended 143 instead of 0: the fake sign-in
 * on a CI runner after the v0.8.16 tag, and the fake setup-token in the same shape (0.8.17). The window is the time
 * between two statements, which no test can stop a running process inside, so the order is read off each fixture's
 * top-level statements instead.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../../../..");

/** Every fixture file of every member's tests. */
function fixtures(): string[] {
  const out: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const member of readdirSync(join(ROOT, group))) {
      const tests = join(ROOT, group, member, "tests");
      let entries: string[] = [];
      try {
        entries = readdirSync(tests, { recursive: true }) as string[];
      } catch {
        continue;
      }
      out.push(...entries.filter((path) => /(^|\/)fixtures\/.*\.ts$/.test(path)).map((path) => join(tests, path)));
    }
  }
  return out;
}

const isHandler = (statement: ts.Statement): boolean =>
  ts.isExpressionStatement(statement) &&
  ts.isCallExpression(statement.expression) &&
  /^process\.(on|once)$/.test(statement.expression.expression.getText()) &&
  statement.expression.arguments[0]?.getText() === '"SIGTERM"';

/** Whether `node` calls something that prints: the process's streams, the console, or one of `writers`. A function it defines is not a call. */
function prints(node: ts.Node, writers: ReadonlySet<string>): boolean {
  if (ts.isFunctionLike(node)) return false;
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    if (/^process\.(stdout|stderr)\.write$|^console\.\w+$/.test(callee) || writers.has(callee)) return true;
  }
  return ts.forEachChild(node, (child) => prints(child, writers) || undefined) ?? false;
}

/** A function whose body prints, by the name a fixture gives it: `const out = (text) => process.stdout.write(text)`. */
function writerName(statement: ts.Statement, writers: ReadonlySet<string>): string | null {
  const body = (fn: ts.Node | undefined) => fn && ts.isFunctionLike(fn) && "body" in fn && fn.body !== undefined && prints(fn.body as ts.Node, writers);
  if (ts.isFunctionDeclaration(statement) && statement.name && body(statement)) return statement.name.text;
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && body(declaration.initializer)) return declaration.name.text;
    }
  }
  return null;
}

/** The first top-level statement that prints before the SIGTERM handler is set, or null; undefined for a fixture with none. */
function printedBeforeHandler(path: string): string | null | undefined {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const writers = new Set<string>();
  let first: string | null = null;
  for (const statement of file.statements) {
    if (isHandler(statement)) return first;
    const name = writerName(statement, writers);
    if (name) writers.add(name);
    else if (first === null && prints(statement, writers)) first = statement.getText().split("\n")[0]!;
  }
  return undefined;
}

describe("a fake that ends on SIGTERM", () => {
  const handled = fixtures().flatMap((path) => {
    const early = printedBeforeHandler(path);
    return early === undefined ? [] : [{ fixture: relative(ROOT, path), early }];
  });

  test("there are such fakes to check", () => {
    expect(handled.length).toBeGreaterThanOrEqual(3);
  });

  for (const { fixture, early } of handled) {
    test(`${fixture}: sets its handler before it prints anything`, () => {
      expect({ fixture, printsFirst: early }).toEqual({ fixture, printsFirst: null });
    });
  }
});
