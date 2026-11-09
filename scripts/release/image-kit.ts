#!/usr/bin/env bun
/**
 * The public edition's container image, as a kit another repository can build without this one's source.
 *
 *   bun run build:binary --bundle-only --require-gateway     dist/nouride.bundle.js and its private map, first
 *   bun run scripts/release/image-kit.ts --edition basic     dist/nouride-image-kit.tar.gz
 *
 * One kit. Router had its own until it became part of the free build; its image is the free one's now, with a line
 * added after it is built (`scripts/release/router-image.Dockerfile`), and needs no kit.
 *
 * The public images were built here, on the one build runner, under emulation for arm64 — the longest part of a
 * release (2026-10-19: 19 of the 37 minutes of work). They are built now in `nouverse/nouride`, on GitHub's
 * free runners for public repositories, natively per architecture. That repository holds no source: what it builds
 * from is this kit — the bundle, the dashboard, the skills, the entrypoint scripts and a Dockerfile — listed in a
 * checksum file this repository signs (`sign` in release.yml). It checks the signature with the keys install.sh
 * embeds before building, and checks the image's bundle against the kit's after, so what it can publish is only ever
 * what was built and signed here, and the private map written for this bundle fits the image's bytes.
 *
 * ## The Dockerfile is the main one's runtime stages, not a second copy
 *
 * `kitDockerfile` takes the stages from `runtime-base` on and points their `COPY` lines at the kit's files instead of
 * the build stages. A second Dockerfile written by hand would drift from this one — a package added to the image here
 * and not there — and nothing would say so; a `COPY --from=` this does not know how to map is refused instead.
 *
 * Self-contained on purpose: `node:` and the build's plugin list only, so a test runs it on fixtures.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { NOUGATE } from "../build/edition.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

export type PublicEdition = "basic";

/** What each build-stage `COPY` of the runtime becomes in the kit: its file in the kit's root. */
const COPY_MAP: [from: RegExp, to: string][] = [
  [/^COPY --from=engine-builder \/app\/dist\/nouride\.bundle\.js (.+)$/, "COPY nouride.bundle.js $1"],
  [/^COPY --from=dashboard-builder \/app\/apps\/dashboard\/dist (.+)$/, "COPY dashboard $1"],
  [/^COPY --from=engine-builder \/app\/internals\/nougate\/apps\/frontend\/dist (.+)$/, "COPY frontend $1"],
  [/^COPY content\/skills (.+)$/, "COPY skills $1"],
  [/^COPY config\.example\.toml (.+)$/, "COPY config.example.toml $1"],
  [/^COPY scripts\/docker-entrypoint\.sh (.+)$/, "COPY docker-entrypoint.sh $1"],
  [/^COPY scripts\/docker-nouride\.sh (.+)$/, "COPY docker-nouride.sh $1"],
  [/^COPY packages\/system-packages\/root (.+)$/, "COPY nouride-pkg $1"],
];

/**
 * The kit's Dockerfile: the global `ARG`s the runtime reads — `EDITION` defaulting to the kit's own — then the
 * `runtime-base` stage, the kit edition's stage and the final one, with each `COPY` pointed at the kit. The other
 * editions' stages are left out: a kit carries one edition's files, and a stage naming another's would build an image
 * without them. Throws on a `COPY` it cannot place, rather than build an image that silently lacks it.
 */
export function kitDockerfile(dockerfile: string, edition: PublicEdition): string {
  const lines = dockerfile.split("\n");
  const firstFrom = lines.findIndex((line) => line.startsWith("FROM "));
  const runtime = lines.findIndex((line) => /^FROM .* AS runtime-base$/.test(line));
  if (firstFrom < 0 || runtime < 0) throw new Error("the Dockerfile has no runtime-base stage to take the image from");
  const args = lines
    .slice(0, firstFrom)
    .filter((line) => /^ARG (EDITION|BUN_VERSION|BUN_DIGEST)=/.test(line))
    .map((line) => (line.startsWith("ARG EDITION=") ? `ARG EDITION=${edition}` : line));
  const out: string[] = [
    "# Generated from the Nouride repository's Dockerfile by scripts/release/image-kit.ts — its runtime stages, with",
    "# each COPY pointed at this kit. Built by nouverse/nouride; edit the source, not this.",
    ...args,
    "",
  ];
  let skipping = false;
  for (const line of lines.slice(runtime)) {
    if (line.startsWith("FROM ")) {
      const stage = / AS edition-([a-z-]+)$/.exec(line)?.[1];
      skipping = stage !== undefined && stage !== edition;
    }
    if (skipping) continue;
    if (!line.startsWith("COPY ")) {
      out.push(line);
      continue;
    }
    const mapped = COPY_MAP.find(([from]) => from.test(line));
    if (!mapped) throw new Error(`no kit file for "${line}" — add it to COPY_MAP in scripts/release/image-kit.ts`);
    out.push(line.replace(mapped[0], mapped[1]));
  }
  return out.join("\n");
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The kit's file name, as the checksum file and the public workflow know it. */
export const kitName = (edition: PublicEdition) => (edition === "basic" ? "nouride-image-kit.tar.gz" : `nouride-image-kit-${edition}.tar.gz`);

/**
 * Where the kit's `frontend/` comes from: the gateway's built frontend when the bundle carries the gateway — required
 * then, or the image would serve a gateway whose page is a 404 — and an empty directory when it does not, since the
 * image's `COPY frontend` is there either way. Read off the bundle by the gateway's own marker, as the build's
 * `assertEmbedded` reads it, so the kit cannot disagree with the bytes it ships.
 */
export function kitFrontend(bundle: string, frontendBuilt: boolean): "copy" | "empty" {
  if (!bundle.includes(NOUGATE.marker)) return "empty";
  if (!frontendBuilt) throw new Error("the bundle carries the LLM gateway, and its frontend is not built: build internals/nougate/apps/frontend first");
  return "copy";
}

function main(argv: string[]): void {
  const at = argv.indexOf("--edition");
  const edition = argv[at + 1] as PublicEdition;
  if (at < 0 || edition !== "basic") {
    console.error("usage: image-kit.ts --edition basic   (after `build:binary --bundle-only`)");
    process.exit(2);
  }
  const dist = join(ROOT, "dist");
  const bundle = join(dist, "nouride.bundle.js");
  const mapName = edition === "basic" ? "nouride-image.map" : `nouride-${edition}-image.map`;
  const map = join(dist, mapName);
  if (!existsSync(bundle) || !existsSync(map)) throw new Error(`build the ${edition} bundle first: bun run build:binary --bundle-only${edition === "basic" ? "" : ` --${edition}`}`);
  // The bundle in dist/ is whichever edition was built last: the map's stamp says which, and for which bytes.
  const stamp = (JSON.parse(readFileSync(map, "utf8")) as { x_nouride?: { edition?: string; codeSha256?: string; version?: string } }).x_nouride ?? {};
  const bundleSha = sha256(bundle);
  if (stamp.edition !== edition || stamp.codeSha256 !== bundleSha) {
    throw new Error(`dist/nouride.bundle.js is not the ${edition} bundle its map was written for (map says ${stamp.edition} ${stamp.codeSha256}) — build it again`);
  }

  const kit = join(dist, `image-kit-${edition}`);
  rmSync(kit, { recursive: true, force: true });
  mkdirSync(kit, { recursive: true });
  cpSync(bundle, join(kit, "nouride.bundle.js"));
  cpSync(join(ROOT, "apps/dashboard/dist"), join(kit, "dashboard"), { recursive: true });
  cpSync(join(ROOT, "content/skills"), join(kit, "skills"), { recursive: true });
  cpSync(join(ROOT, "config.example.toml"), join(kit, "config.example.toml"));
  cpSync(join(ROOT, "scripts/docker-entrypoint.sh"), join(kit, "docker-entrypoint.sh"));
  cpSync(join(ROOT, "scripts/docker-nouride.sh"), join(kit, "docker-nouride.sh"));
  cpSync(join(ROOT, "packages/system-packages/root"), join(kit, "nouride-pkg"), { recursive: true });
  const frontend = join(ROOT, "internals/nougate/apps/frontend/dist");
  if (kitFrontend(readFileSync(bundle, "latin1"), existsSync(frontend)) === "copy") cpSync(frontend, join(kit, "frontend"), { recursive: true });
  else mkdirSync(join(kit, "frontend"));
  writeFileSync(join(kit, "Dockerfile"), kitDockerfile(readFileSync(join(ROOT, "Dockerfile"), "utf8"), edition));
  // What the public workflow holds the built image to: the bundle in it must be this one, byte for byte.
  writeFileSync(join(kit, "kit.json"), `${JSON.stringify({ edition, version: stamp.version, bundleSha256: bundleSha }, null, 2)}\n`);

  const out = join(dist, kitName(edition));
  const tar = spawnSync("tar", ["--no-xattrs", "-czf", out, "-C", kit, "."], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (tar.status !== 0) throw new Error("could not pack the kit");
  console.log(`✓ dist/${kitName(edition)} — the ${edition} image's bundle (${bundleSha.slice(0, 12)}…), dashboard, skills and Dockerfile`);
}

if (import.meta.main) main(process.argv.slice(2));
