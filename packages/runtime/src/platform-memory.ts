/**
 * What an operating system says of memory, where each says it its own way: how much of the machine's is in use, and
 * which processes there are and what each holds.
 *
 * One table by the platform's name, and nothing else asks which system this is. Linux reads `/proc`; Android under
 * proot is Linux here, and so is Windows under WSL2. macOS has no `/proc` and is asked through its own programs,
 * `vm_stat` and `ps`. Another system is one more entry. There is none for Windows itself: Nouride has no build for it,
 * so an entry could never be run. Where a system has no entry, or its figure cannot be read, there is none to say.
 */

import type { MachineSource } from "./machine.ts";

/** A process: itself, its parent, and what it holds in bytes when asked: nothing once it has ended. */
interface ProcessRow {
  pid: number;
  parent: number;
  held: () => number;
}

interface PlatformMemory {
  /** What of the machine's memory is in use, in bytes, or null where the system keeps no such figure. */
  usedBytes(source: MachineSource, machineBytes: number): number | null;
  /** Every process there is now, or null where they cannot be listed. */
  processes(source: MachineSource): ProcessRow[] | null;
}

const LINUX: PlatformMemory = {
  usedBytes(source, machineBytes) {
    // Under WSL2 this is the WSL machine's memory, not the Windows host's.
    const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(source.read("/proc/meminfo") ?? "")?.[1] ?? 0) * 1024;
    return machineBytes > 0 && available > 0 ? Math.max(0, machineBytes - available) : null;
  },
  processes(source) {
    const rows: ProcessRow[] = [];
    for (const name of source.list("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      // `pid (name) state parent ..`: the name may hold spaces and brackets of its own, so what follows is read from
      // the last `)`. No file: the process ended while the others were being read.
      const stat = source.read(`/proc/${name}/stat`);
      const parent = stat === null ? Number.NaN : Number(stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[1]);
      if (!Number.isInteger(parent)) continue;
      // No such file once it has ended, and no such line for a kernel's thread: neither holds anything.
      rows.push({ pid: Number(name), parent, held: () => Number(/^VmRSS:\s+(\d+) kB$/m.exec(source.read(`/proc/${name}/status`) ?? "")?.[1] ?? 0) * 1024 });
    }
    return rows.length > 0 ? rows : null;
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
  processes(source) {
    const listing = source.run("ps", ["-A", "-o", "pid=,ppid=,rss="]);
    if (!listing) return null;
    const rows: ProcessRow[] = [];
    for (const line of listing.text.split("\n")) {
      const [pid, parent, kib] = line.trim().split(/\s+/).map(Number);
      // The listing is a process too, a child of whoever asked for it, and gone by the time its words are read.
      if (!Number.isInteger(pid) || !Number.isInteger(parent) || !Number.isFinite(kib) || pid === listing.pid) continue;
      rows.push({ pid: pid!, parent: parent!, held: () => kib! * 1024 });
    }
    return rows.length > 0 ? rows : null;
  },
};

const PLATFORMS: Record<string, PlatformMemory> = { linux: LINUX, darwin: DARWIN };

/** What of the machine's memory is in use, as its system says it, in bytes; null where it does not say. */
export function machineUsedBytes(source: MachineSource, machineBytes: number): number | null {
  return PLATFORMS[source.platform()]?.usedBytes(source, machineBytes) ?? null;
}

/**
 * What every process started by this one holds together, in bytes: its children, theirs, and so on down, without this
 * process itself. Null where the system's processes cannot be listed.
 *
 * Each process's resident memory, summed. Pages that several of them share (a program's own code, a library) are
 * counted once for each, so the sum is over what they hold together, never under it.
 */
export function descendantsHeldBytes(source: MachineSource): number | null {
  const rows = PLATFORMS[source.platform()]?.processes(source) ?? null;
  if (rows === null) return null;
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) children.set(row.parent, [...(children.get(row.parent) ?? []), row]);
  const seen = new Set<number>([source.pid()]);
  const waiting = [source.pid()];
  let held = 0;
  while (waiting.length > 0) {
    for (const child of children.get(waiting.pop()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      held += child.held();
      waiting.push(child.pid);
    }
  }
  return held;
}
