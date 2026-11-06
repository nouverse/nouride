/**
 * The private source map is the map of the code that ships — proven by symbolizing a real crash, from a binary and
 * from an image's bundle.
 *
 * A fixture is compiled the way the build compiles (`compileFlags`), with no map, and `compileMap` makes its map
 * the way the build does. The fixture carries the three things that make a compile's code differ from a plain
 * bundle's — a `#!` line, a `with { type: "text" }` import and a `process.platform` test — so a map from any other
 * route would be off here as it was off on the daemon. Then the binary is run, it throws at a known line, and its
 * stack, read against the map, has to name that file, that line and that function. The same fixture goes through
 * `writeImageBundle`, the image's path, and its bundle is run the way the image runs it.
 *
 * And the tarballs: a source map, or a reference to one, in a tarball fails the build.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@nouride/runtime";
import { assertTarballCarriesNoMap, bundleFlags, compileFlags, compileMap, writeImageBundle } from "../../../../scripts/build/core.ts";
import { PUBLIC_EDITIONS } from "../../../../scripts/build/editions.ts";
import {
  entryCode,
  mapFitsBinary,
  mapFitsBundle,
  mapsInTarball,
  sourceMapReferences,
  STAMP_FIELD,
  stampMap,
  type RawSourceMap,
} from "../../../../scripts/build/source-map.ts";
import { symbolize } from "../../../../scripts/symbolize.ts";
import { parseFrames } from "../../../../scripts/symbolize/resolve.ts";

const ROOT = new URL("../../../..", import.meta.url).pathname;
/** Put together at run time: written out, this file would carry a map reference, which `lint:public` refuses. */
const REF = ["//# sourceMappingURL", ""].join("=");
const run = (argv: string[], cwd = ROOT) =>
  runCommand(argv, { cwd, timeoutMs: 90_000, maxOutputBytes: 256_000, env: process.env as Record<string, string> });

const MAIN = [
  "#!/usr/bin/env bun",
  `import notes from "./notes.txt" with { type: "text" };`,
  `import { readConfig } from "./lib/config.ts";`,
  ``,
  `function platformNote(): string {`,
  `  if (process.platform === "plan9") return "never";`,
  `  return notes.trim();`,
  `}`,
  ``,
  `try {`,
  `  readConfig(platformNote());`,
  `} catch (err) {`,
  `  console.log((err as Error).stack);`,
  `}`,
].join("\n");

const CONFIG = [
  `import { ConfigError } from ${JSON.stringify(join(ROOT, "packages/shared/src/errors.ts"))};`,
  ``,
  `export class Loader {`,
  `  load(text: string): number {`,
  `    const values = text.split(",").map((part) => {`,
  `      if (part === "bad") throw new ConfigError("[memory] dir is not a directory"); // line 6`,
  `      return part.length;`,
  `    });`,
  `    return values.length;`,
  `  }`,
  `}`,
  ``,
  `export function readConfig(text: string): number {`,
  // Not a call in tail position: JavaScriptCore makes that a proper tail call and the frame is gone — and the
  // minifier folds `const n = f(); return n;` into one, so the result is used before it is returned.
  `  const count = new Loader().load(text);`,
  `  return count + 1;`,
  `}`,
].join("\n");

let dir: string;
let binary: string;
let map: RawSourceMap;
let stack: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nr-source-map-"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "main.ts"), MAIN);
  writeFileSync(join(dir, "lib/config.ts"), CONFIG);
  writeFileSync(join(dir, "notes.txt"), "ok,bad,ok\n");
  binary = join(dir, "shipped");
  const compile = ["bun", "build", ...compileFlags(PUBLIC_EDITIONS[0]!)];
  const built = await run([...compile, "--outfile", binary, "main.ts"], dir);
  if (built.exitCode !== 0) throw new Error(built.stderr);
  mkdirSync(join(dir, "scratch"));
  ({ map } = await compileMap(compile, "main.ts", binary, join(dir, "scratch"), dir));
  stack = (await run([binary], dir)).stdout;}, 180_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the private source map", () => {
  test("is not in the binary: the shipped stack names positions, not files", () => {
    expect(stack.split("\n")[0]).toBe("ConfigError: [memory] dir is not a directory");
    expect(parseFrames(stack).length).toBeGreaterThanOrEqual(3);
    expect(stack).not.toContain("config.ts");
  });

  test("puts the compiled binary's frames back on the right file, line and function", () => {
    const report = symbolize(stack, map, "fixture").split("\n");
    expect(report[1]).toBe("error: ConfigError");
    const resolved = report.filter((line) => /^ {3}\S+:\d+:\d+ {2}in /.test(line));
    // The throw, inside the arrow inside Loader.load; then load; then readConfig; then the top level of main.ts.
    expect(resolved.slice(0, 4).map((line) => line.trim().replace(/:\d+ {2}in /, "  in "))).toEqual([
      "lib/config.ts:6  in <anonymous> in Loader.load",
      "lib/config.ts:5  in Loader.load",
      "lib/config.ts:14  in readConfig",
      "main.ts:11  in <module>",
    ]);
    expect(report.join("\n")).toContain(`| if (part === "bad") throw new ConfigError(`);
  });

  test("is said to be wrong when it is the map of other code, and the build refuses it", async () => {
    // The same fixture with one more statement: a real map, of a different binary.
    writeFileSync(join(dir, "other.ts"), `${MAIN}\nconsole.log("one more line");\n`);
    const other = join(dir, "scratch", "other");
    const built = await run(["bun", "build", ...compileFlags(PUBLIC_EDITIONS[0]!), "--sourcemap=external", "--outfile", other, "other.ts"], dir);
    expect(built.exitCode).toBe(0);
    const otherShipped = join(dir, "scratch", "other-shipped");
    expect((await run(["bun", "build", ...compileFlags(PUBLIC_EDITIONS[0]!), "--outfile", otherShipped, "other.ts"], dir)).exitCode).toBe(0);
    const otherMap = JSON.parse(readFileSync(`${other}.map`, "utf8")) as RawSourceMap;
    const bytes = (path: string) => new Uint8Array(readFileSync(path));

    expect(mapFitsBinary(otherMap, bytes(otherShipped), bytes(other))).toBeNull(); // its own binary: it fits
    expect(mapFitsBinary(otherMap, bytes(binary), bytes(other))).toMatch(/carries different code from the shipped one/);
    expect(mapFitsBinary(map, bytes(otherShipped), bytes(other))).toMatch(/the map's debugId .* is not the one/);
    const longer = { ...otherMap, mappings: `${otherMap.mappings}${";".repeat(40)}` };
    expect(mapFitsBinary(longer, bytes(otherShipped), bytes(other))).toMatch(/describes \d+ lines and the code has/);
    const shifted = { ...otherMap, mappings: otherMap.mappings.replace(/^(;*)/, "$1;") };
    expect(mapFitsBinary(shifted, bytes(otherShipped), bytes(other))).toMatch(/is \d+ long and the map has a mapping at column/);
  });

  test("finds the entry module in a compiled binary, #! line included", () => {
    const code = entryCode(new Uint8Array(readFileSync(binary)))!.toString("utf8");
    expect(code.startsWith("#!/usr/bin/env bun\n// @bun\n")).toBe(true);
    expect(code).toContain("[memory] dir is not a directory");
  });
});

describe("an image's bundle", () => {
  /** What the image ships, its map, and what running it the way the image does prints. */
  let shipped: Buffer;
  let imageMap: RawSourceMap;
  let imageStack: string;
  const binaryMap = (): RawSourceMap =>
    stampMap(map, { version: "0.0.0", edition: "basic", target: "linux-x64", codeSha256: "x" }, (source) => source);

  beforeAll(async () => {
    const out = join(dir, "app", "nouride.bundle.js");
    mkdirSync(join(dir, "app"));
    const mapPath = await writeImageBundle(PUBLIC_EDITIONS[0]!, { entry: "main.ts", out, mapDir: join(dir, "image"), cwd: dir });
    expect(mapPath).toBe(join(dir, "image", "nouride-image.map"));
    shipped = readFileSync(out);
    imageMap = JSON.parse(readFileSync(mapPath, "utf8")) as RawSourceMap;
    // The map is not beside the bundle, as in the image: Bun would apply a `nouride.bundle.js.map` there itself.
    imageStack = (await run(["bun", "--no-install", out], dir)).stdout;
  }, 60_000);

  test("reads the platform when it runs, so the one bundle can be compiled for any target", () => {
    // `--bundle-only` writes this bundle. A compile folds `process.platform` into the target's literal, and code lifted
    // out of a linux-x64 binary and compiled for a Mac believed it was Linux (finding 3 of issue #7 on
    // nouride-releases); this bundle keeps the test, so `bun build --compile --target=bun-darwin-arm64` of it is a Mac's.
    const text = shipped.toString("utf8");
    expect(text).toContain("process.platform");
    expect(text).toContain('"plan9"');
  });

  test("is mangled, names no map, and is stamped for the image with the hash of exactly what ships", () => {
    const text = shipped.toString("utf8");
    expect({ platformNote: text.includes("platformNote"), readConfig: text.includes("readConfig") }).toEqual({
      platformNote: false,
      readConfig: false,
    });
    expect(text).toContain('"ConfigError"'); // the literal, which is what a log is searched by
    expect(sourceMapReferences(text)).toEqual([]);
    expect(text).not.toContain("debugId");
    expect(imageMap[STAMP_FIELD]).toMatchObject({
      edition: "basic",
      target: "image",
      codeSha256: createHash("sha256").update(shipped).digest("hex"),
    });
    expect(imageMap.sources).toEqual(expect.arrayContaining(["main.ts", "lib/config.ts"]));
  });

  test("is byte for byte what a build without a map writes", async () => {
    const plain = join(dir, "plain");
    const built = await run(["bun", "build", ...bundleFlags(PUBLIC_EDITIONS[0]!), "--outdir", plain, "--entry-naming", "x.js", "main.ts"], dir);
    expect(built.exitCode).toBe(0);
    expect(readFileSync(join(plain, "x.js")).equals(shipped)).toBe(true);
  });

  test("puts the image's frames back on the right file, line and function", () => {
    expect(parseFrames(imageStack).map((frame) => frame.kind)).toEqual(["image", "image", "image", "image"]);
    const report = symbolize(imageStack, imageMap, "fixture image").split("\n");
    expect(report[1]).toBe("error: ConfigError");
    const resolved = report.filter((line) => /^ {3}\S+:\d+:\d+ {2}in /.test(line));
    expect(resolved.map((line) => line.trim().replace(/:\d+ {2}in /, "  in "))).toEqual([
      "lib/config.ts:6  in <anonymous> in Loader.load",
      "lib/config.ts:5  in Loader.load",
      "lib/config.ts:14  in readConfig",
      "main.ts:11  in <module>",
    ]);
  });

  test("a binary's frames are not read with an image's map, nor an image's with a binary's", () => {
    expect(symbolize(stack, imageMap, "h")).toContain("not read: a frame from a binary and the map of an image");
    expect(symbolize(imageStack, binaryMap(), "h")).toContain("not read: a frame from an image and the map of a binary — run again with --target image");
    expect(symbolize(imageStack, binaryMap(), "h")).not.toContain("lib/config.ts");
  });

  test("is refused with a map it does not fit", () => {
    const withTrailer = (code: Buffer, id = imageMap.debugId) => Buffer.concat([code, Buffer.from(`\n//# debugId=${id}\n`)]);
    const fits = mapFitsBundle(imageMap, withTrailer(shipped));
    expect("code" in fits && fits.code.equals(shipped)).toBe(true);

    expect(mapFitsBundle(imageMap, shipped)).toEqual({ problem: expect.stringContaining("does not end with the `//# debugId=` line") });
    expect(mapFitsBundle(imageMap, withTrailer(shipped, "0123456789ABCDEF"))).toEqual({ problem: expect.stringMatching(/the map's debugId .* is not the one/) });
    const named = Buffer.concat([shipped, Buffer.from(`${REF}nouride.bundle.js.map\n`)]);
    expect(mapFitsBundle(imageMap, withTrailer(named))).toEqual({ problem: expect.stringContaining("the bundle names a source map") });
    const shifted = { ...imageMap, mappings: imageMap.mappings.replace(/^(;*)/, "$1;") };
    expect(mapFitsBundle(shifted, withTrailer(shipped))).toEqual({ problem: expect.stringMatching(/is \d+ long and the map has a mapping at column/) });
  });
});

describe("a tarball", () => {
  test("with a .map in it, or a map reference in a file, is named; Bun's own strings are not", () => {
    expect(mapsInTarball([{ name: "nouride.map", text: "" }])).toEqual(["nouride.map: a source map"]);
    expect(mapsInTarball([{ name: "nouride", text: `x\n${REF}nouride.js.map\n` }])).toEqual([`nouride: ${REF}nouride.js.map`,
    ]);
    const inline = `${REF}data:application/json;base64,${"eyJ2ZXJzaW9uIjozfQ".repeat(4)}`;
    expect(mapsInTarball([{ name: "dashboard/a.js", text: inline }])).toHaveLength(1);
    // A compiled binary carries `sourceMappingURL=` in Bun's runtime strings; those are not a map.
    expect(mapsInTarball([{ name: "nouride", text: readFileSync(binary).toString("latin1") }])).toEqual([]);
  });

  test("the build's own check refuses one that carries a map, and passes one that does not", async () => {
    const stage = join(dir, "stage");
    mkdirSync(join(stage, "dashboard"), { recursive: true });
    writeFileSync(join(stage, "nouride"), "binary");
    writeFileSync(join(stage, "dashboard/index.js"), "console.log(1)\n");
    const tar = async (name: string, items: string[]) => {
      const out = join(dir, name);
      expect((await run(["tar", "-czf", out, "-C", stage, ...items], dir)).exitCode).toBe(0);
      return out;
    };
    await assertTarballCarriesNoMap(await tar("clean.tar.gz", ["nouride", "dashboard"]));

    writeFileSync(join(stage, "nouride.map"), "{}");
    await expect(assertTarballCarriesNoMap(await tar("with-map.tar.gz", ["nouride", "nouride.map"]))).rejects.toThrow(
      /nouride\.map: a source map/,
    );
    writeFileSync(join(stage, "dashboard/index.js"), `console.log(1)\n${REF}index.js.map\n`);
    await expect(assertTarballCarriesNoMap(await tar("with-ref.tar.gz", ["nouride", "dashboard"]))).rejects.toThrow(
      /sourceMappingURL=index\.js\.map/,
    );
  });
});
