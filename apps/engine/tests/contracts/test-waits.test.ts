/**
 * How a test waits: one helper per workspace member, the same everywhere, and fixed sleeps that do not grow.
 *
 * `sleep` and `until` were written again in about fifteen test files, each a little different — one returned false
 * on a timeout and let the next `expect` explain, one threw, one polled every millisecond — and a dozen more slept a
 * fixed time and then asserted, which is a bet on how late a timer fires that a busy machine loses. A package's tests
 * cannot import the engine's helpers (each member imports what its own manifest declares), so each member that waits
 * has `tests/wait.ts`, and every copy is the engine's.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const CANONICAL = "apps/engine/tests/wait.ts";

/** A promise that only a timer settles — a sleep, however it is spelled. */
const SLEEP_PROMISE = /new Promise(?:<[^>]*>)?\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*setTimeout\(\s*\1\b/;
/** A wait helper declared in a test file instead of imported. */
const WAIT_DECLARED = /(?:async\s+)?function\s+(sleep|until|waitFor|eventually)\b|(?:const|let)\s+(?:sleep\s*=|(?:until|waitFor|eventually)\s*=\s*async\b)/;
/** A fixed sleep: `sleep(` itself, not `noSleep(` or a property named so. */
const SLEEP_CALL = /(?<![\w.])sleep\(/g;

/**
 * Fixed sleeps each member's tests hold, at most. Most of them say a thing did *not* happen, which no condition can
 * show, or pace a fake to make a race. A new one that waits for something to happen should be `eventually`; one that
 * cannot be is a reason to raise this number in the same change, with the reason beside the sleep.
 */
const FIXED_SLEEPS: Record<string, number> = {
  // 195 → 199 for an ask that moves to the background (0.7.19, `background-asks.test.ts`): two pace a fake past the ask's
  // wait, which is the race under test, and two show a thing did not happen — a wake-up before the turn in progress
  // ended, and the asking turn's abort reaching the job. 199 → 201 for the doubling nudges (0.7.25): a step held past a
  // reply's first nudge, which is elapsed time and nothing else (`budget-nudges.test.ts`), and a stopped watch shown not
  // to fire again (`budget-watch.test.ts`). 201 → 203 for memory's one write path (0.8.0, `memory/write.test.ts`): a
  // write shown not to happen while another writer holds the file's lock, and compaction's archive copy shown not made.
  // 204 → 211 for the bubble's line while a model works after its steps (0.8.7, `chat-progress.test.ts`,
  // `quiet-after-steps.test.ts`): five show no line drawn in a tick's time, one holds a fake provider past a few ticks,
  // and the fake CLI's `script` mode keeps the pace it is given between its updates. 211 → 212 for a tool that never
  // stops (`stuck-tool.test.ts`): a deadline on a turn that, broken, hangs rather than fails. 212 → 213 for a provider's
  // promised retry across a restart (`provider-resume.test.ts`): the third process shown not to take the turn up again.
  // 213 → 215 for a helper in the foreground that moves after the wait (`waited-helpers.test.ts`): two pace a fake past
  // the wait, the race under test, in a call whose move is refused and in a scheduled turn's, where nothing may move.
  "apps/engine": 215,
  "apps/dashboard": 37,
  "packages/gateways": 11,
  "packages/llm": 2,
  // 0 → 1 (0.8.1, `acp.test.ts`): a refusal written to a peer already gone shown not to reject unhandled.
  "packages/acp": 1,
  "packages/queue": 8,
  // Each about time: a stream paced to lose a race, a prompt's turn, a deadline for a hang, an idle timeout outlasted.
  "packages/runtime": 4,
  "packages/shared": 5,
  "packages/update": 4,
};

function members(): string[] {
  const out: string[] = [];
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      if (existsSync(join(ROOT, group, name, "tests"))) out.push(`${group}/${name}`);
    }
  }
  return out;
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/**
 * Source with its string literals emptied: a script a test writes for a child process is not the test waiting, and
 * neither is an example in a string — this file's own, for one.
 */
const stripped = (source: string): string =>
  source.replace(/`(?:\\.|[^`\\])*`/g, "``").replace(/"(?:\\.|[^"\\\n])*"/g, '""').replace(/'(?:\\.|[^'\\\n])*'/g, "''");
const code = (path: string): string => stripped(readFileSync(path, "utf8"));

describe("waiting in a test", () => {
  test("every member's tests/wait.ts is the engine's, byte for byte", () => {
    const canonical = readFileSync(join(ROOT, CANONICAL), "utf8");
    const copies = members().map((member) => `${member}/tests/wait.ts`).filter((path) => existsSync(join(ROOT, path)));
    expect(copies.length).toBeGreaterThan(1);
    expect(copies.filter((path) => readFileSync(join(ROOT, path), "utf8") !== canonical)).toEqual([]);
  });

  test("no test file declares its own sleep or poll — it imports its member's", () => {
    const found: string[] = [];
    for (const member of members()) {
      for (const path of testFiles(join(ROOT, member, "tests"))) {
        if (path.endsWith("/wait.ts")) continue;
        const source = code(path);
        const rel = relative(ROOT, path);
        if (SLEEP_PROMISE.test(source)) found.push(`${rel}: a promise only a timer settles — use \`sleep\` from tests/wait.ts`);
        const declared = WAIT_DECLARED.exec(source);
        if (declared) found.push(`${rel}: declares \`${declared[0]}\` — import \`eventually\` or \`sleep\` from tests/wait.ts`);
      }
    }
    expect(found).toEqual([]);
  });

  test("fixed sleeps do not grow: a new wait for something to happen is `eventually`", () => {
    const counts: Record<string, number> = {};
    for (const member of members()) {
      let count = 0;
      for (const path of testFiles(join(ROOT, member, "tests"))) {
        if (!path.endsWith("/wait.ts")) count += code(path).match(SLEEP_CALL)?.length ?? 0;
      }
      if (count > 0) counts[member] = count;
    }
    const over = Object.entries(counts)
      .filter(([member, count]) => count > (FIXED_SLEEPS[member] ?? 0))
      .map(([member, count]) => `${member}: ${count} fixed sleeps, at most ${FIXED_SLEEPS[member] ?? 0}`);
    expect(over).toEqual([]);
  });

  test("the checks see what they refuse", () => {
    expect(SLEEP_PROMISE.test("await new Promise((r) => setTimeout(r, 50));")).toBe(true);
    expect(SLEEP_PROMISE.test("new Promise<void>((resolve) => setTimeout(resolve, ms))")).toBe(true);
    expect(SLEEP_PROMISE.test('new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 300))')).toBe(false);
    expect(WAIT_DECLARED.test("async function until(check: () => boolean, ms: number)")).toBe(true);
    expect(WAIT_DECLARED.test("const sleep = (ms: number) => sleep(ms);")).toBe(true);
    expect(WAIT_DECLARED.test("const waitFor = async (done: () => boolean) => {")).toBe(true);
    // A simulated clock's `until` is not a wait.
    expect(WAIT_DECLARED.test("const until = (minutes: number) => {")).toBe(false);
    expect("await sleep(5); noSleep(); x.sleep(1)".match(SLEEP_CALL)?.length).toBe(1);
    expect(stripped("const script = `await new Promise((r) => setTimeout(r, 2000));`;")).not.toMatch(SLEEP_PROMISE);
  });
});
