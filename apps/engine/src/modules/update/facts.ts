/**
 * What this install *is*, gathered so the plugin can decide what to do about it.
 *
 * The split is deliberate and it is the same one `internals/pro/packages/multi-user` draws: the engine
 * knows where it lives and what supervises it; the plugin knows what those facts mean.
 * Nothing here decides anything — every value is read, and the one that cannot be read
 * honestly says so rather than guessing.
 */

import { dirname, fileExists, isWritableDir, runningPlatform } from "@nouride/runtime";
import { VERSION } from "@/commons/version.ts";
import { COMPILED, EDITION } from "@/commons/build.ts";
import { detectSupervisor } from "@/service/supervisor.ts";

/** Mirrors `nouride-update`'s `InstallFacts`, which is declared rather than imported. */
export interface InstallFacts {
  version: string;
  edition: "basic" | "router" | "pro";
  installDir: string;
  installDirWritable: boolean;
  supervisor: string;
  restartsOnExit: boolean;
  compiled: boolean;
  platform: string;
  arch: string;
  musl: boolean;
}

/**
 * The install directory, derived the same way the `nouride` tool derives it.
 *
 * `<install>/.nouride/data` is the data directory, so two levels up is the install. Done
 * from the data directory rather than from `process.execPath` because the latter is
 * `bun` in a source checkout and the path of a temporary extraction in some container
 * runtimes — and this has to name the directory the dashboard is served from.
 */
export function installDirFor(dataDir: string): string {
  return dirname(dirname(dataDir));
}

/**
 * Is this a musl system?
 *
 * The same question `install.sh` answers, and the reason it matters is the same: the
 * `-musl` tarballs and the glibc ones are different builds, and the wrong one fails on
 * its first run with an error that reads like a corrupt download.
 *
 * Checked by looking for musl's own loader, plus Alpine's release file. `install.sh` runs
 * `ldd /bin/sh` and greps, which is the more thorough test and needs a subprocess; this
 * is the file test that gets the same answer on every system either of them has met.
 * A wrong answer here is visible before it does harm — the artifact name is part of the
 * plan, and the plan is what the operator approves.
 */
async function detectMusl(arch: string): Promise<boolean> {
  if (await fileExists("/etc/alpine-release")) return true;
  const loader = arch === "arm64" ? "/lib/ld-musl-aarch64.so.1" : "/lib/ld-musl-x86_64.so.1";
  return await fileExists(loader);
}

/**
 * The release target this install takes — `linux-arm64`, `linux-x64-musl` — or null where none is built. The same
 * answer as `nouride-update`'s `targetFor`, which is declared rather than imported; a test holds the two together.
 */
export function installTarget(facts: Pick<InstallFacts, "platform" | "arch" | "musl">): string | null {
  const arch = facts.arch === "x64" ? "x64" : facts.arch === "arm64" ? "arm64" : null;
  if (!arch) return null;
  if (facts.platform === "darwin") return `darwin-${arch}`;
  if (facts.platform !== "linux") return null;
  return facts.musl ? `linux-${arch}-musl` : `linux-${arch}`;
}

export async function gatherInstallFacts(dataDir: string): Promise<InstallFacts> {
  const installDir = installDirFor(dataDir);
  const supervisor = detectSupervisor({ inContainer: await fileExists("/.dockerenv") });
  // Asked of the operating system, not the build's folded `process.platform`/`process.arch` (`runningPlatform`): what
  // decides which tarball an update fetches is the machine, and the swap holds it to the same answer.
  const { platform, arch } = runningPlatform();

  return {
    version: VERSION,
    /**
     * `unknown` is not a value the plugin takes, and it does not need to be: `compiled`
     * is false in exactly the case the edition is unknown, and the plugin refuses a
     * source checkout before it looks at the edition at all. Narrowed here so the
     * boundary carries the five real names and nothing else.
     */
    edition: EDITION === "unknown" ? "basic" : EDITION,
    installDir,
    installDirWritable: isWritableDir(installDir),
    supervisor: supervisor.kind,
    restartsOnExit: supervisor.restartsOnExit,
    compiled: COMPILED,
    platform,
    arch,
    musl: platform === "linux" ? await detectMusl(arch) : false,
  };
}
