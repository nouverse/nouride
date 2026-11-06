/**
 * The WhatsApp bridge never pulls in the GPL-3.0 `libsignal`.
 *
 * Baileys depends on `libsignal`, and the npm package of that name is GPL-3.0: the one thing that
 * would make a binary carrying the bridge a combined work. The bridge points it at a local MIT shim
 * (`packages/wa-bridge/shims/libsignal`, forwarding to `whatsapp-rust-bridge`). Since the bridge
 * became a workspace member that override has to live in the ROOT manifest — overrides only apply
 * there — and a stray edit to it would install the real package with nothing failing. This fails.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");
const SHIM = "file:./packages/wa-bridge/shims/libsignal";

describe("libsignal", () => {
  test("the root manifest points it at the shim", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { overrides?: Record<string, string> };
    expect(manifest.overrides?.libsignal).toBe(SHIM);
  });

  test("every copy in bun.lock is the shim, never a registry package", () => {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    // Package entries: `"<path>/libsignal": ["libsignal@<resolution>", …]`.
    const resolutions = [...lock.matchAll(/"(?:[^"]*\/)?libsignal":\s*\["libsignal@([^"]+)"/g)].map((m) => m[1]!);
    expect(resolutions.length).toBeGreaterThan(0);
    for (const resolution of resolutions) expect({ resolution, shim: resolution.startsWith("file:") && resolution.includes("wa-bridge/shims/libsignal") }).toEqual({ resolution, shim: true });
  });

  test("the shim declares what it forwards to, at the version Baileys itself uses", () => {
    // It imported `whatsapp-rust-bridge` without declaring it and resolved only through the store's hoisted fallback,
    // which held whichever version Baileys happened to depend on: a Baileys upgrade, or an install that skipped
    // dev dependencies, changed what the shim loaded with no manifest saying so.
    const shim = JSON.parse(readFileSync(join(ROOT, "packages/wa-bridge/shims/libsignal/package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    const baileys = /"@whiskeysockets\/baileys": \["@whiskeysockets\/baileys@[^"]+", "", \{ "dependencies": \{[^}]*"whatsapp-rust-bridge": "([^"]+)"/.exec(lock)?.[1];
    expect(baileys).toBeDefined();
    expect(shim.dependencies?.["whatsapp-rust-bridge"]).toBe(baileys);
    // And the lock installs it beside each copy of the shim, not only somewhere above it.
    const copies = [...lock.matchAll(/"[^"]*\/libsignal": \["libsignal@file:[^"]+", (\{[^\]]*\})\]/g)].map((m) => m[1]);
    expect(copies.length).toBeGreaterThan(0);
    for (const meta of copies) expect(meta).toContain(`"whatsapp-rust-bridge": "${baileys}"`);
  });

  test("the shim is ours, not a copy of the GPL package", () => {
    const shim = JSON.parse(readFileSync(join(ROOT, "packages/wa-bridge/shims/libsignal/package.json"), "utf8")) as { private?: boolean; license?: string };
    expect(shim.private).toBe(true);
    expect(shim.license ?? "").not.toMatch(/GPL/i);
  });
});
