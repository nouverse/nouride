/**
 * What this machine gives the work it runs: its cores and its memory, as this process may use them.
 *
 * The operating system answers for the machine, and inside a container that is the host: a container held to two
 * cores and 2 GB of a 64 GB server reads sixty-four. An LXC is told the truth through `/proc` (`totalMemoryBytes`) and
 * its CPU set; a Docker container is held by its cgroup alone, so the cgroup's own limits are read too and the lower
 * figure is the one said. Every number is read, none assumed: a file that is not there lowers nothing.
 */

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { totalMemoryBytes } from "./process.ts";

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

const SYSTEM: MachineSource = {
  cores: () => availableParallelism(),
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
