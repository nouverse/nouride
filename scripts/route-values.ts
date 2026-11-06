/**
 * What a value in a control route can be, as far as its file says (0.8.20): the half of `route-words.ts` that follows a
 * value, split out when that file passed its size cap. A const and what it holds; what a function of the file returns,
 * an element of a tuple or a field of an object it returns; either side of `?:`, `||` and `??`; a parameter of a function
 * of the file, by the arguments its calls pass; and a const another file exports, or a function of the control API's
 * own (`web/control/`). A function of any other file is a domain's: what it returns is not followed, and the value
 * stands as itself, for `route-words.ts` to call words it cannot read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..");
export const CONTROL = join(ROOT, "apps/engine/src/modules/web/control");

type Fn = ts.FunctionLikeDeclaration;

export const unwrap = (node: ts.Expression): ts.Expression => {
  let at = node;
  while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) at = at.expression;
  return at;
};

export const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);

/** A value that is no text at all: a field holding one of these says nothing. */
export const isNoText = (node: ts.Node): boolean =>
  ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isNumericLiteral(node) ||
  node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
  (ts.isIdentifier(node) && node.text === "undefined");

export function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();
}

const isConst = (declaration: ts.VariableDeclaration): boolean =>
  ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;

/** Where a name is declared, seen from `from`: a const, a function, a parameter, a loop's or a catch's variable. */
export function declarationOf(name: string, from: ts.Node): ts.Node | undefined {
  return declaredIn(name, from) ?? imported(name, from.getSourceFile());
}

const parsed = new Map<string, ts.SourceFile>();

/**
 * A const another file of the engine exports and this one imports by name: shared words, such as one `plain` several
 * routes answer with. A function too, where it is the control API's own (`web/control/`): words worded at the route,
 * shared by two of them. A function of any other file is a domain's, and what it returns is not read here.
 */
function imported(name: string, file: ts.SourceFile): ts.Node | undefined {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    const specifier = bindings && ts.isNamedImports(bindings) ? bindings.elements.find((element) => element.name.text === name) : undefined;
    if (!specifier) continue;
    const from = statement.moduleSpecifier.text;
    const path = from.startsWith("@/") ? join(ROOT, "apps/engine/src", from.slice(2)) : from.startsWith(".") ? join(file.fileName, "..", from) : null;
    if (!path || !path.endsWith(".ts")) return undefined;
    let source = parsed.get(path);
    if (!source) {
      try {
        source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      } catch {
        return undefined;
      }
      parsed.set(path, source);
    }
    const exported = (specifier.propertyName ?? specifier.name).text;
    const routes = path.startsWith(`${CONTROL}/`);
    for (const declared of source.statements) {
      const isExported = (ts.isVariableStatement(declared) || ts.isFunctionDeclaration(declared)) && declared.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) continue;
      if (ts.isFunctionDeclaration(declared)) {
        if (routes && declared.name?.text === exported) return declared;
        continue;
      }
      const found = (declared as ts.VariableStatement).declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === exported);
      if (found && (routes || !functionOf(found))) return found;
    }
    return undefined;
  }
  return undefined;
}

function declaredIn(name: string, from: ts.Node): ts.Node | undefined {
  for (let at: ts.Node | undefined = from; at; at = at.parent) {
    if (ts.isFunctionLike(at)) {
      const parameter = at.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === name);
      if (parameter) return parameter;
    }
    if (ts.isCatchClause(at) && at.variableDeclaration && ts.isIdentifier(at.variableDeclaration.name) && at.variableDeclaration.name.text === name) {
      return at.variableDeclaration;
    }
    if ((ts.isForOfStatement(at) || ts.isForInStatement(at) || ts.isForStatement(at)) && at.initializer && ts.isVariableDeclarationList(at.initializer)) {
      const found = at.initializer.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
      if (found) return found;
    }
    if (ts.isBlock(at) || ts.isSourceFile(at) || ts.isModuleBlock(at) || ts.isCaseClause(at) || ts.isDefaultClause(at)) {
      for (const statement of at.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
        if (ts.isVariableStatement(statement)) {
          const found = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

/** The function a declaration names: a function, or a const holding an arrow or a function expression. */
export function functionOf(declaration: ts.Node | undefined): Fn | undefined {
  if (!declaration) return undefined;
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const value = unwrap(declaration.initializer);
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value;
  }
  return undefined;
}

/** The name a function of the file is called by, if it has one. */
function nameOf(fn: Fn): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text;
  let at: ts.Node = fn.parent;
  while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at)) at = at.parent;
  return ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) ? at.name.text : undefined;
}

/** What a function returns: its own `return`s, not those of a function inside it. */
function returnsOf(fn: Fn): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/** Each call of a function of the file, found by its name where that name means this function. */
function callsOf(fn: Fn): ts.CallExpression[] | undefined {
  const name = nameOf(fn);
  if (!name) return undefined;
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name && functionOf(declarationOf(name, node)) === fn) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(fn.getSourceFile());
  return found;
}

/**
 * What a value can be, as far as its file says: itself, or what a const holds, what a function of the file returns,
 * an element of a tuple or a field of an object it returns, either side of `?:`, `||` and `??`, and a parameter's
 * arguments where the function is the file's. What the file does not say is the value itself, for the caller to read.
 */
export function values(node: ts.Expression, seen: Set<ts.Node> = new Set()): ts.Expression[] {
  const at = unwrap(node);
  if (seen.has(at)) return [];
  seen.add(at);
  if (ts.isConditionalExpression(at)) return [...values(at.whenTrue, seen), ...values(at.whenFalse, seen)];
  if (ts.isBinaryExpression(at) && (at.operatorToken.kind === ts.SyntaxKind.BarBarToken || at.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [...values(at.left, seen), ...values(at.right, seen)];
  }
  if (ts.isAwaitExpression(at)) return values(at.expression, seen);
  if (ts.isIdentifier(at)) {
    const declaration = declarationOf(at.text, at);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && isConst(declaration) && !functionOf(declaration)) {
      return values(declaration.initializer, seen);
    }
    if (declaration && ts.isParameter(declaration)) {
      const fn = declaration.parent as Fn;
      const index = fn.parameters.indexOf(declaration);
      const calls = callsOf(fn);
      if (calls && calls.length > 0 && calls.every((call) => !call.arguments.some(ts.isSpreadElement))) {
        return calls.flatMap((call) => {
          const argument = call.arguments[index] ?? declaration.initializer;
          return argument ? values(argument, seen) : [];
        });
      }
    }
    return [at];
  }
  if (ts.isCallExpression(at) && ts.isIdentifier(at.expression)) {
    const fn = functionOf(declarationOf(at.expression.text, at));
    if (fn) return returnsOf(fn).flatMap((returned) => values(returned, seen));
    return [at];
  }
  if (ts.isElementAccessExpression(at) && ts.isNumericLiteral(at.argumentExpression)) {
    const index = Number(at.argumentExpression.text);
    return values(at.expression, seen).flatMap((value) => {
      if (ts.isArrayLiteralExpression(value)) return value.elements[index] ? values(value.elements[index] as ts.Expression, seen) : [];
      return isNoText(value) ? [] : [at];
    });
  }
  if (ts.isPropertyAccessExpression(at)) {
    const name = at.name.text;
    return values(at.expression, seen).flatMap((value) => {
      if (ts.isObjectLiteralExpression(value)) {
        const field = value.properties.find((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propertyName(p.name) === name);
        if (!field) return [];
        return values(ts.isPropertyAssignment(field) ? field.initializer : field.name, seen);
      }
      return isNoText(value) ? [] : [at];
    });
  }
  return [at];
}
