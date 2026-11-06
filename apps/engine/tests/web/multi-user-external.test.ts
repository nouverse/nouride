/**
 * The multi-user plugin is reached only by dynamic import, never statically.
 *
 * Two properties matter here:
 *
 * 1. **The plugin must not reach a Basic (free) build.** `--external nouride-multi-user`
 *    removes it at compile time, and a static import would defeat that entirely.
 *    The edge is dynamic on purpose; nothing in the build system catches a static one.
 *
 * 2. **The `.d.ts` ambient declaration must not drift from the plugin's actual exports.**
 *    The engine declares what it needs in `nouride-multi-user.d.ts` rather than
 *    importing from the plugin source (same reason as `wa-bridge.d.ts`). This test
 *    reads the plugin source directly and fails if the declaration has gone stale.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ENGINE_SRC = join(import.meta.dir, "../../src");
/**
 * Four levels up, counted from `import.meta.dir` (`apps/engine/tests/web`) rather than guessed: web → tests →
 * engine → apps → repo root.
 *
 * Counted wrong, the path names nothing on any checkout. Before this test moved into `tests/web/` it went one
 * level too far, `existsSync` was false everywhere, and the three tests that read the plugin returned early and
 * passed — green with the plugin deleted.
 */
const PLUGIN_SRC = join(import.meta.dir, "../../../../internals/pro/packages/multi-user/src/index.ts");

function source(rel: string): string {
  return readFileSync(join(ENGINE_SRC, rel), "utf8");
}

/**
 * Whether the private submodule is checked out, which in a public clone it is not.
 *
 * `internals/pro/packages/multi-user` only ships in editions that are not published, so the repository it lives in
 * is private and `git clone` leaves the directory here empty. The drift check below reads its source
 * and cannot run without it.
 *
 * Keyed on `package.json`, not on the source file, and that distinction is the point. Absent
 * `package.json` means "nobody checked the submodule out" and is a legitimate state to skip. Present
 * `package.json` with the source missing is a broken checkout, and the first test in that block still
 * fails on it — which is the bug the note on `PLUGIN_SRC` above describes, where three tests reported
 * themselves green with the plugin deleted.
 */
const CHECKED_OUT = existsSync(join(import.meta.dir, "../../../../internals/pro/packages/multi-user/package.json"));

describe("the multi-user plugin is reached only on demand", () => {
  test("no static import of the plugin anywhere in the engine", () => {
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;

        for (const line of readFileSync(path, "utf8").split("\n")) {
          const trimmed = line.trim();
          // Prose mentions are fine; only real import edges count.
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          // `import … from "…nouride-multi-user…"` is the static form.
          // `await import(…)` is the one we want — it has no `from`.
          if (/^(?:import|export)\b[^"']*from\s+["'][^"']*nouride-multi-user/.test(trimmed)) {
            offenders.push(`${path.slice(ENGINE_SRC.length + 1)}: ${trimmed}`);
          }
        }
      }
    };

    walk(ENGINE_SRC);
    expect(offenders).toEqual([]);
  });

  test("the resolver reaches it by package name, not by path", () => {
    /**
     * The dynamic import must use the package name so `--external` can match it.
     * A relative path cannot be externalised — that was how the bridge was wired
     * originally, and neither `--external` nor `--define` pruned it.
     */
    const resolver = source("modules/users/multi-user.ts");
    expect(resolver).toContain('import("nouride-multi-user")');
    expect(resolver).not.toMatch(/import\(["']\.\.?[/\\]/);
  });
});

describe.skipIf(!CHECKED_OUT)("the .d.ts declaration has not drifted from the plugin", () => {
  /**
   * Skipped where the private submodule `internals/pro` is not checked out (`CHECKED_OUT`), as in CI's public
   * `verify` job, and run where it is: `verify-private`, and a checkout with the submodule.
   *
   * Inside the block the source is asserted rather than returned early on. An early return is what let a wrong
   * path hide — absent meant skipped meant green — and the submodule there with the source missing is a broken
   * checkout, worth a red test.
   */
  test("the plugin source is where this test thinks it is", () => {
    expect(existsSync(PLUGIN_SRC)).toBe(true);
  });

  test(
    "MULTI_USER_CAPABILITY is exported by the plugin",
    () => {
      const plugin = readFileSync(PLUGIN_SRC, "utf8");
      expect(plugin).toContain("MULTI_USER_CAPABILITY");
    },
  );

  test(
    "the marker string in the plugin matches the one the build asserts on",
    () => {
      const plugin = readFileSync(PLUGIN_SRC, "utf8");
      // This exact sentence is the `assertAbsent` / `assertEmbedded` marker.
      // If it changes in the plugin, the build assertions silently stop working.
      expect(plugin).toContain("multi-user capability provider active in this daemon process");
    },
  );

  test(
    "the .d.ts ambient declaration covers every name the engine calls",
    () => {
      const decl = source("modules/users/nouride-multi-user.d.ts");
      for (const name of [
        "MULTI_USER_CAPABILITY",
        "verifyMultiUserEdition",
        "admitAccountCreation",
        "admitRoleChange",
      ]) {
        expect(decl).toContain(name);
      }
    },
  );

  test(
    "every name the resolver calls is exported by the plugin",
    () => {
      const plugin = readFileSync(PLUGIN_SRC, "utf8");
      /**
       * The resolver reaches these through a dynamic import, so a rename in the plugin
       * is a runtime `undefined is not a function` at the first request rather than a
       * type error at build time. `mod.admitAccountCreation(...)` typechecks against the
       * `.d.ts`, which is a promise about the plugin and not a reading of it.
       */
      const resolver = source("modules/users/multi-user.ts");
      for (const name of ["verifyMultiUserEdition", "admitAccountCreation", "admitRoleChange"]) {
        expect(resolver).toContain(`mod.${name}`);
        expect(plugin).toMatch(new RegExp(`export function ${name}\\b`));
      }
    },
  );

  test(
    "the plugin and the engine agree on which roles exist",
    () => {
      /**
       * Two declarations of the same three strings, on either side of a boundary that
       * must not become an import. A role added to one and not the other is a 400 with
       * no explanation: the dashboard offers it, the plugin refuses it as unknown.
       */
      const roles = (text: string): string[] =>
        [...text.matchAll(/"(admin|operator|viewer)"/g)].map((m) => m[1]!);
      const uniq = (list: string[]): string[] => [...new Set(list)].sort();

      const plugin = readFileSync(PLUGIN_SRC, "utf8");
      const pluginRoles = uniq(
        roles(plugin.slice(plugin.indexOf("MULTI_USER_ROLES"), plugin.indexOf("isMultiUserRole"))),
      );
      const store = source("modules/users/users.store.ts");
      const engineRoles = uniq(roles(store.slice(store.indexOf("const USER_ROLES"), store.indexOf("function isUserRole"))));

      expect(pluginRoles).toEqual(["admin", "operator", "viewer"]);
      expect(engineRoles).toEqual(pluginRoles);
    },
  );
});

describe("a build without the plugin has no multi-user rules to run", () => {
  test("the policy refuses before boot has resolved anything", async () => {
    /**
     * The safe default matters more than it looks. `userPolicy()` is read synchronously
     * by a route handler, and a request that arrived while the dynamic import was still
     * in flight used to read a boolean that had not been written yet. The refusing
     * policy is the value it starts at, so the race answers "no".
     */
    const { userPolicy } = await import("@/modules/users/multi-user.ts");
    const policy = userPolicy();
    expect(policy.multiUser).toBe(false);

    const created = policy.admitAccountCreation({ existingAccounts: 1, requestedRole: "operator" });
    expect(created.ok).toBe(false);
    if (created.ok) throw new Error("unreachable");
    expect(created.status).toBe(403);
    expect(created.reason).toContain("the Pro edition");

    const moved = policy.admitRoleChange({ currentRole: "admin", requestedRole: "viewer", adminCount: 2 });
    expect(moved.ok).toBe(false);
    if (moved.ok) throw new Error("unreachable");
    expect(moved.status).toBe(403);
  });

  test("the refusal is the whole of multi-user here — the rules are not in this tree", () => {
    /**
     * The property this change exists to create: the engine holds the seam, and the
     * plugin holds the rules. A rule that crept back into the engine would be invisible
     * to the build's `assertAbsent`, which only searches for the plugin's marker string.
     *
     * Searched for by shape rather than by name: the last-admin rule and the role
     * vocabulary are the two that were here before, and either reappearing means the
     * Basic build carries multi-user logic again.
     */
    const facade = source("modules/users/multi-user.ts");
    const routes = source("modules/web/control/routes/users.ts");

    for (const [where, text] of [["multi-user.ts", facade], ["routes/users.ts", routes]] as const) {
      expect(`${where}: ${/adminCount\(\)\s*<=\s*1/.test(text)}`).toBe(`${where}: false`);
      expect(`${where}: ${/"operator"\s*:\s*"viewer"|role\s*===\s*"admin"/.test(text)}`).toBe(`${where}: false`);
    }
  });
});
