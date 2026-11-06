/**
 * What must stay out of every artefact that carries the bridge — which is every artefact.
 *
 * Baileys reaches for its optional peers with `import('sharp').catch(() => {})` and gives up quietly
 * when they are absent — a send loses its thumbnail and nothing else. Bundling one defeats that:
 * `sharp` is a native module, so what lands in the bundle is its *loader*, which then tries to
 * materialise a `.node` file that is not there. Bun answers by reaching for a temp directory it has
 * not been given, and the error is fatal rather than catchable:
 *
 *   error: Unexpected accessing temporary directory. Please set $BUN_TMPDIR or $BUN_INSTALL
 *
 * Seen live the first time anything was sent to WhatsApp as an image: the bridge exited 1, the gateway
 * reconnected, and the retry landed before the new session had finished linking — so the visible
 * symptom was "not linked yet", two layers away from the cause. The bridge runs inside the daemon now,
 * so the exit would be the daemon's.
 *
 * This is the guard that a peer added upstream does not walk back into the artefact unnoticed, and
 * that what a build left in `dist/` carries no loader.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_EXTERNALS, NATIVE_LOADER_MARKERS } from "../../../scripts/bridge-externals.ts";

const BRIDGE_ROOT = join(import.meta.dir, "..");
const BAILEYS = join(BRIDGE_ROOT, "node_modules/@whiskeysockets/baileys/package.json");

describe("the bundle's external list", () => {
  test.skipIf(!existsSync(BAILEYS))("covers every peer dependency Baileys declares", () => {
    // Read from Baileys itself rather than restated here: the failure mode is upstream adding one,
    // and a hand-copied list cannot notice that.
    const pkg = JSON.parse(readFileSync(BAILEYS, "utf-8")) as {
      peerDependencies?: Record<string, string>;
    };
    const peers = Object.keys(pkg.peerDependencies ?? {});
    expect(peers.length).toBeGreaterThan(0);

    const missing = peers.filter((name) => !(BRIDGE_EXTERNALS as readonly string[]).includes(name));
    expect(missing).toEqual([]);
  });

  test("names sharp, which is the one that is native and not optional upstream", () => {
    // `sharp` is the only peer Baileys does *not* mark optional in `peerDependenciesMeta`, and the
    // only one carrying a platform binary. If this list ever loses it, media sending dies fatally.
    expect(BRIDGE_EXTERNALS).toContain("sharp");
  });
});

describe("what ships", () => {
  /**
   * Every artefact a build leaves in `dist/`: the host binary, each target's, and the image's bundle. This looked at the
   * standalone bridge's, which no build has made since every edition carried the bridge in-process — so it skipped
   * everywhere, while each daemon carried sharp 0.33.5's loader. Whichever exist are checked; a checkout that has built
   * none skips, and the build itself fails on the same markers (`assertAbsent`).
   */
  const DIST = join(BRIDGE_ROOT, "../../dist");
  const built = existsSync(DIST)
    ? [
        join(DIST, "nouride"),
        join(DIST, "nouride.bundle.js"),
        ...readdirSync(DIST)
          .filter((entry) => entry.startsWith("nouride-") && !entry.endsWith(".tar.gz"))
          .map((entry) => join(DIST, entry, "nouride")),
      ].filter(existsSync)
    : [];

  test.skipIf(built.length === 0)("carries no native module's loader", () => {
    // Searched as bytes rather than as a decoded string: most of a compiled artefact is the Bun runtime, not text.
    for (const path of built) {
      const bytes = readFileSync(path);
      for (const marker of NATIVE_LOADER_MARKERS) expect({ path, marker, found: bytes.includes(marker) }).toEqual({ path, marker, found: false });
      // Still a build with the bridge in it, so an empty or truncated file cannot pass this by accident.
      expect(bytes.includes("no session directory was given")).toBe(true);
    }
  });
});

/**
 * The engine no longer launches the bridge at all.
 *
 * It used to search four directories for a `wa-bridge` executable the tarball shipped beside the
 * daemon, spawn it, and pipe newline-delimited JSON to it. Every edition bundles the bridge
 * in-process now, so there is no second executable, no search and no spawn — and the four tests that
 * pinned that search are gone with it.
 *
 * What replaces them is the assertion that it cannot come back by accident: the engine reaches the
 * bridge through one dynamic import, and `bridge-inproc.test.ts` owns that edge.
 */
describe("nothing spawns the bridge any more", () => {
  const source = readFileSync(
    join(BRIDGE_ROOT, "../../apps/engine/src/modules/gateways/bridge.ts"),
    "utf-8",
  );

  test("no candidate search, no spawn, no `bun` in front of anything", () => {
    expect(source).not.toContain("wa-bridge/wa-bridge");
    expect(source).not.toContain("spawnLongLived");
    expect(source).not.toContain("isExecutableFile");
    expect(source).not.toMatch(/const BUN = /);
  });
});
