/**
 * Every error class says its own name, as a string, in its own body.
 *
 * Release builds mangle identifiers, so a name read off the class at run time — `new.target.name`,
 * `constructor.name`, or the `Error` an unnamed subclass inherits — is two letters in the shipped binary
 * or no name at all. 0.7.8 logged `jm: [files] path escapes workspace`. The journal line is the one thing
 * a customer's box sends back, and its error name is what it is searched by, so the name has to be a
 * literal the minifier cannot touch.
 *
 * Two spellings count, both already in the tree: a `name = "X"` field, or `this.name = "X"` in the
 * constructor. The literal must equal the class's own name — a copied class that kept its parent's
 * literal would log under the wrong name forever.
 *
 * Which classes are errors is found, not listed: anything whose `extends` reaches a built-in error,
 * through any number of the tree's own error classes. By name, across files — two classes of one name
 * are both held to the rule, which over-reaches harmlessly.
 */

import ts from "typescript";

const BUILTIN_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DOMException",
]);

export interface ErrorClass {
  file: string;
  line: number;
  /** `null` for an anonymous class expression, which cannot be named stably at all. */
  name: string | null;
  extends: string;
  /** The literal the class names itself with, or `null` when it says none. */
  declared: string | null;
}

/** The identifier an `extends` clause names: `Error`, `NourideError`, or `errors.ToolError` as `ToolError`. */
function heritageName(node: ts.ClassLikeDeclaration): string | null {
  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const expr = clause.types[0]?.expression;
    if (!expr) return null;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    return null;
  }
  return null;
}

/** `name = "X"` as an instance field, or `this.name = "X"` as a statement directly in the constructor. */
function declaredName(node: ts.ClassLikeDeclaration): string | null {
  for (const member of node.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) &&
      ts.isIdentifier(member.name) &&
      member.name.text === "name" &&
      member.initializer &&
      ts.isStringLiteralLike(member.initializer)
    ) {
      return member.initializer.text;
    }
    if (ts.isConstructorDeclaration(member) && member.body) {
      for (const statement of member.body.statements) {
        if (!ts.isExpressionStatement(statement)) continue;
        const expr = statement.expression;
        if (
          ts.isBinaryExpression(expr) &&
          expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(expr.left) &&
          expr.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          expr.left.name.text === "name" &&
          ts.isStringLiteralLike(expr.right)
        ) {
          return expr.right.text;
        }
      }
    }
  }
  return null;
}

/** Every class in these sources, with what it extends — error or not; `errorClasses` decides. */
function classesIn(file: string, text: string): ErrorClass[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: ErrorClass[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const parent = heritageName(node);
      if (parent) {
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          name: node.name?.text ?? null,
          extends: parent,
          declared: declaredName(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The error classes among `sources`: those whose `extends` chain reaches a built-in error. */
export function errorClasses(sources: { file: string; text: string }[]): ErrorClass[] {
  // Only a file that says `extends` can hold a class that does: parsing all 1,300 sources took 10–40 s on a loaded Mac,
  // past the test's 5 s, and most of them have no class at all.
  const all = sources.filter(({ text }) => text.includes("extends")).flatMap(({ file, text }) => classesIn(file, text));
  const errors = new Set(BUILTIN_ERRORS);
  for (let grew = true; grew; ) {
    grew = false;
    for (const cls of all) {
      if (cls.name && !errors.has(cls.name) && errors.has(cls.extends)) {
        errors.add(cls.name);
        grew = true;
      }
    }
  }
  return all.filter((cls) => errors.has(cls.extends));
}

/** What is wrong with each error class that does not name itself as itself. Empty when every one does. */
export function unnamedErrorClasses(sources: { file: string; text: string }[]): string[] {
  return errorClasses(sources).flatMap((cls) => {
    const at = `${cls.file}:${cls.line}`;
    if (cls.name === null) return [`${at}: an anonymous class extends ${cls.extends} — give it a name and a \`name = "…"\` field`];
    if (cls.declared === null) return [`${at}: ${cls.name} says no name — add \`override name = "${cls.name}";\``];
    if (cls.declared !== cls.name) return [`${at}: ${cls.name} calls itself "${cls.declared}"`];
    return [];
  });
}
