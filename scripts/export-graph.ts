/**
 * Who imports each exported value — resolved by specifier, through barrels, with tests counted apart.
 *
 * `check-deadcode.ts` used to call an export used when any other file under `apps/` or `packages/` held its name as a
 * word. Three things passed that way that should not have:
 *
 * - **a test** — an export kept alive by the one test that imports it (`AutoApprovalGate`, a test double, lived in
 *   `src` and was "used" by twenty-five tests);
 * - **a barrel** — `export { loadSkills } from "./skills.ts"` named it, so every package's surface counted itself
 *   as its own caller, and barrels were exempt besides;
 * - **a namesake** — the dashboard's `PLATFORMS` was used because the engine has two private constants of that name,
 *   and `hasMedia` because two files have a local `hasMedia`.
 *
 * So imports are resolved: a relative path, an app's `@/`, a workspace package's name to its `exports`, and the
 * daemon's plugins to theirs. A re-export passes a use through to the file that defines the value; it is not one.
 * A namespace import counts the members it reads; a dynamic import, what it destructures, or everything when it
 * keeps the module whole.
 */

import { dirname, join, normalize } from "node:path";
import ts from "typescript";

/** A file under test: its own exports are not checked and its imports are counted apart. */
export const isTest = (rel: string) => /(^|\/)tests\//.test(rel) || /\.test\.tsx?$/.test(rel);

export interface ExportUse {
  /** Files other than its own, outside tests, that import it — directly or through any barrel. */
  production: Set<string>;
  /** Test files that import it. */
  tests: Set<string>;
}

interface Parsed {
  /** Values this file declares and exports: `export function|const|class name`, with the line. */
  values: Map<string, number>;
  /** `export { a as b } from "x"` — b → [x, a]. */
  reexports: Map<string, [string, string]>;
  /** `export * from "x"`. */
  stars: string[];
  /** What this file imports: [specifier, names], `*` meaning the whole module. */
  imports: [string, string[]][];
}

/** An `export` that is not `export default` — a default export is a module's one value, imported by no name. */
function hasExport(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  return modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) && !modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
}

/** Every property read off `name` in `file` — `ns.foo` gives `foo`. */
function membersRead(file: ts.SourceFile, name: string): string[] {
  const read = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) read.add(node.name.text);
    node.forEachChild(visit);
  };
  visit(file);
  return [...read];
}

function parse(rel: string, text: string): Parsed {
  const file = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const parsed: Parsed = { values: new Map(), reexports: new Map(), stars: [], imports: [] };
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name && hasExport(statement)) {
      parsed.values.set(statement.name.text, lineOf(statement));
    } else if (ts.isVariableStatement(statement) && hasExport(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) parsed.values.set(declaration.name.text, lineOf(statement));
      }
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const from = statement.moduleSpecifier.text;
      if (!statement.exportClause) parsed.stars.push(from);
      else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          // A type is not a value, and exported types are deliberately not checked (check-deadcode.ts says why).
          if (statement.isTypeOnly || element.isTypeOnly) continue;
          parsed.reexports.set(element.name.text, [from, (element.propertyName ?? element.name).text]);
        }
      } else parsed.imports.push([from, ["*"]]); // export * as ns — the whole module, to whoever imports ns
    } else if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name) && statement.body && ts.isModuleBlock(statement.body)) {
      // `declare module "nouride-update" { export function … }` — the engine's declaration of the part of a plugin it
      // uses, in place of importing its source (`check-seams.ts` holds the two together). Each name it declares is a
      // use of the plugin's export of that name.
      const names: string[] = [];
      for (const inner of statement.body.statements) {
        const name = (inner as { name?: ts.Node }).name;
        if (name && ts.isIdentifier(name)) names.push(name.text);
        if (ts.isVariableStatement(inner)) for (const d of inner.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
      parsed.imports.push([statement.name.text, names]);
    } else if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const names: string[] = [];
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
      } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        names.push(...membersRead(file, clause.namedBindings.name.text));
      }
      if (clause?.name) names.push("default");
      parsed.imports.push([statement.moduleSpecifier.text, names]);
    }
  }

  // Dynamic imports anywhere: `const { a, b } = await import("x")` reads a and b; anything else keeps the module whole.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const specifier = node.arguments[0].text;
      let parent: ts.Node = node.parent;
      if (ts.isAwaitExpression(parent)) parent = parent.parent;
      if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
        parsed.imports.push([specifier, parent.name.elements.map((element) => ((element.propertyName ?? element.name) as ts.Identifier).text)]);
      } else if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
        parsed.imports.push([specifier, membersRead(file, parent.name.text)]);
      } else {
        parsed.imports.push([specifier, ["*"]]);
      }
    }
    node.forEachChild(visit);
  };
  visit(file);
  return parsed;
}

export interface GraphInput {
  /** Every file that may import something — relative path → text. Tests, scripts and generated files included. */
  files: ReadonlyMap<string, string>;
  /** A package name (`@nouride/llm`, `nouride-update`) → the file its `exports["."]` names. */
  packages: ReadonlyMap<string, string>;
}

/** The file a specifier names from `from`, or null when it is not one of ours. */
export function resolveSpecifier(from: string, specifier: string, input: GraphInput): string | null {
  const candidates = (base: string) => [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base.replace(/\.js$/, ".ts")];
  const first = (base: string) => candidates(normalize(base)).find((path) => input.files.has(path)) ?? null;
  if (specifier.startsWith(".")) return first(join(dirname(from), specifier));
  if (specifier.startsWith("@/")) {
    // An app's own `src`: `apps/<app>/…` maps `@/` there, and the root scripts borrow the engine's.
    const app = /^(apps\/[^/]+)\//.exec(from)?.[1] ?? "apps/engine";
    return first(join(app, "src", specifier.slice(2)));
  }
  const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
  const entry = input.packages.get(name);
  if (!entry) return null;
  const subpath = specifier.slice(name.length);
  return subpath === "" ? entry : first(join(dirname(entry), subpath));
}

/**
 * For each file's exported values, who imports them. `checked` is the set of files whose exports are reported on;
 * everything in `files` may count as a user.
 */
export function exportUses(input: GraphInput): Map<string, Map<string, ExportUse>> {
  return graph(input).values;
}

/**
 * The same, plus each file's re-exports: `export { a } from "./x"` in a barrel is a name somebody may import from the
 * barrel and nobody may — a surface kept for no one, which a use of `a` from inside the package does not justify.
 */
export function graph(input: GraphInput): { values: Map<string, Map<string, ExportUse>>; reexports: Map<string, Map<string, ExportUse>> } {
  const parsed = new Map<string, Parsed>();
  for (const [rel, text] of input.files) parsed.set(rel, parse(rel, text));

  const uses = new Map<string, Map<string, ExportUse>>();
  for (const [rel, file] of parsed) {
    uses.set(rel, new Map([...file.values.keys()].map((name) => [name, { production: new Set<string>(), tests: new Set<string>() }])));
  }
  const passed = new Map<string, Map<string, ExportUse>>();
  for (const [rel, file] of parsed) {
    passed.set(rel, new Map([...file.reexports.keys()].map((name) => [name, { production: new Set<string>(), tests: new Set<string>() }])));
  }

  /** Mark `name` of `target` used by `user`, through re-exports, at most once per path. */
  const mark = (target: string, name: string, user: string, seen = new Set<string>()): void => {
    const key = `${target}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const file = parsed.get(target);
    if (!file) return;
    if (name === "*") {
      for (const own of file.values.keys()) mark(target, own, user, seen);
      for (const exported of file.reexports.keys()) mark(target, exported, user, seen);
      for (const star of file.stars) {
        const next = resolveSpecifier(target, star, input);
        if (next) mark(next, "*", user, seen);
      }
      return;
    }
    const use = uses.get(target)?.get(name);
    if (use) {
      if (user !== target) (isTest(user) ? use.tests : use.production).add(user);
      return;
    }
    const through = file.reexports.get(name);
    if (through) {
      const use = passed.get(target)?.get(name);
      if (use && user !== target) (isTest(user) ? use.tests : use.production).add(user);
      const next = resolveSpecifier(target, through[0], input);
      if (next) mark(next, through[1], user, seen);
      return;
    }
    for (const star of file.stars) {
      const next = resolveSpecifier(target, star, input);
      if (next) mark(next, name, user, seen);
    }
  };

  for (const [rel, file] of parsed) {
    for (const [specifier, names] of file.imports) {
      const target = resolveSpecifier(rel, specifier, input);
      if (target) for (const name of names) mark(target, name, rel);
    }
  }
  return { values: uses, reexports: passed };
}

/** Whether `name`, exported by `file`, is in the end a value — a function, const or class — and not a type. */
export function resolvesToValue(file: string, name: string, input: GraphInput, seen = new Set<string>()): boolean {
  const key = `${file}#${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const text = input.files.get(file);
  if (text === undefined) return false;
  const parsed = parse(file, text);
  if (parsed.values.has(name)) return true;
  const through = parsed.reexports.get(name);
  if (through) {
    const next = resolveSpecifier(file, through[0], input);
    return next !== null && resolvesToValue(next, through[1], input, seen);
  }
  return parsed.stars.some((star) => {
    const next = resolveSpecifier(file, star, input);
    return next !== null && resolvesToValue(next, name, input, seen);
  });
}

/** Whether `name` is used in its own file other than where it is declared — so dropping `export` would not kill it. */
export function usedInOwnFile(text: string, name: string): boolean {
  return (text.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length > 1;
}

/** The line each exported value of `rel` is declared on. */
export function exportedValues(rel: string, text: string): Map<string, number> {
  return parse(rel, text).values;
}
