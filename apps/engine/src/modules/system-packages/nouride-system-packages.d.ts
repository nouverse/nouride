/**
 * What the engine needs from `nouride-system-packages`, declared here rather than imported.
 *
 * The same choice, and for the same reasons, as `update/nouride-update.d.ts`: a path mapping would
 * drag the plugin's source into this project's program, and would make a separable component
 * required. Every edition links it, and the resolution is still dynamic, so a build with a dropped
 * symlink degrades instead of failing to start; `scripts/build/edition.ts` asserts the marker so that
 * build does not get made.
 *
 * `scripts/check-seams.ts` (`bun run lint:seams`) compiles the plugin's module against everything
 * below and fails on any difference; `apps/engine/tests/system-packages/external.test.ts` checks
 * what the plugin may depend on.
 */

declare module "nouride-system-packages" {
  /** Value: "system packages provider active in this daemon process". The build assertion marker. */
  export const SYSTEM_PACKAGES_CAPABILITY: string;

  /** Called by the boot resolver; also what keeps the marker alive through minification. */
  export function verifySystemPackagesProvider(): string;

  /** Where `nouride-pkg.socket` listens. */
  export const PACKAGE_SOCKET: string;

  export type PackageOp = "install" | "remove" | "upgrade";

  export type PackageRequest =
    | { op: "status" }
    | { op: "refresh" }
    | { op: PackageOp; names: readonly string[]; check?: boolean };

  export interface PackageAnswer {
    status: "ok" | "refused" | "failed";
    detail: string;
    installs: string[];
    removes: string[];
    output: string;
  }

  export interface ClientOptions {
    socket?: string;
    onData?: (chunk: string) => void;
  }

  /** Never throws: an unreachable service is a `failed` answer that says why. */
  export function askPackages(request: PackageRequest, options?: ClientOptions): Promise<PackageAnswer>;
  export function packageBackend(options?: ClientOptions): Promise<string | null>;
  export function isPackageName(name: string): boolean;
  export function isPackageOp(value: unknown): value is PackageOp;
}
