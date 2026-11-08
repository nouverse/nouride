/**
 * A module imports from itself and from `commons`, and `commons` imports from no module.
 *
 * The house rule — `commons/` holds what two or more modules share, and no module imports another — and eleven imports
 * broke it: the shared layout reached into `update`, `access` and
 * `setup`; `setup` and `llm-gateway` imported each other; `home` and `box` borrowed `update`'s helpers.
 * Deleting or moving one module broke pages in another, which is what the rule exists to prevent. The
 * shared pieces are in `commons` now, and the pieces only one module used went to that module.
 *
 * And the small helpers that had been written twice — `formatBytes` three times, `ago` twice with
 * different answers, two copy buttons, two password minimums — have one definition each.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = join(dirname(import.meta.path), "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

/** `modules/chat/…` → `chat`; `commons/…` → `commons`; the route files and the entry → null (they wire, and may reach anything). */
function ownerOf(path: string): string | null {
  const [top, module] = relative(SRC, path).split(sep);
  if (top === "modules") return module ?? null;
  return top === "commons" ? "commons" : null;
}

/** Every module an import in this file reaches, by `@/modules/x` or by a relative path. */
function importedModules(path: string): { line: string; module: string }[] {
  return [...readFileSync(path, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].flatMap((m) => {
    const specifier = m[1]!;
    const target = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(path), specifier) : null;
    const owner = target ? ownerOf(`${target}.ts`) : null;
    return owner && owner !== "commons" ? [{ line: specifier, module: owner }] : [];
  });
}

describe("module boundaries", () => {
  test("the scan sees imports, so a clean result means something", () => {
    const chat = sources(join(SRC, "modules", "chat")).flatMap(importedModules);
    expect(chat.some(({ module }) => module === "chat")).toBe(true);
  });

  test("no module imports another, and commons imports none", () => {
    const crossing = sources(SRC).flatMap((path) => {
      const owner = ownerOf(path);
      if (!owner) return [];
      return importedModules(path)
        .filter(({ module }) => module !== owner)
        .map(({ line }) => `${relative(SRC, path)} imports ${line}`);
    });
    expect(crossing).toEqual([]);
  });
});

describe("helpers written once", () => {
  const ONE_HOME: Record<string, string> = {
    "function formatBytes": "commons/lib/format.ts",
    "const ago =": "commons/lib/format.ts",
    "function CopyButton": "commons/components/ui/CopyButton.tsx",
    "MIN_PASSWORD_LENGTH = ": "commons/lib/password.ts",
    "SWEET_SPOT = ": "modules/agents/components/ToolBudgetControl.tsx",
  };

  test.each(Object.entries(ONE_HOME))("%s is defined only in %s", (definition, home) => {
    const at = sources(SRC)
      .filter((path) => readFileSync(path, "utf8").includes(definition))
      .map((path) => relative(SRC, path).split(sep).join("/"));
    expect(at).toEqual([home]);
  });
});
