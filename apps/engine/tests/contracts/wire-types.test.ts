/**
 * `@nouride/wire`: the control API's payload types, one copy, which the engine's routes and the dashboard both import.
 *
 * The dashboard kept its own copy of every payload, and `check-wire.ts` compared a few dozen of their word lists with
 * the daemon's by hand; a field renamed or retyped passed both. Now a payload changed in the package fails the
 * dashboard's typecheck, which this proves by changing one and compiling the dashboard. And the line around the
 * package — types only, imported as types, no copy kept beside it — is `check-arch.ts`'s, whose rules are planted here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { generateRouteTree } from "../../../dashboard/scripts/routes.ts";
import { wireExports, wireFindings } from "../../../../scripts/wire-rules.ts";

const ROOT = join(import.meta.dir, "../../../..");
const DASHBOARD = join(ROOT, "apps/dashboard");

/** The dashboard's own type errors, with one wire file read as `swap` says. */
function dashboardErrors(swap?: { file: string; text: string }): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(join(DASHBOARD, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!config) throw new Error("the dashboard's tsconfig did not parse");
  const host = ts.createCompilerHost(config.options);
  if (swap) {
    const target = realpathSync(join(ROOT, swap.file));
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (name, language, ...rest) => (realpathSync.native(name) === target ? ts.createSourceFile(name, swap.text, language) : read(name, language, ...rest));
  }
  const program = ts.createProgram(config.fileNames, config.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith(realpathSync(join(DASHBOARD, "src"))))
    .map((d) => `${d.file!.fileName.slice(ROOT.length)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** `file` with the type alias `name` declared as `type` instead. */
function retyped(file: string, name: string, type: string): string {
  const text = readFileSync(join(ROOT, file), "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const alias = source.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
  if (!alias) throw new Error(`${file}: no type ${name}`);
  return text.slice(0, alias.type.getStart(source)) + type + text.slice(alias.type.getEnd());
}

describe("the dashboard builds on @nouride/wire", () => {
  test("a payload type changed in the package fails the dashboard's typecheck — a turn's status, a word list the engine owns", async () => {
    await generateRouteTree();
    expect(dashboardErrors()).toEqual([]);
    const errors = dashboardErrors({ file: "packages/wire/src/chat.ts", text: retyped("packages/wire/src/chat.ts", "TurnStatus", "number") });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("apps/dashboard/src/");
  }, 90_000);
});

describe("the line around it", () => {
  const exported = new Set(["User", "TurnStatus"]);
  const rules = (rel: string, text: string) => wireFindings(rel, text, exported).map((f) => f.rule);

  test("the package holds types, and imports and exports them as types", () => {
    expect(rules("packages/wire/src/x.ts", 'import type { ModelTier } from "@nouride/shared";\nexport interface A { tier: ModelTier }\nexport type B = A;\nexport type { ModelTier };\n')).toEqual([]);
    expect(rules("packages/wire/src/x.ts", "export const LEVELS = [1, 2];\n")).toEqual(["wire-not-types-only"]);
    expect(rules("packages/wire/src/x.ts", "export function f(): void {}\n")).toEqual(["wire-not-types-only"]);
    expect(rules("packages/wire/src/x.ts", 'import { type ModelTier } from "@nouride/shared";\nexport type A = ModelTier;\n')).toEqual(["wire-not-types-only"]);
    expect(rules("packages/wire/src/x.ts", 'export { ModelTier } from "@nouride/shared";\n')).toEqual(["wire-not-types-only"]);
  });

  test("and names the types of shared and acp, and no other package", () => {
    expect(rules("packages/wire/src/x.ts", 'import type { CliStanding } from "@nouride/acp";\nimport type { A } from "./a.ts";\nexport type B = [CliStanding, A];\n')).toEqual([]);
    expect(rules("packages/wire/src/x.ts", 'import type { Usage } from "@nouride/llm";\nexport type A = Usage;\n')).toEqual(["wire-imports-workspace"]);
  });

  test("the dashboard imports it with `import type` alone", () => {
    expect(rules("apps/dashboard/src/a.ts", 'import type { User } from "@nouride/wire";\nexport const who = (u: User) => u.id;\n')).toEqual([]);
    expect(rules("apps/dashboard/src/a.ts", 'import { type User } from "@nouride/wire";\n')).toEqual(["wire-imported-as-value"]);
    expect(rules("apps/dashboard/src/a.tsx", 'import { User } from "@nouride/wire";\n')).toEqual(["wire-imported-as-value"]);
    expect(rules("apps/dashboard/src/a.ts", 'export { User } from "@nouride/wire";\n')).toEqual(["wire-imported-as-value"]);
    expect(rules("apps/dashboard/src/a.ts", 'const wire = await import("@nouride/wire");\n')).toEqual(["wire-imported-as-value"]);
  });

  test("and keeps no copy of a type it exports, a local one included", () => {
    expect(rules("apps/dashboard/src/a.ts", 'export interface User { id: string }\n')).toEqual(["wire-type-copied"]);
    expect(rules("apps/dashboard/src/a.tsx", 'function f() { type TurnStatus = "running"; return null as unknown as TurnStatus; }\n')).toEqual(["wire-type-copied"]);
    expect(rules("apps/dashboard/src/a.ts", "export interface Props { id: string }\n")).toEqual([]);
  });

  test("what the package exports is read off its files — every wire file's names, the re-exported ones too", () => {
    expect(wireExports("packages/wire/src/x.ts", 'import type { ModelTier } from "@nouride/shared";\nexport interface A {}\ntype Local = A;\nexport type B = Local;\nexport type { ModelTier };\n')).toEqual(["A", "B", "ModelTier"]);
  });
});
