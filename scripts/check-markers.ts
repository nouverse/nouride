#!/usr/bin/env bun
/**
 * History in comments, counted per file, and growth refused: the way `check-size.ts` holds `any`.
 *
 * A comment says why the code is as it is. When it says instead which release a line came in, the day, who asked, or
 * the id of a plan or review kept in a private document, it ages into something no reader can follow: `(G11)` stood in
 * fifty-six comments of published code and meant nothing outside an archive, and git already says when and by whom.
 *
 * Four kinds of marker, each counted in the comments of every source file under `apps/` and `packages/` (`comments.ts`
 * reads them; a string a person or a model reads is not a comment and is never counted). Each file's counts are
 * recorded in `comment-markers.json`; a file may lose markers and may not gain them. A plan id and a person's name are
 * allowed nowhere, whatever a record says: the comment says the reason the id pointed at, or what was decided rather
 * than who decided it. Versions and dates may stay where they are, counted.
 *
 * `--write` records the counts as they are, only downward: it writes nothing while any file is over its record. A
 * raise is an edit of the table by hand, which a reviewer sees.
 */

import { relative } from "node:path";
import { comments } from "./comments.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const TABLE = new URL("./comment-markers.json", import.meta.url).pathname;

/**
 * Agent names that were written in comments as the people who reviewed, tested or reported something. In a story of
 * what the product did (an agent tagged another, a bot posted a reply) an agent's name is the product's and is not
 * counted; as the source of a finding it is a person's.
 */
const AGENTS = "(?:Nox|Nix|Nexa|Nestor|Nouva|Kuro|Nero)";

/**
 * Tokens shaped like a plan id that are something else: file formats, an algorithm, a ranking, an engine, and the
 * memory tags' rules R1 to R5 (`memory/tags.ts`). A `lint:sql` rule (S5, P1) is public, named in
 * `scripts/check-sql.ts`, when the comment names the lint before it.
 */
const NOT_PLAN_IDS = "(?:MP3|MP4|ID3|BM25|S256|V8|R[1-5])";

/** A section sign after a document's name, on the same line or at the start of the comment's next. */
const SECTION = "(?: |\\s*\\n\\s*(?:\\*|//)\\s*)§";

/** The documents of `docs/`, published with the code: cited by a section, they are a pointer, not a private plan. */
const PUBLIC_DOCS = "(?:ARCHITECTURE|SPEC|CONTRIBUTING|TECH_DECISION|CLI|EVENTS|DASHBOARD|DEPLOY|README|SYSTEM_REQUIREMENTS|CLA)";

export const MARKERS = {
  /** A release, `0.8.12` or `0.8.x`: when a line was written, which git says better. */
  version: /(?<![\w.@/-])v?0\.\d{1,2}\.(?:\d{1,2}|x)(?![\w.]*\d)/g,
  /** A day, `2026-11-03`. */
  date: /\b20\d\d-[01]\d-[0-3]\d\b/g,
  /**
   * An id of a plan, a review or an audit finding, or the name of the private document that holds it: `G11`, `(D8)`,
   * `REVIEW B2`, `HARDENING §8`, `RFC_SIDE_QUESTIONS`, `PLAN §3.3`, `SIMPLIFY RFC §1`, `(config-restart-ux)`. A
   * document of `docs/` cited by its section (`ARCHITECTURE.md §3`) is one every reader has, and is not counted.
   */
  plan: new RegExp(
    [
      `(?<![\\w+\\-#.])(?<!lint:sql\`? )(?!${NOT_PLAN_IDS}(?![\\w+]))[A-Z]{1,2}\\d{1,3}(?![\\w+])`,
      "\\b(?:REVIEW|HARDENING|SHAPE_INVENTORY|HARDWARE_PENDING|CARRY_OVER_FROM_[\\w.]+|PLAN_TO_1\\.0|RFC_[A-Z_]*[A-Z]|v0\\.\\d+\\.[\\w.]*_RFC)\\b",
      `\\b(?!${PUBLIC_DOCS}(?:\\.md)?${SECTION})[A-Z][A-Z0-9_]{2,}(?:\\.md)?${SECTION}`,
      "\\b[A-Z][A-Z0-9_]{3,} RFC\\b",
      "\\(`?(?:[a-z][a-z0-9]*-){2,}[a-z0-9]+`?\\)",
    ].join("|"),
    "g",
  ),
  /**
   * A person who works on Nouride, or an agent cited as one: the owner as the one who asked, said or decided (not the
   * owner of a box, a connection or an install, which are the product's words), a name, an agent's review.
   */
  name: new RegExp(
    [
      "\\b[Gg]ading\\b",
      "\\(the owner\\b(?! of\\b)",
      "[,;—] the owner(?=[,):;])",
      "\\b[Tt]he owner(?:['’]s)?:",
      "\\b[Tt]he owner['’]s (?:words?|call|ask|asks|answers?|decision|rule|design|line|iPhone|screenshot|phone|group|bubble|legal|own|D\\d+)\\b",
      "\\b[Tt]he owner (?:asked|said|says|wanted|found|read|saw|pressed|decided|chose|was offered|could not|had to|took|edited|expected|moved|set|put it|kept|liked|picked|opened|turned|tried|noticed|reported|approved|answered|wrote)\\b",
      "\\b(?:by|to|from) the owner\\b(?! of\\b)",
      "\\bowner['’]s word\\b",
      `\\b${AGENTS}['’]s (?:(?:first|second|third|fourth|fifth|sixth|seventh|last) )?review\\b`,
      `\\((?:live, )?${AGENTS}(?=[,;)])`,
      `[;,] ${AGENTS}(?=, 20\\d\\d-)`,
    ].join("|"),
    "g",
  ),
} as const;

export type MarkerKind = keyof typeof MARKERS;
type Counts = Partial<Record<MarkerKind, number>>;

/** What to write instead, by kind. */
const WHY: Record<MarkerKind, string> = {
  version: "a comment says why, and git says when",
  date: "a comment says why, and git says when",
  plan: "an id in a document a reader has not got tells them nothing: say the reason it pointed at",
  name: "who asked is history git keeps: say what was decided and why",
};

/** Kinds no file may hold: none is recorded, so the first one is growth. */
const NONE_ALLOWED: readonly MarkerKind[] = ["plan", "name"];

/** How many of each kind the comments of `source` hold. */
export function markerCounts(source: string, jsx: boolean): Counts {
  const counts: Counts = {};
  for (const comment of comments(source, jsx)) {
    for (const kind of Object.keys(MARKERS) as MarkerKind[]) {
      const found = comment.text.match(MARKERS[kind])?.length ?? 0;
      if (found > 0) counts[kind] = (counts[kind] ?? 0) + found;
    }
  }
  return counts;
}

export interface MarkerFinding {
  file: string;
  rule: "markers-grew" | "record-stale";
  detail: string;
}

/** What a file's counts say against its record, if anything — both directions, as the size ratchet turns. */
export function markerFindings(file: string, counts: Counts, recorded: Counts | undefined): MarkerFinding[] {
  const findings: MarkerFinding[] = [];
  for (const kind of Object.keys(MARKERS) as MarkerKind[]) {
    const has = counts[kind] ?? 0;
    const allowed = NONE_ALLOWED.includes(kind) ? 0 : (recorded?.[kind] ?? 0);
    if (has > allowed) {
      const why = WHY[kind];
      const raise = NONE_ALLOWED.includes(kind) ? "" : `, or raise its record in \`scripts/comment-markers.json\` by hand`;
      findings.push({ file, rule: "markers-grew", detail: `${has} ${kind} marker(s) in comments, recorded ${allowed}: ${why}${raise}` });
    } else if (has < allowed) {
      findings.push({ file, rule: "record-stale", detail: `${has} ${kind} marker(s), recorded ${allowed} — run \`bun run scripts/check-markers.ts --write\`, or it may grow back` });
    }
  }
  return findings;
}

/** Every source file whose comments are counted: the published code, `apps/` and `packages/`, its tests included. */
async function countedFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob("{apps,packages}/**/*.{ts,tsx}").scan({ cwd: ROOT, absolute: true })) {
    if (path.includes("/node_modules/") || path.endsWith(".gen.ts") || path.includes("routeTree")) continue;
    files.push(relative(ROOT, path));
  }
  return files.sort();
}

/** The table as written: one line a file, its kinds in a fixed order, so a change is one line of a diff. */
function serialize(table: Record<string, Counts>): string {
  const kinds = Object.keys(MARKERS) as MarkerKind[];
  const lines = Object.keys(table)
    .sort()
    .map((file) => {
      const counts = kinds.filter((kind) => table[file]![kind]).map((kind) => `"${kind}": ${table[file]![kind]}`);
      return `  ${JSON.stringify(file)}: { ${counts.join(", ")} }`;
    });
  return `{\n${lines.join(",\n")}\n}\n`;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  // No table yet: the first `--write` records the tree as it is, and a check has nothing to hold it to.
  const first = !(await Bun.file(TABLE).exists());
  if (first && !write) {
    console.error("✗ no record of the markers yet — run `bun run scripts/check-markers.ts --write`");
    process.exit(1);
  }
  const recorded = first ? {} : (JSON.parse(await Bun.file(TABLE).text()) as Record<string, Counts>);
  const current: Record<string, Counts> = {};
  const findings: MarkerFinding[] = [];

  const files = await countedFiles();
  for (const file of files) {
    const counts = markerCounts(await Bun.file(`${ROOT}${file}`).text(), file.endsWith(".tsx"));
    if (Object.keys(counts).length > 0) current[file] = counts;
    findings.push(...markerFindings(file, counts, recorded[file]));
  }
  const seen = new Set(files);
  for (const [file, counts] of Object.entries(recorded)) {
    if (!seen.has(file)) findings.push({ file, rule: "record-stale", detail: "recorded and no longer exists — run `bun run scripts/check-markers.ts --write`" });
    for (const kind of NONE_ALLOWED.filter((none) => counts[none])) {
      findings.push({ file, rule: "record-stale", detail: `a ${kind} marker is never recorded, as none is allowed — run \`bun run scripts/check-markers.ts --write\`` });
    }
  }

  const grew = findings.filter((finding) => finding.rule === "markers-grew");
  if (write) {
    if (grew.length > 0 && !first) {
      console.error(`✗ not written: ${grew.length} file(s) over their record — a raise is an edit of the table by hand`);
      for (const finding of grew) console.error(`  ${finding.file}  ${finding.detail}`);
      process.exit(1);
    }
    await Bun.write(TABLE, serialize(current));
    console.log(`✓ recorded ${Object.keys(current).length} file(s)`);
    return;
  }

  if (findings.length === 0) {
    console.log("✓ no comment gained a version, a date, a plan id or a name");
    return;
  }
  console.error(`✗ ${findings.length} finding(s):\n`);
  for (const finding of findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))) {
    console.error(`  ${finding.file}  [${finding.rule}]`);
    console.error(`    ${finding.detail}\n`);
  }
  process.exit(1);
}

if (import.meta.main) await main();
