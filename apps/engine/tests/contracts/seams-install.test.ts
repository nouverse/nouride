/**
 * lint:seams names the install a plugin is waiting for, rather than failing on each of its imports.
 *
 * Nougate keeps its own lockfiles and is installed apart from this workspace, so in a fresh clone its backend imports
 * `drizzle-orm` from nowhere — and the check said so twelve times, as if the seam had drifted, until somebody worked
 * out which `bun install` it wanted. `uninstalledAt` decides which unresolved import is that, and
 * where to run the install; laid out here as Nougate is: a repository with a lockfile at its root and one per app.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uninstalledAt } from "../../../../scripts/uninstalled.ts";

let root = "";
let source = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "seams-install-"));
  const gateway = join(root, "internals/gateway");
  const backend = join(gateway, "apps/backend");
  mkdirSync(join(backend, "src/db"), { recursive: true });
  writeFileSync(join(root, "bun.lock"), "{}\n");
  writeFileSync(join(gateway, "bun.lock"), "{}\n");
  writeFileSync(join(backend, "bun.lock"), "{}\n");
  writeFileSync(
    join(backend, "package.json"),
    JSON.stringify({ name: "backend", dependencies: { "drizzle-orm": "0.45.2" }, devDependencies: { "@types/bun": "1.4.2" } }),
  );
  source = join(backend, "src/db/index.ts");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("an import that does not resolve", () => {
  test("of a package its manifest declares and nothing has installed is an install, run beside the app's own lockfile", () => {
    expect(uninstalledAt(source, "drizzle-orm", root)).toEqual({ dir: "internals/gateway/apps/backend", pkg: "drizzle-orm" });
    // A subpath is its package's, and a scoped name is two segments.
    expect(uninstalledAt(source, "drizzle-orm/sqlite-core", root)).toEqual({ dir: "internals/gateway/apps/backend", pkg: "drizzle-orm" });
    expect(uninstalledAt(source, "@types/bun/globals", root)).toEqual({ dir: "internals/gateway/apps/backend", pkg: "@types/bun" });
  });

  test("of a package that is installed is not: the import itself is what is wrong", () => {
    mkdirSync(join(root, "internals/gateway/apps/backend/node_modules/drizzle-orm"), { recursive: true });
    expect(uninstalledAt(source, "drizzle-orm/sqlite-core", root)).toBeNull();
  });

  test("an install higher up counts — a workspace links its members' packages above them", () => {
    mkdirSync(join(root, "internals/gateway/node_modules/drizzle-orm"), { recursive: true });
    expect(uninstalledAt(source, "drizzle-orm", root)).toBeNull();
  });

  test("of a package no manifest declares is a missing dependency, which no install would fix", () => {
    expect(uninstalledAt(source, "left-pad", root)).toBeNull();
  });

  test("a relative or a runtime import is never an install", () => {
    expect(uninstalledAt(source, "./schema/sqlite.ts", root)).toBeNull();
    expect(uninstalledAt(source, "bun:sqlite", root)).toBeNull();
  });

  test("with no lockfile from the manifest up, there is no install to name", () => {
    rmSync(join(root, "bun.lock"));
    rmSync(join(root, "internals/gateway/bun.lock"));
    rmSync(join(root, "internals/gateway/apps/backend/bun.lock"));
    expect(uninstalledAt(source, "drizzle-orm", root)).toBeNull();
  });
});
