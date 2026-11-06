/**
 * `bun run symbolize`: a crash from a customer's box, back to source — deterministically, from the map of exactly
 * that build, and never from another build's map.
 *
 * The end-to-end proof against a compiled binary is `source-map.test.ts`. This holds the pieces to their word: the
 * frames found in a journal excerpt, the function named for a position, the map chosen — or refused — for a build.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@nouride/runtime";
import { STAMP_FIELD, type RawSourceMap } from "../../../../scripts/build/source-map.ts";
import { findMap, internalRepoFor, mapNameFor, symbolize } from "../../../../scripts/symbolize.ts";
import { enclosingFunction, errorNames, parseFrames } from "../../../../scripts/symbolize/resolve.ts";

const ROOT = new URL("../../../..", import.meta.url).pathname;
const run = (argv: string[], cwd = ROOT, stdin?: string) =>
  runCommand(argv, { cwd, timeoutMs: 60_000, maxOutputBytes: 256_000, env: process.env as Record<string, string>, ...(stdin ? { stdin } : {}) });

const SOURCE = [
  `export class Store {`,
  `  open(path: string): string {`,
  `    if (path === "") throw new Error("no path");`,
  `    return path;`,
  `  }`,
  `}`,
  `export const pick = (items: string[]) => items.map((item) => new Store().open(item));`,
].join("\n");

let dir: string;
let map: RawSourceMap;
/** A frame at the `throw`, in the bundle's own coordinates, as a compiled binary would print it. */
let frameAtThrow: string;

const ID = { version: "0.7.10", edition: "pro", target: "linux-x64" };
const stamped = (stamp: Partial<typeof ID>): RawSourceMap => ({ ...map, [STAMP_FIELD]: { ...ID, codeSha256: "x", ...stamp } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nr-symbolize-"));
  writeFileSync(join(dir, "store.ts"), SOURCE);
  const built = await run(["bun", "build", "--minify", "--sourcemap=external", "--outdir", join(dir, "out"), "store.ts"], dir);
  if (built.exitCode !== 0) throw new Error(built.stderr);
  map = JSON.parse(readFileSync(join(dir, "out/store.js.map"), "utf8")) as RawSourceMap;
  const code = readFileSync(join(dir, "out/store.js"), "utf8").split("\n");
  const line = code.findIndex((text) => text.includes("throw"));
  frameAtThrow = `at open (/$bunfs/root/nouride:${line + 1}:${code[line]!.indexOf("throw") + 1})`;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("frames", () => {
  test("are found in a plain stack and in a journal line whose stack is an escaped JSON string", () => {
    const journal =
      `Oct 17 10:00:01 box nouride[812]: {"level":"error","message":"uncaught exception","data":{"error":"x",` +
      `"stack":"ConfigError: bad\\n    at Rie (/$bunfs/root/nouride:41:6983)\\n    at async Ax (/$bunfs/root/nouride:43:928)\\n    at /$bunfs/root/nouride:1627:4447"}}`;
    expect(parseFrames(journal)).toEqual([
      { printed: "Rie", line: 41, column: 6983, kind: "binary" },
      { printed: "Ax", line: 43, column: 928, kind: "binary" },
      { printed: null, line: 1627, column: 4447, kind: "binary" },
    ]);
    expect(errorNames(journal)).toEqual(["ConfigError"]);
    // A frame with its own file name has nothing to resolve.
    expect(parseFrames("    at run (/home/x/apps/engine/src/index.ts:3:1)\n    at map (native:1:11)")).toEqual([]);
  });

  test("are found in a container's log, as the image's bundle prints them", () => {
    const logs = [
      `TypeError: null is not an object (evaluating 'A.minutes')`,
      `      at <anonymous> (/app/nouride.bundle.js:2059:38454)`,
      `      at async n (file:///app/nouride.bundle.js:2058:284)`,
      `{"level":"error","data":{"stack":"Error: x\\n    at Rie (/app/nouride.bundle.js:41:6983)"}}`,
    ].join("\n");
    expect(parseFrames(logs)).toEqual([
      { printed: "<anonymous>", line: 2059, column: 38454, kind: "image" },
      { printed: "n", line: 2058, column: 284, kind: "image" },
      { printed: "Rie", line: 41, column: 6983, kind: "image" },
    ]);
    // Another bundle's frame is not the image's: only `nouride.bundle.js` is.
    expect(parseFrames("    at x (/app/other.bundle.js:1:2)")).toEqual([]);
  });

  test("are named by the function around them, however that function is written", () => {
    const text = [
      `class Store {`, //                                              0
      `  constructor() { go(); }`, //                                  1
      `  get size() { return go(); }`, //                              2
      `  open = () => go();`, //                                       3
      `  read(ids: string[]) { return ids.map((id) => go(id)); }`, //  4
      `}`,
      `const load = function () { go(); };`, //                        6
      `export function boot() { [1].forEach(function () { go(); }); }`, // 7
      `go();`, //                                                      8
    ].join("\n");
    const at = (line: number) => enclosingFunction("x.ts", text, line, text.split("\n")[line]!.lastIndexOf("go("));
    expect([1, 2, 3, 4, 6, 7, 8].map(at)).toEqual([
      "Store.constructor",
      "Store.get size",
      "Store.open",
      "<anonymous> in Store.read",
      "load",
      "<anonymous> in boot",
      "<module>",
    ]);
  });
});

describe("a report", () => {
  test("names the source line and function of a frame, and is the same every time", () => {
    const input = `Error: no path\n    ${frameAtThrow}\n`;
    const first = symbolize(input, stamped({}), "nouride 0.7.10 pro linux-x64");
    expect(first.split("\n").slice(1)).toEqual([
      "error: Error",
      expect.stringMatching(/^#1 open at \d+:\d+$/),
      // The source as the map names it: relative to where that build ran, which for the daemon is the checkout.
      expect.stringMatching(/store\.ts:3:\d+ {2}in Store\.open$/),
      `   | if (path === "") throw new Error("no path");`,
    ]);
    expect(symbolize(input, stamped({}), "nouride 0.7.10 pro linux-x64")).toBe(first);
  });

  test("says a frame outside the map is outside it, rather than borrowing the nearest line", () => {
    expect(symbolize("at x (/$bunfs/root/nouride:9999:1)", map, "h")).toContain("not in the map");
  });
});

describe("the map for a build", () => {
  test("is found by its stamp, and another version's, edition's or target's map is refused by name", () => {
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    const name = mapNameFor(ID);
    expect(name).toBe("nouride-pro-linux-x64.map");
    const cache = join(dir, "cache");
    for (const [stamp, said] of [
      [{ version: "0.7.9" }, "it is the map of 0.7.9 pro linux-x64"],
      [{ edition: "basic" }, "it is the map of 0.7.10 basic linux-x64"],
      [{ target: "linux-arm64" }, "it is the map of 0.7.10 pro linux-arm64"],
    ] as const) {
      writeFileSync(join(dist, name), JSON.stringify(stamped(stamp)));
      const found = findMap(ID, { dist, cache, offline: true });
      expect("looked" in found && found.looked[0]).toEndWith(`not used — ${said}`);
    }
    writeFileSync(join(dist, name), JSON.stringify({ ...map }));
    const unstamped = findMap(ID, { dist, cache, offline: true });
    expect("looked" in unstamped && unstamped.looked[0]).toContain("carries no build stamp");

    writeFileSync(join(dist, name), JSON.stringify(stamped({})));
    // Used, and said to be a local build: one built at another path is not the release's code byte for byte.
    expect(findMap(ID, { dist, cache, offline: true })).toMatchObject({
      map: { [STAMP_FIELD]: { version: "0.7.10" } },
      from: expect.stringContaining("(this checkout's own build, not the release's)"),
    });
  });

  test("is downloaded when it is nowhere local, kept only if it is that build's, and never for --offline or a host build", () => {
    const dist = join(dir, "empty-dist");
    const cache = join(dir, "dl-cache");
    let calls = 0;
    const serving = (map: RawSourceMap) => (id: typeof ID, into: string) => {
      calls += 1;
      mkdirSync(into, { recursive: true });
      writeFileSync(join(into, mapNameFor(id)), JSON.stringify(map));
      return { ok: true, detail: "" };
    };

    expect(findMap(ID, { dist, cache, offline: true, fetch: serving(stamped({})) })).toHaveProperty("looked");
    expect(findMap({ ...ID, target: "host" }, { dist, cache, fetch: serving(stamped({})) })).toHaveProperty("looked");
    expect(calls).toBe(0);

    const wrong = findMap(ID, { dist, cache, fetch: serving(stamped({ version: "0.7.9" })) });
    expect("looked" in wrong && wrong.looked.at(-1)).toContain("it is the map of 0.7.9");
    expect(() => readFileSync(join(cache, "0.7.10", mapNameFor(ID)))).toThrow(); // not kept

    const right = findMap(ID, { dist, cache, fetch: serving(stamped({})) });
    expect(right).toHaveProperty("map");
    // And the next run is offline-capable: it is in the cache now.
    expect(findMap(ID, { dist, cache, offline: true })).toHaveProperty("map");
    expect(calls).toBe(2);
  });

  test("for an image is one per edition, looked for like a binary's, and the CLI takes --target image", async () => {
    expect(mapNameFor({ version: "0.7.10", edition: "basic", target: "image" })).toBe("nouride-image.map");
    expect(mapNameFor({ version: "0.7.10", edition: "pro", target: "image" })).toBe("nouride-pro-image.map");
    let asked = "";
    const missing = findMap({ ...ID, target: "image" }, {
      dist: join(dir, "no-dist"),
      cache: join(dir, "image-cache"),
      fetch: (id) => {
        asked = mapNameFor(id);
        return { ok: false, detail: "no assets match the file pattern" };
      },
    });
    expect(asked).toBe("nouride-pro-image.map");
    expect("looked" in missing && missing.looked.at(-1)).toBe("nouverse/nouride-legacy release v0.7.10: no assets match the file pattern");

    const cli = await run(
      ["bun", "scripts/symbolize.ts", "--version", "0.0.1", "--edition", "basic", "--target", "image", "--offline", "-"],
      ROOT,
      "at x (/app/nouride.bundle.js:1:1)\n",
    );
    expect(cli.exitCode).toBe(2);
    expect(cli.stderr).toContain("no source map for nouride 0.0.1 basic image — nothing is resolved");
  });

  test("missing, the CLI says so and resolves nothing", async () => {
    const out = await run(
      ["bun", "scripts/symbolize.ts", "--version", "0.0.1", "--edition", "basic", "--target", "linux-x64", "--offline", "-"],
      ROOT,
      `Error: x\n    ${frameAtThrow}\n`,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("no source map for nouride 0.0.1 basic linux-x64 — nothing is resolved");
    expect(out.stdout).toBe("");
    const usage = await run(["bun", "scripts/symbolize.ts", "--version", "0.0.1"]);
    expect(usage.exitCode).toBe(1);
  });
});

test("a version's maps are read from the private release that holds them: legacy up to 0.8.20, nouride-pro after", () => {
  expect(internalRepoFor("0.7.10")).toBe("nouverse/nouride-legacy");
  expect(internalRepoFor("0.8.20")).toBe("nouverse/nouride-legacy");
  expect(internalRepoFor("0.8.21")).toBe("nouverse/nouride-pro");
  expect(internalRepoFor("1.0.0")).toBe("nouverse/nouride-pro");
});
