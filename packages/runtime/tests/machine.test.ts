/**
 * The machine as this process may use it (`machine.ts`): the system's own figures, lowered to a container's limits
 * where its cgroup holds it below them. Against files of the test's making, so each figure said is one that was read.
 */

import { describe, expect, test } from "bun:test";
import { readMachine, type MachineSource } from "../src/machine.ts";

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
