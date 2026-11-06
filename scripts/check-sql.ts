#!/usr/bin/env bun
/**
 * Keeps the SQL fast and safe — TD-015.
 *
 * SQLite is the database (TD-015), so whether a query would run on another engine stopped being a
 * question. Three others replaced it, and every rule below answers one of them:
 *
 * - **Can it be injected?** A value spliced into SQL instead of bound, a `LIKE` whose `%` a person can
 *   type, an FTS5 expression built from raw input.
 * - **Is it slow by construction?** A query plan that scans a table it should search — the plan check
 *   runs every query it can against the schema that ships — or one query per item in a loop.
 * - **Does it lean on a footgun?** `INSERT OR REPLACE` deleting before it inserts, SQLite's clock in
 *   UTC, a double-quoted string that is silently a column name.
 *
 * Each finding names its rule, what it caught and what to write instead. Errors fail the commit;
 * warnings are printed and pass.
 *
 * The portability rules this replaced are gone, not relaxed: `rowid`, json1, `BLOB`, `GROUP_CONCAT`,
 * `WITHOUT ROWID` and the rest are ordinary SQLite now. Two came back for reasons that have nothing to
 * do with portability — `INSERT OR REPLACE` (F1) and `AUTOINCREMENT` (F5).
 *
 * ## How it reads the code
 *
 * Through the TypeScript parser. A literal is SQL when it *starts* with a SQL verb and the keyword
 * that must follow it, so a string that merely mentions `SELECT` is not, and neither is the dashboard's
 * `method: "DELETE"`. Comments are not literals, so the doc comments in this repo — which talk about
 * SQL constantly — never look like queries. The parser also tells the rules what a regex could not:
 * which `${…}` a template splices in, whether a literal is concatenated, whether a statement runs
 * inside a loop.
 *
 * ## The ways this could pass while checking nothing
 *
 * An extractor that stops matching finds nothing and reports success forever, so a run that finds
 * implausibly few statements fails. The plan check has the same shape — a statement it cannot plan is
 * skipped rather than failed — so it carries a floor of its own.
 */

import { basename, relative } from "node:path";
import ts from "typescript";
import { lintedFiles, PRO } from "./lint-sources.ts";

export type Severity = "error" | "warning";

export interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
  severity: Severity;
}

/** What one rule found, before it is pinned to a file and line. */
export type Hit = { rule: string; detail: string; severity: Severity };

/** A SQL literal as the parser found it. */
export interface Literal {
  line: number;
  /** Its text, with every interpolation written back as `${expression}`. */
  sql: string;
  /**
   * The same text with each interpolation as a sentinel, `⟨0⟩`, `⟨1⟩`… — what the rules read, so a
   * `${…}` holding a template of its own, braces and all, can never be half-parsed as SQL.
   */
  skeleton: string;
  /** The source of each `${…}`, in order. */
  interpolations: string[];
  /** An operand of `+` or `+=` beside something that is not itself a literal. */
  concatenated: boolean;
  /** The argument of an `.exec(…)` call, which binds nothing. */
  executed: boolean;
}

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * Files allowed to contain SQL at all (A1).
 *
 * The other half of the sentence `check-arch.ts` enforces: SQL lives in a `*.store.ts` file. That rule
 * keeps the *handle* in the data layer; this keeps the *queries* there — a helper handed a store could
 * still build a query string and pass it in. `ls **\/*.store.ts` stays the complete list of SQL a
 * schema change has to read.
 */
function mayHoldSql(rel: string): boolean {
  return (
    rel.endsWith(".store.ts") ||
    rel === "packages/runtime/src/db.ts" ||
    // The migration runner and the snapshots: their SQL is the schema-version bookkeeping itself.
    rel.startsWith("apps/engine/src/db/") ||
    // An operator migration across every column `db/keys.ts` lists — see the note in `check-arch.ts`.
    rel === "apps/engine/src/modules/gateways/rename.ts"
  );
}

/**
 * The one file in the Pro code that writes SQL, until it stops: the account reset deletes the engine's account rows
 * through a connection of its own (`pro-account-reset-reaches-into-engine-db`), and the fix is to ask the engine's
 * user store instead — after which this file holds no SQL and the entry is reported until it goes. Any other SQL in
 * `internals/pro` is held to every rule here; a plugin owns no tables, so it should have none.
 */
// Empty since 0.7.9: the setup console's account reset asks the engine (`UserStore.resetAll`) instead of opening its database.
const PRO_SQL_UNTIL_FIXED: Record<string, string> = {};

/**
 * Tests are not checked. Nothing in them ships: a fixture that inserts a row to prove a store reads it
 * back is asserting against the schema on purpose, and an injection rule has nothing to protect there.
 */
const isTest = (rel: string) => rel.includes("/tests/") || rel.endsWith(".test.ts");

/**
 * Migrations at or below this version are not re-checked.
 *
 * Correctness, not leniency: an applied migration never runs again, and editing one refuses to boot
 * (`apps/engine/src/db/index.ts`). Raised from 32 to 44 when TD-015 retired the portability rules, to 68 with 0.8.0's
 * squash, and to 69 with 0.8.1's: `069_baseline.sql` is the schema every box 0.8.1 starts on already has.
 */
export const GRANDFATHERED_THROUGH = 69;

/**
 * What makes a string a query rather than prose — or an HTTP method.
 *
 * A verb alone matched the dashboard's `method: "DELETE"` 143 times, so each verb is paired with what
 * SQL requires after it. Two gaps in the first version hid whole queries from every rule: `WITH`
 * demanded `WITH name AS`, which a recursive CTE (`WITH RECURSIVE walk(origin, id) AS`) or any CTE
 * with a column list is not, and `CREATE VIRTUAL TABLE` was not a start at all.
 */
export const SQL_START = new RegExp(
  "^\\s*(?:--[^\\n]*\\n\\s*)*(?:" +
    [
      "SELECT\\s+\\S",
      "INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\b",
      "REPLACE\\s+INTO\\b",
      "DELETE\\s+FROM\\b",
      "UPDATE\\s+\\S+\\s+SET\\b",
      "CREATE\\s+(?:UNIQUE\\s+|VIRTUAL\\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\\b",
      "DROP\\s+(?:TABLE|INDEX|VIEW|TRIGGER)\\b",
      "ALTER\\s+TABLE\\b",
      "PRAGMA\\s+\\S",
      "WITH\\s+(?:RECURSIVE\\s+)?\\w+\\s*(?:\\([^)]*\\)\\s*)?AS\\b",
      // `BEGIN`, `COMMIT` and `ROLLBACK` are absent on purpose: they are also English and CLI words —
      // the first version reported `helm rollback` as a query — and only the adapter writes them.
    ].join("|") +
    ")",
  "i",
);

/** A rule that reads the SQL text alone. */
interface TextRule {
  id: string;
  pattern: RegExp;
  detail: string;
  severity: Severity;
  /** A statement this rule leaves alone, and the reason is beside it. */
  unless?: RegExp;
}

/**
 * Every rule that can be decided from the statement's text.
 *
 * Interpolations are blanked and single-quoted strings emptied before these run (except P2, which is
 * about what a quoted pattern starts with), so a word inside a value never fires a rule.
 */
const TEXT_RULES: TextRule[] = [
  {
    id: "S6",
    pattern: /\bload_extension\s*\(|\battach\s+(?:database\s+)?['"?:$@]|\bcreate\s+virtual\s+table\s+\w+\s+using\s+(?!fts5\b)\w+/i,
    detail: "code execution and file access, and a file beside the binary — TD-015 keeps extensions, ATTACH and any virtual table but FTS5 out",
    severity: "error",
  },
  {
    id: "P3",
    pattern: /\border\s+by\s+random\s*\(\s*\)/i,
    detail: "sorts every row to pick a few — pick in TypeScript",
    severity: "error",
  },
  {
    id: "F1",
    pattern: /\binsert\s+or\s+replace\b|\breplace\s+into\b/i,
    detail: "deletes the old row first: its ON DELETE cascades fire and every column not listed resets — use `INSERT … ON CONFLICT (cols) DO UPDATE SET …`",
    severity: "error",
  },
  {
    id: "F2",
    pattern: /\binsert\s+or\s+ignore\b/i,
    detail: "also swallows NOT NULL and CHECK failures, not only the conflict — use `INSERT … ON CONFLICT (cols) DO NOTHING`",
    severity: "error",
  },
  {
    id: "F3",
    pattern: /'now'|'localtime'|\bstrftime\s*\(|\bjulianday\s*\(|\bunixepoch\b|\bcurrent_(?:timestamp|date|time)\b/i,
    detail: "SQLite's clock is UTC, not the daemon's `time_zone` — pass epoch milliseconds from TypeScript and do the date arithmetic there",
    severity: "error",
  },
  {
    id: "F5",
    pattern: /\bautoincrement\b/i,
    detail: "extra CPU, memory and disk by SQLite's own account, for a guarantee nothing here needs — ids come from `newId`, or an INTEGER PRIMARY KEY",
    severity: "warning",
    // The one place the guarantee is the point: the event stream's cursor, which followers hold. A number handed out
    // twice is a row they drop as old (`events.store.ts`).
    unless: /\bcreate\s+table\s+events\w*\s*\(\s*seq\s+integer\s+primary\s+key\s+autoincrement\b/i,
  },
  {
    id: "P5",
    pattern: /\boffset\s+(?:\?|\d|[:$@]\w)/i,
    detail: "re-reads every row it skips — page by key instead: `WHERE (started_at, id) < (?, ?) ORDER BY started_at DESC, id DESC LIMIT ?`",
    severity: "warning",
  },
  {
    id: "A2",
    pattern: /\bpragma\b/i,
    detail: "engine configuration lives in one place — the adapter, `packages/runtime/src/db.ts` — never in a store",
    severity: "error",
  },
];

/**
 * `${…}` a SQL literal may splice in, keyed by file and expression: why it cannot carry input, and what
 * to plan it as (S1).
 *
 * `${marks(…)}` needs no entry — it writes `?, ?, …` and nothing else. Anything without an entry is an
 * error: bind it with `?`. An entry without `planAs` is allowed and never planned.
 */
export const INTERPOLATIONS: Record<string, { why: string; planAs?: string }> = {
  "memory-index.store.ts sql": { why: "`where()` builds it from fixed clauses; every value is bound with `?`", planAs: "e.chat = ?" },
  "memory-index.store.ts table": { why: "a name from the literal list beside it" },
  "memory-fts.store.ts sql": { why: "the same `where()` fragment, scoping `rank()`", planAs: "e.chat = ?" },
  "memory-fts.store.ts fact": { why: "`i.item IN (?, …)` from `marks()`, or the constant `1 = 0`", planAs: "i.item IN (?)" },
  "memory-fts.store.ts section": { why: "`s.collection IN (?, …)` from `marks()`, or the constant `1 = 0`", planAs: "s.collection IN (?)" },
  "memory-analytics.store.ts sql": { why: "the index's own `where()` fragment, so a count and a search agree on scope", planAs: "e.chat = ?" },
  "memory-analytics.store.ts column": { why: "one of three fixed column names, picked by `period`", planAs: "e.day" },
  "logs.store.ts where": { why: "`filter()` joins fixed clauses; every value is bound with `?`", planAs: "WHERE component = ?" },
  "sessions.store.ts where": { why: "`filter()` joins fixed clauses; every value is bound with `?`", planAs: "WHERE s.agent_id = ?" },
  "cron.store.ts where": { why: "fixed clauses joined by `list()`; the agent id is bound", planAs: "WHERE agent_id = ?" },
  "grants.store.ts where": { why: "fixed clauses joined by `list()`; the agent id is bound", planAs: "WHERE agent_id = ? AND revoked_at IS NULL" },
  "chat-attachments.store.ts notThese": { why: "`AND ref NOT IN (?, …)` for the message's own files, or nothing", planAs: "AND ref NOT IN (?)" },
  "usage.store.ts byAgent": { why: "`AND agent_id = ?`, or nothing", planAs: " AND agent_id = ?" },
  "turns.store.ts OWN": { why: "a constant clause naming the two causes of a delegate's own turn", planAs: "(cause IS NULL OR json_extract(cause, '$.via') NOT IN ('delegate', 'ask_agent'))" },
  "tokens.store.ts COLUMNS": { why: "a constant column list", planAs: "id, person, agents, scopes, label, created_at, last_used_at" },
  "rename.ts table": { why: "a table name from `db/keys.ts`, checked by `identifier()`" },
  "rename.ts set.sql": { why: "`assignment()`: a column from `db/keys.ts` checked by `identifier()`, set to a fixed expression; values are bound" },
  "rename.ts where.sql": { why: "`naming()`: a column from `db/keys.ts` checked by `identifier()`, compared by a fixed operator; values are bound" },
  "rename.ts identifier(table)": { why: "checked against `^[a-z_][a-z0-9_]*$` by `identifier()`, which throws otherwise" },
  "rename.ts where": { why: "`naming()` clauses, joined by `OR` and behind an `IN_FLIGHT` condition from `db/keys.ts`; values are bound" },
};

/** Tables a full scan of is the point, and why (P1). */
export const SCANS_ALLOWED: Record<string, string> = {
  memory_tag_aliases: "`aliases()` reads it whole — a handful of rows",
  memory_vectors: "a catch-up's `pruneGone` reads every item once, to drop the vectors of what is gone — every other read is by model or by item, through an index",
  memory_episode_agents: "the facet counts read every row by design — the counts are the question",
  memory_files: "`signature()` sums every file's size and mtime — one row per vault file, read whole on purpose",
  memory_groups: "one row per named group chat, read whole into a map",
  memory_pass_runs: "trimmed to the last `RUNS_KEPT` runs on every insert",
  skill_reviews: "one row a week, the weekly skill review's; `last()` reads the newest",
  memory_attempts: "one row per episode that failed to summarise — a handful",
  approvals: "pruned by age; the recent-resolutions lookup and the sweep read what is kept",
  chat_attachments: "only the daily age sweep scans it; every read goes through `idx_chat_attachments_chat`",
  cron_runs: "only the boot-time recovery of interrupted runs scans it, once per boot",
  jobs: "the log sweep reads every finished job on purpose, and finished jobs are pruned",
  sessions: "one row per conversation, pruned by age; history pages through it newest first",
  sender_access: "one row per person who asked for access, read whole for the access page",
  skill_drafts: "proposals awaiting a decision, swept once decided",
  tool_grants: "standing grants an operator made by hand — a handful",
  users: "dashboard accounts — a handful",
  cron_jobs: "a handful of jobs; only the gateway rename tool's LIKE reads it whole, once, by hand",
  mcp_tokens: "one row per MCP client a person connected — a handful, listed whole",
  user_sessions: "dashboard sign-ins, swept on expiry; deleting a user reaches it through the foreign key",
  turn_journal: "holds only the turns in flight — emptied at every settle — and is read whole once, at boot",
  sqlite_sequence: "SQLite's own table: one row per AUTOINCREMENT table, two of them — `latest()` reads the stream's",
  knowledge_documents: "one row per document people kept, a few hundred: the page and `nouride knowledge list` list them whole, a sync reads each collection's, and the graph's knowledge layer counts them to know when to build again",
  knowledge_sections: "the embedding catch-up lists every section once a run, and a memory reindex writes every section's words again; the graph's knowledge layer reads those holding a link once per change; search reads by item and by collection",
};

/**
 * Stores whose every statement may read whole tables, and why (P1) — narrower than `SCANS_ALLOWED`, which would let any
 * query of the table scan it. For a step that runs once, at an upgrade, and has to look at every row to do its work.
 */
export const SCANNING_STORES: Record<string, string> = {
  "moved-paths.store.ts": "renames every path under a folder that moved: out of `data/` at the 0.8.0 move or a move that stopped half-way, or the whole install, at its first start in another folder",
};

/**
 * Methods allowed to query once per item, and why (P4). Each entry is a loop somebody decided is
 * bounded; anything else becomes one statement — `IN (…)` in chunks, a join, or a CTE.
 */
export const QUERIES_PER_ITEM: Record<string, string> = {
  "memory-index.store.ts pages":
    "one statement a page of 500 episodes, not one an item: a sweep over the vault reads it a page at a time so it never holds every episode at once",
};

/** Line number of an offset, 1-indexed. */
function lineOf(file: ts.SourceFile, position: number): number {
  return file.getLineAndCharacterOfPosition(position).line + 1;
}

/** The sentinel standing for interpolation `i` in a skeleton. */
export const sentinel = (i: number) => `⟨${i}⟩`;

/** The text a string or template literal holds: as written, and as a skeleton. */
function literalText(node: ts.Node, file: ts.SourceFile): { sql: string; skeleton: string; interpolations: string[] } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { sql: node.text, skeleton: node.text, interpolations: [] };
  if (!ts.isTemplateExpression(node)) return null;
  const interpolations = node.templateSpans.map((span) => span.expression.getText(file));
  const sql = node.head.text + node.templateSpans.map((span, i) => `\${${interpolations[i]}}${span.literal.text}`).join("");
  const skeleton = node.head.text + node.templateSpans.map((span, i) => `${sentinel(i)}${span.literal.text}`).join("");
  return { sql, skeleton, interpolations };
}

/** Whether every leaf of a `+` chain is a literal — a long string broken across lines, not SQL being built. */
function allLiterals(node: ts.Node): boolean {
  if (ts.isParenthesizedExpression(node)) return allLiterals(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return allLiterals(node.left) && allLiterals(node.right);
  }
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** The SQL literals in one file, with what surrounds each. */
export function literalsOf(fileName: string, source: string): Literal[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: Literal[] = [];
  const visit = (node: ts.Node): void => {
    const text = literalText(node, file);
    if (text && SQL_START.test(text.sql)) {
      let top: ts.Node = node;
      while (ts.isParenthesizedExpression(top.parent) || (ts.isBinaryExpression(top.parent) && top.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
        top = top.parent;
      }
      const parent = top.parent;
      const concatenated =
        (top !== node && !allLiterals(top)) ||
        (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken);
      const executed =
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === "exec";
      found.push({ line: lineOf(file, node.getStart(file)), ...text, concatenated, executed });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const ITERATING = new Set(["map", "flatMap", "forEach", "filter", "reduce", "some", "every", "find", "findIndex", "toSorted", "sort"]);

/** The method, function or file a node belongs to — the scope a statement's name is looked up in. */
function ownerOf(node: ts.Node): ts.Node {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n)) return n;
    if (ts.isSourceFile(n)) return n;
  }
  return node.getSourceFile();
}

/** Whether `node` is a statement object: `….prepare(…)` or `….query(…)` itself, or a name its method binds to one. */
function isStatement(node: ts.Expression): boolean {
  const prepared = (expr: ts.Expression | undefined): boolean =>
    !!expr &&
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ["prepare", "query"].includes(expr.expression.name.text);
  if (prepared(node)) return true;
  if (!ts.isIdentifier(node)) return false;
  let bound = false;
  const look = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === node.text && prepared(n.initializer)) bound = true;
    if (!bound) ts.forEachChild(n, look);
  };
  look(ownerOf(node));
  return bound;
}

/** The name of the function or method a node sits in, for the P4 allowlist. */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isGetAccessorDeclaration(n)) && n.name) return n.name.getText();
    if (ts.isConstructorDeclaration(n)) return "constructor";
  }
  return "(top level)";
}

/** Reads (`.get`, `.all`, `.values`) on a statement inside a loop or an iterating callback (P4). */
export function loopQueries(fileName: string, source: string): { line: number; method: string }[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: { line: number; method: string }[] = [];
  const inLoop = (node: ts.Node): boolean => {
    for (let from: ts.Node = node, n: ts.Node | undefined = node.parent; n; from = n, n = n.parent) {
      // What a loop iterates over, and a `for`'s initializer, are evaluated once — `for (const row of stmt.all())` is one query.
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && from === n.expression) continue;
      if (ts.isForStatement(n) && from === n.initializer) continue;
      if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) return true;
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
        const call = n.parent;
        return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ITERATING.has(call.expression.name.text);
      }
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)) return false;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["get", "all", "values"].includes(node.expression.name.text) &&
      isStatement(node.expression.expression) &&
      inLoop(node)
    ) {
      found.push({ line: lineOf(file, node.getStart(file)), method: enclosingName(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** A skeleton with `--` comments dropped and single-quoted values emptied. */
function bare(skeleton: string): string {
  return skeleton.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");
}

/** The rules decidable from the text alone, plus the `LIKE` ones (S4, P2). */
export function textFindings(skeleton: string): Hit[] {
  const out: Hit[] = [];
  const cleaned = bare(skeleton);
  // F3 reads quoted words — `'now'` is the footgun — so it sees the values the others do not.
  const unquoted = skeleton.replace(/--[^\n]*/g, " ");
  for (const rule of TEXT_RULES) {
    const text = rule.id === "F3" ? unquoted : cleaned;
    if (rule.pattern.test(text) && !rule.unless?.test(text)) out.push({ rule: rule.id, detail: rule.detail, severity: rule.severity });
  }
  for (const like of unquoted.matchAll(/\blike\s+('(?:[^']|'')*'|\S+)(\s+escape\b)?/gi)) {
    const operand = like[1] ?? "";
    if (operand.startsWith("'")) {
      if (operand.startsWith("'%")) {
        out.push({ rule: "P2", detail: "a leading wildcard always scans — FTS5 (`memory-fts.store.ts`), or a junction table", severity: "error" });
      }
    } else if (!like[2]) {
      out.push({
        rule: "S4",
        detail: "a `%` or `_` in the value is a wildcard, and a leading `%` scans the table — escape it with `likeLiteral()` and add `ESCAPE '\\'`",
        severity: "error",
      });
    }
  }
  return out;
}

/** Everything decidable from one literal and the file it is in: placement, splicing, MATCH, and the text rules. */
export function literalFindings(rel: string, literal: Literal): Hit[] {
  const file = basename(rel);
  const out: Hit[] = [];
  if (!mayHoldSql(rel)) {
    out.push({ rule: "A1", detail: "queries live in a `*.store.ts` file — move this one there and take the store instead", severity: "error" });
  }
  for (const expression of literal.interpolations) {
    if (!expression.startsWith("marks(") && !INTERPOLATIONS[`${file} ${expression}`]) {
      out.push({ rule: "S1", detail: `\`\${${expression}}\` is spliced into the SQL — bind it with \`?\`, or list it in INTERPOLATIONS with why it cannot carry input`, severity: "error" });
    }
  }
  if (literal.concatenated) out.push({ rule: "S2", detail: "SQL built with `+` — a template with listed interpolations, or parameters", severity: "error" });
  if (literal.executed && literal.interpolations.length > 0 && !rel.startsWith("apps/engine/src/db/")) {
    out.push({ rule: "S3", detail: "`exec()` binds nothing — use `prepare(…).run(…)` with parameters", severity: "error" });
  }
  if (/\bmatch\b/i.test(bare(literal.skeleton)) && file !== "memory-fts.store.ts") {
    out.push({ rule: "S5", detail: "FTS5 query syntax is a language of its own — build it with `ftsQuery()` and run it through `memory-fts.store.ts`", severity: "error" });
  }
  return [...out, ...textFindings(literal.skeleton)];
}

/** Double-quoted words that are not a table, column or index name — a string SQLite would take as one (F4). */
export function quotedStrings(skeleton: string, names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const match of bare(skeleton).matchAll(/"([^"]*)"/g)) {
    const word = (match[1] ?? "").toLowerCase();
    if (!names.has(word)) out.push(match[1] ?? "");
  }
  return out;
}

/** What `FROM`, `JOIN`, `UPDATE` and `INTO` name, by alias as well as by name — a plan reads `SCAN e`. */
function aliasesOf(sql: string): Map<string, string> {
  const KEYWORDS = new Set([
    "where", "on", "join", "left", "right", "inner", "outer", "cross", "natural", "using", "group", "order", "limit",
    "set", "values", "select", "union", "having", "window", "returning", "as", "indexed", "not", "default", "full",
  ]);
  const map = new Map<string, string>();
  for (const match of sql.matchAll(/\b(?:from|join|update|into)\s+([a-z_]\w*)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)) {
    const table = (match[1] ?? "").toLowerCase();
    map.set(table, table);
    const alias = match[2]?.toLowerCase();
    if (alias && !KEYWORDS.has(alias)) map.set(alias, table);
  }
  return map;
}

/** Whether a statement reads, and so has a plan worth checking. */
export function reads(sql: string): boolean {
  const head = sql.replace(/^\s*(?:--[^\n]*\n\s*)*/, "");
  return /^(?:select|with|update|delete)\b/i.test(head) || (/^insert\b/i.test(head) && /\bselect\b/i.test(head));
}

/**
 * P1 and P6 from one statement's plan.
 *
 * With no `ANALYZE` data SQLite assumes every table is large, so a plan against an empty schema shows
 * whether an index *can* be used — the question that matters here. `SCAN … USING [COVERING] INDEX`,
 * a virtual table (the FTS5 index), and a CTE, subquery or `json_each` are not table scans.
 */
export function planFindings(
  plan: readonly string[],
  sql: string,
  tables: ReadonlySet<string>,
  allowed: Readonly<Record<string, string>> = SCANS_ALLOWED,
): Hit[] {
  const out: Hit[] = [];
  const aliases = aliasesOf(sql);
  for (const detail of plan) {
    const scan = /^SCAN (\S+)(.*)$/.exec(detail);
    if (scan && !/\bUSING\b|VIRTUAL TABLE/.test(scan[2] ?? "")) {
      const table = aliases.get((scan[1] ?? "").toLowerCase()) ?? (scan[1] ?? "").toLowerCase();
      if (tables.has(table) && !allowed[table]) {
        out.push({ rule: "P1", detail: `reads all of \`${table}\` — index the column it filters on, or list the table in SCANS_ALLOWED with the reason`, severity: "error" });
      }
    }
    // A sort no index could have provided is not a finding: by an expression (`bm25(…)`, a score), or over
    // groups (`GROUP BY … ORDER BY n DESC`). Nor is one over a table that may be read whole anyway.
    const orderBy = /\border\s+by\s+([\s\S]*?)(?:\blimit\b|$)/i.exec(sql)?.[1] ?? "";
    const sorted = [...new Set(aliases.values())].filter((table) => tables.has(table));
    if (
      detail.startsWith("USE TEMP B-TREE FOR ORDER BY") &&
      !orderBy.includes("(") &&
      !/\bgroup\s+by\b/i.test(sql) &&
      sorted.some((table) => !allowed[table])
    ) {
      out.push({ rule: "P6", detail: "sorts in a temporary B-tree — an index in the sort order would hand the rows over already sorted", severity: "warning" });
    }
  }
  return out;
}

/**
 * The least SQL this repository can plausibly contain, and the least of it the plan check must reach.
 * Below either, the extractor or the substitution is broken, not the repository. Measured when v2
 * landed — 289 statements, 237 planned — and set below both, so ordinary deletions never trip them
 * while a broken extractor cannot pass.
 */
export const MIN_EXPECTED_QUERIES = 240;
export const MIN_PLANNED = 200;

export function floorFailure(queries: number, planned: number): string | null {
  if (queries < MIN_EXPECTED_QUERIES) {
    return `found only ${queries} SQL statements, expected at least ${MIN_EXPECTED_QUERIES} — the extractor in this script is broken, not the repo`;
  }
  if (planned < MIN_PLANNED) {
    return `planned only ${planned} statements, expected at least ${MIN_PLANNED} — a plan check that quietly plans nothing is the fail-open shape this guards against`;
  }
  return null;
}

/** A statement ready for `EXPLAIN QUERY PLAN`, or the reason it is not. */
function forPlanning(file: string, literal: Literal): string | null {
  let sql = literal.skeleton;
  for (const [i, expression] of literal.interpolations.entries()) {
    const entry = INTERPOLATIONS[`${file} ${expression}`];
    const sample = expression.startsWith("marks(") ? "?" : entry?.planAs;
    if (sample === undefined) return null;
    sql = sql.replace(sentinel(i), sample);
  }
  return sql;
}

async function main(): Promise<void> {
  const { openDatabase } = await import("../packages/runtime/src/index.ts");
  const { migrate } = await import("../apps/engine/src/db/index.ts");
  const db = openDatabase(":memory:");
  await migrate(db);
  const tables = new Set(
    db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name.toLowerCase()),
  );
  const names = new Set<string>(tables);
  for (const row of db.prepare<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").all()) names.add(row.name.toLowerCase());
  for (const table of tables) {
    for (const column of db.prepare<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).all()) names.add(column.name.toLowerCase());
  }

  const findings: Finding[] = [];
  const add = (file: string, line: number, hit: Hit) => findings.push({ file, line, ...hit });
  let queries = 0;
  let planned = 0;
  let readsSeen = 0;

  // The Pro code too, when it is checked out (`lint-sources.ts`).
  const untilFixed = new Set<string>();
  for (const path of await lintedFiles(ROOT, ["ts"])) {
    const rel = relative(ROOT, path);
    if (rel.endsWith(".gen.ts") || rel.endsWith(".d.ts") || isTest(rel)) continue;
    // The adapter is where the engine-specific part lives — it opens the file and sets the PRAGMAs.
    if (rel === "packages/runtime/src/db.ts") continue;
    const source = await Bun.file(path).text();
    const file = basename(rel);
    const store = rel.endsWith(".store.ts");

    if (PRO_SQL_UNTIL_FIXED[rel]) {
      if (literalsOf(rel, source).length > 0) untilFixed.add(rel);
      continue;
    }

    for (const literal of literalsOf(rel, source)) {
      queries += 1;
      const at = (hit: Hit) => add(rel, literal.line, hit);
      for (const hit of literalFindings(rel, literal)) at(hit);
      for (const word of quotedStrings(literal.skeleton, names)) {
        at({ rule: "F4", detail: `"${word}" names no table or column, so SQLite reads it as a string — use single quotes`, severity: "error" });
      }

      if (!reads(literal.skeleton)) continue;
      readsSeen += 1;
      const sql = forPlanning(file, literal);
      if (sql === null) continue;
      let plan: string[];
      try {
        plan = db.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail);
      } catch (err) {
        at({ rule: "Q0", detail: `does not prepare against the schema that ships: ${err instanceof Error ? err.message : String(err)}`, severity: "error" });
        continue;
      }
      planned += 1;
      for (const hit of planFindings(plan, sql, tables)) if (!(hit.rule === "P1" && SCANNING_STORES[file])) at(hit);
    }

    if (store) {
      for (const { line, method } of loopQueries(rel, source)) {
        if (QUERIES_PER_ITEM[`${file} ${method}`]) continue;
        add(rel, line, {
          rule: "P4",
          detail: `\`${method}\` queries once per item — one statement instead: \`IN (…)\` in chunks, a join, or a CTE (or list it in QUERIES_PER_ITEM with the reason)`,
          severity: "error",
        });
      }
    }
  }

  // An exemption whose file holds no SQL any more is reported until it is removed, so it cannot outlive its reason.
  // Only while the Pro code is checked out: absent, the file is not there to ask.
  for (const [rel, why] of Object.entries(PRO_SQL_UNTIL_FIXED)) {
    if (!untilFixed.has(rel) && (await Bun.file(`${ROOT}${PRO}package.json`).exists())) {
      add(rel, 0, { rule: "A2", detail: `holds no SQL any more, so its exemption (${why}) is stale — remove it from PRO_SQL_UNTIL_FIXED`, severity: "error" });
    }
  }

  // ── New migrations, statement by statement ────────────────────────────────
  for await (const path of new Bun.Glob("apps/engine/src/db/migrations/*.sql").scan({ cwd: ROOT, absolute: true })) {
    const rel = relative(ROOT, path);
    const version = Number.parseInt(basename(rel).slice(0, 3), 10);
    if (Number.isFinite(version) && version <= GRANDFATHERED_THROUGH) continue;
    const sql = await Bun.file(path).text();
    let offset = 0;
    for (const statement of sql.split(";")) {
      const line = sql.slice(0, offset).split("\n").length + (statement.match(/^\s*/)?.[0].split("\n").length ?? 1) - 1;
      for (const hit of textFindings(statement)) add(rel, line, hit);
      offset += statement.length + 1;
    }
  }
  db.close();

  const floor = floorFailure(queries, planned);
  if (floor) {
    console.error(`✗ ${floor}. Fix it before trusting a pass.`);
    process.exit(1);
  }

  const sorted = findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const errors = sorted.filter((f) => f.severity === "error");
  const warnings = sorted.filter((f) => f.severity === "warning");
  // Warnings on request: a list printed on every commit is a list people learn to scroll past.
  if (process.argv.includes("--warnings")) {
    for (const f of warnings) console.warn(`  ! ${f.file}:${f.line}  [${f.rule}] ${f.detail}`);
  }
  if (errors.length === 0) {
    const share = readsSeen ? Math.round((100 * planned) / readsSeen) : 100;
    const noted = warnings.length ? `, ${warnings.length} warning(s) — \`bun run lint:sql --warnings\`` : "";
    console.log(`✓ SQL checked — ${queries} statements, ${planned} query plans (${share}% of reads)${noted}`);
    return;
  }

  console.error(`✗ ${errors.length} SQL finding(s), in ${queries} statements and ${planned} query plans:\n`);
  for (const f of errors) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
    console.error(`    ${f.detail}\n`);
  }
  console.error("See §3 of docs/ARCHITECTURE.md — the SQL is fast and safe — and TD-015.");
  process.exit(1);
}

if (import.meta.main) await main();
