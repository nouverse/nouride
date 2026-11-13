/**
 * The machine as this process may use it (`machine.ts`): the system's own figures, lowered to a container's limits
 * where its cgroup holds it below them. Against files of the test's making, so each figure said is one that was read.
 */

import { describe, expect, test } from "bun:test";
import { readMachine, readMemoryUse, type MachineSource } from "../src/machine.ts";

const GiB = 1024 ** 3;

/** A machine of `cores` and `gib`, and the files a cgroup would show. */
function source(cores: number, gib: number, files: Record<string, string> = {}): MachineSource {
  return { cores: () => cores, memoryBytes: () => gib * GiB, read: (path) => files[path] ?? null };
}

describe("the machine's cores and memory", () => {
  test("a machine with no cgroup to read is what the system says it is", () => {
    expect(readMachine(source(8, 16))).toEqual({ cores: 8, memoryBytes: 16 * GiB });
    // The real one: read, never assumed. Whatever this machine is, it has a core and says its memory.
    const real = readMachine();
    expect(real.cores).toBeGreaterThanOrEqual(1);
    expect(real.memoryBytes).toBeGreaterThan(0);
  });

  test("a process whose `navigator` was taken away still reads its cores", () => {
    // What a DOM stand-in in another test file of the same run leaves behind: the full suite met it, no file alone did.
    const kept = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Reflect.deleteProperty(globalThis, "navigator");
    try {
      expect((globalThis as { navigator?: unknown }).navigator).toBeUndefined();
      expect(readMachine().cores).toBeGreaterThanOrEqual(1);
    } finally {
      if (kept) Object.defineProperty(globalThis, "navigator", kept);
    }
  });

  test("a container held below its host is its own limits: the host's sixty-four cores and gigabytes are not its", () => {
    const docker = { "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": `${2 * GiB}\n`, "/sys/fs/cgroup/cpu.max": "200000 100000\n" };
    expect(readMachine(source(64, 64, docker))).toEqual({ cores: 2, memoryBytes: 2 * GiB });
  });

  test("a limit set on a cgroup above this one counts: the lowest on the way up is the limit", () => {
    const unit = {
      "/proc/self/cgroup": "1:name=systemd:/ignored\n0::/system.slice/nouride.service/daemon\n",
      "/sys/fs/cgroup/system.slice/nouride.service/daemon/memory.max": "max\n",
      "/sys/fs/cgroup/system.slice/nouride.service/memory.max": `${3 * GiB}\n`,
      "/sys/fs/cgroup/system.slice/memory.max": `${6 * GiB}\n`,
      "/sys/fs/cgroup/system.slice/nouride.service/cpu.max": "max 100000\n",
    };
    expect(readMachine(source(4, 8, unit))).toEqual({ cores: 4, memoryBytes: 3 * GiB });
  });

  test("no limit lowers nothing: `max`, a limit above the machine, and a quota of none", () => {
    const loose = { "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/cpu.max": "max 100000\n" };
    expect(readMachine(source(4, 8, loose))).toEqual({ cores: 4, memoryBytes: 8 * GiB });
    const v1 = {
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
    };
    expect(readMachine(source(4, 8, v1))).toEqual({ cores: 4, memoryBytes: 8 * GiB });
  });

  test("an older Docker host's cgroup files are read too", () => {
    const v1 = {
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${GiB}\n`,
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "150000\n",
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
    };
    expect(readMachine(source(16, 32, v1))).toEqual({ cores: 1, memoryBytes: GiB });
  });

  test("part of a CPU is one core, and a system that will not say its memory says 0 rather than a guess", () => {
    const half = { "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.max": "50000 100000\n" };
    expect(readMachine(source(8, 0, half))).toEqual({ cores: 1, memoryBytes: 0 });
    expect(readMachine(source(0, 4))).toEqual({ cores: 1, memoryBytes: 4 * GiB });
  });
});

describe("the memory in use, of what this process may use", () => {
  const MiB = 1024 ** 2;
  /** A machine of `gib` whose kernel says `freeGib` could still be handed out, and the files a cgroup would show. */
  const using = (gib: number, freeGib: number, files: Record<string, string> = {}): MachineSource =>
    source(8, gib, { ...(freeGib > 0 ? { "/proc/meminfo": `MemTotal:       ${gib * 1024 * 1024} kB\nMemFree:          1024 kB\nMemAvailable:   ${freeGib * 1024 * 1024} kB\n` } : {}), ...files });

  test("a machine with no limit on this process: its memory less what could still be handed out", () => {
    expect(readMemoryUse(using(16, 10))).toEqual({ usedBytes: 6 * GiB, totalBytes: 16 * GiB, limited: false, machineBytes: 16 * GiB });
    // `max` is no limit, and one above the machine binds nothing.
    const loose = { "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "max\n", "/sys/fs/cgroup/memory.current": `${3 * GiB}\n` };
    expect(readMemoryUse(using(16, 10, loose))).toMatchObject({ usedBytes: 6 * GiB, limited: false });
    const above = { "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": `${64 * GiB}\n`, "/sys/fs/cgroup/memory.current": `${3 * GiB}\n` };
    expect(readMemoryUse(using(16, 10, above))).toMatchObject({ usedBytes: 6 * GiB, totalBytes: 16 * GiB, limited: false });
  });

  test("a container held to 1 GB of a 64 GB host is its own count, less the file cache the kernel gives back", () => {
    const docker = {
      "/proc/self/cgroup": "0::/\n",
      "/sys/fs/cgroup/memory.max": `${GiB}\n`,
      "/sys/fs/cgroup/memory.current": `${700 * MiB}\n`,
      "/sys/fs/cgroup/memory.stat": `anon ${350 * MiB}\nfile ${340 * MiB}\nactive_file ${40 * MiB}\ninactive_file ${300 * MiB}\n`,
    };
    // The host has 40 GB free: none of that is this container's, and its 300 MB of cache is not in use.
    expect(readMemoryUse(using(64, 40, docker))).toEqual({ usedBytes: 400 * MiB, totalBytes: GiB, limited: true, machineBytes: 64 * GiB });
  });

  test("a limit on a cgroup above this one binds, and the count is that group's: the daemon and its commands together", () => {
    const unit = {
      "/proc/self/cgroup": "0::/system.slice/nouride.service/daemon\n",
      "/sys/fs/cgroup/system.slice/nouride.service/daemon/memory.max": "max\n",
      "/sys/fs/cgroup/system.slice/nouride.service/daemon/memory.current": `${300 * MiB}\n`,
      "/sys/fs/cgroup/system.slice/nouride.service/memory.max": `${6 * GiB}\n`,
      "/sys/fs/cgroup/system.slice/nouride.service/memory.current": `${2 * GiB}\n`,
      "/sys/fs/cgroup/system.slice/nouride.service/memory.stat": `inactive_file ${GiB / 2}\n`,
      // A looser limit further up: the lowest on the way is the one that binds, and its group's count the one said.
      "/sys/fs/cgroup/system.slice/memory.max": `${7 * GiB}\n`,
      "/sys/fs/cgroup/system.slice/memory.current": `${5 * GiB}\n`,
    };
    expect(readMemoryUse(using(8, 3, unit))).toEqual({ usedBytes: 1.5 * GiB, totalBytes: 6 * GiB, limited: true, machineBytes: 8 * GiB });
  });

  test("an older Docker host's files: usage less its inactive file cache", () => {
    const v1 = {
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${2 * GiB}\n`,
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${GiB}\n`,
      "/sys/fs/cgroup/memory/memory.stat": `cache ${400 * MiB}\ntotal_inactive_file ${256 * MiB}\n`,
    };
    expect(readMemoryUse(using(32, 20, v1))).toEqual({ usedBytes: 768 * MiB, totalBytes: 2 * GiB, limited: true, machineBytes: 32 * GiB });
  });

  test("what nothing says is null, never 0: a limit with no count beside it, a system that will not say", () => {
    const blind = { "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": `${GiB}\n` };
    expect(readMemoryUse(using(64, 40, blind))).toEqual({ usedBytes: null, totalBytes: GiB, limited: true, machineBytes: 64 * GiB });
    expect(readMemoryUse(using(0, 0))).toEqual({ usedBytes: null, totalBytes: 0, limited: false, machineBytes: 0 });
    // A system that keeps no figure of what could be handed out (a Mac): none is made from what is merely free.
    expect(readMemoryUse(using(8, 0))).toEqual({ usedBytes: null, totalBytes: 8 * GiB, limited: false, machineBytes: 8 * GiB });
    expect(readMemoryUse(source(8, 16, { "/proc/meminfo": "MemTotal: 16777216 kB\nMemFree: 131072 kB\n" }))).toMatchObject({ usedBytes: null, totalBytes: 16 * GiB });
    // The real one: read, never assumed.
    const real = readMemoryUse();
    expect(real.totalBytes).toBeGreaterThan(0);
    if (real.usedBytes !== null) expect(real.usedBytes).toBeLessThanOrEqual(real.totalBytes * 1.05);
  });
});
