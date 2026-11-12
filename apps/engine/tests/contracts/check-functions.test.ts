/**
 * `lint:functions` checks itself: what counts as a named function and how long it is, the ratchet from both sides, and
 * the whole check over this tree with a record taken away or lowered.
 *
 * The size check held files and nothing held what was in them: the executor's `run` reached 535 lines inside a file
 * under its cap. A check that stopped finding functions would pass for ever, so each rule is pinned here rather than
 * trusted from the tree's own clean run.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFunctions, functionFindings, longFunctions } from "../../../../scripts/check-functions.ts";
import { LONG_FUNCTIONS } from "../../../../scripts/function-lengths.ts";

const ROOT = join(import.meta.dir, "../../../..");

/** `n` lines of code: one statement each. */
const body = (n: number) => Array.from({ length: n }, (_unused, i) => `  const v${i} = ${i};`).join("\n");
/** The names `text` holds over a cap of 3 lines of code, with their lengths. */
const long = (text: string, rel = "apps/engine/src/planted.ts") => longFunctions(rel, text, 3).map(({ name, lines }) => ({ name, lines }));

describe("this tree", () => {
  test("holds: every function over the cap is recorded, at its length, and every record is found", async () => {
    const { findings, long: found } = await checkFunctions(ROOT);
    expect(findings).toEqual([]);
    // The Pro code's records count where it is checked out: a public clone has the records and not the files.
    const present = Object.entries(LONG_FUNCTIONS).filter(([file]) => existsSync(join(ROOT, file)));
    expect(found).toBe(present.reduce((sum, [, names]) => sum + Object.keys(names).length, 0));
    expect(found).toBeGreaterThan(60);
    // A reading of the whole tree, as the two under "the whole check refuses" are.
  }, 30_000);

  test("and the lint says so the way lint:check runs it", () => {
    const run = spawnSync("bun", ["run", "scripts/check-functions.ts"], { cwd: ROOT, encoding: "utf8" });
    expect(run.stdout + run.stderr).toContain("no function over 150 lines of code but the");
    expect(run.status).toBe(0);
  }, 60_000);
});

describe("the whole check refuses", () => {
  test("a long function nobody recorded, by its file, line and name, with what to do", async () => {
    const { "apps/engine/src/index.ts": _taken, ...rest } = LONG_FUNCTIONS;
    const { findings } = await checkFunctions(ROOT, rest);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "apps/engine/src/index.ts", rule: "function-too-long" });
    expect(findings[0]!.line).toBeGreaterThan(0);
    expect(findings[0]!.detail).toContain("`runDaemon` is ");
    expect(findings[0]!.detail).toContain("over the 150 cap. Split it on a seam");
    expect(findings[0]!.detail).toContain("record it in `LONG_FUNCTIONS`");
    // A reading of the whole tree: past the default five seconds on a busy machine, where this and the next failed.
  }, 30_000);

  test("a recorded one past its record, and a record for a file that is gone", async () => {
    const recorded = LONG_FUNCTIONS["apps/engine/src/index.ts"]!.runDaemon!;
    const { findings } = await checkFunctions(ROOT, {
      ...LONG_FUNCTIONS,
      "apps/engine/src/index.ts": { runDaemon: { ...recorded, lines: recorded.lines - 1 } },
      "apps/engine/src/gone.ts": { gone: { lines: 200, why: "planted" } },
    });
    expect(findings.map(({ file, rule }) => ({ file, rule }))).toEqual([
      { file: "apps/engine/src/index.ts", rule: "function-grew" },
      { file: "apps/engine/src/gone.ts", rule: "stale-record" },
    ]);
  }, 30_000);

  test("but not the Pro code's records in a public clone, where the submodule is not checked out", async () => {
    const root = mkdtempSync(join(tmpdir(), "nouride-functions-"));
    try {
      mkdirSync(join(root, "apps/engine/src"), { recursive: true });
      writeFileSync(join(root, "apps/engine/src/short.ts"), "export const one = 1;\n");
      const records = { "internals/pro/packages/x/src/index.ts": { make: { lines: 200, why: "planted" } }, "apps/engine/src/gone.ts": { gone: { lines: 200, why: "planted" } } };
      expect((await checkFunctions(root, records)).findings.map(({ file, rule }) => ({ file, rule }))).toEqual([
        { file: "apps/engine/src/gone.ts", rule: "stale-record" },
      ]);
      // Checked out, the same record is one whose file is gone.
      mkdirSync(join(root, "internals/pro"), { recursive: true });
      writeFileSync(join(root, "internals/pro/package.json"), "{}\n");
      expect((await checkFunctions(root, records)).findings.map(({ rule }) => rule)).toEqual(["stale-record", "stale-record"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("what is a named function", () => {
  test("a declaration, a method, a constructor, an accessor, and an arrow or function expression something names", () => {
    const text = [
      `function declared() {\n${body(4)}\n}`,
      `class Box {\n  constructor() {\n${body(4)}\n  }\n  method() {\n${body(4)}\n  }\n  get size() {\n${body(4)}\n    return 1;\n  }\n  field = () => {\n${body(4)}\n  };\n}`,
      `const arrow = async () => {\n${body(4)}\n};`,
      `const expression = function () {\n${body(4)}\n};`,
      `const wrapped = (() => {\n${body(4)}\n}) as () => void;`,
      `const object = {\n  key: () => {\n${body(4)}\n  },\n  shorthand() {\n${body(4)}\n  },\n};`,
      `export default function () {\n${body(4)}\n}`,
    ].join("\n");
    expect(long(text).map((fn) => fn.name)).toEqual([
      "declared",
      "Box.constructor",
      "Box.method",
      "Box.size",
      "Box.field",
      "arrow",
      "expression",
      "wrapped",
      "key",
      "shorthand",
      "default",
    ]);
  });

  test("a callback handed to a call is its caller's, not a function of its own", () => {
    expect(long(`test("a case", () => {\n${body(10)}\n});\nroutes.post("/x", async (c) => {\n${body(10)}\n});`)).toEqual([]);
    expect(long(`function caller() {\n  run(() => {\n${body(10)}\n  });\n}`)).toEqual([{ name: "caller", lines: 14 }]);
  });

  test("one inside another is named after it, and two of one name in a file are told apart by their order", () => {
    const text = `function outer() {\n  function inner() {\n${body(4)}\n  }\n}\ndescribe("a", () => {\n  function helper() {\n${body(4)}\n  }\n});\ndescribe("b", () => {\n  function helper() {\n${body(4)}\n  }\n});`;
    expect(long(text).map((fn) => fn.name)).toEqual(["outer", "outer.inner", "helper", "helper#2"]);
  });

  test("its length is its lines of code: a comment or a blank line costs nothing, a multi-line string every line", () => {
    const commented = `function documented() {\n  // why the first line is here\n  /**\n   * and a block\n   */\n\n  const a = 1;\n\n  return a;\n}`;
    expect(long(commented)).toEqual([{ name: "documented", lines: 4 }]);
    expect(longFunctions("x.ts", commented, 4)).toEqual([]);
    const template = "function prompt() {\n  return `one\ntwo\nthree`;\n}";
    expect(long(template)).toEqual([{ name: "prompt", lines: 5 }]);
  });

  test("a component in a .tsx file, its markup counted as code", () => {
    const tsx = `export function Page() {\n  return (\n    <div>\n      <p>one</p>\n      {/* a note */}\n      <p>two</p>\n    </div>\n  );\n}`;
    expect(longFunctions("apps/dashboard/src/page.tsx", tsx, 3).map(({ name, lines }) => ({ name, lines }))).toEqual([{ name: "Page", lines: 9 }]);
  });
});

describe("the ratchet, both ways", () => {
  const at = (lines: number) => [{ name: "run", line: 10, lines }];
  const record = (lines: number, why = "the loop over one state") => ({ run: { lines, why } });
  const rules = (found: ReturnType<typeof at> | [], records?: Record<string, { lines: number; why: string }>) =>
    functionFindings("a.ts", found, records).map((finding) => finding.rule);

  test("unrecorded, a function over the cap is refused", () => {
    expect(rules(at(151))).toEqual(["function-too-long"]);
    expect(functionFindings("a.ts", at(151))[0]).toMatchObject({ file: "a.ts", line: 10 });
  });

  test("recorded, it may not grow; it may shrink a few lines, and past that its record is lowered", () => {
    expect(rules(at(200), record(200))).toEqual([]);
    expect(rules(at(201), record(200))).toEqual(["function-grew"]);
    expect(rules(at(195), record(200))).toEqual([]);
    expect(rules(at(194), record(200))).toEqual(["record-slack"]);
    expect(functionFindings("a.ts", at(194), record(200))[0]!.detail).toContain("lower it to 194");
  });

  test("a record whose function is back under the cap, or gone, leaves the list", () => {
    expect(rules([], record(200))).toEqual(["record-under-cap"]);
  });

  test("a record's reason is one, at most 200 characters", () => {
    expect(rules(at(200), record(200, "x".repeat(200)))).toEqual([]);
    expect(rules(at(200), record(200, "x".repeat(201)))).toEqual(["record-why"]);
    expect(rules(at(200), record(200, ""))).toEqual(["record-why"]);
  });
});
