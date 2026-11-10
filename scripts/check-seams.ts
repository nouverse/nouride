#!/usr/bin/env bun
/**
 * The engine's declarations of its plugins, and the types two sides of a seam each keep, held to one another.
 *
 * The engine does not import a plugin's source. It declares the part it uses — `declare module "nouride-update"`, in
 * `apps/engine/src/**\/*.d.ts` — so its program does not take in the plugin's, and a plugin an edition leaves out is
 * never required. A declaration is a copy, and copies drift: a function renamed, an option made required, a field a
 * report stopped sending — each compiles on both sides and fails on a box. What stood guard read names with a regex,
 * or did not exist.
 *
 * So this compiles, for each declared module whose plugin is in this tree, the plugin's real module against its
 * declaration: every function, constant and class it declares, and every type it names. Then each pair of types kept
 * by hand on two sides (`PAIRS`): what one side makes, assigned to what the other reads — or, for two copies of one
 * definition, held equal. A plugin not in this tree (a public clone has no `internals/`) is said and passed over.
 *
 * Tooling may read every tree; nothing here ends up in a build.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { ALWAYS, OPTIONAL, type PluginSpec } from "./build/edition.ts";
import { notInstalled, uninstalledAt } from "./uninstalled.ts";
import { PAIRS, type Pair, type Side } from "./seam-pairs.ts";

export { PAIRS };

const ROOT = join(import.meta.dir, "..");
const PLUGINS: readonly PluginSpec[] = [...ALWAYS, ...OPTIONAL];

/** One `declare module "…"` block: what it says the plugin exports. */
export interface Declaration {
  module: string;
  /** Repo-relative. */
  file: string;
  values: string[];
  /** The types it names. A generic one is checked through the values that use it. */
  types: { name: string; generic: boolean }[];
}

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

/** Every module the engine declares in place of importing it. A pattern — `*.sql` — is not a plugin. */
export function declarations(texts?: ReadonlyMap<string, string>): Declaration[] {
  const found: Declaration[] = [];
  walk(join(ROOT, "apps/engine/src"), (path) => {
    if (!path.endsWith(".d.ts")) return;
    const file = relative(ROOT, path);
    const source = ts.createSourceFile(file, texts?.get(file) ?? readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isModuleDeclaration(statement) || !ts.isStringLiteral(statement.name) || statement.name.text.includes("*")) continue;
      if (!statement.body || !ts.isModuleBlock(statement.body)) continue;
      const declaration: Declaration = { module: statement.name.text, file, values: [], types: [] };
      const value = (name: string) => void (declaration.values.includes(name) || declaration.values.push(name));
      for (const member of statement.body.statements) {
        if (ts.isFunctionDeclaration(member) && member.name) value(member.name.text);
        if (ts.isVariableStatement(member)) {
          for (const variable of member.declarationList.declarations) if (ts.isIdentifier(variable.name)) value(variable.name.text);
        }
        if (ts.isClassDeclaration(member) && member.name) value(member.name.text);
        if ((ts.isClassDeclaration(member) || ts.isInterfaceDeclaration(member) || ts.isTypeAliasDeclaration(member)) && member.name) {
          declaration.types.push({ name: member.name.text, generic: Boolean(member.typeParameters?.length) });
        }
      }
      found.push(declaration);
    }
  });
  return found;
}

/** The plugin a module name belongs to, and the subpath of its `exports` it names. */
function pluginOf(module: string): { plugin: PluginSpec; subpath: string } | null {
  for (const plugin of PLUGINS) {
    if (module === plugin.pkg) return { plugin, subpath: "." };
    if (module.startsWith(`${plugin.pkg}/`)) return { plugin, subpath: `.${module.slice(plugin.pkg.length)}` };
  }
  return null;
}

/** The file a module name resolves to, by its package's `exports` — null when the package is not in this tree. */
function entryOf(plugin: PluginSpec, subpath: string): { dir: string; entry: string | null } | null {
  const dir = join(ROOT, plugin.pkgDir ?? plugin.dir);
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return null;
  const exports = (JSON.parse(readFileSync(manifest, "utf8")) as { exports?: unknown }).exports;
  let target: unknown = typeof exports === "string" ? (subpath === "." ? exports : undefined) : (exports as Record<string, unknown> | undefined)?.[subpath];
  if (typeof target === "object" && target !== null) target = (target as Record<string, unknown>).import ?? (target as Record<string, unknown>).default;
  return { dir, entry: typeof target === "string" && existsSync(join(dir, target)) ? join(dir, target) : null };
}

/** The compiler options a plugin is written for: its own tsconfig, the nearest above it, or the workspace's. */
function configOf(dir: string): string {
  for (let at = dir; at.startsWith(ROOT) && at !== ROOT; at = dirname(at)) {
    if (existsSync(join(at, "tsconfig.json"))) return join(at, "tsconfig.json");
  }
  return join(ROOT, "tsconfig.base.json");
}

function optionsOf(config: string): ts.CompilerOptions {
  const read = ts.readConfigFile(config, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config)).options;
  return {
    ...options,
    ...(config.endsWith("tsconfig.base.json") ? { types: ["bun"] } : {}),
    noEmit: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
  };
}

/** A file this check writes and compiles, with what each of its lines stands for. */
interface Probe {
  path: string;
  lines: string[];
  says: string[];
  /**
   * Aliases for each real type the probe compares, by what they stand for. One that comes out `any` — a module that
   * did not resolve, an import that did not compile in this program — would agree with anything, so it is a problem
   * of its own rather than a pass.
   */
  guards: Map<string, string>;
  /** The plugin directories whose source the probe reads: each import there has to resolve, or what it brings is `any`. */
  dirs: string[];
}

const PRELUDE = [
  "type Into<To, From extends To> = From;",
  "type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
];

function probe(path: string): Probe {
  return { path, lines: [...PRELUDE], says: PRELUDE.map(() => ""), guards: new Map(), dirs: [] };
}

function line(into: Probe, text: string, says: string): void {
  into.lines.push(text);
  into.says.push(says);
}

function guard(into: Probe, type: string, says: string): void {
  const alias = `G${into.guards.size}`;
  line(into, `type ${alias} = ${type};`, says);
  into.guards.set(alias, says);
}

/** An import specifier for `file` from the probe at `from`. */
function specifier(from: string, file: string): string {
  const path = relative(dirname(from), file);
  return JSON.stringify(path.startsWith(".") ? path : `./${path}`);
}

/** Each declared value assigned from the real one, each named type from the real one, and no real one that is `any`. */
function declarationProbe(path: string, declared: { declaration: Declaration; entry: string }[]): Probe {
  const into = probe(path);
  into.dirs.push(dirname(path));
  declared.forEach(({ declaration, entry }, n) => {
    const at = `${declaration.module} (${declaration.file})`;
    line(into, `import type * as D${n} from ${JSON.stringify(declaration.module)};`, at);
    line(into, `import type * as R${n} from ${specifier(path, entry)};`, `${at}: the plugin's module, ${relative(ROOT, entry)}`);
    for (const name of declaration.values) {
      line(into, `export const v${n}_${name}: typeof D${n}.${name} = null as unknown as typeof R${n}.${name};`, `${at}: \`${name}\``);
      guard(into, `typeof R${n}.${name}`, `${at}: \`${name}\``);
    }
    for (const type of declaration.types) {
      if (type.generic) continue;
      line(into, `export type t${n}_${type.name} = Into<D${n}.${type.name}, R${n}.${type.name}>;`, `${at}: the type \`${type.name}\``);
      guard(into, `R${n}.${type.name}`, `${at}: the type \`${type.name}\``);
    }
  });
  return into;
}

function sideType(side: Side, alias: string): string {
  return side.type.includes("$") ? side.type.replaceAll("$", alias) : `${alias}.${side.type}`;
}

function pairsProbe(path: string, pairs: readonly Pair[]): Probe {
  const into = probe(path);
  pairs.forEach((pair, n) => {
    const at = `${pair.what} (${pair.from.file} → ${pair.to.file})`;
    line(into, `import type * as F${n} from ${specifier(path, join(ROOT, pair.from.file))};`, at);
    line(into, `import type * as T${n} from ${specifier(path, join(ROOT, pair.to.file))};`, at);
    const from = sideType(pair.from, `F${n}`);
    const to = sideType(pair.to, `T${n}`);
    guard(into, from, `${at}: ${pair.from.file}'s side`);
    guard(into, to, `${at}: ${pair.to.file}'s side`);
    if (pair.relation === "equal") line(into, `export const p${n}: true = null as unknown as Same<${from}, ${to}>;`, `${at}: not the same type`);
    else line(into, `export type p${n} = Into<${to}, ${from}>;`, at);
  });
  return into;
}

/** The probes compiled in one program, with the declarations as the engine's program sees them. */
function compile(config: string, probes: Probe[], texts?: ReadonlyMap<string, string>): string[] {
  const options = optionsOf(config);
  const host = ts.createCompilerHost(options, true);
  const written = new Map(probes.map((p) => [p.path, p.lines.join("\n")]));
  const contentOf = (fileName: string) => written.get(fileName) ?? texts?.get(relative(ROOT, fileName));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, onError, create) => {
    const content = contentOf(fileName);
    return content === undefined ? getSourceFile(fileName, language, onError, create) : ts.createSourceFile(fileName, content, language, true);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => contentOf(fileName) !== undefined || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => contentOf(fileName) ?? readFile(fileName);

  const ambient: string[] = [];
  walk(join(ROOT, "apps/engine/src"), (path) => void (path.endsWith(".d.ts") && ambient.push(path)));
  const program = ts.createProgram({ rootNames: [...probes.map((p) => p.path), ...ambient], options, host });

  const problems: string[] = [];
  const checker = program.getTypeChecker();
  const dirs = probes.flatMap((p) => p.dirs);
  /** The installs the imports below are waiting for, by where to run each: said once, ahead of what they cause. */
  const missing = new Map<string, Set<string>>();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || written.has(file.fileName) || file.fileName.includes("/node_modules/")) continue;
    if (!dirs.some((dir) => file.fileName.startsWith(`${dir}/`))) continue;
    for (const statement of file.statements) {
      const from = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined;
      if (from && ts.isStringLiteral(from) && !checker.getSymbolAtLocation(from)) {
        const install = uninstalledAt(file.fileName, from.text);
        if (install) missing.set(install.dir, (missing.get(install.dir) ?? new Set<string>()).add(install.pkg));
        else problems.push(`${relative(ROOT, file.fileName)}: \`${from.text}\` does not resolve in this check — what comes through it is \`any\`, and agrees with anything`);
      }
    }
  }
  problems.unshift(...[...missing].map(([dir, packages]) => notInstalled(dir, [...packages].sort(), "compared")));
  for (const probe of probes) {
    const source = program.getSourceFile(probe.path)!;
    for (const statement of source.statements) {
      if (!ts.isTypeAliasDeclaration(statement) || !probe.guards.has(statement.name.text)) continue;
      if (checker.getTypeFromTypeNode(statement.type).flags & ts.TypeFlags.Any) {
        problems.push(`${probe.guards.get(statement.name.text)}\n      is \`any\` here — its module did not compile in this check, so nothing about it was compared`);
      }
    }
    for (const diagnostic of [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]) {
      const at = diagnostic.start === undefined ? 0 : source.getLineAndCharacterOfPosition(diagnostic.start).line;
      const message = ts
        .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        .replaceAll(`${ROOT}/`, "")
        .split("\n")
        .slice(0, 4)
        .join("\n      ");
      problems.push(`${probe.says[at] || "the check itself"}\n      ${message}`);
    }
  }
  return problems;
}

export interface SeamReport {
  problems: string[];
  /** Plugins and pairs compiled. */
  checked: string[];
  /** Plugins and pairs whose source is not in this tree. */
  absent: string[];
}

/**
 * Every declaration against its plugin, and every pair. `texts` stands in for files by repo-relative path — a
 * test's way to make a declaration drift without writing it — and `only` narrows the check to some plugins and
 * pairs, by package name or by what the pair is.
 */
export function checkSeams(texts?: ReadonlyMap<string, string>, only: (name: string) => boolean = () => true): SeamReport {
  const report: SeamReport = { problems: [], checked: [], absent: [] };
  const groups = new Map<string, Probe[]>();
  const add = (config: string, p: Probe) => groups.set(config, [...(groups.get(config) ?? []), p]);

  const byPlugin = new Map<PluginSpec, { declaration: Declaration; entry: string; dir: string }[]>();
  for (const declaration of declarations(texts)) {
    const owner = pluginOf(declaration.module);
    if (owner && !only(owner.plugin.pkg)) continue;
    if (!owner) {
      report.problems.push(`${declaration.module} (${declaration.file}): declared, and no plugin in scripts/build/edition.ts is that package — nothing holds it to a source`);
      continue;
    }
    const found = entryOf(owner.plugin, owner.subpath);
    if (!found) {
      if (!report.absent.includes(owner.plugin.pkg)) report.absent.push(owner.plugin.pkg);
      continue;
    }
    if (!found.entry) {
      report.problems.push(`${declaration.module} (${declaration.file}): ${owner.plugin.pkg}'s package.json exports no "${owner.subpath}"`);
      continue;
    }
    byPlugin.set(owner.plugin, [...(byPlugin.get(owner.plugin) ?? []), { declaration, entry: found.entry, dir: found.dir }]);
  }
  for (const [plugin, declared] of byPlugin) {
    const dir = declared[0]!.dir;
    add(configOf(dir), declarationProbe(join(dir, "__seams__.ts"), declared));
    report.checked.push(plugin.pkg);
  }

  const pairs = PAIRS.filter((pair) => only(pair.what));
  const present = pairs.filter((pair) => existsSync(join(ROOT, pair.from.file)) && existsSync(join(ROOT, pair.to.file)));
  for (const pair of pairs) (present.includes(pair) ? report.checked : report.absent).push(pair.what);
  if (present.length > 0) add(join(ROOT, "tsconfig.base.json"), pairsProbe(join(ROOT, "__seams__.ts"), present));

  for (const [config, probes] of groups) report.problems.push(...compile(config, probes, texts));
  return report;
}

if (import.meta.main) {
  const report = checkSeams();
  if (report.problems.length > 0) {
    console.error(`✗ ${report.problems.length} seam(s) out of step:\n${report.problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  const absent = report.absent.length ? ` — not in this tree: ${report.absent.join(", ")}` : "";
  console.log(`✓ the engine's plugin declarations and the hand-kept seam types hold (${report.checked.length} checked)${absent}`);
}
