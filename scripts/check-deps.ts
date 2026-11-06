#!/usr/bin/env bun
/**
 * What each workspace member declares in its `package.json`, against what its files import — both ways.
 *
 * The package graph used to be written twice: in each `package.json`, and by hand in `check-arch.ts` as `ALLOWED_DEPS`,
 * whose header said it was read from the first and never read a manifest. The two had drifted (the matrix let `llm`
 * import `runtime`, which `llm` does not declare), a package missing from the map — `update`, `system-packages`,
 * `wa-bridge` — could import anything, and an `await import("@nouride/policy")` passed it. With Bun's isolated linker a
 * `package.json` is what actually decides what resolves, in CI and in the image, so it is the matrix, and this holds it:
 *
 * - **imported, not declared** — a bare import of a package the member's manifest does not name. It resolves on a
 *   laptop through a stale link or the store's hoisted fallback, and not after a clean `bun install --frozen-lockfile`.
 *   The shim's `whatsapp-rust-bridge` was one.
 * - **declared, not imported** — a dependency no file of the member imports: a graph edge, or an install, for nothing.
 *   The site's `lucide-react` and `persona`'s `@nouride/secrets` once were. `TOOLING` names the ones a tool uses
 *   rather than an import, each with its reason.
 * - **a cycle** among the workspace members' own dependencies.
 *
 * Imports are read by TypeScript's own pre-processor — every spelling, dynamic and `require` included, and nothing that
 * only looks like one inside a string — plus an Astro page's frontmatter, an MDX file's import lines, and a
 * stylesheet's `@import` and `@plugin`.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { ALWAYS, OPTIONAL } from "./build/edition.ts";

export interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface Member {
  /** Relative to the root: `packages/llm`. */
  dir: string;
  manifest: Manifest;
  /** Each file's path relative to the root, and its text. */
  files: { path: string; text: string }[];
}

export interface Finding {
  member: string;
  rule: "imported-not-declared" | "declared-not-imported" | "cycle" | "stale-tooling";
  detail: string;
}

/**
 * Declared and used by something other than an import, by member: name → why. A tool that runs the package (`tsc`,
 * the Astro CLI) or reads it by name from its own config is a use the scan cannot see.
 */
export const TOOLING: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "*": {
    typescript: "`tsc` — lint:types runs it in every project",
    "@types/node": "Node's globals for the compiler, not a module anything imports",
  },
  "apps/site": {
    "@astrojs/check": "`astro check` loads it — lint:site runs it over the pages",
    satteri:
      "Starlight's `<Steps>` and `<Tabs>` render through it when a page is built. Declared here, Vite resolves it from " +
      "the site and leaves it out of the prerender bundle; bundled, its loader looked for its native binding beside the " +
      "bundle, where Bun's isolated linker puts none, and a fresh install's build stopped at the first such page " +
      "(site-build-fresh-clone). Starlight's own range, held by site-satteri.test.ts",
  },
};

/** Specifiers that are not packages: this app's own `src` and the brand assets, by tsconfig path or Vite alias. */
const ALIASES = ["@/", "@brand/"];

const SOURCE = /\.(?:[cm]?[jt]sx?|astro|mdx)$/;
const STYLE = /\.css$/;
const STYLE_IMPORT = /@(?:import|plugin)\s+["']([^"']+)["']/g;
const SKIP_DIRS = new Set(["node_modules", "dist", "public", ".astro", ".tanstack"]);

/** The package a bare specifier names — `react` for `react-dom/client` is `react-dom`; `@a/b` for `@a/b/c`. */
export function packageOf(specifier: string): string | null {
  const bare = specifier.split("?")[0]!;
  if (bare.startsWith(".") || bare.startsWith("/") || bare.includes(":")) return null; // relative, absolute, node:, bun:, astro:
  if (ALIASES.some((alias) => bare.startsWith(alias))) return null;
  const parts = bare.split("/");
  if (bare.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0]!;
}

/** Node's own modules, bare-spelled — `path`, `fs/promises`. Prefixed ones (`node:`) never reach `packageOf`. */
const NODE_CORE = new Set([
  "assert", "async_hooks", "buffer", "child_process", "crypto", "dns", "events", "fs", "http", "https", "module", "net",
  "os", "path", "perf_hooks", "process", "readline", "stream", "string_decoder", "timers", "tls", "tty", "url", "util",
  "worker_threads", "zlib",
]);

/** The script in a file: an Astro page's frontmatter, an MDX file's `import` lines, or the whole of anything else. */
function scriptOf(path: string, text: string): string {
  if (path.endsWith(".astro")) return /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  if (path.endsWith(".mdx")) return text.split("\n").filter((line) => /^(?:import|export)\s/.test(line)).join("\n");
  return text;
}

/** Every package a file imports, by name. */
export function importsOf(path: string, text: string): string[] {
  const found = new Set<string>();
  const add = (specifier: string) => {
    const name = packageOf(specifier);
    if (name && !NODE_CORE.has(name) && name !== "bun") found.add(name);
  };
  if (STYLE.test(path)) {
    for (const match of text.matchAll(STYLE_IMPORT)) add(match[1]!);
    return [...found];
  }
  // `require(…)` only where it is how a file imports — a JavaScript file. In TypeScript a `store.require("name")` is a
  // method call, and the pre-processor would read it as one.
  const javascript = /\.[cm]?jsx?$/.test(path);
  for (const { fileName } of ts.preProcessFile(scriptOf(path, text), true, javascript).importedFiles) add(fileName);
  return [...found];
}

const declared = (manifest: Manifest) => ({
  ...manifest.peerDependencies,
  ...manifest.optionalDependencies,
  ...manifest.devDependencies,
  ...manifest.dependencies,
});

/**
 * A daemon plugin, linked into `node_modules` by the build rather than declared (`scripts/build/edition.ts`): the engine
 * imports it by name and an edition that leaves it out has none. Only the engine may.
 */
const LINKED_PLUGINS = new Set([...ALWAYS, ...OPTIONAL].map((plugin) => plugin.pkg));
const isLinkedPlugin = (member: string, name: string) => member === "apps/engine" && LINKED_PLUGINS.has(name);

/**
 * The findings for a set of members — pure, so the test can plant each case. `root` is the repository's own manifest:
 * what it declares resolves from every member by walking up to the root `node_modules`, so a member may import it
 * without declaring it again (`typescript`, `@types/bun`).
 */
export function depFindings(
  members: readonly Member[],
  root: Manifest = { name: "root" },
  exempt: Readonly<Record<string, Readonly<Record<string, string>>>> = TOOLING,
): Finding[] {
  const findings: Finding[] = [];
  const workspace = new Set(members.map((member) => member.manifest.name));
  const inherited = declared(root);
  for (const member of members) {
    const names = declared(member.manifest);
    const imported = new Map<string, string>();
    for (const file of member.files) for (const name of importsOf(file.path, file.text)) if (!imported.has(name)) imported.set(name, file.path);

    for (const [name, where] of imported) {
      if (name === member.manifest.name || name in names || name in inherited || isLinkedPlugin(member.dir, name)) continue;
      const kind = workspace.has(name) ? "the workspace package" : "the package";
      findings.push({ member: member.dir, rule: "imported-not-declared", detail: `${where} imports ${kind} ${name}, which ${member.dir}/package.json does not declare` });
    }
    const tooling = { ...exempt["*"], ...exempt[member.dir] };
    // An entry of this member's own that an import now covers, or that names nothing it declares, is an exemption kept
    // for nothing — and the next one copies it.
    for (const name of Object.keys(exempt[member.dir] ?? {})) {
      if (imported.has(name) || !(name in names)) findings.push({ member: member.dir, rule: "stale-tooling", detail: `TOOLING excuses ${name} in ${member.dir}, which ${imported.has(name) ? "is imported" : "is not declared"} — drop the entry` });
    }
    for (const name of Object.keys(names)) {
      if (imported.has(name) || name in tooling) continue;
      // A types package is used by the import of the package it types.
      if (name.startsWith("@types/") && imported.has(name.slice("@types/".length).replace(/^(.+)__(.+)$/, "@$1/$2"))) continue;
      findings.push({ member: member.dir, rule: "declared-not-imported", detail: `${member.dir}/package.json declares ${name}, and nothing in ${member.dir} imports it` });
    }
  }
  findings.push(...cycles(members, workspace));
  return findings;
}

/** A cycle among the members' runtime dependencies on one another, said once per cycle. */
function cycles(members: readonly Member[], workspace: ReadonlySet<string>): Finding[] {
  const edges = new Map(members.map((member) => [member.manifest.name, Object.keys(member.manifest.dependencies ?? {}).filter((name) => workspace.has(name))]));
  const dirOf = new Map(members.map((member) => [member.manifest.name, member.dir]));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const visit = (name: string, path: string[]): void => {
    const at = path.indexOf(name);
    if (at !== -1) {
      const loop = [...path.slice(at), name];
      const key = [...loop.slice(0, -1)].sort().join(",");
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ member: dirOf.get(name)!, rule: "cycle", detail: `the dependencies go round: ${loop.join(" → ")}` });
      }
      return;
    }
    for (const next of edges.get(name) ?? []) visit(next, [...path, name]);
  };
  for (const name of edges.keys()) visit(name, []);
  return findings;
}

function filesUnder(root: string, dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      // A nested package is a member of its own (the bridge's libsignal shim), not part of this one.
      if (existsSync(join(root, rel, "package.json"))) continue;
      out.push(...filesUnder(root, rel));
    } else if ((SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) || STYLE.test(entry.name)) {
      out.push({ path: rel, text: readFileSync(join(root, rel), "utf8") });
    }
  }
  return out;
}

/** The root manifest's workspaces, read from disk. */
export function workspaceMembers(root: string): Member[] {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { workspaces?: string[] };
  return workspaces.map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest,
    files: filesUnder(root, dir),
  }));
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const members = workspaceMembers(root);
  const findings = depFindings(members, JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest);
  if (findings.length === 0) {
    console.log(`✓ every workspace member imports what its package.json declares, and declares what it imports (${members.length} members)`);
  } else {
    console.error(`✗ ${findings.length} dependency finding(s):\n`);
    for (const finding of findings) console.error(`  ${finding.member}  [${finding.rule}]\n    ${finding.detail}`);
    console.error(`\nDeclare it, import it, or — when a tool and not an import uses it — name it in TOOLING in ${relative(root, import.meta.path)}.`);
    process.exit(1);
  }
}
