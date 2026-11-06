/**
 * lint:types names the install a project is waiting for, as lint:seams does.
 *
 * The Pro tree keeps its own lockfile and is installed apart from this workspace, so in a fresh clone
 * `internals/pro/packages/appliance` failed with three TS2307s and nothing said why. `installsInTsc` reads `tsc`'s output for
 * them; laid out here as the Pro tree is: a workspace with its lockfile at its root, and a member that declares what it
 * imports.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installsInTsc, notInstalled } from "../../../../scripts/uninstalled.ts";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "types-install-"));
  const pro = join(root, "internals/pro");
  mkdirSync(join(pro, "packages/appliance/src"), { recursive: true });
  writeFileSync(join(root, "bun.lock"), "{}\n");
  writeFileSync(join(pro, "bun.lock"), "{}\n");
  writeFileSync(join(pro, "package.json"), JSON.stringify({ name: "pro", workspaces: ["packages/appliance"] }));
  writeFileSync(join(pro, "packages/appliance/package.json"), JSON.stringify({ name: "appliance", devDependencies: { vite: "8.3.0", "@vitejs/plugin-react": "6.1.1" } }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A TS2307 line as `tsc` prints it from the root, piped. */
const cannotFind = (file: string, specifier: string) => `${file}(1,30): error TS2307: Cannot find module '${specifier}' or its corresponding type declarations.`;

describe("tsc's output in a clone whose Pro tree is not installed", () => {
  test("a TS2307 for a package the project declares is the install, run beside the Pro tree's lockfile", () => {
    const output = [
      cannotFind("internals/pro/packages/appliance/vite.config.ts", "vite"),
      cannotFind("internals/pro/packages/appliance/vite.config.ts", "@vitejs/plugin-react"),
      cannotFind("internals/pro/packages/appliance/src/ui.ts", "vite/client"),
    ].join("\n");
    expect(installsInTsc(output, root)).toEqual(new Map([["internals/pro", new Set(["vite", "@vitejs/plugin-react"])]]));
  });

  test("a TS2307 that no install would fix — undeclared, relative, already installed — and any other error are not", () => {
    mkdirSync(join(root, "internals/pro/node_modules/vite"), { recursive: true });
    const output = [
      cannotFind("internals/pro/packages/appliance/vite.config.ts", "vite"),
      cannotFind("internals/pro/packages/appliance/vite.config.ts", "left-pad"),
      cannotFind("internals/pro/packages/appliance/src/ui.ts", "./missing.ts"),
      "internals/pro/packages/appliance/src/ui.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    ].join("\n");
    expect(installsInTsc(output, root)).toEqual(new Map());
  });

  test("the hint is lint:seams' own: the directory, what does not resolve, and the frozen install", () => {
    expect(notInstalled("internals/pro", ["@vitejs/plugin-react", "vite"], "typechecked")).toBe(
      "internals/pro: its dependencies are not installed — `@vitejs/plugin-react`, `vite` do not resolve, so nothing that comes through them can be " +
        "typechecked. Run `bun install --frozen-lockfile` in internals/pro, then this check again — frozen, the install takes what the lockfile pins and writes nothing",
    );
  });
});
