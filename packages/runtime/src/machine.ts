/**
 * What this machine gives the work it runs: its cores and its memory, as this process may use them.
 *
 * The operating system answers for the machine, and inside a container that is the host: a container held to two
 * cores and 2 GB of a 64 GB server reads sixty-four. An LXC is told the truth through `/proc` (`totalMemoryBytes`) and
 * its CPU set; a Docker container is held by its cgroup alone, so the cgroup's own limits are read too and the lower
 * figure is the one said. Every number is read, none assumed: a file that is not there lowers nothing.
 *
 * And what of that memory is in use now (`readMemoryUse`), counted where the limit is: a container's own count, not
 * its host's, which is what `/proc/meminfo` shows inside Docker.
 */

import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { totalMemoryBytes } from "./process-memory.ts";

export interface MachineSpec {
  /** The cores this process may run on, a container's CPU quota counted. At least 1. */
  cores: number;
  /** The memory there is, in bytes: the machine's, or a container's limit below it. 0 when it will not say. */
  memoryBytes: number;
}

/** Where the figures are read: the system's own, unless a test gives files of its making. */
export interface MachineSource {
  cores(): number;
  memoryBytes(): number;
  /** A file's text, or null when it is not there. */
  read(path: string): string | null;
}

/**
 * The cores this process may run on. Bun answers `availableParallelism` from `navigator`, and a process whose global
 * was taken away (a DOM stand-in does that) has none: it threw, and every caller with it. The CPU list is the same
 * count where no affinity narrows it.
 */
function systemCores(): number {
  try {
    return availableParallelism();
  } catch {
    return cpus().length;
  }
}

const SYSTEM: MachineSource = {
  cores: systemCores,
  memoryBytes: () => totalMemoryBytes(),
  read: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

const CGROUP = "/sys/fs/cgroup";

/** A limit file's number, or null for `max`, a negative "none", or no file. */
const limit = (text: string | null | undefined): number | null => {
  const value = Number(text?.trim());
  return text != null && text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
};

/** This process's cgroup and every one above it, nearest first (cgroup v2). None where there is no such thing. */
function cgroupChain(source: MachineSource): string[] {
  const path = (source.read("/proc/self/cgroup") ?? "").split("\n").find((line) => line.startsWith("0::"))?.slice(3).trim();
  if (path === undefined) return [];
  const parts = path.split("/").filter(Boolean);
  return Array.from({ length: parts.length + 1 }, (_, up) => [CGROUP, ...parts.slice(0, parts.length - up)].join("/"));
}

/** The CPUs a `cpu.max` allows (`<quota> <period>`), or null when it allows all of them. */
function quotaCores(text: string | null): number | null {
  const [quota, period] = (text ?? "").trim().split(/\s+/);
  const allowed = limit(quota);
  const each = limit(period);
  return allowed !== null && each !== null ? allowed / each : null;
}

export function readMachine(source: MachineSource = SYSTEM): MachineSpec {
  const chain = cgroupChain(source);
  const memoryLimits = [
    ...chain.map((dir) => limit(source.read(`${dir}/memory.max`))),
    // cgroup v1, where an older Docker host still has it: one file each, and "none" is a number larger than any machine.
    limit(source.read(`${CGROUP}/memory/memory.limit_in_bytes`)),
  ].filter((value): value is number => value !== null);
  const cpuLimits = [
    ...chain.map((dir) => quotaCores(source.read(`${dir}/cpu.max`))),
    quotaCores(`${source.read(`${CGROUP}/cpu/cpu.cfs_quota_us`) ?? ""} ${source.read(`${CGROUP}/cpu/cpu.cfs_period_us`) ?? ""}`),
  ].filter((value): value is number => value !== null);

  const machineMemory = source.memoryBytes();
  const memoryBytes = Math.min(...memoryLimits, machineMemory > 0 ? machineMemory : Infinity);
  // Half a CPU is still one core to plan with; two and a half are two.
  const cores = Math.max(1, Math.floor(Math.min(...cpuLimits, Math.max(1, source.cores()))));
  return { cores, memoryBytes: Number.isFinite(memoryBytes) ? memoryBytes : 0 };
}

export interface MemoryUse {
  /** In use now, in bytes; null where nothing says. */
  usedBytes: number | null;
  /** What there is to use: a limit set on this process's group, or the machine's memory. 0 when it will not say. */
  totalBytes: number;
  /** Whether `totalBytes` is such a limit (a container's, a service unit's), below the machine's memory. */
  limited: boolean;
  /** The machine's memory as the system says it: inside a Docker container, its host's. 0 when it will not say. */
  machineBytes: number;
}

/** A number a cgroup file holds, or null: no file, or not a count. */
const count = (text: string | null): number | null => {
  const value = Number(text?.trim());
  return text != null && text.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : null;
};

/** A line of `memory.stat`, `<name> <bytes>`. */
const stat = (text: string | null, name: string): number => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(text ?? "")?.[1] ?? 0);

/**
 * The memory in use of what this process may use.
 *
 * Where a cgroup's limit is below the machine's memory, that group's own count: `memory.current` less the file cache
 * the kernel gives back on demand (`inactive_file`), which is how `docker stats` counts a container, so the figure a
 * person reads here is the one they read there. The lowest limit on the way up is the one that binds, as `readMachine`
 * has it. Elsewhere the machine's: its memory less what the kernel says could still be handed out (`MemAvailable`).
 *
 * Where no such figure is kept there is none to say, and none is made from what is merely free: a Mac's free pages
 * are a sliver of what it could hand out, and the difference read 99 % in use on a machine with room to spare.
 */
export function readMemoryUse(source: MachineSource = SYSTEM): MemoryUse {
  const machineBytes = Math.max(0, source.memoryBytes());
  const held = [
    ...cgroupChain(source).map((dir) => ({
      max: limit(source.read(`${dir}/memory.max`)),
      used: () => {
        const current = count(source.read(`${dir}/memory.current`));
        return current === null ? null : Math.max(0, current - stat(source.read(`${dir}/memory.stat`), "inactive_file"));
      },
    })),
    {
      max: limit(source.read(`${CGROUP}/memory/memory.limit_in_bytes`)),
      used: () => {
        const usage = count(source.read(`${CGROUP}/memory/memory.usage_in_bytes`));
        return usage === null ? null : Math.max(0, usage - stat(source.read(`${CGROUP}/memory/memory.stat`), "total_inactive_file"));
      },
    },
  ]
    .filter((group): group is { max: number; used: () => number | null } => group.max !== null && (machineBytes === 0 || group.max < machineBytes))
    .sort((a, b) => a.max - b.max)[0];
  if (held) return { usedBytes: held.used(), totalBytes: held.max, limited: true, machineBytes };
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(source.read("/proc/meminfo") ?? "")?.[1] ?? 0) * 1024;
  return { usedBytes: machineBytes > 0 && available > 0 ? Math.max(0, machineBytes - available) : null, totalBytes: machineBytes, limited: false, machineBytes };
}
