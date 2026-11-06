/**
 * `lint:deadcode`'s export rule, by what it resolves rather than what it reads as a word.
 *
 * It used to call an export used when any other file held its name: so a test kept production code alive, a barrel's
 * own `export { x } from` line counted as a caller (and barrels were exempt besides), and the dashboard's `PLATFORMS`
 * was used because the engine has two private constants of that name. Each case below is one of those, planted.
 */

import { describe, expect, test } from "bun:test";
import { barrelVerdict, TEST_ONLY_EXPORTS } from "../../../../scripts/check-deadcode.ts";
import { graph, resolvesToValue, type GraphInput } from "../../../../scripts/export-graph.ts";

const LLM = "packages/llm/src/index.ts";

function input(files: Record<string, string>): GraphInput {
  return { files: new Map(Object.entries(files)), packages: new Map([["@nouride/llm", LLM]]) };
}

/** `file#name` → who uses it, as `production` and `tests` lists. */
function usesOf(files: Record<string, string>) {
  const { values, reexports } = graph(input(files));
  const flat = (map: typeof values) =>
    Object.fromEntries([...map].flatMap(([file, names]) => [...names].map(([name, use]) => [`${file}#${name}`, { production: [...use.production], tests: [...use.tests] }])));
  return { values: flat(values), reexports: flat(reexports) };
}

describe("an export's users", () => {
  test("a namesake in another file is not one — the dashboard's PLATFORMS and the engine's own", () => {
    const { values } = usesOf({
      "apps/dashboard/src/GatewayList.tsx": "export const PLATFORMS = [1];\nexport const used = PLATFORMS;",
      "apps/engine/src/people/match.ts": "const PLATFORMS = [2];\nexport const x = PLATFORMS;",
    });
    expect(values["apps/dashboard/src/GatewayList.tsx#PLATFORMS"]).toEqual({ production: [], tests: [] });
  });

  test("a test is counted apart, so an export only a test imports is seen to be one", () => {
    const { values } = usesOf({
      "apps/engine/src/tools/approval.ts": "export class AutoApprovalGate {}",
      "apps/engine/tests/a.test.ts": 'import { AutoApprovalGate } from "@/tools/approval.ts";',
    });
    expect(values["apps/engine/src/tools/approval.ts#AutoApprovalGate"]).toEqual({ production: [], tests: ["apps/engine/tests/a.test.ts"] });
  });

  test("a barrel passes a use through to the file that defines it, and its own re-export is not one", () => {
    const files = {
      "packages/llm/src/skills.ts": "export function loadSkills() {}\nexport function other() {}",
      [LLM]: 'export { loadSkills, other } from "./skills.ts";\nexport * from "./tokens.ts";',
      "packages/llm/src/tokens.ts": "export const estimate = 1;",
      "apps/engine/src/use.ts": 'import { other, estimate } from "@nouride/llm";',
    };
    const { values, reexports } = usesOf(files);
    expect(values["packages/llm/src/skills.ts#loadSkills"]).toEqual({ production: [], tests: [] });
    expect(reexports[`${LLM}#loadSkills`]).toEqual({ production: [], tests: [] });
    expect(values["packages/llm/src/skills.ts#other"]!.production).toEqual(["apps/engine/src/use.ts"]);
    expect(reexports[`${LLM}#other`]!.production).toEqual(["apps/engine/src/use.ts"]);
    // Through `export *` too.
    expect(values["packages/llm/src/tokens.ts#estimate"]!.production).toEqual(["apps/engine/src/use.ts"]);
  });

  test("a namespace import uses what it reads, a dynamic one what it destructures — or all of it, kept whole", () => {
    const { values } = usesOf({
      "apps/engine/src/m.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;",
      "apps/engine/src/ns.ts": 'import * as m from "./m.ts";\nconsole.log(m.a);',
      "apps/engine/src/dyn.ts": 'const { b } = await import("./m.ts");',
    });
    expect(values["apps/engine/src/m.ts#a"]!.production).toEqual(["apps/engine/src/ns.ts"]);
    expect(values["apps/engine/src/m.ts#b"]!.production).toEqual(["apps/engine/src/dyn.ts"]);
    expect(values["apps/engine/src/m.ts#c"]!.production).toEqual([]);
    const whole = usesOf({ "apps/engine/src/m.ts": "export const c = 3;", "apps/engine/src/w.ts": 'void import("./m.ts");' });
    expect(whole.values["apps/engine/src/m.ts#c"]!.production).toEqual(["apps/engine/src/w.ts"]);
  });

  test("the engine's declaration of a plugin uses what it declares — the plugin is never imported as source", () => {
    const { values } = usesOf({
      [LLM]: "export function used() {}\nexport function left() {}",
      "apps/engine/src/llm.d.ts": 'declare module "@nouride/llm" {\n  export function used(): void;\n}',
    });
    expect(values[`${LLM}#used`]!.production).toEqual(["apps/engine/src/llm.d.ts"]);
    expect(values[`${LLM}#left`]!.production).toEqual([]);
  });

  test("a default export is no named value, and a re-exported type is no value at all", () => {
    const files = {
      "apps/dashboard/src/page.tsx": "export default function Page() {}",
      [LLM]: 'export { type Shape, Kind } from "./types.ts";',
      "packages/llm/src/types.ts": "export interface Kind {}\nexport type Shape = {};",
    };
    expect(usesOf(files).values["apps/dashboard/src/page.tsx#Page"]).toBeUndefined();
    expect(usesOf(files).reexports[`${LLM}#Shape`]).toBeUndefined();
    expect(resolvesToValue(LLM, "Kind", input(files))).toBe(false);
  });
});

describe("a barrel's re-export", () => {
  const use = (production: string[], tests: string[]) => ({ production: new Set(production), tests: new Set(tests) });

  test("one production imports through the barrel says nothing", () => {
    expect(barrelVerdict("packages/llm/src/index.ts", "createProvider", use(["apps/engine/src/x.ts"], []))).toBeNull();
  });

  test("one only tests import fails, unless it is a seam named with its reason — it was a warning nobody read", () => {
    const verdict = barrelVerdict("packages/policy/src/index.ts", "scriptSegments", use([], ["packages/policy/tests/a.test.ts"]));
    expect(verdict).toMatchObject({ rule: "test-only-barrel-export" });
    expect(verdict && verdict !== "seam" ? verdict.detail : "").toContain("TEST_ONLY_EXPORTS");
    expect(barrelVerdict("packages/gateways/src/index.ts", "UndeliverableError", use([], ["apps/engine/tests/a.test.ts"]))).toBe("seam");
  });

  test("one nobody imports fails", () => {
    expect(barrelVerdict("packages/llm/src/index.ts", "gone", use([], []))).toMatchObject({ rule: "unused-barrel-export" });
  });

  test("every seam says why it is one", () => {
    for (const names of Object.values(TEST_ONLY_EXPORTS)) for (const why of Object.values(names)) expect(why.length).toBeGreaterThan(20);
  });
});
