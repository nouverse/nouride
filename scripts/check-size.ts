#!/usr/bin/env bun
/**
 * Two things nothing else in this repo was watching: `any`, and files that keep growing.
 *
 * Both were found by someone reading the code rather than by a check, which is the argument for the
 * check. `tsc` cannot help with either: `noImplicitAny` is already on and says nothing about an
 * `any` somebody wrote on purpose, and no compiler has an opinion about file length.
 *
 * ## Why lines of *code*, not lines of file
 *
 * Because this repo's house style is dense documentation, and a total-line rule would punish exactly
 * the files that explain themselves best. Measured: the median source file is 84 code lines, and the
 * longest ones are long for two different reasons — `hardline.ts` is 1230 lines and 569 of code,
 * while `dashboard/lib/api.ts` is 1302 and 854. One is a documented classifier; the other is a god
 * file. A rule that cannot tell them apart is a rule that gets switched off.
 *
 * ## Why a ratchet instead of a threshold
 *
 * A plain cap would have failed on fifteen files the day it was added, which means it would have been
 * committed with the cap set above all of them — a rule that permits everything present and calls
 * that a standard. Instead each oversized file is recorded at the size it is now: it may shrink, it
 * may not grow, and anything not listed has to stay under the cap. Existing debt is named, cannot get
 * worse, and a new god file is refused outright.
 */

import { relative } from "node:path";
import { lintedFiles } from "./lint-sources.ts";
import { ANY_BUDGET, BUDGET, TEST_BUDGET } from "./size-budgets.ts";

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * Code lines a source file may reach without being listed below.
 *
 * Set at 400 against a median of 84 and a p90 of 287 — high enough that no ordinary module is near
 * it, low enough that reaching it is a real signal. This is not a target; it is the point at which
 * somebody has to make a decision and write it down.
 */
const MAX_CODE_LINES = 400;

/** How far over its file a budget may sit — a few lines for the next small change, not room to grow back into. */
const HEADROOM = 10;

/**
 * Tests have a cap of their own, and the files over it a budget. They used to be exempt, and six grew past a thousand
 * lines — `pipeline.test.ts` past five thousand, with fifteen hand-built Pipeline harnesses among them. A test file
 * that size is one nobody reads before adding to it; new cases go in a file of their own.
 */
const MAX_TEST_CODE_LINES = 1_000;

/**
 * `any` in a type position, however it is spelled.
 *
 * `Promise<any>`, `: any`, `as any`, `any[]`. Not `unknown` — that is the honest version and the
 * whole point of having somewhere to move to.
 */
const EXPLICIT_ANY = /(?::\s*any\b|<\s*any\s*>|\bas\s+any\b|\bany\[\]|<any\[\]>)/g;

/**
 * Every file this check sizes: the linted source (`lint-sources.ts`), and the root `scripts/` — the lints, the build
 * and the release tooling, which the other lints do not read as source and this one skipped with them. `check-sql.ts`
 * had reached 481 code lines unseen.
 */
export async function sizedFiles(root: string): Promise<string[]> {
  const scripts: string[] = [];
  for await (const path of new Bun.Glob("scripts/**/*.{ts,tsx}").scan({ cwd: root, absolute: true })) scripts.push(path);
  return [...(await lintedFiles(root, ["ts", "tsx"])), ...scripts.sort()];
}

/** A file nobody wrote by hand, or one whose job is to be a test fixture. */
function isGenerated(rel: string): boolean {
  return rel.endsWith(".gen.ts") || rel.includes("routeTree");
}

function isTest(rel: string): boolean {
  return rel.includes("/tests/") || rel.endsWith(".test.ts") || rel.endsWith(".test.tsx");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);
}

/**
 * Blank out string contents, keeping the quotes and every newline.
 *
 * Needed for the `any` scan and not for the size one: the first version reported a prompt line that
 * reads "Beyond it: any host you have an ssh entry for" — the model's own instructions, matched on
 * `: any`. Same lesson `check-sql.ts` learned the hard way, in the other direction: a rule that reads
 * source has to know what part of the source it is reading.
 */
function stripStrings(source: string): string {
  return source.replace(
    /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/**
 * What a file's size says against its cap and its budget, if anything — both directions of the ratchet. Exported for
 * the test that holds each.
 */
export function sizeFinding(
  code: number,
  cap: number,
  budget: number | undefined,
  table = "BUDGET",
): { rule: "file-too-large" | "file-grew" | "budget-under-cap" | "budget-slack"; detail: string } | null {
  if (budget === undefined) {
    if (code <= cap) return null;
    return {
      rule: "file-too-large",
      detail: `${code} lines of code, over the ${cap} cap. Split it on a seam, or add it to \`${table}\` in this script with the reason it stays whole`,
    };
  }
  if (code > budget) {
    return {
      rule: "file-grew",
      detail: `${code} lines of code, over its budget of ${budget}. Split it, or raise the budget in \`${table}\` and say in its \`why\` what the lines are and why they belong here`,
    };
  }
  if (code <= cap) return { rule: "budget-under-cap", detail: `${code} lines of code, under the ${cap} cap — remove its entry from \`${table}\`, or it may grow back to ${budget}` };
  if (budget - code > HEADROOM) return { rule: "budget-slack", detail: `${code} lines of code against a budget of ${budget} — lower it to ${code}, or it may grow back unseen` };
  return null;
}

async function main(): Promise<void> {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const sizes = new Map<string, number>();

  // `internals/pro` included when it is checked out, and held to the same cap: it ships in the Box editions. It
  // used to be skipped here as "another repository with rules of its own", and it had none — see `lint-sources.ts`.
  // The root `scripts/` too (`sizedFiles`).
  for (const path of await sizedFiles(ROOT)) {
    const rel = relative(ROOT, path);
    if (isGenerated(rel)) continue;

    const raw = await Bun.file(path).text();
    const source = stripComments(raw);
    seen.add(rel);

    // ── `any` ───────────────────────────────────────────────────────────────
    //
    // Tests included, deliberately, and this is the one place tests are not exempt: a fake typed
    // `any` is a fake that cannot disagree with the thing it stands in for, which is how a test
    // starts agreeing with the bug. The `{ id: string }` approval fixture did exactly that.
    const anys = [...stripStrings(source).matchAll(EXPLICIT_ANY)];
    const allowed = ANY_BUDGET[rel] ?? 0;
    if (anys.length > allowed) {
      // Reported per occurrence past the budget, newest first, so a file at its limit names the line
      // that pushed it over rather than all of them.
      for (const match of anys.slice(allowed)) {
        findings.push({
          file: rel,
          line: source.slice(0, match.index).split("\n").length,
          rule: "explicit-any",
          detail:
            "`any` disables checking rather than describing anything — use `unknown` and narrow, or a " +
            "generic parameter so the caller says what it expects (see `cli/client.ts` and `cli/wire.ts`)" +
            (allowed > 0 ? `. This file is budgeted ${allowed} and has ${anys.length}` : ""),
        });
      }
    }

    // ── size ────────────────────────────────────────────────────────────────
    const code = source.split("\n").filter((line) => line.trim().length > 0).length;
    const [cap, budgets, table] = isTest(rel) ? [MAX_TEST_CODE_LINES, TEST_BUDGET, "TEST_BUDGET"] : [MAX_CODE_LINES, BUDGET, "BUDGET"];
    sizes.set(rel, code);
    const finding = sizeFinding(code, cap, budgets[rel]?.lines, table);
    if (finding) findings.push({ file: rel, line: finding.rule === "file-too-large" || finding.rule === "file-grew" ? 1 : 0, ...finding });
  }

  // A budget for a file that is gone is a licence nothing needs.
  for (const [rel, { lines }] of [...Object.entries(BUDGET), ...Object.entries(TEST_BUDGET)]) {
    if (!seen.has(rel)) {
      findings.push({ file: rel, line: 0, rule: "stale-budget", detail: `listed at ${lines} lines and no longer exists — remove the entry` });
    }
  }
  for (const rel of Object.keys(ANY_BUDGET)) {
    if (!seen.has(rel)) {
      findings.push({
        file: rel,
        line: 0,
        rule: "stale-budget",
        detail: "listed in `ANY_BUDGET` and no longer exists — remove the entry",
      });
    }
  }

  if (findings.length === 0) {
    console.log("✓ no explicit `any`, no file over its budget");
    return;
  }

  console.error(`✗ ${findings.length} finding(s):\n`);
  for (const f of findings.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file))) {
    console.error(`  ${f.file}${f.line > 0 ? `:${f.line}` : ""}  [${f.rule}]`);
    console.error(`    ${f.detail}\n`);
  }
  process.exit(1);
}

if (import.meta.main) await main();
