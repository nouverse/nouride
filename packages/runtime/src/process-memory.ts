/**
 * How much memory there is and who holds it: the machine's total and what of it could still be handed out, and this
 * process's own. Read from `/proc` where there is one, since inside an LXC that is where the container's figures
 * are; the operating system's own calls elsewhere.
 */

import { freemem, totalmem } from "node:os";
import { readTextFileSync } from "./fs.ts";

/**
 * What this machine says it has, in bytes, or 0 when it will not say.
 *
 * `/proc/meminfo` first, and that is the whole point of this function. Inside an LXC, lxcfs rewrites
 * `/proc/meminfo` to show the *container's* memory — but it cannot intercept the `sysinfo()` syscall
 * that `os.totalmem()` uses, so `totalmem()` reports the **host's**. On a 2 GB container of a 62 GB
 * Proxmox node the two disagree by a factor of thirty, and a ceiling computed from the wrong one is
 * no ceiling. Found by writing it the easy way first and watching the unit come out at 50 GB.
 *
 * `totalmem()` stays as the fallback for everywhere `/proc` is not a thing.
 */
export function totalMemoryBytes(): number {
  try {
    const match = /^MemTotal:\s+(\d+) kB$/m.exec(readTextFileSync("/proc/meminfo"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux, or /proc is not mounted.
  }
  try {
    return totalmem();
  } catch {
    return 0;
  }
}

/**
 * This process's own memory, in bytes: what is resident, and how much of the JavaScript heap is in use.
 *
 * Two numbers because they answer different questions. Resident is what the machine pays — the heap, the runtime, and
 * the pages of the executable mapped from disk, which the kernel drops and re-reads under pressure. The heap in use is
 * the part it cannot drop, and the one that grows if something is kept that should not be.
 */
export function processMemory(): { rssBytes: number; heapUsedBytes: number } {
  const usage = process.memoryUsage();
  return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed };
}

/**
 * What this process holds that the kernel cannot take back by dropping a page it can read again: its own memory
 * (`RssAnon`) and what it shares (`RssShmem`), without the pages of its executable mapped from disk. Where the system
 * says, which is Linux; elsewhere everything resident.
 *
 * For a figure shown beside a container's count of what is in use, which leaves the same file pages out: in a
 * container held to 1 GB the daemon's resident memory read 84 MB where everything in use was 45.
 */
export function processHeldBytes(status: string | null = procStatus()): number {
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(status ?? "")?.[1] ?? Number.NaN);
  const held = kb("RssAnon") + (Number.isFinite(kb("RssShmem")) ? kb("RssShmem") : 0);
  return Number.isFinite(held) ? held * 1024 : process.memoryUsage().rss;
}

/** `/proc/self/status`, or null where there is none. */
function procStatus(): string | null {
  try {
    return readTextFileSync("/proc/self/status");
  } catch {
    return null;
  }
}

/**
 * What the kernel says could still be handed out without swapping, in bytes, or 0 when it will not say.
 *
 * `MemAvailable` rather than `MemFree`: free memory on a box that has been up a while is mostly page
 * cache, which the kernel gives back on demand, so `MemFree` reads as nearly full on a box with room
 * to spare. `/proc/meminfo` first for the same LXC reason as {@link totalMemoryBytes}.
 */
export function availableMemoryBytes(): number {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(readTextFileSync("/proc/meminfo"));
    if (match) return Number(match[1]) * 1024;
  } catch {
    // Not Linux, or /proc is not mounted.
  }
  try {
    return freemem();
  } catch {
    return 0;
  }
}
