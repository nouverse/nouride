/**
 * Hosting the WhatsApp bridge in the daemon's own process.
 *
 * Two properties matter more than the plumbing, and both are invisible at runtime:
 *
 * 1. **Baileys must not be evaluated by a daemon that does not use WhatsApp.** It is a large module
 *    graph and a static import would walk it at boot on every install, configured or not. The edge
 *    is dynamic on purpose, and nothing fails if somebody makes it static.
 * 2. **The session key must not enter `process.env`.** The spawned bridge used to get it in its
 *    child environment, which was safe because that child was the bridge. Doing the same here would
 *    put it in the *daemon's* environment, and every command the agent runs through `exec` inherits
 *    that.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGateways } from "@/modules/config/global/open-sections.ts";

const ENGINE_SRC = join(import.meta.dir, "../../src");

function source(rel: string): string {
  return readFileSync(join(ENGINE_SRC, rel), "utf8");
}

describe("the bridge is reached only on demand", () => {
  test("no static import of the plugin anywhere in the engine", () => {
    // Asserted across the whole tree rather than on one file, because the point is that *nothing*
    // links Baileys in — a helper importing it three files away costs exactly as much.
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
          // Prose mentions the plugin all over this codebase; only a real edge counts.
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
          // `import … from "…wa-bridge…"` is the static form. `await import(…)` is the one we want,
          // and it does not match: it has no `from`.
          if (/^(?:import|export)\b[^"']*from\s+["'][^"']*wa-bridge/.test(trimmed)) {
            offenders.push(`${path.slice(ENGINE_SRC.length + 1)}: ${trimmed}`);
          }
        }
      }
    };

    walk(ENGINE_SRC);
    expect(offenders).toEqual([]);
  });

  test("the in-process host reaches it by package name, not by path", () => {
    /**
     * The other half: the edge must exist, or this suite asserts nothing. And it must be a *name* —
     * `--external` matches the import specifier, and a relative path cannot be matched. It was a
     * relative path first and neither `--external` nor a `--define` guard could match it. The name
     * is also what `packages/wa-bridge` declares in its `exports`, which is what keeps the plugin
     * outside the workspace.
     */
    const text = source("modules/gateways/bridge-inproc.ts");
    expect(text).toContain('await import("nouride-wa-bridge")');
    expect(text).not.toMatch(/import\([^)]*internals\/wa-bridge/);
  });

  test("an unresolvable bridge fails with a sentence, not a resolver error", () => {
    /**
     * Every release carries the plugin, so the only way to reach this is a source checkout — and
     * there `bun install` is not enough: nothing depends on `nouride-wa-bridge` by name, so nothing
     * links it. The message used to say `bun install`, which changed nothing. What they need is the
     * command that does, not the name of a package they never wrote down.
     */
    const text = source("modules/gateways/bridge-inproc.ts");
    expect(text).toContain("ln -s ../packages/wa-bridge node_modules/nouride-wa-bridge");
    // And it must not send them back to a transport that no longer exists.
    expect(text).not.toContain("stdio");
  });

  test("every edition links it in, and none externalises it", () => {
    /**
     * One shape of WhatsApp, not two. It was conditional on the edition until 2026-09-16 — the
     * tarball shipped a second executable and the daemon spawned it — and the condition is gone:
     * every artefact carries the bridge in-process.
     *
     * Asserted on the build script rather than on an artefact because building a binary in a unit
     * test is a minute nobody wants to pay per run. The marker check in the build itself is what
     * proves the bundling actually happened.
     */
    const spec = readFileSync(join(import.meta.dir, "../../../../scripts/build/edition.ts"), "utf8");
    const core = readFileSync(join(import.meta.dir, "../../../../scripts/build/core.ts"), "utf8");

    // In `ALWAYS`, which every edition links — not in any edition's own `bundles`.
    expect(spec).toContain('pkg: "nouride-wa-bridge"');
    expect(core).toContain("for (const plugin of [...ALWAYS, ...edition.bundles])");
    // Never externalised: a build that leaves it out is a build that cannot do WhatsApp, and only
    // `edition.excludes` produces an `--external`, so an edition would have to ask for it by name.
    expect(readFileSync(join(import.meta.dir, "../../../../scripts/build/editions.ts"), "utf8"))
      .not.toContain("nouride-wa-bridge");
    // And there is no edition switch left to get wrong.
    expect(core).not.toContain("BUNDLE_BRIDGE");
  });

  test("there is no way to build without WhatsApp at all", () => {
    /**
     * `--no-wa-bridge` was the third shape and it is gone. It existed to save 36 MB of tarball, and
     * what it produced was a daemon that silently could not connect to a platform its own config
     * named — a support question rather than a saving. WhatsApp is always present; only its
     * topology varies.
     *
     * Asserted rather than assumed because the flag is the kind of thing that comes back: the
     * externalisation it used to control is still there, doing a different job.
     */
    const build = readFileSync(join(import.meta.dir, "../../../../scripts/build/core.ts"), "utf8");
    expect(build).not.toContain('includes("--no-wa-bridge")');
    expect(build).not.toContain("SKIP_BRIDGE");
  });

  test("the plugin exports the name the engine imports", () => {
    // The resolution half. A stale `exports` map turns the include-WhatsApp build into a build error
    // rather than a silent omission, but only if this stays in step.
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../../packages/wa-bridge/package.json"), "utf8"),
    ) as { name?: string; exports?: Record<string, string> };
    expect(pkg.name).toBe("nouride-wa-bridge");
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
    expect(pkg.exports?.["./io"]).toBe("./src/io.ts");
  });

  test("and in-process is the one transport", () => {
    const text = source("modules/gateways/bridge.ts");
    // No branch left: `ws` went in 0.7.10, and the opener always hosts the bridge here.
    expect(text).not.toContain("bridgeTransport");
    expect(text).not.toContain("WebSocket");
    expect(text).toContain('await import("./bridge-inproc.ts")');
    // The import stays inside the returned factory, not above it.
    expect(text).not.toMatch(/^import[^"']*wa-bridge/m);
  });
});

describe("the session key stays out of the environment", () => {
  test("the host hands it over directly", () => {
    const text = source("modules/gateways/bridge-inproc.ts");
    expect(text).toContain("bridge.configure(");
    // The spawned path's mechanism must not appear here. `printenv` in an agent's shell is one
    // command, and a child inherits whatever the daemon set.
    expect(text).not.toContain("NOURIDE_WA_SESSION_KEY");
    expect(text).not.toMatch(/process\.env\s*\[/);
  });

  test("and there is no spawned path left to leak it through", () => {
    // The `stdio` transport passed the key in a child's environment, which was correct while that
    // child was the bridge. There is no child now, so the variable should appear nowhere here.
    expect(source("modules/gateways/bridge.ts")).not.toContain("NOURIDE_WA_SESSION_KEY");
  });
});

describe("what a config may still say about the transport", () => {
  const whatsapp = (extra: Record<string, unknown>) => parseGateways({ whatsapp: { main: { enabled: true, ...extra } } });

  test("`inproc`, or nothing, is the bridge in this process", () => {
    expect(whatsapp({})).toHaveLength(1);
    expect(whatsapp({ bridge_transport: "inproc" })).toHaveLength(1);
  });

  test("`stdio` is refused, naming what to remove — 0.7.22 rewrote it as inproc in every file", () => {
    expect(() => whatsapp({ bridge_transport: "stdio" })).toThrow(/bridge_transport = "stdio" is gone: the bridge runs in this process.*Remove bridge_transport from this table\./);
  });

  test("`ws` is refused at load, with what to do instead", () => {
    // It dialled a bridge running elsewhere, which nothing in this repository served. Read as in-process it would
    // start a second session for the number here instead of saying what changed.
    expect(() => whatsapp({ bridge_transport: "ws", bridge_url: "ws://wa:8099" })).toThrow(
      /bridge_transport = "ws" is gone: the bridge runs in this process, one WhatsApp number per daemon\. Remove bridge_transport and bridge_url/,
    );
    expect(() => whatsapp({ bridge_transport: "carrier-pigeon" })).toThrow(/bridge_transport must be "inproc", or left out/);
  });

  test("and a save from the dashboard writes no transport, nor reads one", () => {
    const text = source("modules/config/settings/gateways.ts");
    expect(text).not.toContain("bridgeTransport");
    expect(text).not.toContain("values.bridge_transport");
  });
});
