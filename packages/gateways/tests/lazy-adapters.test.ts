/**
 * The platform SDKs must not be reachable from the barrel by a static edge.
 *
 * This is a source-shape test, which is unusual here, and the reason is that the property it guards
 * is invisible at runtime and expensive in production. `discord.js` costs **16.2 MB of RSS** and
 * `grammy` **0.7 MB** simply by being evaluated — measured on the Pi, two daemons, same config, one
 * with the SDKs stubbed out. That cost is paid at boot whether or not a connection of that kind is
 * configured, so a 415 MB box running Telegram only was renting 16 MB to a platform it had never
 * spoken to.
 *
 * `createGateway` defers them with `await import()`. Nothing fails if somebody undoes that: adding
 * `import { DiscordGateway } from "./channels/discord/gateway.ts"` to the barrel, or re-exporting
 * the class as a value, compiles clean, passes every other test, and quietly puts the 16 MB back.
 * A bundler follows a re-export exactly as eagerly as an import, which is the part that is easy to
 * miss — `export { X } from` is a static edge and `export type { X } from` is not.
 *
 * So the assertion is on the edge itself. It reads the barrel rather than the bundle because the
 * bundle is not decisive: a single-file build still *contains* the deferred module, it just never
 * evaluates it, so searching the output for the library name would fail on a correct build.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BARREL = join(import.meta.dir, "../src/index.ts");

/** Modules that pull a platform SDK in behind them. */
const HEAVY = ["./channels/discord/gateway.ts", "./channels/telegram/gateway.ts"];

/**
 * Every static edge out of the barrel: `import … from "x"` and `export … from "x"`, minus the
 * type-only forms, which the compiler erases and a bundler therefore never follows.
 */
function staticEdges(source: string): string[] {
  const edges: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import type") || trimmed.startsWith("export type")) continue;
    const from = /^(?:import|export)\b[^"']*from\s+["']([^"']+)["']/.exec(trimmed);
    if (from) edges.push(from[1] as string);
    // A bare side-effect import — `import "./x.ts"` — is a static edge with no clause to match above.
    const bare = /^import\s+["']([^"']+)["']/.exec(trimmed);
    if (bare) edges.push(bare[1] as string);
  }
  return edges;
}

describe("the barrel does not drag a platform SDK in", () => {
  const source = readFileSync(BARREL, "utf8");
  const edges = staticEdges(source);

  for (const heavy of HEAVY) {
    test(`no static edge to ${heavy}`, () => {
      // Named rather than just counted: the failure message has to say which one came back, because
      // the fix is to move it into the `await import()` inside `createGateway`.
      expect({ module: heavy, staticallyImported: edges.includes(heavy) }).toEqual({
        module: heavy,
        staticallyImported: false,
      });
    });
  }

  test("the type-only re-exports are still there", () => {
    // The other half of the bargain. Dropping the edge is only correct because the types stayed
    // reachable; a consumer that can no longer name `DiscordGatewayOptions` would import the module
    // itself and put the 16 MB back from the outside.
    expect(source).toContain('export type { DiscordCacheLimits, DiscordGatewayOptions }');
    expect(source).toContain('export type { TelegramGatewayOptions }');
  });

  test("the deferred imports are the ones that exist", async () => {
    // Guards the rename that a source-shape test would otherwise sail past: if a gateway module
    // moves, `HEAVY` goes stale and starts asserting nothing at all.
    for (const heavy of HEAVY) {
      const resolved = join(import.meta.dir, "../src", heavy.replace("./", ""));
      expect({ module: heavy, exists: readFileSync(resolved, "utf8").length > 0 }).toEqual({
        module: heavy,
        exists: true,
      });
    }
  });
});
