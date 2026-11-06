/**
 * The appliance plugin is reached only by dynamic import, never statically.
 *
 * Three properties matter here, and the first two are the same pair
 * `multi-user-external.test.ts` guards:
 *
 * 1. **The plugin must not reach a published build.** `--external nouride-appliance` removes it at
 *    compile time for every edition but Pro, and a static import would defeat
 *    that entirely. The edge is dynamic on purpose; nothing in the build system catches a static
 *    one.
 * 2. **The `.d.ts` ambient declaration must not drift from the plugin's actual exports.** The engine
 *    declares what it needs in `boot/nouride-appliance.d.ts` rather than importing from the plugin
 *    source, and this test reads that source and fails when the declaration goes stale.
 * 3. **Pairing and licensing must not leak back into the engine.** The whole point of moving them
 *    out is that a Basic download does not contain the sync protocol, the fingerprint derivation or
 *    the licence verifier. A helpful refactor that pulls one of them back into `apps/engine/src`
 *    puts it into the free binary, and nothing else would notice.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ENGINE_SRC = join(import.meta.dir, "../../src");
/** tests/appliance → tests → engine → apps → repo root. */
const PLUGIN_DIR = join(import.meta.dir, "../../../../internals/pro/packages/appliance");
/** The runtime half. `src/ui` is the setup console's React source, built to one HTML file; it is not code the engine loads. */
const PLUGIN_SRC = join(PLUGIN_DIR, "src", "core");

/**
 * Whether the private submodule is checked out, which in a public clone it is not.
 *
 * Keyed on `package.json` rather than on a source file, for the reason the multi-user test records:
 * an absent manifest means "nobody checked the submodule out" and is legitimately skipped, while a
 * present manifest with missing source is a broken checkout that should fail.
 */
const CHECKED_OUT = existsSync(join(PLUGIN_DIR, "package.json"));

function walkFiles(dir: string, visit: (path: string, source: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(path, visit);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      visit(path, readFileSync(path, "utf8"));
    }
  }
}

describe("the appliance plugin is reached only on demand", () => {
  test("no static import of the plugin anywhere in the engine", () => {
    const offenders: string[] = [];

    walkFiles(ENGINE_SRC, (path, source) => {
      // `import ... from "nouride-appliance"` at the top level. `await import(...)` is the shape
      // that must survive, and a type-only import carries no runtime edge.
      if (/^\s*import\s+(?!type\b)[^;]*from\s+["']nouride-appliance["']/m.test(source)) {
        offenders.push(path.replace(ENGINE_SRC, ""));
      }
    });

    expect(offenders).toEqual([]);
  });

  test("only the boot seam mentions the plugin at all", () => {
    const mentions: string[] = [];

    walkFiles(ENGINE_SRC, (path, source) => {
      if (source.includes("nouride-appliance")) mentions.push(path.replace(ENGINE_SRC, ""));
    });

    // `boot/appliance.ts` loads it; `commons/context.ts` types the field `/health` reads. Anything
    // else is the engine growing an opinion about appliances, which is what this file prevents.
    expect(mentions.sort()).toEqual(["/boot/appliance.ts", "/commons/context.ts"]);
  });
});

describe("pairing and licensing do not live in the engine", () => {
  /**
   * Terms that only make sense inside the plugin. Each one of these appearing in the engine means a
   * published build now contains a piece of the appliance protocol.
   *
   * `device.json` is deliberately not on this list: `boot/appliance.ts` checks whether that file
   * exists so it can refuse to start a box it cannot serve, and a path is not a protocol.
   */
  test.each([
    ["the sync endpoint", "/api/appliances/sync"],
    ["the fingerprint salt", "nouverse-hw-appliance-v1"],
    ["the licence public key", "BEGIN PUBLIC KEY"],
    ["silicon serial paths", "/proc/device-tree/serial-number"],
  ])("%s is not in the engine source", (_name, needle) => {
    const offenders: string[] = [];

    walkFiles(ENGINE_SRC, (path, source) => {
      if (source.includes(needle)) offenders.push(path.replace(ENGINE_SRC, ""));
    });

    expect(offenders).toEqual([]);
  });
});

describe("the ambient declaration matches the plugin", () => {
  const declaration = readFileSync(
    join(ENGINE_SRC, "boot/nouride-appliance.d.ts"),
    "utf8",
  );

  const SYMBOLS = ["APPLIANCE_CAPABILITY", "verifyApplianceEdition", "createAppliance"];

  test("the engine declares what it uses of the plugin", () => {
    for (const symbol of SYMBOLS) expect(declaration).toContain(symbol);
  });

  // Skipped, not passed, without the private submodule: these returned before their first `expect`, so a clone
  // without it reported them green having checked nothing (multi-user-external.test.ts says how that hid a wrong path).
  test.skipIf(!CHECKED_OUT)("and the plugin exports each", () => {
    const plugin = readFileSync(join(PLUGIN_SRC, "index.ts"), "utf8");
    for (const symbol of SYMBOLS) expect(plugin).toContain(`export ${symbol === "APPLIANCE_CAPABILITY" ? "const" : "function"} ${symbol}`);
  });

  test.skipIf(!CHECKED_OUT)("the build marker in the declaration is the one the plugin actually exports", () => {
    const plugin = readFileSync(join(PLUGIN_SRC, "index.ts"), "utf8");
    const marker = /APPLIANCE_CAPABILITY = "([^"]+)"/.exec(plugin)?.[1];

    // The marker is what `assertEmbedded` in `scripts/build/core.ts` greps for to prove the link and prove the exclusion. A
    // declaration quoting a stale value is a build assertion that checks nothing.
    expect(marker).toBe("appliance pairing and licensing active in this daemon process");
    expect(declaration).toContain(marker!);
  });

  test("the seam hands the plugin's release source to the updater", () => {
    // Without it a box keeps asking the public mirror, which carries no Pro build, and never updates.
    const seam = readFileSync(join(ENGINE_SRC, "boot/appliance.ts"), "utf8");
    expect(seam).toContain("setReleaseSource(runner.releaseSource());");
    // …and with it the nightly schedule and the new version's proof of life.
    expect(seam).toContain("startApplianceUpdates(ctx, runner, version, updates);");
    expect(declaration).toContain("releaseSource(): import(\"nouride-update\").ReleaseSource;");
  });

  test.skipIf(!CHECKED_OUT)("the plugin imports nothing from this repository", () => {
    const offenders: string[] = [];

    walkFiles(PLUGIN_SRC, (path, source) => {
      // `@nouride/runtime` and friends would drag the engine's module graph back in through the
      // door `--external` exists to close. `node:` built-ins and relative files only.
      if (/from\s+["']@nouride\//.test(source)) offenders.push(path.replace(PLUGIN_SRC, ""));
    });

    expect(offenders).toEqual([]);
  });
});
