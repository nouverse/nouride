/**
 * Which build this is, and what that means for replacing it.
 *
 * Two different questions, and conflating them is how you get a daemon offering to
 * download a tarball that was never published for it:
 *
 * - **Edition** is what was compiled in — `basic`, `router`, `pro`.
 * - **Delivery** is how that edition reaches a machine: a tarball, or a container image.
 *   Each releases as both (a Box and a server take the tarball, a pod the image), and which one
 *   *this* install is came from how it is supervised.
 *
 * The edition is stamped into the binary at build time (`--define`), because inferring it
 * from which capabilities resolved cannot separate `basic` from `router` — the
 * LLM gateway is imported on demand and a daemon that never used it has not loaded it.
 * An unstamped build (a source checkout) says so rather than guessing.
 */

import { compareVersions, parseVersion } from "./version.ts";

export type Edition = "basic" | "router" | "pro";

export type Delivery = "tarball" | "container";

/** Held to the build's own list, `scripts/targets.ts`, by `apps/engine/tests/contracts/artifact-names.test.ts`. */
export const EDITIONS: readonly Edition[] = ["basic", "router", "pro"];

/**
 * The licensed edition: never a public download. The release workflow attaches its tarballs to no public
 * repository and pushes its image privately, a box takes its builds from Nouverse, and it installs only a signed
 * release (`signing.ts`).
 */
export function isPrivateEdition(edition: Edition): boolean {
  return edition === "pro";
}

/**
 * The `--variant` name `install.sh` takes for this edition, and the tarball infix.
 *
 * `basic` has none — its artifacts are `nouride-<target>.tar.gz`, with no infix — and
 * that asymmetry is deliberate rather than an oversight: the free build's names are the
 * ones on the public download page and they predate the other editions.
 */
export function variantFor(edition: Edition): string {
  return edition === "basic" ? "" : edition;
}

/**
 * How this install was delivered.
 *
 * Read from the supervisor rather than from the edition, because the free edition ships
 * both ways and only the running process knows which one it is. A container reports
 * `docker` from `/.dockerenv`; everything else got here as a tarball.
 */
export function deliveryFor(_edition: Edition, supervisor: string): Delivery {
  return supervisor === "docker" ? "container" : "tarball";
}

/**
 * The tarball name for one edition on one target.
 *
 * Mirrors `install.sh`'s own derivation exactly — it builds the same name once and uses
 * it in three URLs, for the same reason this is one function: a suffix applied in some
 * places and not others downloads the wrong build and reports the right one.
 */
export function artifactName(edition: Edition, target: string): string {
  const variant = variantFor(edition);
  return variant ? `nouride-${variant}-${target}` : `nouride-${target}`;
}

/**
 * The first release whose checksum files are named `CHECKSUMS` rather than `SHA256SUMS`.
 *
 * 0.8.0 upgrades only from the last 0.7.x. The updaters from 0.7.11 on read that floor; the ones before know nothing of
 * it, and would take 0.8.0 straight away and meet a daemon that refuses their data. They pick a release by the two
 * files it carries — the tarball and `SHA256SUMS` — so 0.8.0 is published without a `SHA256SUMS`, and they keep
 * stepping within 0.7.x to the last one; the updaters from 0.7.21 on know this name. Tied to the version, as signing is
 * (`SIGNED_SINCE`), so a staged release is verified against the right file without asking the channel.
 */
const CHECKSUMS_RENAMED_IN = "0.8.0";

/**
 * The checksum file that covers that tarball, in the release `tag`.
 *
 * One file per variant, not one for the release: the three binary editions are built by
 * separate jobs and each uploads its own, so `SHA256SUMS` covers the free tarballs and
 * `SHA256SUMS-pro` covers the Pro ones — `CHECKSUMS` and `CHECKSUMS-pro` from 0.8.0.
 */
export function checksumName(edition: Edition, tag: string): string {
  const variant = variantFor(edition);
  // On the release line, not the full version: a 0.8.0 release candidate is as much 0.8.0 to an old updater as 0.8.0 is.
  const version = parseVersion(tag);
  const line = version && { ...version, prerelease: "" };
  const base = line && compareVersions(line, parseVersion(CHECKSUMS_RENAMED_IN)!) >= 0 ? "CHECKSUMS" : "SHA256SUMS";
  return variant ? `${base}-${variant}` : base;
}

export interface TargetFacts {
  /** `process.platform` — `linux` or `darwin`. */
  platform: string;
  /** `process.arch` — `x64` or `arm64`. */
  arch: string;
  /** Whether the C library is musl. Only meaningful on linux. */
  musl: boolean;
}

/**
 * The release target triple, or null when this platform has no published build.
 *
 * The null cases are real and worth naming: 32-bit ARM has no build at all (`install.sh`
 * stops on `armv7l` rather than downloading something that will not run), and Windows
 * has never had one.
 */
export function targetFor(facts: TargetFacts): string | null {
  const arch = facts.arch === "x64" ? "x64" : facts.arch === "arm64" ? "arm64" : null;
  if (!arch) return null;
  if (facts.platform === "darwin") return `darwin-${arch}`;
  if (facts.platform !== "linux") return null;
  return facts.musl ? `linux-${arch}-musl` : `linux-${arch}`;
}
