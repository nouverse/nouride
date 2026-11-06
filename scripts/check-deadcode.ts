#!/usr/bin/env bun
/**
 * Finds code and schema that nothing reaches.
 *
 * A companion to `check-arch.ts` and written the same way — a grep, not a plugin — for the same
 * reason: a handful of rules, no lint setup to hang a plugin off, and it runs inside
 * `bun run lint:check` so drift fails CI instead of being caught in review.
 *
 * ## Why it exists
 *
 * Every rule here is a thing that was found by hand, weeks late, on a live box.
 *
 *   `message_queue` and `gateway_state` were declared in the first migration, described a design
 *   that went another way, and sat at zero rows for three weeks while a test *asserted one of them
 *   existed*. Nothing was wrong with the code that read them, because there was none.
 *
 *   `listForAgent` on the session store lost its last caller in a refactor and stayed. So did a
 *   second `count()` on the same class, which typechecked as a duplicate overload for a while.
 *
 * None of that is caught by `noUnusedLocals`: TypeScript treats an `export` as a use, so an
 * exported symbol nobody imports looks used from inside the file that declares it. That gap is
 * the whole subject of this file.
 *
 * ## What it deliberately does not check
 *
 * Exported **types**. An interface used only by its own file's signatures costs nothing at runtime
 * and the check produced 239 of them against 44 values — a ratio that turns a rule into noise, and
 * a noisy rule is one people learn to skip. Values only.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { generateRouteTree } from "../apps/dashboard/scripts/routes.ts";
import { exportedValues, graph, isTest, resolvesToValue, usedInOwnFile, type GraphInput } from "./export-graph.ts";
import { lintedFiles, PRO } from "./lint-sources.ts";

interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * The Pro code's exports that nothing imports, as the audit found them (`pro-dead-exports-and-code`) — the one
 * exception to the rule below, and a ratchet rather than a pass: these may go, none may be added, and an entry
 * whose export is gone is reported until it is removed here, as `check-size.ts` treats a budget. Their removal is
 * planned with the rest of 0.7.10's dead code, and lives in that repository.
 */
// Empty since 0.7.10: the pro tree's last dead exports were dropped (pro-dead-exports-and-code). An entry here goes
// stale the moment its name is fixed, which is what keeps this list from becoming a place debt waits.
const PRO_KNOWN_DEAD: Record<string, readonly string[]> = {};

/**
 * Exports only tests import, kept on purpose: file → name → why. Each is a seam — a reset for state a module keeps, a
 * read of it, or a list a contract test holds a copy elsewhere to — not production code a test happens to keep alive.
 * An entry that is no longer one is reported, as `PRO_KNOWN_DEAD` is.
 *
 * A package barrel's entries are names it re-exports for the engine's tests, which may not reach past a barrel
 * (invariant 11): a package's own tests import its modules and need none. Until 0.7.11 a barrel export only tests
 * imported was a warning nobody read, and 22 had gathered.
 */
export const TEST_ONLY_EXPORTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "apps/engine/src/cli/commands/access.ts": {
    ACCESS_CHANGES: "the verbs that change somebody's standing; own-cli-verbs.test.ts holds @nouride/policy's copy to it",
  },
  "apps/engine/src/db/keys.ts": {
    ON_CONVERSATION_DELETE: "what deleting a conversation does to each table that keys on one; key-columns.test.ts holds the schema to it",
  },
  "apps/engine/src/modules/config/schema.ts": {
    configAnnotationDrift: "the annotations that describe no key any more; config-schema.test.ts holds it at none",
  },
  "apps/engine/src/modules/gateways/rename.ts": {
    RENAMED_IDENTIFIERS: "every identifier the rename interpolates; gateway-rename.test.ts holds each to the identifier guard",
  },
  "apps/engine/src/modules/llm/summarize.ts": {
    resetCompactionBreaker: "the compaction breaker is module state; a test that trips it resets it",
  },
  "apps/engine/src/modules/tools/builtins/sessions.ts": {
    activeSessionCount: "the live sub-sessions are module state; the tests read how many are left",
  },
  "apps/engine/src/modules/tools/builtins/plan.ts": {
    planTool: "the tool with nowhere to keep a plan past the turn — the refusals are tested on it, apart from any store",
  },
  "packages/persona/src/skill-requirements.ts": {
    clearSoftwareCache: "which programs are installed is cached for the process; a test that changes PATH clears it",
  },
  "packages/runtime/src/process-cgroup.ts": {
    forgetCommandIsolation: "where commands are moved to is module state; a test that split a cgroup of its own making forgets it",
  },
  "packages/acp/src/server.ts": {
    authRequired: "the error a session that wants a sign-in throws; the fake CLI throws it as a signed-out CLI does",
  },
  "packages/acp/src/index.ts": {
    authRequired: "the error a session that wants a sign-in throws; the fake CLI throws it as a signed-out CLI does",
  },
  "packages/gateways/src/index.ts": {
    UndeliverableError: "what an adapter throws for a chat that will never take a message; the pipeline's tests throw it as one would",
  },
  "packages/llm/src/index.ts": {
    flattenSystem: "a prompt's system blocks as the text a model reads; the engine's prompt tests assert on that text",
    systemBlocks: "a prompt's system blocks as the provider sends them; the memory fixture records what a pass was asked",
  },
  "packages/mcp/src/index.ts": {
    parseTools: "a server's tools/list answer as tools; the engine's MCP tool tests build their servers' tools through it",
  },
  "packages/persona/src/index.ts": {
    effectiveMcpServers: "the loader's MCP step without the rest of a pack; the engine's fold and login tests ask what an agent runs after a write, as the loader would read it",
    readAgentMcp: "an agent's mcp.toml read as the loader reads it; the engine's fold and library-save tests check what a write left, through the loader's own reading",
    loadAgent: "one pack, loaded as the registry loads each; the example pack's and person_record's tests load theirs",
    listSkills: "a pack's skills as the loader reads them; reflection's tests read back what a pass wrote",
    CANDIDATES: "where the built-in skills are looked for; builtin-skills-shipped.test.ts holds the release layout to it",
    checkSoftware: "which programs a skill needs, by name; skill-requirements.test.ts checks it against a PATH it builds",
    clearSoftwareCache: "which programs are installed is cached for the process; a test that changes PATH clears it",
    renderSkillMarkdown: "a skill written as its SKILL.md; reflection's tests render the one a pass would write",
    validateSupportFiles: "the files a written skill may carry; reflection's tests hold the paths it refuses",
  },
  "packages/shared/src/types/events.ts": {
    EVENT_EXAMPLES: "a row of every kind, for the event contract's tests to run the writers against",
  },
  "packages/update/src/edition.ts": {
    EDITIONS: "the editions; artifact-names.test.ts holds the build's own list in scripts/targets.ts to it",
  },
  "packages/update/src/release.ts": {
    forgetChannel: "the channel's answers are cached for the process; a test that serves another release clears them",
  },
};

/**
 * What a barrel's re-export of `name` is, by who imports it through the barrel: nothing to say (production does), a
 * seam TEST_ONLY_EXPORTS names, or a finding — nobody imports it, or only tests do.
 */
export function barrelVerdict(
  file: string,
  name: string,
  use: { production: ReadonlySet<string>; tests: ReadonlySet<string> },
): null | "seam" | { rule: "unused-barrel-export" | "test-only-barrel-export"; detail: string } {
  if (use.production.size > 0) return null;
  if (use.tests.size === 0) return { rule: "unused-barrel-export", detail: `\`${name}\` is re-exported and nothing imports it from here — drop it from the barrel` };
  if (TEST_ONLY_EXPORTS[file]?.[name]) return "seam";
  return {
    rule: "test-only-barrel-export",
    detail:
      `\`${name}\` is re-exported only for tests (${[...use.tests].slice(0, 2).join(", ")}) — drop it from the barrel and have a package test ` +
      "import its module, test it through what production calls, or name the seam in TEST_ONLY_EXPORTS with its reason",
  };
}

/** Whose exports are checked: shipped source — not tests, the root scripts, generated files or a framework's config. */
function isChecked(rel: string): boolean {
  return !isTest(rel) && !rel.startsWith("scripts/") && !rel.endsWith(".gen.ts") && !rel.includes(".config.") && !rel.endsWith(".d.ts");
}

/**
 * Everything that may import an export: the linted source with its tests, the generated route tree (the dashboard's
 * routes are imported by nothing else) and the root scripts (the release tooling imports the update plugin's signing);
 * and every workspace package by name — the Pro tree's too, when it is checked out — to the file its `exports` names.
 */
async function graphInput(): Promise<GraphInput> {
  const files = new Map<string, string>();
  for (const path of await lintedFiles(ROOT, ["ts", "tsx"])) files.set(relative(ROOT, path), await Bun.file(path).text());
  for await (const rel of new Bun.Glob("scripts/**/*.ts").scan({ cwd: ROOT })) files.set(rel, await Bun.file(join(ROOT, rel)).text());
  const packages = new Map<string, string>();
  const members = (base: string): string[] => {
    const manifest = join(ROOT, base, "package.json");
    if (!existsSync(manifest)) return [];
    return ((JSON.parse(readFileSync(manifest, "utf8")) as { workspaces?: string[] }).workspaces ?? []).map((dir) => join(base, dir));
  };
  for (const dir of [...members(""), ...members(PRO)]) {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as { name: string; exports?: unknown };
    const dot = typeof manifest.exports === "string" ? manifest.exports : (manifest.exports as Record<string, unknown> | undefined)?.["."];
    const entry = typeof dot === "string" ? dot : ((dot as { import?: string; default?: string } | undefined)?.import ?? (dot as { default?: string } | undefined)?.default);
    if (entry) packages.set(manifest.name, join(dir, entry));
  }
  return { files, packages };
}

/**
 * Files a `package.json` script runs by path — `build:pro` runs `internals/pro/packages/build-pro/build.ts` — which nothing
 * imports and which are not dead: they are run by name, like `scripts/`.
 */
const RUN_BY_SCRIPT = new Set(
  Object.values((JSON.parse(await Bun.file(`${ROOT}package.json`).text()) as { scripts?: Record<string, string> }).scripts ?? {})
    .flatMap((command) => [...command.matchAll(/(?:^|\s)([\w./-]+\.tsx?)(?=\s|$)/g)].map((m) => m[1]!)),
);

/** Same stripper as `check-arch.ts`: a name inside a doc comment is not a use of it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

/**
 * Files that are entry points, ambient declarations, or otherwise reached by something other than
 * an `import`.
 *
 * `.d.ts` is the important one: an ambient declaration is picked up by the compiler's include
 * globs and never imported by anything, so every one of them looks orphaned.
 */
function isReachedWithoutImport(rel: string): boolean {
  return (
    rel.endsWith(".d.ts") ||
    /(^|\/)(index|main)\.tsx?$/.test(rel) ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    rel.includes(".config.") ||
    rel.endsWith(".gen.ts") ||
    // TanStack Router discovers these by directory, not by import.
    rel.includes("/src/routes/") ||
    // A standalone script is run by name.
    rel.includes("/scripts/") ||
    RUN_BY_SCRIPT.has(rel)
  );
}

async function main(): Promise<void> {
  const findings: Finding[] = [];

  // The dashboard's route tree, generated and gitignored, is the only importer of every route's `Route`. lint:types
  // writes it too, but runs after this in lint:check: in a fresh clone or a new worktree, with no build yet, every
  // route was reported unused and the hook failed until the dashboard had been built by hand (fresh-checkout-hook).
  await generateRouteTree();

  // ── Read every source file once ───────────────────────────────────────────
  //
  // The Pro code too, when it is checked out: its own dead code is found the same way, and an engine export only the
  // Pro code uses is not reported as unused.
  const sources = new Map<string, string>();
  for (const path of await lintedFiles(ROOT, ["ts", "tsx"])) {
    const rel = relative(ROOT, path);
    if (rel.endsWith(".gen.ts")) continue;
    sources.set(rel, stripComments(await Bun.file(path).text()));
  }

  // ── 1. A table nothing names ──────────────────────────────────────────────
  //
  // The rule that would have caught `message_queue` and `gateway_state`. A migration is the only
  // place a table is created, and any code that uses one has to write its name in SQL — so a name
  // that appears in `db/` and nowhere else is a table with no code behind it.
  const tables = new Set<string>();
  // In version order: a glob lists files in no particular order, and a `DROP` read before the
  // `CREATE` it undoes would leave the dropped table counted as live.
  const migrations: string[] = [];
  for await (const path of new Bun.Glob("apps/engine/src/db/migrations/*.sql").scan({ cwd: ROOT, absolute: true })) migrations.push(path);
  for (const path of migrations.sort()) {
    const sql = await Bun.file(path).text();
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?["']?([a-z_]+)/g)) tables.add(m[1]!);
    for (const m of sql.matchAll(/DROP TABLE (?:IF EXISTS )?["']?([a-z_]+)/g)) tables.delete(m[1]!);
    // A rebuild-and-rename — the only way SQLite drops a constraint — leaves a `_new` table that
    // exists for three statements. It is not dead; it is not there at all by the end of the file.
    for (const m of sql.matchAll(/ALTER TABLE ["']?([a-z_]+)["']? RENAME TO/g)) tables.delete(m[1]!);
  }

  for (const table of tables) {
    const named = [...sources].some(
      ([file, code]) => !file.includes("/db/") && new RegExp(`\\b${table}\\b`).test(code),
    );
    if (!named) {
      findings.push({
        file: "apps/engine/src/db/migrations",
        line: 0,
        rule: "unreferenced-table",
        detail: `\`${table}\` is created by a migration and named by no source file — a schema that promises something no code delivers`,
      });
    }
  }

  // ── 2. A module nothing imports ───────────────────────────────────────────
  const importedPaths = new Set<string>();
  for (const [, code] of sources) {
    // Static and dynamic both: `nougate-inproc.ts` is only ever reached through
    // `await import(...)` behind an `[nougate] in_process` check, and it is not dead.
    for (const m of code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      importedPaths.add(m[1]!.replace(/\.(ts|tsx)$/, ""));
    }
  }
  // A file a test names by path is run, not imported: a fixture spawned as its own process, because what it stands in
  // for would otherwise reach the whole test run (`wa-bridge/tests/fixtures/restart.ts`).
  const runByTests = new Set<string>();
  for (const [rel, code] of sources) {
    if (!/\.test\.tsx?$/.test(rel)) continue;
    for (const m of code.matchAll(/["'`](?:\.\.?\/)*([\w/-]+\/[\w.-]+\.tsx?)["'`]/g)) runByTests.add(m[1]!);
  }
  for (const rel of sources.keys()) {
    if (isReachedWithoutImport(rel)) continue;
    const stem = rel.replace(/\.(ts|tsx)$/, "");
    const reached =
      [...importedPaths].some((spec) => stem.endsWith(spec.replace(/^[@./]*/, "")) || spec.endsWith(stem)) ||
      [...runByTests].some((path) => rel.endsWith(`/${path}`));
    if (!reached) {
      findings.push({
        file: rel,
        line: 1,
        rule: "orphan-module",
        detail: "no import anywhere reaches this file, statically or dynamically",
      });
    }
  }

  const knownDeadSeen = new Set<string>();
  // ── 3. An exported value nothing imports ──────────────────────────────────
  //
  // `noUnusedLocals` cannot see this: an `export` counts as a use, so the symbol looks live from inside its own module.
  // Who imports what is resolved by specifier through barrels (`export-graph.ts`), and a test is counted apart: an
  // export only a test imports is production code kept alive by its test. Removing the keyword is usually the whole
  // fix — and then the compiler says whether it was over-exported or genuinely dead.
  const input = await graphInput();
  const { values, reexports } = graph(input);
  const entries = new Set(input.packages.values());
  const testOnlySeen = new Set<string>();
  for (const [file, names] of values) {
    if (!isChecked(file)) continue;
    for (const [name, use] of names) {
      if (use.production.size > 0) continue;
      const line = exportedValues(file, input.files.get(file)!).get(name) ?? 0;
      if (use.tests.size === 0) {
        if (PRO_KNOWN_DEAD[file]?.includes(name)) {
          knownDeadSeen.add(`${file} ${name}`);
          continue;
        }
        findings.push({ file, line, rule: "unused-export", detail: `\`${name}\` is exported and nothing imports it — drop the \`export\`, and let the compiler say whether it is dead` });
      } else if (!usedInOwnFile(sources.get(file) ?? "", name)) {
        if (TEST_ONLY_EXPORTS[file]?.[name]) {
          testOnlySeen.add(`${file} ${name}`);
          continue;
        }
        findings.push({
          file,
          line,
          rule: "test-only-export",
          detail: `\`${name}\` is imported only by tests (${[...use.tests].slice(0, 2).join(", ")}) and used nowhere else — delete it, move a test double into the tests, or name the seam in TEST_ONLY_EXPORTS with its reason`,
        });
      }
    }
  }

  // A barrel's re-export nothing imports through it: a package surface kept for nobody. One only tests import is a seam
  // named in TEST_ONLY_EXPORTS, or a name to drop: the package's own tests import its modules.
  for (const [file, names] of reexports) {
    if (!entries.has(file) || !isChecked(file)) continue;
    for (const [name, use] of names) {
      if (!resolvesToValue(file, name, input)) continue;
      const verdict = barrelVerdict(file, name, use);
      if (verdict === "seam") testOnlySeen.add(`${file} ${name}`);
      else if (verdict) findings.push({ file, line: 0, ...verdict });
    }
  }

  for (const [file, names] of Object.entries(TEST_ONLY_EXPORTS)) {
    for (const name of Object.keys(names).filter((known) => !testOnlySeen.has(`${file} ${known}`))) {
      findings.push({ file, line: 0, rule: "stale-test-only", detail: `\`${name}\` is listed in TEST_ONLY_EXPORTS and is not a test-only export — remove it from the list` });
    }
  }

  // An entry for an export that is gone, or that something uses now, is a licence nothing needs: reported until it is
  // removed, so the list can only shrink. Only while the Pro code is checked out — absent, it says nothing either way.
  if ([...sources.keys()].some((file) => file.startsWith(PRO))) {
    for (const [file, names] of Object.entries(PRO_KNOWN_DEAD)) {
      for (const name of names.filter((known) => !knownDeadSeen.has(`${file} ${known}`))) {
        findings.push({
          file,
          line: 0,
          rule: "stale-known-dead",
          detail: `\`${name}\` is listed in PRO_KNOWN_DEAD and is no longer an unused export — remove it from the list`,
        });
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  if (findings.length === 0) {
    console.log("✓ no dead code or schema");
    return;
  }

  console.error(`✗ ${findings.length} dead-code finding(s):\n`);
  for (const f of findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))) {
    console.error(`  ${f.file}${f.line > 0 ? `:${f.line}` : ""}  [${f.rule}]`);
    console.error(`    ${f.detail}\n`);
  }
  process.exit(1);
}

if (import.meta.main) await main();
