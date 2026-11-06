/**
 * `nouride-system-packages` — what the engine uses to reach `nouride-pkg`.
 *
 * Two halves in one plugin, and only one of them is TypeScript:
 *
 * - `root/` — the root service: `nouride-pkg`, a backend per package manager, the systemd units.
 *   Shipped in the release tarball as `pkg/` and installed by `install.sh --allow-packages`. This
 *   is where the rules are.
 * - `src/` — the protocol and the client the daemon and `nouride pkg` speak it with.
 *
 * Resolved by the engine by dynamic import at start, like `nouride-update`: a build without it
 * degrades to "system packages are not available in this build" instead of failing to start. It
 * depends on `@nouride/runtime` and nothing else of this repository's.
 */

export { askPackages, packageBackend, PACKAGE_SOCKET, type ClientOptions } from "./client.ts";
export { isPackageName, isPackageOp, type PackageAnswer, type PackageOp, type PackageRequest } from "./protocol.ts";

/** The build's marker (`scripts/build/edition.ts`): a literal no other part of the binary carries. */
export const SYSTEM_PACKAGES_CAPABILITY = "system packages provider active in this daemon process";

/** Called by the engine's resolver; also what keeps the marker through minification. */
export function verifySystemPackagesProvider(): string {
  return SYSTEM_PACKAGES_CAPABILITY;
}
