#!/usr/bin/env bun
/**
 * Router's names for Community's build, so the Router installs already out there keep updating.
 *
 *   bun run scripts/release/router-alias.ts dist        after the `CHECKSUMS` of Community's tarballs is written
 *
 * Router became part of Community (v0.8.28_RFC): the free build carries the LLM gateway, off until
 * `[nougate] in_process = true`, and no Router build is made. But a Router binary from before asks the public release
 * for its own files, by name — `nouride-router-<target>.tar.gz` and `CHECKSUMS-router` with its `.sig`
 * (`packages/update`: `newestCarrying` picks the newest release carrying both, `planUpdate` wants the signature,
 * `checksumFor` the tarball's line, `releaseFloor` the floor) — and `install.sh --variant router` fetches the same two.
 * Without them every Router install would stay on its version for good, told it is up to date.
 *
 * So each release publishes Community's tarballs a second time under Router's names: the same bytes, and a checksum
 * file of their own — Community's, each line renamed, and every comment line, the `# nouride-min-version:` floor among
 * them, as it is. The release workflow's `sign` job signs it with the others (it signs every `CHECKSUMS*`). Once
 * updated, the daemon reports `basic` and asks for Community's names from then on.
 *
 * 0.9.0 removes this, with Router's other names (v0.8.28_RFC).
 *
 * Self-contained on purpose: `node:` and the build's own names only, so a test runs it on a fake release.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactName, KNOWN_TARGETS } from "../targets.ts";

/** Community's checksum file, and the one written beside it — `checksumName("basic" | "router", tag)` from 0.8.0 on. */
export const COMMUNITY_SUMS = "CHECKSUMS";
export const ROUTER_SUMS = "CHECKSUMS-router";

/** Community's tarball name → Router's, for every target the build knows. */
const RENAMED = new Map(KNOWN_TARGETS.map((target) => [`${artifactName("basic", target)}.tar.gz`, `${artifactName("router", target)}.tar.gz`]));

/** A tarball's line of a checksum file, as `sha256sum` writes it: its hash, the separator, the `./`, the name. */
const TARBALL_LINE = /^([0-9a-f]{64})( [ *])(\.\/)?(\S+)$/;

/** The tarballs Community's checksum file names, with the name each takes. Throws on a line it does not know. */
function renamedTarballs(community: string): { line: string; hash: string; from: string; to: string; routerLine: string }[] {
  return community
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => {
      const match = TARBALL_LINE.exec(line);
      const to = match && RENAMED.get(match[4]!);
      // A file this does not know is not one to vouch for under another name.
      if (!match || !to) throw new Error(`${COMMUNITY_SUMS} has a line this does not know: ${line}`);
      return { line, hash: match[1]!, from: match[4]!, to, routerLine: `${match[1]}${match[2]}${match[3] ?? ""}${to}` };
    });
}

/**
 * Router's checksum file, from Community's: each tarball's line with Router's name, in the form it had, and every
 * other line — the floor's among them — as it is, where it is.
 */
export function routerChecksums(community: string): string {
  const renamed = new Map(renamedTarballs(community).map((tarball) => [tarball.line, tarball.routerLine]));
  return community
    .split("\n")
    .map((line) => renamed.get(line) ?? line)
    .join("\n");
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Copies each tarball `CHECKSUMS` in `dir` names to Router's name, checks the copy, and writes `CHECKSUMS-router`. */
export function writeRouterAlias(dir: string): string[] {
  const community = readFileSync(join(dir, COMMUNITY_SUMS), "utf8");
  const tarballs = renamedTarballs(community);
  if (tarballs.length === 0) throw new Error(`${COMMUNITY_SUMS} in ${dir} names no tarball`);
  for (const { hash, from, to } of tarballs) {
    if (!existsSync(join(dir, from))) throw new Error(`${COMMUNITY_SUMS} names ${from}, and it is not in ${dir}`);
    copyFileSync(join(dir, from), join(dir, to));
    // The same bytes, said by the hash the signed file will carry: a copy that differs is not published.
    if (sha256(join(dir, to)) !== hash) throw new Error(`${to} is not the file ${COMMUNITY_SUMS} names`);
  }
  writeFileSync(join(dir, ROUTER_SUMS), routerChecksums(community));
  return [...tarballs.map((tarball) => tarball.to), ROUTER_SUMS];
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: router-alias.ts <dir holding Community's tarballs and CHECKSUMS>");
    process.exit(2);
  }
  for (const name of writeRouterAlias(dir)) console.log(`✓ ${name} — Router's name for Community's build, until 0.9.0`);
}
