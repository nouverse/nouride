/**
 * An update installs a build for the machine it runs on, and nothing else.
 *
 * The check and the plan pick the artefact from facts the engine gathers, and those were once the build's rather than
 * the machine's: a darwin-arm64 binary compiled from the linux-x64 release's code read `linux/x64`, and `nouride update
 * --start` would have downloaded the Linux tarball, verified it — it is genuinely signed — and swapped a Linux ELF over
 * the Mac's binary (finding 3 of issue #7 on nouride-releases). So the swap holds the line itself, twice, against what
 * the running process is asked at the moment of installing (`runningPlatform`, which no compile folds):
 *
 * 1. the artefact's name names this platform and architecture — before anything is fetched;
 * 2. the `nouride` inside it is an executable for them — after it is unpacked, before anything moves. A name is a
 *    claim; the file's header is what the kernel will read.
 */

export interface PlatformArch {
  platform: string;
  arch: string;
}

/** `nouride-linux-x64`, `nouride-pro-darwin-arm64`, `nouride-router-linux-arm64-musl` → its platform and arch. */
export function artifactTarget(artifact: string): PlatformArch | null {
  const match = /-(linux|darwin)-(x64|arm64)(?:-musl)?$/.exec(artifact);
  return match ? { platform: match[1]!, arch: match[2]! } : null;
}

/** ELF's `e_machine` and Mach-O's `cputype` for the two architectures a release is built for. */
const ELF_MACHINE: Record<number, string> = { 0x3e: "x64", 0xb7: "arm64" };
const MACHO_CPU: Record<number, string> = { 0x01000007: "x64", 0x0100000c: "arm64" };

/**
 * What an executable's first bytes say it runs on, or null when they are not a 64-bit little-endian ELF or Mach-O
 * file. Every release build is one of the two; a test's shell script is neither, and the name check still holds it.
 */
export function executableTarget(head: Uint8Array): PlatformArch | null {
  if (head.length < 20) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  // ELF: 7f 'E' 'L' 'F', class 2 (64-bit), data 1 (little-endian), then e_machine at 18.
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 && head[4] === 2 && head[5] === 1) {
    const arch = ELF_MACHINE[view.getUint16(18, true)];
    return arch ? { platform: "linux", arch } : { platform: "linux", arch: "unknown" };
  }
  // Mach-O 64-bit, little-endian: MH_MAGIC_64 (0xfeedfacf), then cputype.
  if (view.getUint32(0, true) === 0xfeedfacf) {
    const arch = MACHO_CPU[view.getUint32(4, true)];
    return { platform: "darwin", arch: arch ?? "unknown" };
  }
  return null;
}

const same = (a: PlatformArch, b: PlatformArch): boolean => a.platform === b.platform && a.arch === b.arch;

/** Why `artifact` is not for `host`, or null when it is. */
export function foreignArtifact(artifact: string, host: PlatformArch): string | null {
  const target = artifactTarget(artifact);
  if (!target) return `${artifact} names no platform this can check against ${host.platform}/${host.arch}; refusing it`;
  if (same(target, host)) return null;
  return `${artifact} is a build for ${target.platform}/${target.arch}, and this machine is ${host.platform}/${host.arch}; refusing it`;
}

/** Why the executable whose first bytes are `head` is not for `host`, or null when it is or cannot be told. */
export function foreignExecutable(head: Uint8Array, host: PlatformArch): string | null {
  const target = executableTarget(head);
  if (!target || same(target, host)) return null;
  return `the \`nouride\` in this release is an executable for ${target.platform}/${target.arch}, and this machine is ${host.platform}/${host.arch}; refusing it`;
}
