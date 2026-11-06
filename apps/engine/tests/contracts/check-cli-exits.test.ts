/**
 * `lint:cli`'s exit rule checks itself (`scripts/cli-exits.ts`, `lint-cli-exit-code-guard`): every shape 0.7.10 fixed
 * by hand is refused by line, every shape that is not one is let through, and a run that reads too few lines fails.
 *
 * About twenty paths printed their usage or a refusal and exited 0 — the `nouride` tool read "restart needs --then"
 * and "refusing a root unit" as successes — and each was fixed with a test of its own, while nothing stopped the next.
 * Run over the files as they stood before that fix, the rule names 25 places; each shape here is one of them.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { checkCliExits, cliExitFindings, MIN_SAYS } from "../../../../scripts/cli-exits.ts";

const ROOT = join(import.meta.dir, "../../../..");

/** The lines a planted command is told about. */
const flagged = (body: string) =>
  cliExitFindings("apps/engine/src/cli/commands/planted.ts", `export async function planted(client, args) {\n${body}\n}\n`).findings.map(
    (finding) => finding.line - 1,
  );

describe("this tree", () => {
  test("holds: no command says its usage as its whole answer, or a ✗, and exits 0", () => {
    const { says, findings } = checkCliExits(ROOT);
    expect(findings).toEqual([]);
    expect(says).toBeGreaterThanOrEqual(MIN_SAYS);
  });

  test("and the lint says so the way lint:check runs it", () => {
    const run = spawnSync("bun", ["run", "scripts/check-cli-help.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("is usage or a ✗ followed by exit 0");
    expect(run.status).toBe(0);
  }, 60_000);
});

describe("what is refused", () => {
  test("a call missing what it needs, answered with its usage — the shape of nearly every one 0.7.10 fixed", () => {
    expect(flagged('  const [action, name] = args;\n  if (!name) return say(`${DIM}nouride secret set <name> --stdin${RESET}`);')).toEqual([2]);
    expect(flagged('  if (!id) {\n    say(`${DIM}nouride cron update <id> [--name <name>]${RESET}`);\n    return;\n  }')).toEqual([2]);
    expect(flagged("  if (action === undefined) return say(USAGE);")).toEqual([1]);
    expect(flagged('  if (!wake) return say(wakeUpUsage("nouride restart", "nouride restart --then …"));')).toEqual([1]);
    expect(flagged('  if (!ref) return say("usage: nouride skills install <source>");')).toEqual([1]);
  });

  test("a blank line before it is not a listing, and neither is an earlier branch that returned", () => {
    expect(flagged('  if (!then) {\n    say();\n    return say(`${DIM}nouride update --start --then "<what>"${RESET}`);\n  }')).toEqual([3]);
    expect(flagged('  if (a) return say("listed");\n  if (!b) return say(`${DIM}nouride webhook add --name <name>${RESET}`);')).toEqual([2]);
  });

  test("a ✗ line with nothing after it that fails — a refusal read as a success", () => {
    expect(flagged("  say(`${RED}✗${RESET} refusing a root unit`);\n  return;")).toEqual([1]);
    expect(flagged("  if (!draft) return say(`${RED}✗${RESET} no such draft`);")).toEqual([1]);
    expect(flagged("  say(ok ? `${GREEN}✓${RESET} done` : `${RED}✗${RESET} failed`);")).toEqual([1]);
    expect(flagged("  say(`  ✗ ${problem}`);")).toEqual([1]);
  });
});

describe("what is let through", () => {
  test("a usage line after a listing: a footer, what to do next", () => {
    expect(flagged('  const { jobs } = await client.get("/jobs");\n  for (const job of jobs) say(job.id);\n  say(`${DIM}nouride jobs log <id>  ·  kill <id>${RESET}`);')).toEqual([]);
    expect(flagged('  say(`${BOLD}3 snapshot(s)${RESET}`);\n  if (more) {\n    return say(`${DIM}nouride db restore <file>${RESET}`);\n  }')).toEqual([]);
  });

  test("help given on purpose, which says so — emit({ help }) first, as --help does", () => {
    expect(flagged("  emit({ help: plain(USAGE) });\n  return say(USAGE);")).toEqual([]);
  });

  test("a heading is not usage: a command's name with no argument written the way usage writes one", () => {
    expect(flagged("  say(`${BOLD}nouride doctor${RESET}`);\n  say(`${BOLD}nouride chat${RESET} ${DIM}→ ${client.baseUrl}${RESET}`);")).toEqual([]);
  });

  test("a ✗ that the command then fails on, or sets the exit code for", () => {
    expect(flagged("  say(`${RED}✗${RESET} ${path}`);\n  fail(\"That database does not check out.\", verdict.detail);")).toEqual([]);
    expect(flagged("  say(`${RED}✗${RESET} ${answer.status}`);\n  process.exitCode = exitCodeFor(answer);\n  return;")).toEqual([]);
    expect(flagged("  if (bad) {\n    say(`${RED}✗${RESET} the database is on ${to}:`);\n    for (const line of lines) say(line);\n    fail(\"Rename the rest by hand.\");\n  }")).toEqual([]);
  });

  test("a ✗ marking one item of a list — a run that failed, a file that did not index — where the list is the answer", () => {
    expect(flagged("  for (const f of failed) say(`${RED}✗${RESET} ${f.episodeId}`);")).toEqual([]);
    expect(flagged("  refused.forEach((r) => say(`${RED}✗${RESET} ${r.name}: ${r.reason}`));")).toEqual([]);
    // Setting the code back to 0 is not failing.
    expect(flagged("  say(`${RED}✗${RESET} gone`);\n  process.exitCode = 0;")).toEqual([1]);
  });
});
