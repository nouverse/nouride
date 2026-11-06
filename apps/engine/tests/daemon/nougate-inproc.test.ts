/**
 * Hosting the LLM gateway in the daemon's own process.
 *
 * The same two invisible properties the WhatsApp bridge needed, for the same reasons — and one more
 * that only applies here.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";

const ENGINE_SRC = join(import.meta.dir, "../../src");
const REPO = join(import.meta.dir, "../../../..");

function source(rel: string): string {
  return readFileSync(join(ENGINE_SRC, rel), "utf8");
}

describe("the gateway is reached only on demand", () => {
  test("no static import of the plugin anywhere in the engine", () => {
    // Nougate brings its own database layer and provider registry. A helper importing it three files
    // away costs exactly as much as the host doing it, so the whole tree is checked.
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
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          if (/^(?:import|export)\b[^"']*from\s+["'][^"']*nougate-backend/.test(trimmed)) {
            offenders.push(`${path.slice(ENGINE_SRC.length + 1)}: ${trimmed}`);
          }
        }
      }
    };
    walk(ENGINE_SRC);
    expect(offenders).toEqual([]);
  });

  test("the host reaches it by package name, so --external can match", () => {
    // A relative path cannot be externalised — that lesson cost the WhatsApp bridge a release where
    // the bridge shipped in every artefact whether or not it was wanted.
    const text = source("modules/gateways/nougate-inproc.ts");
    expect(text).toContain('await import("@nouverse/nougate-backend")');
  });

  test("a build without it fails with a sentence, not a resolver error", () => {
    const text = source("modules/gateways/nougate-inproc.ts");
    expect(text).toContain("does not carry the gateway");
    // The two editions that carry it, by the flags that build them: `--pro` since 0.7.20.
    expect(text).toContain("built without --router or --pro");
  });

  test("every other edition externalises it, and the artefact is checked", () => {
    const core = readFileSync(join(REPO, "scripts/build/core.ts"), "utf8");
    // One field drives both directions: an edition that does not bundle a plugin gets `--external`
    // for it and is checked for its absence, from the same `bundles` list. Two lists that had to
    // agree did not, and `--pro` shipped a plugin its banner denied.
    expect(core).toContain("OPTIONAL.filter((plugin) => !edition.bundles.includes(plugin))");
    const build = readFileSync(join(REPO, "scripts/build/edition.ts"), "utf8");
    /**
     * The marker matters more than it looks. The first one was `provider:model-id`, which nouride's
     * own `packages/llm/src/classify.ts` uses in an error message — so it was present in every build
     * and the check could never fail. `nougate.db` appears nowhere outside the plugin.
     */
    expect(build).toContain('marker: "nougate.db"');
  });
});

describe("it is off unless asked for", () => {
  test("the default config does not host a gateway", () => {
    // A gateway serving several machines has no business inside one of them, and both live boxes
    // reach a remote one at no cost. Hosting it here is for a device with no network.
    expect(DEFAULT_CONFIG.nougate.inProcess).toBe(false);
  });

  test("its port is beside the daemon's own, not nougate's usual 3000", () => {
    // A gateway hosted here is part of this install and its port should read like one.
    expect(DEFAULT_CONFIG.nougate.port).toBe(18256);
    expect(DEFAULT_CONFIG.nougate.port).not.toBe(DEFAULT_CONFIG.dashboard.port);
  });

  test("it binds loopback by default", () => {
    /**
     * Default to loopback so it is not exposed unexpectedly on bare-metal installs.
     * Respects process.env.HOST so container port mappings work when requested.
     */
    const text = source("modules/gateways/nougate-inproc.ts");
    expect(text).toContain('process.env.HOST ?? "127.0.0.1"');
    /**
     * And through the runtime adapter, which also brings the EADDRINUSE message — the failure an
     * operator who already runs a nougate on this box will actually hit.
     *
     * Only the positive half is asserted. `check-arch` already refuses `Bun.*` outside
     * `packages/runtime` across the whole tree, and a second check here on the *absence* of the
     * string failed on the comment explaining why it is absent.
     */
    expect(text).toContain("serveHttp({");
  });
});

describe("it stops with the daemon", () => {
  /**
   * The gateway writes what it holds when its host tells it to stop (`shutdown`, which it exports for a host: inside one
   * it answers no signal itself). The real module is not linked outside a build, so this reads the stop.
   */
  test("and has the gateway write what it holds as it stops", () => {
    const text = source("modules/gateways/nougate-inproc.ts");
    const stop = text.slice(text.indexOf("stop: async () => {"));
    expect(stop).toContain("await gatewayModule.shutdown();");
  });

  test("shutdown closes it, after the drain", () => {
    // A turn still draining may be mid-stream against this gateway, so stopping it earlier would
    // fail the very work the drain is waiting for.
    const text = source("boot/shutdown.ts");
    expect(text).toContain("nougate?.stop()");
    const stopAt = text.indexOf("nougate?.stop()");
    const drainAt = text.indexOf("await pipeline.drain()");
    expect({ drainFirst: drainAt < stopAt, both: drainAt >= 0 && stopAt >= 0 }).toEqual({
      drainFirst: true,
      both: true,
    });
  });
});

describe("the engine and the gateway agree on what the gateway is", () => {
  /**
   * `nougate.d.ts` declares the surface instead of importing it, so nothing compares the two — a
   * function declared here and missing there compiles, and fails at the first boot of a Router box.
   */
  const boot = join(REPO, "internals/nougate/apps/backend/src/boot.ts");
  // Skipped, not passed, in a clone without the submodule — which builds no edition that hosts it.
  test.skipIf(!existsSync(boot))("every function the engine declares is one the gateway exports", () => {
    const declared = [...source("modules/gateways/nougate.d.ts").matchAll(/export function (\w+)/g)].map((m) => m[1]);
    const exported = readFileSync(boot, "utf8");
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(exported).toMatch(new RegExp(`export (?:async )?function ${name}\\b|export \\{[^}]*\\b${name}\\b[^}]*\\}`));
    }
  });

  /**
   * Which files are the gateway's is the gateway's to know. The basic edition's artefact check looks
   * for the gateway's database filename to prove the gateway is not in the build — so an engine file
   * that names it makes the public build fail as though it carried the gateway. Found building the
   * basic image, after the backfill listed the gateway's files here; the list moved into nougate.
   */
  test("no engine source names the gateway's database file", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ts$/.test(entry.name) && !entry.name.endsWith(".d.ts") && readFileSync(path, "utf8").includes("nougate.db")) hits.push(path);
      }
    };
    walk(ENGINE_SRC);
    expect(hits).toEqual([]);
  });
});
