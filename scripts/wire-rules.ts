/**
 * The line around `@nouride/wire`, the control API's payload types, which `check-arch.ts` holds (ARCHITECTURE.md §3).
 *
 * The dashboard reaches the daemon over HTTP and imports no daemon code. It may import this package because nothing in
 * it runs: types only, imported with `import type`, so the bundle carries none of it and none of what it names — the
 * types of `@nouride/shared` and `@nouride/acp`, the daemon's own words. Each rule below keeps one half of that true:
 *
 * - `wire-not-types-only`: the package declares types and imports and exports them as types, and nothing else.
 * - `wire-imports-workspace`: it names `@nouride/shared` and `@nouride/acp`, and no other package.
 * - `wire-imported-as-value`: the dashboard imports it with `import type` alone — an `import { … }` whose every name
 *   is a type is dropped by the bundler today, and kept the day a value is added to it.
 * - `wire-type-copied`: the dashboard declares no type the package exports. Its copies of every payload were what the
 *   package replaced, and `check-wire.ts` compared a few dozen of their word lists by hand.
 */

import ts from "typescript";

export const WIRE = "@nouride/wire";

/** The packages whose types the wire may name. */
const WIRE_MAY_IMPORT = new Set(["@nouride/shared", "@nouride/acp"]);

export interface WireFinding {
  line: number;
  rule: "wire-not-types-only" | "wire-imports-workspace" | "wire-imported-as-value" | "wire-type-copied";
  detail: string;
}

const parse = (rel: string, text: string) =>
  ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const lineOf = (source: ts.SourceFile, node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/** The names a wire file exports: its interfaces and type aliases, and what it re-exports by name. */
export function wireExports(rel: string, text: string): string[] {
  const names: string[] = [];
  for (const statement of parse(rel, text).statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) names.push(statement.name.text);
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
  }
  return names;
}

/** What `rel` — a file of the wire package or of the dashboard — breaks of the rules above. `exported`: `wireExports` of every wire file. */
export function wireFindings(rel: string, text: string, exported: ReadonlySet<string>): WireFinding[] {
  const source = parse(rel, text);
  const findings: WireFinding[] = [];
  const at = (node: ts.Node, rule: WireFinding["rule"], detail: string) => findings.push({ line: lineOf(source, node), rule, detail });

  if (rel.startsWith("packages/wire/")) {
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) {
        const from = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (!from.startsWith("./") && !WIRE_MAY_IMPORT.has(from)) {
          at(statement, "wire-imports-workspace", `"${from}" — the wire names the types of ${[...WIRE_MAY_IMPORT].join(" and ")} only`);
        }
        continue;
      }
      if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
      at(statement, "wire-not-types-only", `${statement.getText(source).split("\n")[0]!.slice(0, 80)} — ${WIRE} holds types, imported and exported as types`);
    }
    return findings;
  }

  if (!rel.startsWith("apps/dashboard/")) return findings;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === WIRE) {
      const typeOnly = ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly;
      if (!typeOnly) at(node, "wire-imported-as-value", `${node.getText(source).slice(0, 80)} — import ${WIRE} with \`import type\`, so the bundle carries none of it`);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0].text === WIRE) {
      at(node, "wire-imported-as-value", `${node.getText(source).slice(0, 80)} — ${WIRE} has nothing to load at runtime`);
    } else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && exported.has(node.name.text)) {
      at(node, "wire-type-copied", `${node.name.text} — ${WIRE} exports it; import that rather than keep a copy`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}
