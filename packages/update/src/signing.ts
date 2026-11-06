/**
 * Whether a release's checksum file was published by Nouverse.
 *
 * The checksum file says what the tarball must hash to; this says the checksum file itself is
 * genuine. Together they make the chain an install trusts: a signature over the checksum file,
 * verified here against a key compiled into the binary, then the tarball against that file
 * (`install.ts`). Nothing about *where* the files came from is in the chain — not the host, not the
 * URL, not the service that handed the URL out — so a source that has been compromised can refuse
 * to update a box but cannot install anything on one.
 *
 * ## The format
 *
 * `<checksums>.sig` beside the checksum file: the base64 of a raw Ed25519 signature over its exact
 * bytes. Made by `scripts/release/sign-checksums.sh` in the release workflow, with a private key that lives
 * only in that workflow's secrets. It is **not** the appliance licence key: that one signs
 * entitlement and lives with the Nouverse service; this one signs code and lives with CI, and losing
 * either must not compromise the other.
 *
 * ## Which releases require it
 *
 * The private editions', always. Their releases come from a source supplied from outside this plugin, so the
 * requirement is the plugin's rather than the source's — a source that simply did not offer a signature must not
 * be how a Device box ends up installing an unsigned build.
 *
 * And every public release from 0.7.4 on (`SIGNED_SINCE`), the first one signed. Before the floor, a public release
 * was checked only when it listed a signature — so whoever could edit a release dropped the `.sig`, swapped the
 * tarball and its checksum file, and a free or router daemon installed what they put there. An older public
 * release still installs unsigned: it was published before there was a key.
 *
 * Public keys, not secrets; publishing this file is the point. A list, so a key can be rotated: a
 * release signed with the next key verifies on boxes that carry both, and the old one is dropped
 * once every box has updated past the release that added the new one.
 */

import { verifyEd25519 } from "@nouride/runtime";
import { isPrivateEdition, type Edition } from "./edition.ts";
import { compareVersions, parseVersion } from "./version.ts";

/** The first public release published with a signature. A public tag at or above it must carry a valid one. */
export const SIGNED_SINCE = "0.7.4";

export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  // 2026-09-24, the first release key.
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAnm2hXYQAFI/oKB065wPWCyew0ZxILlSkhE1KFK7cvBw=\n-----END PUBLIC KEY-----\n",
];

/**
 * Whether this release's checksum file must carry a valid signature before anything is installed: a private
 * edition's always, a public one's from `SIGNED_SINCE` on. Without `tag`, the edition alone answers — a tag this
 * cannot read is not given the benefit of the doubt either.
 */
export function requiresSignature(edition: Edition, tag?: string): boolean {
  if (isPrivateEdition(edition)) return true;
  if (tag === undefined) return false;
  const version = parseVersion(tag);
  return version === null || compareVersions(version, parseVersion(SIGNED_SINCE)!) >= 0;
}

/** `SHA256SUMS-pro` → `SHA256SUMS-pro.sig`. */
export function signatureName(checksums: string): string {
  return `${checksums}.sig`;
}

/**
 * Whether `signature` (base64, as published) is a valid signature over `checksums` by any of `keys`.
 *
 * False for anything malformed rather than throwing: "this is not signed by us" is the one answer,
 * whatever shape the bad input took.
 */
export function verifyChecksums(
  checksums: string,
  signature: string,
  keys: readonly string[] = RELEASE_PUBLIC_KEYS,
): boolean {
  const raw = Buffer.from(signature.trim(), "base64");
  if (raw.length !== 64) return false;
  const data = Buffer.from(checksums, "utf8");
  return keys.some((pem) => verifyEd25519(data, raw, pem));
}
