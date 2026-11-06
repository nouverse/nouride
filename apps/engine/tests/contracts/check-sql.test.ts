/**
 * `lint:sql` v2 checks itself: every rule fires on a bad example and stays quiet on the good one, the
 * extractor sees the shapes it used to miss, the plan check catches the scan that made 0.6's keyword
 * search slow, and a run that finds too little fails.
 *
 * A lint that passes because it stopped looking is worse than none, since a pass is also a claim. So
 * each rule is pinned from both sides here rather than trusted from the repository's own clean run.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "@nouride/runtime";
import {
  floorFailure,
  literalFindings,
  literalsOf,
  loopQueries,
  planFindings,
  quotedStrings,
  reads,
  SQL_START,
  textFindings,
  type Literal,
} from "../../../../scripts/check-sql.ts";

const rules = (skeleton: string) => textFindings(skeleton).map((hit) => hit.rule);
const literal = (sql: string, extra: Partial<Literal> = {}): Literal => ({
  line: 1,
  sql,
  skeleton: sql,
  interpolations: [],
  concatenated: false,
  executed: false,
  ...extra,
});
const fromLiteral = (rel: string, lit: Literal) => literalFindings(rel, lit).map((hit) => hit.rule);

describe("the text rules", () => {
  test("S6: extensions, ATTACH and virtual tables other than FTS5 — and FTS5 itself is fine", () => {
    expect(rules("SELECT load_extension('x')")).toContain("S6");
    expect(rules("ATTACH DATABASE ? AS other")).toContain("S6");
    expect(rules("CREATE VIRTUAL TABLE r USING rtree(id, a, b)")).toContain("S6");
    expect(rules("CREATE VIRTUAL TABLE f USING fts5(body, content = '')")).not.toContain("S6");
  });

  test("S4: a bound LIKE needs ESCAPE; P2: a leading wildcard always scans", () => {
    expect(rules("SELECT path FROM memory_files WHERE path LIKE ?")).toContain("S4");
    expect(rules("SELECT path FROM memory_files WHERE path LIKE ? ESCAPE '\\'")).not.toContain("S4");
    expect(rules("SELECT * FROM t WHERE a LIKE '%x'")).toContain("P2");
    expect(rules("SELECT * FROM t WHERE a LIKE 'x%'")).toEqual([]);
  });

  test("P3, P5: a random sort and an offset", () => {
    expect(rules("SELECT * FROM t ORDER BY random() LIMIT 1")).toContain("P3");
    expect(rules("SELECT * FROM t ORDER BY id LIMIT ? OFFSET ?")).toContain("P5");
    expect(rules("SELECT * FROM t WHERE id < ? ORDER BY id DESC LIMIT ?")).toEqual([]);
  });

  test("F1, F2: INSERT OR REPLACE, REPLACE INTO and INSERT OR IGNORE — not ON CONFLICT", () => {
    expect(rules("INSERT OR REPLACE INTO t (id) VALUES (?)")).toContain("F1");
    expect(rules("REPLACE INTO t (id) VALUES (?)")).toContain("F1");
    expect(rules("INSERT OR IGNORE INTO t (id) VALUES (?)")).toContain("F2");
    expect(rules("INSERT INTO t (id) VALUES (?) ON CONFLICT (id) DO NOTHING")).toEqual([]);
  });

  test("F3: SQLite's clock, in any of its spellings — not an epoch passed in", () => {
    for (const clock of ["date('now')", "strftime('%s', x)", "julianday(x)", "unixepoch()", "datetime(x, 'localtime')", "CURRENT_TIMESTAMP"]) {
      expect(rules(`SELECT ${clock}`)).toContain("F3");
    }
    expect(rules("SELECT * FROM t WHERE at >= ?")).toEqual([]);
  });

  test("F5 warns on AUTOINCREMENT, A2 refuses a PRAGMA", () => {
    expect(textFindings("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)")).toContainEqual(expect.objectContaining({ rule: "F5", severity: "warning" }));
    // The stream's cursor is the one place the guarantee is the point: a follower holds it.
    expect(textFindings("CREATE TABLE events_rebuild (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL)").map((hit) => hit.rule)).not.toContain("F5");
    expect(rules("PRAGMA foreign_keys = ON")).toContain("A2");
  });

  test("a word inside a value never fires a rule", () => {
    expect(rules("SELECT * FROM t WHERE note = 'pragma or replace into'")).toEqual([]);
  });

  test("F4: a double-quoted word that names nothing is a string", () => {
    const names = new Set(["t", "status", "order"]);
    expect(quotedStrings(`SELECT * FROM t WHERE status = "done"`, names)).toEqual(["done"]);
    expect(quotedStrings(`SELECT "order" FROM t`, names)).toEqual([]);
  });
});

describe("what the parser sees", () => {
  test("the extractor sees a recursive CTE, a CTE with columns, and CREATE VIRTUAL TABLE", () => {
    expect(SQL_START.test("WITH RECURSIVE walk(origin, id, depth) AS (SELECT 1)")).toBe(true);
    expect(SQL_START.test("WITH picked (id) AS (SELECT 1) SELECT * FROM picked")).toBe(true);
    expect(SQL_START.test("CREATE VIRTUAL TABLE f USING fts5(body)")).toBe(true);
    expect(SQL_START.test("WITH RECURSIVE is how a graph is walked, in prose")).toBe(false);
    expect(literalsOf("x.store.ts", "const q = `WITH RECURSIVE walk(id) AS (SELECT ?) SELECT id FROM walk`;")).toHaveLength(1);
  });

  test("S1: an interpolation must be marks() or listed; S2: SQL built with +; S3: exec with interpolation", () => {
    const [spliced] = literalsOf("x.store.ts", "db.prepare(`SELECT * FROM t WHERE id IN (${marks(ids)}) AND a = ${value}`)");
    expect(spliced!.interpolations).toEqual(["marks(ids)", "value"]);
    expect(fromLiteral("apps/engine/src/x.store.ts", spliced!).filter((rule) => rule === "S1")).toHaveLength(1);

    const [built] = literalsOf("x.store.ts", 'db.prepare("SELECT * FROM t WHERE id = " + id)');
    expect(built!.concatenated).toBe(true);
    const [broken] = literalsOf("x.store.ts", 'db.prepare("SELECT * FROM t " + "WHERE id = ?")');
    expect(broken!.concatenated).toBe(false);

    const [executed] = literalsOf("x.store.ts", "db.exec(`DELETE FROM ${table}`)");
    expect(fromLiteral("apps/engine/src/x.store.ts", executed!)).toEqual(expect.arrayContaining(["S1", "S3"]));
  });

  test("a template inside an interpolation is not half-read as SQL", () => {
    const [nested] = literalsOf("x.store.ts", 'db.prepare(`SELECT * FROM t WHERE a = ? ${more ? `AND ref NOT IN (${holes})` : ""} ORDER BY a`)');
    expect(quotedStrings(nested!.skeleton, new Set(["t", "a", "ref"]))).toEqual([]);
  });

  test("S5: MATCH belongs to the FTS store; A1: SQL belongs to a store", () => {
    const match = literal("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?");
    expect(fromLiteral("apps/engine/src/modules/memory/search.store.ts", match)).toContain("S5");
    expect(fromLiteral("apps/engine/src/modules/memory/memory-fts.store.ts", match)).not.toContain("S5");
    expect(fromLiteral("apps/engine/src/modules/memory/search.ts", literal("SELECT 1 FROM t"))).toContain("A1");
  });

  test("P4: a read per item in a loop or a callback — not the query a loop iterates over", () => {
    const perItem = "function f() { const s = db.prepare('SELECT 1'); for (const id of ids) s.get(id); }";
    const callback = "function f() { return ids.map((id) => db.prepare('SELECT 1').get(id)); }";
    const header = "function f() { for (const row of db.prepare('SELECT 1').all()) use(row); }";
    const unrelated = "function f() { const agents = new Map(); return ids.map((id) => agents.get(id)); }\nfunction g() { const agents = db.prepare('SELECT 1'); }";
    expect(loopQueries("x.store.ts", perItem)).toHaveLength(1);
    expect(loopQueries("x.store.ts", callback)).toHaveLength(1);
    expect(loopQueries("x.store.ts", header)).toEqual([]);
    expect(loopQueries("x.store.ts", unrelated)).toEqual([]);
  });
});

describe("the plan check", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE memory_terms (term TEXT NOT NULL, item TEXT NOT NULL, tf INTEGER NOT NULL, PRIMARY KEY (term, item))");
  db.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(body, content = '', contentless_delete = 1)");
  const tables = new Set(["memory_terms", "memory_fts"]);
  const plan = (sql: string) => db.prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail);
  const check = (sql: string, allowed: Record<string, string> = {}) => planFindings(plan(sql), sql, tables, allowed).map((hit) => hit.rule);

  test("flags the prefix LIKE that made 0.6's keyword search slow, and passes the range that replaced it", () => {
    expect(check("SELECT item, term, tf FROM memory_terms WHERE term LIKE ? ESCAPE '\\'")).toEqual(["P1"]);
    expect(check("SELECT item, term, tf FROM memory_terms WHERE term >= ? AND term < ?")).toEqual([]);
  });

  test("reads a scan through its alias, and lets an allowed table, an index scan and FTS5 through", () => {
    expect(check("SELECT * FROM memory_terms m WHERE m.tf = ?")).toEqual(["P1"]);
    expect(check("SELECT * FROM memory_terms m WHERE m.tf = ?", { memory_terms: "a test says so" })).toEqual([]);
    expect(check("SELECT COUNT(*) FROM memory_terms")).toEqual([]);
    expect(check("SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts)")).toEqual([]);
  });

  test("P6 warns on a sort an index could provide — not on a score, or on groups", () => {
    expect(planFindings(["USE TEMP B-TREE FOR ORDER BY"], "SELECT * FROM memory_terms ORDER BY tf", tables, {})).toContainEqual(
      expect.objectContaining({ rule: "P6", severity: "warning" }),
    );
    expect(planFindings(["USE TEMP B-TREE FOR ORDER BY"], "SELECT term, COUNT(*) n FROM memory_terms GROUP BY term ORDER BY n", tables, {})).toEqual([]);
  });

  test("only statements that read are planned", () => {
    expect(reads("SELECT 1")).toBe(true);
    expect(reads("WITH RECURSIVE w(n) AS (SELECT 1) SELECT n FROM w")).toBe(true);
    expect(reads("INSERT INTO t (a) SELECT a FROM u")).toBe(true);
    expect(reads("INSERT INTO t (a) VALUES (?)")).toBe(false);
  });
});

describe("the floors", () => {
  test("a run that finds or plans too little fails rather than passing", () => {
    expect(floorFailure(10, 1_000)).toContain("extractor");
    expect(floorFailure(1_000, 10)).toContain("plans nothing");
    expect(floorFailure(1_000, 1_000)).toBeNull();
  });
});
