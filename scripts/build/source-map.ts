/**
 * The private source map every build writes beside what it ships, and the checks that keep it honest.
 *
 * Release builds mangle identifiers and ship no map, so a frame in a customer's journal reads
 * `/$bunfs/root/nouride:2:913421` from a binary, or `/app/nouride.bundle.js:2:913421` from an image. The map that
 * turns that back into `file:line` is only worth anything if it was written for exactly those bytes:
 *
 * - a binary's comes from a second compile with `--sourcemap=external` (`writePrivateMap` in `core.ts` says why
 *   nothing else will do), and `mapFitsBinary` proves that binary's code is the shipped one's, byte for byte;
 * - an image's comes from the same `bun build` that writes the bundle, and `mapFitsBundle` proves what ships is
 *   that output with nothing taken away but the `//# debugId=` line Bun appends after the last line of code.
 *
 * The build refuses to write a map it does not hold. Nothing here does I/O: the build and the tests both call it.
 */

/** What a map says it is for. `symbolize` refuses a map whose stamp is not the build it was asked about. */
export interface MapStamp {
  version: string;
  edition: string;
  /** `linux-x64`, `linux-arm64-musl`… `host` for a build for this machine, `image` for a Docker image's bundle. */
  target: string;
  /**
   * SHA-256 of the code every frame's position is counted in: a binary's entry module, or an image's whole
   * `/app/nouride.bundle.js` — which `release.yml` reads back out of the pushed image and compares to this.
   */
  codeSha256: string;
}

/** The field a stamp is kept under — `x_` is how a source map carries a field of its own. */
export const STAMP_FIELD = "x_nouride";

/**
 * The target a Docker image's map is stamped with, and named after: `nouride-image.map`, `nouride-pro-image.map`.
 * One per edition, not per architecture: the bundle is plain JavaScript, built once on the build platform
 * (`--platform=$BUILDPLATFORM` in the Dockerfile) and copied into the amd64 and the arm64 image alike.
 */
export const IMAGE_TARGET = "image";

/** The map Bun wrote, as JSON. Only the fields this module reads or writes are typed. */
export interface RawSourceMap {
  version: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  names: string[];
  mappings: string;
  debugId?: string;
  [STAMP_FIELD]?: MapStamp;
  [other: string]: unknown;
}

const TRAILER = Buffer.from("\n---- Bun! ----\n");
const PRAGMA = Buffer.from("// @bun\n");

/**
 * The entry module's code as a compiled binary carries it: from its first line — a `#!` line, when the entry has
 * one — to the NUL after it.
 *
 * Bun 1.4.2 appends the module graph to the runtime and ends the file with `\n---- Bun! ----\n`. The entry is the
 * last module in the graph that starts with the `// @bun` pragma; what follows it are embedded files (the SQL) and
 * the graph's own table, neither of which carries the pragma. The runtime carries `// @bun` as strings of its
 * own, all far before the graph, so searching back from the trailer meets the entry first. `null` when the
 * layout is not that — a newer Bun, say — which `mapFitsBinary` reports rather than guessing around.
 */
export function entryCode(binary: Uint8Array): Buffer | null {
  const bytes = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const trailer = bytes.lastIndexOf(TRAILER);
  if (trailer < 0) return null;
  let start = bytes.lastIndexOf(PRAGMA, trailer);
  if (start < 0) return null;
  // A `#!` line right before the pragma is the entry's first line (`cli/main.ts` has one), and the map counts it.
  // It sits straight after the previous record — padding in one binary, the end of a hash in another — so it is
  // found by walking back over printable ASCII to its `#!`, not by looking for a line break before it.
  if (bytes[start - 1] === 0x0a) {
    for (let at = start - 2; at >= Math.max(0, start - 256) && bytes[at]! >= 0x20 && bytes[at]! <= 0x7e; at -= 1) {
      if (bytes[at] === 0x23 && bytes[at + 1] === 0x21) {
        start = at;
        break;
      }
    }
  }
  const end = bytes.indexOf(0, start);
  if (end < 0 || end > trailer) return null;
  return bytes.subarray(start, end);
}

/**
 * What `--sourcemap=external` adds to the code: a `//# debugId=` line after the last line of code, so it moves no
 * position the map describes. `null` when `mapped` is not `shipped` followed by exactly that.
 */
function debugIdAfter(shipped: Buffer, mapped: Buffer): string | null {
  if (mapped.length < shipped.length || !mapped.subarray(0, shipped.length).equals(shipped)) return null;
  const tail = /^\n*\/\/# debugId=([0-9A-Fa-f-]+)\s*$/.exec(mapped.subarray(shipped.length).toString("latin1"));
  return tail ? tail[1]! : null;
}

/**
 * Why `map` does not describe the code in `shipped`, or `null` when it does.
 *
 * `mapped` is the binary the map was written beside. Three things are asked of it:
 *
 * 1. Both binaries have an entry module where `entryCode` looks.
 * 2. The shipped code is the mapped binary's, byte for byte, once its `//# debugId=` line is cut. Positions in a
 *    stack trace are counted in that code, so identical bytes give identical `line:col` for every frame.
 * 3. The map is the one written for that code: its `debugId` is the one the mapped code ends with, and no
 *    mapping points past the end of a line of it.
 */
export function mapFitsBinary(map: RawSourceMap, shipped: Uint8Array, mapped: Uint8Array): string | null {
  const shippedCode = entryCode(shipped);
  if (!shippedCode) return "the shipped binary has no entry module where Bun 1.4.2 puts one";
  const mappedCode = entryCode(mapped);
  if (!mappedCode) return "the binary built with the map has no entry module where Bun 1.4.2 puts one";
  const debugId = debugIdAfter(shippedCode, mappedCode);
  if (debugId === null) {
    let at = 0;
    while (at < shippedCode.length && shippedCode[at] === mappedCode[at]) at += 1;
    return (
      `the binary built with the map carries different code from the shipped one, from byte ${at} ` +
      `(${shippedCode.length} bytes shipped, ${mappedCode.length} mapped) — a flag differs between the two compiles`
    );
  }
  if (map.debugId?.toUpperCase() !== debugId.toUpperCase()) {
    return `the map's debugId (${map.debugId ?? "none"}) is not the one its binary's code ends with (${debugId})`;
  }
  const lines = shippedCode.toString("utf8").split("\n");
  const overrun = mappingOverrun(map.mappings, lines);
  return overrun;
}

/**
 * What ships in an image, from a plain `bun build --sourcemap=external` — or why that output cannot ship with this
 * map.
 *
 * Measured on Bun 1.4.2: the output is exactly what the same build without a map writes, followed by
 * `\n//# debugId=<id>\n`. That line comes after the last line of code, so cutting it moves no position the map
 * describes, and what is left is byte for byte the map-less build: one run gives both, the image ships what a build
 * without a map would, and `codeSha256` is the hash a rebuild without one prints — from any directory, since no build
 * carries the path it ran in (`build-path.ts`). Before 0.7.11 three dependencies' `__dirname` were written in as the
 * build's absolute path, `/app/node_modules/…` in the image, and a rebuild matched only at that path.
 *
 * Asked of it:
 *
 * 1. It ends with that line, and its id is the map's `debugId`: this map was written with this output.
 * 2. What is left carries no `sourceMappingURL` (`sourceMapReferences`).
 * 3. No mapping points past the end of a line of what is left, or past its last line.
 */
export function mapFitsBundle(map: RawSourceMap, mapped: Uint8Array): { code: Buffer } | { problem: string } {
  const bytes = Buffer.from(mapped.buffer, mapped.byteOffset, mapped.byteLength);
  // Read as latin1 so an index into the string is an index into the bytes; the trailer itself is ASCII.
  const trailer = /\n\/\/# debugId=([0-9A-Fa-f-]+)\n$/.exec(bytes.toString("latin1"));
  if (!trailer) return { problem: "the bundle does not end with the `//# debugId=` line `--sourcemap=external` writes" };
  if (map.debugId?.toUpperCase() !== trailer[1]!.toUpperCase()) {
    return { problem: `the map's debugId (${map.debugId ?? "none"}) is not the one the bundle ends with (${trailer[1]})` };
  }
  const code = bytes.subarray(0, trailer.index);
  const text = code.toString("utf8");
  const references = sourceMapReferences(text);
  if (references.length > 0) return { problem: `the bundle names a source map: ${references[0]!.slice(0, 80)}` };
  const overrun = mappingOverrun(map.mappings, text.split("\n"));
  return overrun ? { problem: overrun } : { code };
}

/** The first mapping that points past the end of its generated line, or past the last line; `null` when none does. */
function mappingOverrun(mappings: string, lines: string[]): string | null {
  const generated = mappings.split(";");
  if (generated.length > lines.length) return `the map describes ${generated.length} lines and the code has ${lines.length}`;
  for (let line = 0; line < generated.length; line += 1) {
    let column = 0;
    for (const segment of generated[line]!.split(",")) {
      if (!segment) continue;
      column += decodeVlq(segment)[0]!;
      // Columns are UTF-16 units, as JavaScript counts them; a mapping may sit at the very end of a line.
      if (column > lines[line]!.length) {
        return `line ${line + 1} is ${lines[line]!.length} long and the map has a mapping at column ${column}`;
      }
    }
  }
  return null;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** One segment of a v3 source map's `mappings`, as the signed numbers it encodes. */
export function decodeVlq(segment: string): number[] {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of segment) {
    const digit = BASE64.indexOf(char);
    if (digit < 0) throw new Error(`not a base64 VLQ digit: ${char}`);
    value += (digit & 31) * 2 ** shift;
    if (digit & 32) {
      shift += 5;
      continue;
    }
    values.push(value % 2 === 1 ? -(value - 1) / 2 : value / 2);
    value = 0;
    shift = 0;
  }
  return values;
}

/**
 * A reference to a source map inside an artefact: a `sourceMappingURL` naming a `.map` file, or carrying one
 * inline as base64.
 *
 * Narrower than the word on purpose. Bun's runtime carries the phrase as strings of its own — `sourceMappingURL=`
 * followed by `uidgidgid is required` and by a NUL, in every binary it compiles — and a check that fired on
 * those would fail every build, or be loosened until it caught nothing.
 */
const MAP_REFERENCE =
  /\/\/[#@] sourceMappingURL=(?:[\w./@-]+\.map\b|data:application\/json(?:;charset=[\w-]+)?;base64,[A-Za-z0-9+/]{40,})/g;

/** Every map reference in `text`, as written. Empty for an artefact that carries none. */
export function sourceMapReferences(text: string): string[] {
  return [...text.matchAll(MAP_REFERENCE)].map((m) => m[0]);
}

/**
 * What in a tarball says a source map came with it: a `.map` entry, or a map reference in any file's contents.
 * Each line names the entry, so a failure says which file to stop shipping.
 */
export function mapsInTarball(entries: { name: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const { name, text } of entries) {
    if (/\.map$/.test(name)) found.push(`${name}: a source map`);
    for (const ref of sourceMapReferences(text)) found.push(`${name}: ${ref.slice(0, 80)}`);
  }
  return found;
}

/**
 * The map as it is kept: sources normalised by `toSource`, and stamped with the build it is for. Pure, so the
 * caller decides what a source's path is relative to.
 */
export function stampMap(map: RawSourceMap, stamp: MapStamp, toSource: (source: string) => string): RawSourceMap {
  return { ...map, sources: map.sources.map(toSource), [STAMP_FIELD]: stamp };
}

/**
 * `nouride-pro-linux-x64.map`, beside `nouride-pro-linux-x64.tar.gz`; `nouride-pro-image.map` for an image's bundle;
 * `nouride.map` for a host build. Never `nouride.bundle.js.map`: Bun applies a map of that name to the bundle beside
 * it by itself, which would turn a local run's frames into source paths and hide what a customer's frames look like.
 */
export function mapFileName(artifact: string | null): string {
  return `${artifact ?? "nouride"}.map`;
}
