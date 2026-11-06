/**
 * The seam to `nouride-system-packages`: resolved once at start, by dynamic import, like the update
 * provider — a build without it degrades to "not in this build" rather than failing to start.
 *
 * What stays in the engine is what the plugin must not decide: whether a change needs a person (the
 * `system-packages` entry of the fixed list in `@nouride/policy`), and what this edition's installer is (`setup.ts`).
 */

import { fileExistsSync, isRoot, isSocketFile, runningPlatform } from "@nouride/runtime";
import { packageSetup, type PackageSetup } from "./setup.ts";

type Provider = typeof import("nouride-system-packages");

/** Where Nouride's image puts the package service it runs without systemd — the Dockerfile's copy of `root/`. */
const CONTAINER_SERVICE = "/usr/local/lib/nouride-pkg/container/nouride-pkg-container";

let provider: Provider | null | undefined;

/** Idempotent; the daemon calls it at boot and `nouride pkg` before it asks anything. */
export async function resolveSystemPackages(): Promise<Provider | null> {
  if (provider !== undefined) return provider;
  try {
    const mod = await import("nouride-system-packages");
    provider = typeof mod.verifySystemPackagesProvider === "function" && mod.verifySystemPackagesProvider() ? mod : null;
  } catch {
    provider = null;
  }
  return provider;
}

/** The provider, once resolved; null before that or when this build does not carry it. */
function systemPackages(): Provider | null {
  return provider ?? null;
}

/** This host's `PackageSetup`, from what can be read without asking anything. After `resolveSystemPackages`. */
export function localPackageSetup(input: { edition: string; installDir: string; daemon?: boolean }): PackageSetup {
  const mod = systemPackages();
  return packageSetup({
    platform: runningPlatform().platform,
    inContainer: fileExistsSync("/.dockerenv"),
    containerService: fileExistsSync(CONTAINER_SERVICE),
    systemd: fileExistsSync("/run/systemd/system"),
    ...(input.daemon ? { daemonRoot: isRoot() } : {}),
    plugin: mod !== null,
    socketPresent: mod ? isSocketFile(mod.PACKAGE_SOCKET) : false,
    edition: input.edition,
    installDir: input.installDir,
  });
}
