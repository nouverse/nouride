#!/usr/bin/env bun
/**
 * Turn a stack trace from a customer's box back into source: `file:line:col` and the function around it.
 *
 * Release builds mangle identifiers and carry no source map, so a frame reads `at Rie (/$bunfs/root/nouride:41:6983)`
 * from a binary and `at Rie (/app/nouride.bundle.js:41:6983)` from a Docker image. Every build writes a private map
 * for exactly the code it ships (`dist/<artifact>.map`: `writePrivateMap` and `writeImageBundle` in
 * `scripts/build/core.ts`), and the release keeps those maps on the internal release only. This reads one.
 *
 * Usage:
 *   bun run symbolize --version 0.7.10 --edition pro --target linux-x64 crash.txt
 *   journalctl -u nouride -n 200 | bun run symbolize --version 0.7.10 --edition basic --target linux-arm64
 *   docker logs nouride 2>&1 | bun run symbolize --version 0.7.10 --edition router --target image
 *   bun run symbolize --version 0.7.10 --edition basic --target host --map dist/nouride.map < crash.txt
 *
 *   --version   the version the box runs (`nouride --version`, or `version` in /health)
 *   --edition   basic | router | pro (`edition` in /health)
 *   --target    linux-x64 | linux-arm64 | linux-x64-musl | linux-arm64-musl | … | host — or image, for any
 *               architecture of a Docker image: its bundle is the same JavaScript on each
 *   --map       a map file to use; its stamp must still be the build named above
 *   --offline   never download: only dist/ and the cache
 *
 * The map is found in `dist/`, then the cache (`.cache/symbolize/<version>/`), then downloaded from the internal
 * release with `gh release download`. Each is used only if its stamp names this exact version, edition and target:
 * a map from another build puts every frame in the wrong function, so a missing map is said and nothing is guessed.
 *
 * Deterministic: the output depends on the input and the map, nothing else — no clock, no machine path.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { IMAGE_TARGET, mapFileName, STAMP_FIELD, type RawSourceMap } from "./build/source-map.ts";
import { decodeMap, errorNames, parseFrames, resolveFrame } from "./symbolize/resolve.ts";
import { artifactName, EDITIONS, KNOWN_TARGETS, type Edition } from "./targets.ts";

const ROOT = new URL("..", import.meta.url).pathname;
/** Where downloaded maps are kept. Gitignored, and under the checkout so `lint:public` never lists it. */
export const CACHE_DIR = join(ROOT, ".cache", "symbolize");
/** Where the maps of every release from 0.8.21 go; nouverse/nouride-legacy, archived, is read-only. */
export const MAPS_REPO = "nouverse/nouride-pro";

/**
 * The private release a version's maps are on. Up to 0.8.20 the main repository was private and kept them on its own
 * releases, now archived as nouverse/nouride-legacy; from 0.8.21 nouverse/nouride is public and the Pro half of a
 * release puts them on nouverse/nouride-pro's (its release.yml).
 */
export function internalRepoFor(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const legacy = major === 0 && (minor < 8 || (minor === 8 && patch <= 20));
  return legacy ? "nouverse/nouride-legacy" : MAPS_REPO;
}

export interface BuildId {
  version: string;
  edition: string;
  target: string;
}

/** Why `map` is not the map of `id`, or `null` when its stamp names exactly that build. */
export function stampMismatch(map: RawSourceMap, id: BuildId): string | null {
  const stamp = map[STAMP_FIELD];
  if (!stamp) return "it carries no build stamp, so which build it describes cannot be known";
  const wrong = (["version", "edition", "target"] as const).filter((key) => stamp[key] !== id[key]);
  if (wrong.length === 0) return null;
  return `it is the map of ${stamp.version} ${stamp.edition} ${stamp.target}`;
}

/** The map's file name for a build: `nouride-pro-linux-x64.map`, `nouride-pro-image.map`, or `nouride.map` for a host build. */
export function mapNameFor(id: BuildId): string {
  return mapFileName(id.target === "host" ? null : artifactName(id.edition as Edition, id.target));
}

function readMap(path: string): RawSourceMap | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawSourceMap;
  } catch {
    return null;
  }
}

/** `gh release download` of one map into `dir`; the exit status and stderr, so a failure is reported as given. */
function download(id: BuildId, dir: string): { ok: boolean; detail: string } {
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawnSync(
    ["gh", "release", "download", `v${id.version}`, "--repo", internalRepoFor(id.version), "--pattern", mapNameFor(id), "--dir", dir, "--clobber"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return { ok: proc.exitCode === 0, detail: proc.stderr.toString().trim().split("\n")[0] ?? "" };
}

/**
 * The map for exactly `id`, and where it came from — or every place looked and why each was not it.
 * `fetch` is injectable so a test can stand in for the network.
 */
export function findMap(
  id: BuildId,
  opts: { map?: string; offline?: boolean; dist?: string; cache?: string; fetch?: typeof download },
): { map: RawSourceMap; from: string } | { looked: string[] } {
  const looked: string[] = [];
  const name = mapNameFor(id);
  const consider = (path: string): RawSourceMap | null => {
    const shown = relative(ROOT, path).startsWith("..") ? path : relative(ROOT, path);
    if (!existsSync(path)) {
      looked.push(`${shown}: not there`);
      return null;
    }
    const map = readMap(path);
    if (!map) {
      looked.push(`${shown}: not a source map`);
      return null;
    }
    const mismatch = stampMismatch(map, id);
    if (mismatch) {
      looked.push(`${shown}: not used — ${mismatch}`);
      return null;
    }
    return map;
  };
  const found = (path: string, note = "") => {
    const map = consider(path);
    return map ? { map, from: `${relative(ROOT, path).startsWith("..") ? path : relative(ROOT, path)}${note}` } : null;
  };

  if (opts.map) return found(opts.map) ?? { looked };
  // Said in the header: a build of this version in this checkout is stamped like the release's, and is the release's
  // map when it is the same commit built with the same Bun — from any directory since 0.7.11, and before that only at
  // the path the release was built at (`docs/CONTRIBUTING.md`, on a dependency's `__dirname`).
  const fromDist = found(join(opts.dist ?? join(ROOT, "dist"), name), " (this checkout's own build, not the release's)");
  if (fromDist) return fromDist;
  const cacheDir = join(opts.cache ?? CACHE_DIR, id.version);
  const fromCache = found(join(cacheDir, name));
  if (fromCache) return fromCache;
  if (opts.offline || id.target === "host") {
    looked.push(id.target === "host" ? "a host build's map is never published: only dist/ has one" : "--offline: not downloaded");
    return { looked };
  }
  const got = (opts.fetch ?? download)(id, cacheDir);
  if (!got.ok) {
    looked.push(`${internalRepoFor(id.version)} release v${id.version}: ${got.detail || "download failed"}`);
    return { looked };
  }
  const fetched = found(join(cacheDir, name));
  if (!fetched) rmSync(join(cacheDir, name), { force: true }); // a map that is not this build is not kept
  return fetched ?? { looked };
}

/**
 * The report for `input` against `map`: one block per frame, in the order the trace gave them.
 *
 * A stamped map is a binary's or an image's, and a frame of the other kind is named and left alone: the binary and
 * the image are different code, so reading one's position in the other's map would name a wrong line with
 * confidence. An unstamped map (`--map` on a file of one's own) reads both.
 */
export function symbolize(input: string, map: RawSourceMap, header: string): string {
  const frames = parseFrames(input);
  const out = [header];
  const names = errorNames(input);
  if (names.length > 0) out.push(`error: ${names.join(", ")}`);
  if (frames.length === 0) {
    out.push("no frames from a release build (/$bunfs/root/…:LINE:COL or /app/nouride.bundle.js:LINE:COL) in the input");
    return out.join("\n");
  }
  const stamped = map[STAMP_FIELD]?.target;
  const kind = stamped === undefined ? null : stamped === IMAGE_TARGET ? "image" : "binary";
  const decoded = decodeMap(map);
  frames.forEach((frame, i) => {
    out.push(`#${i + 1} ${frame.printed ?? "<anonymous>"} at ${frame.line}:${frame.column}`);
    if (kind && frame.kind !== kind) {
      const rerun = frame.kind === "image" ? "--target image" : "the binary's --target (linux-x64, linux-arm64, …)";
      out.push(`   not read: a frame from ${frame.kind === "image" ? "an image" : "a binary"} and the map of ${kind === "image" ? "an image" : "a binary"} — run again with ${rerun}`);
      return;
    }
    const resolved = resolveFrame(decoded, frame);
    if (!resolved) {
      out.push("   not in the map — this frame is outside the code the map describes");
      return;
    }
    out.push(`   ${resolved.source}:${resolved.line}:${resolved.column}  in ${resolved.function}`);
    if (resolved.text) out.push(`   | ${resolved.text}`);
  });
  return out.join("\n");
}

function arg(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const version = arg(argv, "--version")?.replace(/^v/, "");
  const edition = arg(argv, "--edition");
  const target = arg(argv, "--target");
  const usage = "usage: bun run symbolize --version <x.y.z> --edition <edition> --target <target> [--map <file>] [--offline] [file | -]";
  if (!version || !edition || !target) {
    console.error(`${usage}\n  all three are needed: a map is for one build, and another build's map is wrong everywhere`);
    return 1;
  }
  if (!(EDITIONS as readonly string[]).includes(edition)) {
    console.error(`unknown edition "${edition}" — one of ${EDITIONS.join(", ")}`);
    return 1;
  }
  if (target !== "host" && target !== IMAGE_TARGET && !(KNOWN_TARGETS as readonly string[]).includes(target)) {
    console.error(`unknown target "${target}" — one of ${KNOWN_TARGETS.join(", ")}, host, or ${IMAGE_TARGET} for a Docker image`);
    return 1;
  }
  const valued = new Set(["--version", "--edition", "--target", "--map"]);
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
  const file = positional[0];
  const input = file && file !== "-" ? readFileSync(file, "utf8") : await Bun.stdin.text();

  const id = { version, edition, target };
  const found = findMap(id, { map: arg(argv, "--map"), offline: argv.includes("--offline") });
  if ("looked" in found) {
    console.error(
      `✗ no source map for nouride ${version} ${edition} ${target} — nothing is resolved, and no other build's map is tried.\n` +
        found.looked.map((line) => `  ${line}`).join("\n") +
        `\n  The map is ${mapNameFor(id)} on the ${internalRepoFor(version)} release v${version} (internal). ` +
        `Check the version, edition and target against /health, or rebuild that exact commit to get it.`,
    );
    return 2;
  }
  console.log(symbolize(input, found.map, `nouride ${version} ${edition} ${target} — map: ${found.from}`));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
