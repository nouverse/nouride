/**
 * The system under the daemon, as an agent is told it (`machine.ts` in the engine): its name and version, the
 * architecture, whether it runs in a container, and whether the kernel is an Android phone's. An agent guessed it
 * before it thought to look: `apt` on Alpine, `systemctl` inside Docker, `brew` on Linux. Each part is read; one that
 * cannot be read is left out, never filled in.
 */

import { arch, platform } from "node:os";
import { readFileSync } from "node:fs";
import { SYSTEM } from "./machine.ts";

export interface SystemSpec {
  /** "Debian GNU/Linux 12 (bookworm)", "macOS 15.1": the system's own name for itself, or its platform's. */
  name: string;
  /** As `uname -m` says it: `x86_64`, `aarch64`, `arm64`. */
  arch: string;
  /** A container's own marker is there (Docker's `/.dockerenv`, Podman's `/run/.containerenv`). */
  container: boolean;
  /** The kernel says it is Android's: Nouride Home runs a small Debian under proot on a phone. */
  androidKernel: boolean;
}

export interface SystemSource {
  platform(): string;
  arch(): string;
  /** A file's text, or null when it is not there. */
  read(path: string): string | null;
  /** What one of the system's own programs prints; null when it is not there or fails. */
  run(program: string, args: readonly string[]): { text: string } | null;
}

const OWN: SystemSource = {
  platform: () => platform(),
  arch: () => arch(),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  run: (program, args) => SYSTEM.run(program, args),
};

/** Node's names for an architecture, as `uname -m` says them where they differ. */
const UNAME: Record<string, string> = { x64: "x86_64", ia32: "i686" };

/** One field of `/etc/os-release`, its quotes taken off. */
function release(text: string, key: string): string | null {
  const line = text.split("\n").find((at) => at.startsWith(`${key}=`));
  const value = line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
  return value ? value : null;
}

function systemName(source: SystemSource): string {
  const os = source.platform();
  if (os === "linux") {
    const text = source.read("/etc/os-release") ?? source.read("/usr/lib/os-release") ?? "";
    const named = release(text, "PRETTY_NAME") ?? [release(text, "NAME"), release(text, "VERSION_ID")].filter(Boolean).join(" ");
    return named || "Linux";
  }
  if (os === "darwin") {
    const version = source.run("sw_vers", ["-productVersion"])?.text.trim();
    return version ? `macOS ${version}` : "macOS";
  }
  return os === "win32" ? "Windows" : os;
}

export function readSystem(source: SystemSource = OWN): SystemSpec {
  const cpu = source.arch();
  return {
    name: systemName(source),
    arch: UNAME[cpu] ?? cpu,
    container: source.read("/.dockerenv") !== null || source.read("/run/.containerenv") !== null,
    androidKernel: /android/i.test(source.read("/proc/version") ?? ""),
  };
}
