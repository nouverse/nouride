#!/usr/bin/env bun
/**
 * Enforces the dependency rules in §3 of docs/ARCHITECTURE.md.
 *
 * Written as a grep rather than an ESLint plugin because there are a handful of rules
 * and no lint setup to hang a plugin off. It runs in `bun run lint:check`, so drift
 * fails CI instead of being caught in review — which is the only reason a written
 * rule stays true.
 *
 * This file is itself exempt from the Bun and Node rules: it is tooling, not business logic.
 */

import { dirname, join, relative, resolve } from "node:path";
import { MODULE_SPECIFIER, PRO } from "./lint-sources.ts";

interface Violation {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * Comments are stripped before scanning. Without this, a doc comment that mentions
 * `Bun.serve` while explaining why the adapter exists would fail the check that the
 * adapter is there to satisfy.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

const BUN_API = /\bBun\.[A-Za-z]/;
// `bun:test` is exempt everywhere: it is the sanctioned test runner (TD-014), not a
// runtime API that porting would have to replace. Every other `bun:` module —
// `bun:sqlite` above all — belongs behind the adapter.
const BUN_MODULE = /from\s+["']bun:(?!test["'])[a-z]+["']/;
// ---------------------------------------------------------------------------
// `node:*` is the other half of the Bun rule, and it is the half that leaked. `Bun.*` was enforced
// from the start, so nobody wrote it outside the adapter — but `import { join } from "node:path"`
// sat in fifty files, which meant "what would a port have to touch" could not be answered from the
// dependency graph. Everything those files needed is re-exported from `@nouride/runtime`; some of it
// (paths, hashes) is pure computation that every runtime ships, and it is routed through the barrel
// anyway because the value is the single list, not the indirection.
//
// Matched on the *specifier*, in every form one can appear, rather than on `from "node:…"`. The
// first version of this rule matched only that one form and let four spellings through — proven by
// planting each and watching the lint stay green:
//
//   import { fork } from "node:child_process";  // underscore, outside the [a-z/] class
//   import { join } from "path";                // the same import, no prefix
//   import "node:worker_threads";               // side effect, no `from`
//   await import("node:os");                    // dynamic
// ---------------------------------------------------------------------------

// `MODULE_SPECIFIER` (lint-sources.ts) reads each of those spellings.

/**
 * Node core, hand-written rather than taken from `node:module`'s `builtinModules`.
 *
 * Bun reports its own shims in that list — `ws` and `undici` are ordinary npm packages everywhere
 * else, and flagging an import of one would be a false positive in a lint whose whole value is that
 * it is never wrong. The list below is Bun's, minus `bun*` and those shims.
 *
 * The bare form matters as much as the prefixed one: `from "path"` and `from "node:path"` are the
 * same import and the same portability problem, and the bare spelling is the one a new contributor
 * reaches for out of habit.
 */
const NODE_CORE = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console",
  "constants", "crypto", "dgram", "diagnostics_channel", "dns", "dns/promises", "domain", "events",
  "fs", "fs/promises", "http", "http2", "https", "inspector", "inspector/promises", "module", "net",
  "os", "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode", "querystring",
  "readline", "readline/promises", "repl", "stream", "stream/consumers", "stream/promises",
  "stream/web", "string_decoder", "sys", "timers", "timers/promises", "tls", "trace_events", "tty",
  "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/** Whether a specifier reaches Node's runtime, however it is spelled. */
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || NODE_CORE.has(specifier);
}
const APPS_IMPORT = /from\s+["'](?:[^"']*\/apps\/|@nouride\/(?:engine|dashboard))/;

// ---------------------------------------------------------------------------
// Which package may import which is each package's own `package.json`: `lint:deps` (check-deps.ts) holds every member's
// imports to its manifest and its manifest to its imports, and refuses a cycle. This file kept a copy of that graph by
// hand, `ALLOWED_DEPS`, which read no manifest, had drifted from them, let a package missing from it import anything,
// and saw only `from "…"`. What stays here are the rules a manifest cannot state: `shared` is the bottom, and the
// frontend line below.
// ---------------------------------------------------------------------------

/**
 * Frontend packages are named `ui-*` — `packages/ui-graph` is the first. The name is the rule, so a
 * new one needs no edit here:
 *
 * - `apps/dashboard` imports `ui-*` packages and no other workspace package. It talks to the daemon
 *   over HTTP (ARCHITECTURE.md §3), and a `@nouride/shared` import would put engine code one hop away.
 * - A `ui-*` package imports only other `ui-*` packages, for the same reason one level down.
 * - Nothing else imports a `ui-*` package: browser code has no business in the daemon.
 * - Browser code lives only in `ui-*`: a package whose tsconfig adds the `DOM` lib, or that has a
 *   `.tsx` file, must be named so. The base tsconfig is `ESNext` alone, so touching the DOM *requires*
 *   that lib — a signal that cannot be dodged, unlike grepping for `window.`, which here is also a
 *   variable name in two packages and a Telegram field in a third.
 */
const UI_PREFIX = "ui-";
const isUiPackage = (name: string) => name.startsWith(UI_PREFIX);

/** The `foo` of an `@nouride/foo` specifier, in whatever spelling it was imported. */
const NOURIDE_PACKAGE = /^@nouride\/([a-z-]+)/;

/**
 * Matches deep imports like `from "@nouride/llm/src/anthropic"`. The public API
 * of every package is its barrel `index.ts`; reaching past it couples callers
 * to internal file layout and makes refactors breaking.
 *
 * Every spelling `MODULE_SPECIFIER` knows, not only `from`: `await import("@nouride/llm/anthropic")` passed. The
 * packages' `exports` hold only "." since 0.7.10, so such an import no longer resolves either — this says why.
 */
const NOURIDE_DEEP_IMPORT = /(?:from\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']@nouride\/[a-z-]+\//;

/**
 * Reading the whole system prompt out of a `BuiltPrompt`.
 *
 * The harness block is written in this repo and compiled into the binary, so an install that can
 * print it verbatim makes it public. `buildSystemPrompt` returns `operatorText` for exactly that
 * reason — the operator's own material, with the product's blocks replaced by a note — and the
 * diagnostic surfaces use it.
 *
 * Only the executor may take the full thing, because only the executor sends it to a model. This
 * catches the shape a future edit would take: someone reaching for `.text` because it is the
 * obvious field name, in a file whose job is to show a person something.
 */
const FULL_PROMPT_READ = /\)\s*\.(text|blocks)\b/;

/** A file of `modules/memory` named by path, rather than its barrel. */
const MEMORY_FILE = /^@\/modules\/memory\/(?!index\.ts$)/;

/** Engine source outside memory itself, boot, and the daemon's `index.ts` — what must go through memory's barrel. */
const MUST_USE_MEMORY_BARREL = (rel: string): boolean =>
  rel.startsWith("apps/engine/src/") &&
  !rel.startsWith("apps/engine/src/modules/memory/") &&
  !rel.startsWith("apps/engine/src/boot/") &&
  rel !== "apps/engine/src/index.ts";

/** Only files that build a prompt can misuse one. */
const BUILDS_A_PROMPT = /\bbuildSystemPrompt\b/;

/**
 * Where sending the whole prompt is the entire point.
 *
 * `prepare.ts` assembles the provider request. Nothing else in the tree has a reason to hold the
 * product's own instructions as a string.
 */
const MAY_READ_FULL_PROMPT = ["apps/engine/src/modules/llm/executor/prepare.ts"];

/**
 * A file that holds the database handle, by the only thing that gives one away: the type.
 *
 * `SqliteDb` is the parameter every store takes and the thing `openDatabase` returns, so a file that
 * names it is a file that can run SQL. Matching the type rather than `.prepare(` is deliberate — a
 * file could hold a handle, pass it on, and never write a query itself, and that is still a file a
 * Postgres port has to open.
 */
const DB_HANDLE = /\bSqliteDb\b|\bopenDatabase\b/;

/**
 * Everything allowed to hold one, and why.
 *
 * A **naming convention** rather than a list of files, which is the whole change from the first
 * version of this rule. That version enumerated nineteen paths — ten of them stores that simply had
 * not been called `store.ts` — and a list like that answers "is this file allowed" without ever
 * answering "where does database code go". The convention answers both, and it is one sentence:
 *
 *   **SQL lives in a `*.store.ts` file. Everything else takes a store.**
 *
 * A reader who knows only that sentence can place any new file correctly, and `ls **\/*.store.ts` is
 * the complete inventory of what a port has to rewrite. The exceptions below are the four that are
 * genuinely not stores.
 */
const DATA_LAYER = [
  // The adapter itself, and the migration runner.
  "packages/runtime/src/db.ts",
  "apps/engine/src/db/",
  // Boot opens the handle and hands it out; that is its job.
  "apps/engine/src/boot/",
  "apps/engine/src/commons/context.ts",
  /**
   * An operator migration, not a store: it rewrites one gateway id across every column `db/keys.ts`
   * lists, in a single transaction, and doing that through per-table stores would be a store per
   * table each growing a method that exists for one command.
   */
  "apps/engine/src/modules/gateways/rename.ts",
  /**
   * The one CLI command that runs with the daemon **stopped**, so there is no API to go through and
   * nothing else to open the database for it.
   *
   * Found by this rule rather than by the hand-audit that preceded it: the file names `openDatabase`
   * and never `SqliteDb`, so grepping for the type alone missed it. That is the argument for matching
   * both.
   */
  "apps/engine/src/cli/commands/gateway-rename.ts",
  /**
   * The second, for the same reason: `nouride db restore` replaces the file a running daemon holds
   * open, so it runs with the daemon stopped and there is no API to reach. `backup` and `verify`
   * ship in the same group deliberately — see the header of `cli/commands/db.ts` — so the command
   * a person needs at three in the morning behaves like the ones they already learned.
   */
  "apps/engine/src/cli/commands/db.ts",
  /**
   * The third, for the same reason and one more: `nouride users reset` empties the account table with the daemon
   * stopped — a running one holds the database and answers the sign-ins of the accounts — and the person it is for is
   * locked out of the dashboard, so there is no API for them to reach. It opens the file and hands it to `UserStore`.
   */
  "apps/engine/src/cli/commands/users.ts",
];

/**
 * Formatters that exist once, in `@nouride/shared`, because their output is read by people.
 *
 * Kept short deliberately: this is not a general no-duplication rule, it is a list of functions
 * whose answers have to agree.
 */
const SHARED_FORMATTERS = /(?:export\s+)?function\s+(formatBytes)\s*\(/g;

/** The one module that writes a config file — the daemon's `config.toml`, or a file of an agent's pack. */
const CONFIG_WRITER = "apps/engine/src/modules/config/config-file.ts";
/** What a first argument names when the write is a config file's. */
const CONFIG_FILE_NAMES = /configPath|agentConfigPath|config\.toml|skills\.toml|SKILL_STATES_FILE/;
/** Said on the line above a write that creates a pack, which is written whole and removed whole when it does not load. */
const NEW_PACK_MARKER = "a new pack, written whole";

/** The first argument of each `writeTextFile(…)`/`writeTextFileAtomic(…)` call, with its line — commas inside parens kept. */
function writeTargets(source: string): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = [];
  for (const match of source.matchAll(/\bwriteTextFile(?:Atomic)?\(/g)) {
    let depth = 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === "," && depth === 0) break;
    }
    out.push({ line: source.slice(0, match.index).split("\n").length, target: source.slice(match.index + match[0].length, end) });
  }
  return out;
}

/**
 * C0 control characters that have no business in source, plus a bare carriage return.
 *
 * Built from codepoints rather than written as a character class, because writing the class would
 * mean putting the very escapes this catches into the file that catches them.
 */
const CONTROL_CHARS = new RegExp(
  `[${[
    ...Array.from({ length: 8 }, (_unused, i) => i), // 0x00–0x07
    0x08, // backspace — the one that has actually happened
    0x0b,
    0x0c,
    0x0d, // carriage return: this repo is LF throughout
    ...Array.from({ length: 18 }, (_unused, i) => 0x0e + i), // 0x0e–0x1f
  ]
    .map((code) => `\\u${code.toString(16).padStart(4, "0")}`)
    .join("")}]`,
  "g",
);

/**
 * The store classes, named because there is no way to recognise one from a type position.
 *
 * Listed rather than inferred, and the list is short and stable: it changes only when a store is
 * added, which is a deliberate act that already touches `DATA_LAYER`. A missed name here is a
 * signature that quietly stays un-fakeable, which is the failure this rule exists to prevent.
 */
const STORE_CLASSES = [
  "AccessStore",
  "AuditLog",
  "AutoApprove",
  "ChatAttachmentIndex",
  "ChatEventStore",
  "CronStore",
  "DraftStore",
  "GrantStore",
  "JobStore",
  "JobWakeStore",
  "LogStore",
  "MemoryAnalyticsStore",
  "MemoryIndexStore",
  "MemoryStateStore",
  "MemoryVectorStore",
  "McpTokenStore",
  "RoomMessageStore",
  "RoomStore",
  "SessionStore",
  "ToolGrantStore",
  "TurnStore",
  "UsageStore",
  "UserStore",
];

/**
 * A store class in a type position: after `:`, inside `<…>`, or following `implements`.
 *
 * Deliberately not "the name appears in the file". `new TurnStore(db)` is how boot builds one and
 * `SessionStore.id` was a static — neither is a dependency on the type, and refusing them would
 * refuse the wiring layer its job.
 */
const STORE_CLASS_TYPE = new RegExp(
  String.raw`(?::\s*|<|implements\s+)(` + STORE_CLASSES.join("|") + String.raw`)\b(?!\s*[.(])`,
  "g",
);

/** Boot builds the stores and hands them out, so it names them by necessity. */
function isBootWiring(rel: string): boolean {
  return rel.startsWith("apps/engine/src/boot/") || rel === "apps/engine/src/index.ts";
}

function mayHoldDb(rel: string): boolean {
  // The convention first, because it is the answer for nineteen of the twenty-four files.
  if (rel.endsWith(".store.ts")) return true;
  return DATA_LAYER.some((allowed) => rel.startsWith(allowed));
}


/** Submodule paths, from `.gitmodules`. */
// None in the public export, which has no `.gitmodules`.
const GITMODULES = Bun.file(join(ROOT, ".gitmodules"));
const SUBMODULES: string[] = (await GITMODULES.exists()) ? [...(await GITMODULES.text()).matchAll(/^\s*path\s*=\s*(\S+)/gm)].map((m) => m[1]!) : [];

/**
 * Rule 6: a Pro plugin imports nothing of this repository, and nothing but Node's built-ins and its own files.
 *
 * Each says so in its `package.json` — "deliberately free of dependencies, including this repo's own packages" —
 * because the build (`scripts/build/core.ts`) externalises it out of every public edition, and a plugin that reached into

 * `@nouride/runtime` would drag the engine's graph back in through the door that flag closes; it declares the shapes
 * it needs by hand instead, and `check-seams.ts` holds them. Nothing checked the half that is about imports, and
 * nothing linted `internals/pro` at all (`lint-sources.ts`). The shipped source of each is what its `exports` names —
 * the setup console under `appliance/src/ui` is a browser app built on its own, and is not it.
 *
 * Empty in a public clone, where the submodule is not checked out.
 */
async function proPluginViolations(): Promise<Violation[]> {
  const manifest = Bun.file(join(ROOT, PRO, "package.json"));
  if (!(await manifest.exists())) return [];
  const violations: Violation[] = [];
  for (const workspace of ((await manifest.json()) as { workspaces?: string[] }).workspaces ?? []) {
    const pkg = join(PRO, workspace);
    const plugin = (await Bun.file(join(ROOT, pkg, "package.json")).json()) as { exports?: Record<string, string> };
    const entry = plugin.exports?.["."];
    if (!entry) continue;
    const shipped = join(pkg, dirname(entry));
    for await (const path of new Bun.Glob(`${shipped}/**/*.ts`).scan({ cwd: ROOT, absolute: true })) {
      const rel = relative(ROOT, path);
      if (rel.includes("/tests/") || rel.endsWith(".test.ts") || rel.endsWith(".d.ts")) continue;
      const source = stripComments(await Bun.file(path).text());
      const line = (index: number) => source.slice(0, index).split("\n").length;
      for (const match of source.matchAll(MODULE_SPECIFIER)) {
        const specifier = match[1]!;
        const inside = specifier.startsWith(".") && resolve(dirname(path), specifier).startsWith(join(ROOT, pkg) + "/");
        if (isNodeBuiltin(specifier) || inside) continue;
        violations.push({
          file: rel,
          line: line(match.index!),
          rule: "plugin-imports-outside-itself",
          detail: `"${specifier}" — a Pro plugin imports only Node's built-ins and its own files; declare the shape it needs instead`,
        });
      }
      const bun = BUN_API.exec(source);
      if (bun) violations.push({ file: rel, line: line(bun.index), rule: "plugin-imports-outside-itself", detail: "`Bun.*` — a Pro plugin uses Node's built-ins only" });
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const violations: Violation[] = [];
  const glob = new Bun.Glob("{apps,packages}/**/*.{ts,tsx}");

  for await (const path of glob.scan({ cwd: ROOT, absolute: true })) {
    const rel = relative(ROOT, path);
    if (rel.includes("node_modules") || rel.endsWith(".gen.ts")) continue;

    const isRuntimePkg = rel.startsWith("packages/runtime/");
    /**
     * Tests and build config keep their `node:*` imports.
     *
     * Same reasoning as the `bun:test` exemption above: a fixture that makes a temp directory and
     * writes three files into it is not shipped, so it is not something a port has to carry — and
     * putting `mkdtempSync` in the runtime barrel would grow the adapter's surface for the benefit
     * of nothing that runs in production. `vite.config.ts` is the build's own tooling, and the
     * bundler it configures is Node's either way.
     */
    const isExemptFromNodeRule =
      rel.includes("/tests/") ||
      rel.endsWith(".test.ts") ||
      rel.endsWith(".config.ts") ||
      /**
       * An app's own `scripts/` directory, for the same reason the repository's root `scripts/` is
       * outside the glob entirely: it is build tooling, run by hand or by a `build` script, and never
       * shipped. It lives under the app rather than at the root when it needs that app's own
       * dependencies — `apps/site/scripts/` uses `sharp`, which arrives with Astro and which the
       * root manifest deliberately does not carry.
       *
       * The alternative was making these import `@nouride/runtime`, which would give the docs site a
       * workspace dependency it has spent some effort not having (see its `astro.config.mjs`).
       */
      /^apps\/[^/]+\/scripts\//.test(rel);
    const isSharedPkg = rel.startsWith("packages/shared/");
    const isPackage = rel.startsWith("packages/");
    // A submodule is another repository with rules of its own. None of them is under `packages/` any
    // more — `packages/wa-bridge` was one until 2026-09-30 and is a workspace member on
    // `@nouride/runtime` now — so everything under `packages/` is ours and keeps these rules. Read from
    // `.gitmodules`, so a new submodule needs no edit here.
    if (SUBMODULES.some((dir) => rel.startsWith(`${dir}/`))) continue;

    // Determine which package this file belongs to (if any).
    // e.g. "packages/llm/src/openai.ts" → "llm"
    const pkgMatch = rel.match(/^packages\/([a-z-]+)\//);
    const ownPkg = pkgMatch?.[1] ?? null;

    const source = stripComments(await Bun.file(path).text());
    const lines = source.split("\n");

    // Rule 1b: node builtins only in packages/runtime, and not in tests or build config.
    //
    // Scanned over the whole source rather than line by line, because a specifier can be separated
    // from its `import` by a newline — a multi-line named import puts `from "node:fs"` on its own
    // line, and `import(\n  "node:os",\n)` puts it on nobody's.
    if (!isRuntimePkg && !isExemptFromNodeRule) {
      for (const match of source.matchAll(MODULE_SPECIFIER)) {
        const specifier = match[1]!;
        if (!isNodeBuiltin(specifier)) continue;
        violations.push({
          file: rel,
          // 1-indexed, counted from the newlines before the match.
          line: source.slice(0, match.index).split("\n").length,
          rule: "node-outside-runtime",
          detail: `"${specifier}" — use @nouride/runtime instead (TD-001)`,
        });
      }
    }

    // Rule 1c: the database handle stays in the data layer.
    //
    // The same discipline as TD-001 one layer up. `SqliteDb` is already confined by habit — of the 24
    // files that touch it, 19 are stores and 4 are boot wiring — and this is what turns "clean by
    // accident" into "clean by rule", because the cost of it drifting is not paid until somebody
    // tries to move off SQLite and finds business logic writing SQL.
    //
    // It is also the precondition for that move ever being cheap. Bun's SQLite is synchronous and
    // `Bun.sql` is not, and there is no bridge from async back to sync in JavaScript — so the day a
    // Postgres port happens, every file holding a handle becomes a file that has to grow `await`.
    // Keeping that set small and named is the whole of the preparation.
    //
    // Which files may is `mayHoldDb`: a `*.store.ts` file, or one of the few exceptions `DATA_LAYER`
    // names with its reason — a convention rather than a list, and the doc above `DATA_LAYER` says why.
    if (!isRuntimePkg && !isExemptFromNodeRule && DB_HANDLE.test(source) && !mayHoldDb(rel)) {
      violations.push({
        file: rel,
        line: source.slice(0, source.search(DB_HANDLE)).split("\n").length,
        rule: "db-outside-data-layer",
        detail:
          "holds a database handle — rename it to `*.store.ts` if it is a store, or take a store " +
          "instead of a handle if it is not. The four genuine exceptions are `DATA_LAYER` in this script",
      });
    }

    // The whole prompt, harness block included, is the executor's alone — `FULL_PROMPT_READ` says why.
    if (
      rel.startsWith("apps/engine/src/") &&
      !MAY_READ_FULL_PROMPT.includes(rel) &&
      BUILDS_A_PROMPT.test(source)
    ) {
      // Scoped to files that build one, rather than matched against the call itself: the call in
      // `render-prompt.ts` spans a hundred lines of harness facts, so a pattern that tried to reach
      // from `buildSystemPrompt(` to the field it ends on missed the very case it was written for.
      const hit = FULL_PROMPT_READ.exec(source);
      if (hit) {
        violations.push({
          file: rel,
          line: source.slice(0, hit.index).split("\n").length,
          rule: "full-prompt-outside-the-executor",
          detail:
            `takes \`.${hit[1]}\` from a built prompt — that includes the harness block, which is ` +
            `shipped in the binary. Use \`operatorText\`, which redacts it; only the executor sends ` +
            `the whole prompt anywhere`,
        });
      }
    }

    /**
     * Rule 1d: business logic depends on a port, not on a store class.
     *
     * The third leg of the same discipline. Rules 1b and 1c keep the *handle* and the *queries* in
     * the data layer; this keeps the **type** out of everything else, because a signature naming
     * `TurnStore` is a signature only that class can satisfy — `constructor(private readonly db)`
     * makes a store structurally un-fakeable, which is why 18 test files open a real SQLite file and
     * run 30 migrations to assert on logic that never reads a row.
     *
     * Every store exports `Port<TheStore>` for exactly this. Constructing one is still fine — boot
     * has to — so `new TurnStore(db)` and `TurnStore.something` are both left alone; what is refused
     * is a store class in a *type* position outside the data layer.
     *
     * Scoped to `apps/engine`, and that is not a shortcut. The dashboard cannot import engine code at
     * all — it declares its own wire types and talks HTTP — so a name it shares is a name that
     * happens to collide. The first run of this rule proved the point by reporting
     * `<AuditLog />`, a React component, matched through the `<` alternative meant for a type
     * parameter. Engine files are `.ts`, so there is no JSX to confuse it with there.
     */
    if (rel.startsWith("apps/engine/") && !isExemptFromNodeRule && !mayHoldDb(rel) && !isBootWiring(rel)) {
      for (const match of source.matchAll(STORE_CLASS_TYPE)) {
        violations.push({
          file: rel,
          line: source.slice(0, match.index).split("\n").length,
          rule: "store-class-in-signature",
          detail:
            `${match[1]} is a store class — take its \`Port\` type instead, so a second ` +
            `implementation and a test fake can both satisfy this signature`,
        });
      }
    }

    /**
     * Rule 1e: no stray control characters in source.
     *
     * This one is here because it happened twice in one afternoon, and the second time it disabled a
     * rule while reporting success — the worst failure a check can have, because it is also a claim.
     *
     * Both times an edit script wrote a regex containing `\b` through a language that reads `\b` as
     * a backspace, so the file ended up with a literal 0x08 where the word-boundary escape belonged.
     * The pattern then matched nothing, `check-arch` printed a tick, and the rule it was supposed to
     * enforce was gone. Nothing showed it: a backspace is invisible in a terminal, in a diff, and in
     * the output of `.source` — it took `cat -v` to see, and only after the rule was noticed to be
     * silently permissive.
     *
     * Tabs and newlines are ordinary. Everything else in the C0 range is a mistake in a text file,
     * and a carriage return is one too in a repository that is LF throughout.
     */
    for (const match of source.matchAll(CONTROL_CHARS)) {
      violations.push({
        file: rel,
        line: source.slice(0, match.index).split("\n").length,
        rule: "control-character",
        detail:
          `0x${match[0].charCodeAt(0).toString(16).padStart(2, "0")} — invisible in a terminal, in a ` +
          `diff, and in a printed regex. Usually a \`\\b\` or \`\\t\` written through a script that ` +
          `read the escape itself; write the file with a tool that does not, and check with \`cat -v\``,
      });
    }

    /**
     * Rule 1f: the shared formatters are defined once.
     *
     * There were seven copies of `formatBytes` in this monorepo and four of them stopped at
     * megabytes, so a 2GB file read `2048.0MB` in four places and `2.0 GB` in the CLI. Nobody
     * decided that; a four-line function is small enough to retype rather than import, and two of
     * the seven were added by a commit that was tidying something else.
     *
     * A count is the wrong instinct here — one copy is fine, and the rule is not about duplication
     * as a sin. It is that these particular functions produce text a person reads and an agent reads
     * back, so two answers for one number is a wrong answer half the time.
     *
     * `apps/dashboard` is exempt and must stay so: it reaches no workspace package but the browser UI
     * packages named `ui-*` (ARCHITECTURE.md §3), and importing from `@nouride/shared` to save
     * four lines would be the first crack in a boundary worth much more than that. A `ui-*` package
     * is exempt for the same reason: it may not import `@nouride/shared` either.
     */
    if (!rel.startsWith("apps/dashboard/") && !rel.startsWith("packages/shared/") && !(ownPkg !== null && isUiPackage(ownPkg))) {
      for (const match of source.matchAll(SHARED_FORMATTERS)) {
        violations.push({
          file: rel,
          line: source.slice(0, match.index).split("\n").length,
          rule: "reimplemented-formatter",
          detail: `${match[1]} is defined in @nouride/shared — import it, or two callers will disagree about one number`,
        });
      }
    }

    /**
     * Rule 1g: a config file is written through `modules/config/config-file.ts` and nowhere else.
     *
     * Thirty-four of forty writers of a `config.toml` took no lock and none checked what it wrote: two saves at once
     * lost one of them in the file, and a save the next boot refused answered ok. The helper is the lock, the check
     * and the backup — and for a pack the reload and the rollback — so a write around it takes each of those away
     * again. A pack being created is the exception, said on the line above the write: it is written whole and
     * removed whole when it does not load, which is its own rollback.
     */
    if (rel.startsWith("apps/engine/src/") && rel !== CONFIG_WRITER) {
      // The marker is a comment, which `source` has had stripped: read it from the file as written.
      const written = (await Bun.file(path).text()).split("\n");
      for (const { line, target } of writeTargets(source)) {
        if (!CONFIG_FILE_NAMES.test(target) || (written[line - 2] ?? "").includes(NEW_PACK_MARKER)) continue;
        violations.push({
          file: rel,
          line,
          rule: "config-write-around-the-helper",
          detail: `writes ${target.trim()} directly — use editDaemonConfig or editPackFile (modules/config/config-file.ts)`,
        });
      }
    }

    // Memory is reached through its barrel. Its header said so for months while six files outside it
    // imported its vault, format check, backups and English check by path, so a change inside
    // `modules/memory` broke the CLI, the config check or the MCP surface with no sign at the barrel. Boot
    // and the daemon's `index.ts` build the stores memory is given, and may name them.
    if (MUST_USE_MEMORY_BARREL(rel)) {
      for (const match of source.matchAll(MODULE_SPECIFIER)) {
        if (!MEMORY_FILE.test(match[1]!)) continue;
        violations.push({
          file: rel,
          line: source.slice(0, match.index).split("\n").length,
          rule: "memory-past-its-barrel",
          detail: `"${match[1]}" — import it from "@/modules/memory/index.ts", exporting it there if it is not yet`,
        });
      }
    }

    // Rules 3 and 4b, on every spelling of an import — `await import("@nouride/shared")` from the dashboard passed when
    // these read `from "…"` alone.
    for (const match of source.matchAll(MODULE_SPECIFIER)) {
      const target = NOURIDE_PACKAGE.exec(match[1]!)?.[1];
      if (target === undefined) continue;
      const at = (rule: string, detail: string) =>
        violations.push({ file: rel, line: source.slice(0, match.index).split("\n").length, rule, detail: `"${match[1]}" — ${detail}` });

      // Rule 3: @nouride/shared imports no workspace sibling
      if (isSharedPkg) at("shared-imports-workspace", "@nouride/shared is the bottom of the graph");

      // Rule 4b: frontend packages are `ui-*`, and the line between them and the rest holds both ways
      const fromUi = ownPkg !== null && isUiPackage(ownPkg);
      if (rel.startsWith("apps/dashboard/") && !isUiPackage(target)) {
        at("dashboard-imports-workspace", `the dashboard talks to the daemon over HTTP; it may import only @nouride/${UI_PREFIX}* packages`);
      } else if (fromUi && !isUiPackage(target)) {
        at("ui-imports-workspace", `a ${UI_PREFIX}* package may import only other ${UI_PREFIX}* packages`);
      } else if (!fromUi && !rel.startsWith("apps/dashboard/") && isUiPackage(target)) {
        at("ui-outside-the-dashboard", `@nouride/${target} is browser code; only the dashboard and other ${UI_PREFIX}* packages import it`);
      }
    }

    lines.forEach((line, index) => {
      const at = (rule: string, detail: string) =>
        violations.push({ file: rel, line: index + 1, rule, detail });

      // Rule 1: Bun.* and bun:* only in packages/runtime
      if (!isRuntimePkg && (BUN_API.test(line) || BUN_MODULE.test(line))) {
        at("bun-outside-runtime", `${line.trim()} — use @nouride/runtime instead (TD-001)`);
      }

      // Rule 2: packages never import apps
      if (isPackage && APPS_IMPORT.test(line)) {
        at("package-imports-app", line.trim());
      }

      // Rule 5: no deep imports into package internals
      if (NOURIDE_DEEP_IMPORT.test(line)) {
        at(
          "deep-package-import",
          `${line.trim()} — import from the package barrel ("@nouride/…"), not its internal files`,
        );
      }
    });
  }

  // Rule 4c: browser code lives only in `ui-*` packages.
  for await (const config of new Bun.Glob("packages/*/tsconfig.json").scan({ cwd: ROOT })) {
    const pkg = config.split("/")[1]!;
    if (isUiPackage(pkg) || SUBMODULES.includes(`packages/${pkg}`)) continue;
    const text = await Bun.file(join(ROOT, config)).text();
    if (/"lib"\s*:\s*\[[^\]]*"DOM"/i.test(text)) {
      violations.push({ file: config, line: 1, rule: "browser-code-outside-ui", detail: `adds the DOM lib — a frontend package is named packages/${UI_PREFIX}*` });
    }
  }
  for await (const file of new Bun.Glob("packages/*/**/*.tsx").scan({ cwd: ROOT })) {
    const pkg = file.split("/")[1]!;
    if (file.includes("node_modules") || isUiPackage(pkg) || SUBMODULES.includes(`packages/${pkg}`)) continue;
    violations.push({ file, line: 1, rule: "browser-code-outside-ui", detail: `a .tsx file — a frontend package is named packages/${UI_PREFIX}*` });
  }

  violations.push(...(await proPluginViolations()));

  if (violations.length === 0) {
    console.log("✓ architecture rules hold");
    return;
  }

  console.error(`✗ ${violations.length} architecture violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.detail}`);
  }
  console.error("\nSee §3 of docs/ARCHITECTURE.md.");
  process.exit(1);
}

await main();
