/**
 * Every button has a name a screen reader can say, and the shared error banner is announced.
 *
 * A button drawn as an icon alone is read out as just "button": the room-rename confirm and the history drawer's
 * close were that, and nine more were named by `title` only — the last fallback a reader uses, and one most never
 * expose to touch. So a button whose content is icons and nothing else needs an `aria-label`.
 *
 * Read from the source with the compiler rather than from rendered pages, because most of these buttons appear only
 * after a click — a hover-revealed delete, a rename that is open — and a mount test reaches few of them.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import ts from "typescript";
import { ErrorNote } from "@/commons/components/ui/ui";

const SRC = join(dirname(import.meta.path), "..", "src");
/** Modules whose components draw a glyph and no text. */
const ICON_MODULES = new Set(["lucide-react", "@/commons/components/brand/logos"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".tsx") ? [path] : [];
  });
}

/** Whether a piece of JSX could put words on screen. Anything this cannot see into is taken to: a false alarm teaches people to skip the test. */
function hasText(node: ts.Node, icons: ReadonlySet<string>): boolean {
  if (ts.isJsxText(node)) return node.text.trim().length > 0;
  if (ts.isJsxExpression(node)) return node.expression ? expressionHasText(node.expression, icons) : false;
  if (ts.isJsxSelfClosingElement(node)) return !isIntrinsic(node.tagName) && !icons.has(node.tagName.getText());
  if (ts.isJsxElement(node)) {
    const tag = node.openingElement.tagName;
    if (!isIntrinsic(tag) && !icons.has(tag.getText())) return true;
    return node.children.some((child) => hasText(child, icons));
  }
  if (ts.isJsxFragment(node)) return node.children.some((child) => hasText(child, icons));
  return true;
}

function expressionHasText(expression: ts.Expression, icons: ReadonlySet<string>): boolean {
  if (ts.isParenthesizedExpression(expression)) return expressionHasText(expression.expression, icons);
  if (ts.isConditionalExpression(expression)) {
    return expressionHasText(expression.whenTrue, icons) || expressionHasText(expression.whenFalse, icons);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return expressionHasText(expression.right, icons);
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression)) {
    return hasText(expression, icons);
  }
  return true;
}

const isIntrinsic = (tag: ts.JsxTagNameExpression) => ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);

/** `file:line` of every `<button>` whose content is icons alone and which carries no `aria-label`. */
function unnamedButtons(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!ICON_MODULES.has(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) icons.add(element.name.text);
  }

  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (opening && opening.tagName.getText() === "button") {
      const attributes = opening.attributes.properties;
      const named = attributes.some(
        (attribute) => ts.isJsxSpreadAttribute(attribute) || ["aria-label", "aria-labelledby"].includes(attribute.name.getText()),
      );
      const children = ts.isJsxElement(node) ? node.children : ts.factory.createNodeArray<ts.JsxChild>();
      if (!named && !children.some((child) => hasText(child, icons))) {
        found.push(`${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(opening.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("buttons", () => {
  test("that show only an icon carry a name a screen reader says", () => {
    expect(sources(SRC).flatMap(unnamedButtons)).toEqual([]);
  });
});

describe("the error banner", () => {
  test("is announced when it appears", () => {
    expect(renderToString(createElement(ErrorNote, { error: new Error("the daemon did not answer") }))).toContain('role="alert"');
  });
});
