/**
 * `packages/system-packages` is reached only on demand, its declared shape matches it, and it never
 * decides whether a change needs a person.
 *
 * The same three properties `update-external.test.ts` holds for the update plugin, for the same
 * reasons: a static import would make a separable directory required; a declaration that drifted
 * from the plugin is an `undefined is not a function` at the first call; and the gate has to be
 * the engine's, or one edit to the plugin could widen the only check in front of a change as root.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyHardline } from "@nouride/policy";

const ENGINE_SRC = join(import.meta.dir, "../../src");
const PLUGIN = join(import.meta.dir, "../../../../packages/system-packages");

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else if (entry.name.endsWith(".ts")) visit(path);
  }
}

describe("the system-packages plugin", () => {
  test("no static import of it anywhere in the engine", () => {
    const offenders: string[] = [];
    walk(ENGINE_SRC, (path) => {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // `import type` is erased and leaves no edge; a value import is the one that would.
        if (/^(?:import|export)\s+(?!type\b)[^"']*from\s+["']nouride-system-packages["']/.test(trimmed)) {
          offenders.push(`${path.slice(ENGINE_SRC.length + 1)}: ${trimmed}`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  test("every name the engine declares is exported by the plugin", () => {
    const declared = readFileSync(join(ENGINE_SRC, "modules/system-packages/nouride-system-packages.d.ts"), "utf8");
    const exported = readFileSync(join(PLUGIN, "src/index.ts"), "utf8");
    const names = [...declared.matchAll(/export (?:const|function|type|interface) (\w+)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect({ name, exported: new RegExp(`\\b${name}\\b`).test(exported) }).toEqual({ name, exported: true });
  });

  test("of this repository it depends on @nouride/runtime alone, and never on the engine", () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@nouride/runtime"]);
    walk(join(PLUGIN, "src"), (path) => {
      const source = readFileSync(path, "utf8");
      const imported = [...source.matchAll(/from\s+["'](@nouride\/[^"']+|@\/[^"']*|node:[^"']+)["']/g)].map((m) => m[1]);
      expect({ path, imported: imported.filter((spec) => spec !== "@nouride/runtime") }).toEqual({ path, imported: [] });
    });
  });

  test("the gate is the engine's: a change is on the fixed list, asked every time at careful and balanced (0.8.15)", () => {
    // What a change may touch is `nouride-pkg`'s to decide, however it is asked for; whether a person sees it, the list's.
    // 0.8.0's list left it out, and a balanced agent changed packages as root unasked, so it was put back.
    for (const op of ["install", "remove", "upgrade"]) expect(classifyHardline(["nouride", "pkg", op, "jq"])?.class).toBe("system-packages");
  });
});
