/**
 * What a value in a control route can be, as far as its file says (0.8.20): the half of `route-words.ts` that follows a
 * value, split out when that file passed its size cap. A const and what it holds; what a function of the file returns,
 * an element of a tuple or a field of an object it returns, an entry of a table it looks up; either side of `?:`, `||`
 * and `??`, and the right of `&&`; a parameter of a function of the file, by the arguments its calls pass; and a const
 * another file exports, or a function of the control API's own (`web/control/`). A function of any other file is a
 * domain's: what it returns is not followed, and the value stands as itself, for `route-words.ts` to call words it
 * cannot read.
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
 * What the parameters of a function followed through a call stand for there (0.8.23): the arguments that call passes,
 * or a parameter's default where it passes none (null: nothing). A helper that makes a sentence of the words it is
 * handed, `notSaved("the schedule")` in `plain.ts`, is read with its caller's words in it; read as its own file's, its
 * parameter had no calls there, and what each route handed it was never read.
 */
export type Bound = ReadonlyMap<ts.ParameterDeclaration, ts.Expression | null>;

/** A value, and what the parameters of the functions it was followed into stand for there. */
export interface Valued {
  node: ts.Expression;
  bound: Bound;
}

const UNBOUND: Bound = new Map();

/** A call's arguments over the function's parameters, beside those of the calls it was reached through. */
function bindings(fn: Fn, call: ts.CallExpression, outer: Bound): Bound {
  // Spread over them, which argument is which parameter is not written: each is read by its file's calls, as before.
  if (call.arguments.some(ts.isSpreadElement)) return outer;
  const inner = new Map(outer);
  fn.parameters.forEach((parameter, index) => inner.set(parameter, call.arguments[index] ?? parameter.initializer ?? null));
  return inner;
}

/** What a value can be, as far as its file says: `valuesBound`'s, without what its parameters stood for. */
export function values(node: ts.Expression): ts.Expression[] {
  return valuesBound(node).map((value) => value.node);
}

/**
 * What a value can be, as far as its file says: itself, or what a const holds, what a function of the file returns,
 * an element of a tuple, a field of an object it returns or an entry of a table it looks up, either side of `?:`, `||`
 * and `??`, the right of `&&`, and a parameter's arguments: those of the call it was followed through, else every call
 * of its file's. What the file does not say is the value itself, for the caller to read. Each with what the parameters
 * of the functions it came out of stand for there, for a template it is to read its values by.
 */
export function valuesBound(node: ts.Expression, bound: Bound = UNBOUND, seen: Set<ts.Node> = new Set()): Valued[] {
  const at = unwrap(node);
  if (seen.has(at)) return [];
  seen.add(at);
  const self: Valued[] = [{ node: at, bound }];
  const next = (expression: ts.Expression, under: Bound = bound) => valuesBound(expression, under, seen);
  if (ts.isConditionalExpression(at)) return [...next(at.whenTrue), ...next(at.whenFalse)];
  if (ts.isBinaryExpression(at)) {
    const operator = at.operatorToken.kind;
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) return [...next(at.left), ...next(at.right)];
    // `a && b` is `a` only where `a` is empty, false or nothing, which says nothing: what it can say is `b`.
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return next(at.right);
  }
  if (ts.isAwaitExpression(at)) return next(at.expression);
  if (ts.isIdentifier(at)) {
    const declaration = declarationOf(at.text, at);
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && isConst(declaration) && !functionOf(declaration)) {
      return next(declaration.initializer);
    }
    if (declaration && ts.isParameter(declaration)) {
      if (bound.has(declaration)) {
        const argument = bound.get(declaration);
        return argument ? next(argument) : [];
      }
      const fn = declaration.parent as Fn;
      const index = fn.parameters.indexOf(declaration);
      const calls = callsOf(fn);
      if (calls && calls.length > 0 && calls.every((call) => !call.arguments.some(ts.isSpreadElement))) {
        return calls.flatMap((call) => {
          const argument = call.arguments[index] ?? declaration.initializer;
          return argument ? next(argument) : [];
        });
      }
    }
    return self;
  }
  if (ts.isCallExpression(at) && ts.isIdentifier(at.expression)) {
    const fn = functionOf(declarationOf(at.expression.text, at));
    if (!fn) return self;
    // What it returns, read again for each call: it stands for that call's arguments. The way here stays seen.
    const again = new Set(seen);
    const under = bindings(fn, at, bound);
    return returnsOf(fn).flatMap((returned) => valuesBound(returned, under, again));
  }
  if (ts.isElementAccessExpression(at)) {
    const key = at.argumentExpression;
    return next(at.expression).flatMap(({ node: value, bound: under }) => {
      // An element by its index, an entry by its name; by a key this cannot read, any of them.
      if (ts.isArrayLiteralExpression(value)) {
        const elements = ts.isNumericLiteral(key) ? [value.elements[Number(key.text)]] : value.elements;
        return elements.flatMap((element) => (element && !ts.isSpreadElement(element) ? next(element, under) : []));
      }
      if (ts.isObjectLiteralExpression(value)) {
        const named = ts.isStringLiteralLike(key) ? key.text : null;
        return value.properties.flatMap((p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (named === null || propertyName(p.name) === named)
            ? next(ts.isPropertyAssignment(p) ? p.initializer : p.name, under)
            : [],
        );
      }
      return isNoText(value) ? [] : self;
    });
  }
  if (ts.isPropertyAccessExpression(at)) {
    const name = at.name.text;
    return next(at.expression).flatMap(({ node: value, bound: under }) => {
      if (ts.isObjectLiteralExpression(value)) {
        const field = value.properties.find((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propertyName(p.name) === name);
        if (!field) return [];
        return next(ts.isPropertyAssignment(field) ? field.initializer : field.name, under);
      }
      return isNoText(value) ? [] : self;
    });
  }
  return self;
}
