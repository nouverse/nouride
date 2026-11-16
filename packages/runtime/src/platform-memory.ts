/**
 * What an operating system says of memory, where each says it its own way: how much of the machine's is in use.
 *
 * One table by the platform's name, and nothing else asks which system this is. Linux reads `/proc`; Android under
 * proot is Linux here, and so is Windows under WSL2. macOS has no `/proc` and is asked through its own program,
 * `vm_stat`. Another system is one more entry. There is none for Windows itself: Nouride has no build for it,
 * so an entry could never be run. Where a system has no entry, or its figure cannot be read, there is none to say.
 */

import type { MachineSource } from "./machine.ts";

interface PlatformMemory {
  /** What of the machine's memory is in use, in bytes, or null where the system keeps no such figure. */
  usedBytes(source: MachineSource, machineBytes: number): number | null;
}

const LINUX: PlatformMemory = {
  usedBytes(source, machineBytes) {
    // Under WSL2 this is the WSL machine's memory, not the Windows host's.
    const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(source.read("/proc/meminfo") ?? "")?.[1] ?? 0) * 1024;
    return machineBytes > 0 && available > 0 ? Math.max(0, machineBytes - available) : null;
  },
};

const DARWIN: PlatformMemory = {
  /**
   * What is not the kernel's to hand back at once: the pages processes own that cannot be purged, those wired down,
   * and those the compressor holds. Close to what Activity Monitor calls Memory Used. Apple does not say how it counts
   * that, so no exact match is claimed. Not made from the free pages: a Mac's are a sliver of what it could hand out.
   */
  usedBytes(source) {
    const text = source.run("vm_stat", [])?.text ?? "";
    const size = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? Number.NaN);
    const pages = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\.?\\s*$`, "m").exec(text)?.[1] ?? Number.NaN);
    const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * size;
    return Number.isFinite(used) && used >= 0 ? used : null;
  },
};

const PLATFORMS: Record<string, PlatformMemory> = { linux: LINUX, darwin: DARWIN };

/** What of the machine's memory is in use, as its system says it, in bytes; null where it does not say. */
export function machineUsedBytes(source: MachineSource, machineBytes: number): number | null {
  return PLATFORMS[source.platform()]?.usedBytes(source, machineBytes) ?? null;
}
