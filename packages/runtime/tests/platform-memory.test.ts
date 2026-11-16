/**
 * What a system says of memory (`platform-memory.ts`): a Mac's memory in use, read from `vm_stat`, and what the
 * processes this one started hold together, from `/proc` on Linux and from `ps` on a Mac.
 *
 * The System page said of a Mac that how much of its memory is in use "is not something Nouride can tell here", and
 * of the agents' commands, wherever they have no cgroup of their own, that they are "counted together with Nouride".
 * They were counted nowhere: the daemon's own figure is its one process.
 */

import { describe, expect, test } from "bun:test";
import { readMemoryUse, SYSTEM, type MachineSource } from "../src/machine.ts";
import { descendantsHeldBytes } from "../src/platform-memory.ts";

const GiB = 1024 ** 3;
const KiB = 1024;

/** A machine of 16 GB whose daemon is process 100: its platform, the files it has and what its programs print. */
function machine(platform: string, has: { files?: Record<string, string>; programs?: Record<string, { text: string; pid: number }> } = {}): MachineSource {
  const files = has.files ?? {};
  return {
    cores: () => 8,
    memoryBytes: () => 16 * GiB,
    platform: () => platform,
    pid: () => 100,
    read: (path) => files[path] ?? null,
    list: (path) => [...new Set(Object.keys(files).filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1).split("/")[0]!))],
    run: (program) => has.programs?.[program] ?? null,
  };
}

/** `vm_stat` as a 16 GB Apple silicon Mac printed it, whole. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    32054.
Pages active:                                 378698.
Pages inactive:                               374110.
Pages speculative:                              3626.
Pages throttled:                                   0.
Pages wired down:                             123746.
Pages purgeable:                               22685.
"Translation faults":                      394754017.
Pages copy-on-write:                        21074217.
Pages zero filled:                         225763533.
Pages reactivated:                          40606570.
Pages purged:                                1737237.
File-backed pages:                            219941.
Anonymous pages:                              536493.
Pages stored in compressor:                   230201.
Pages occupied by compressor:                 100716.
Decompressions:                             35965940.
Compressions:                               55457929.
Pageins:                                    10808779.
Pageouts:                                       4070.
Swapins:                                     3502227.
Swapouts:                                    5526699.
`;
const reading = (text: string) => readMemoryUse(machine("darwin", { programs: { vm_stat: { text, pid: 7 } } }));

describe("a Mac's memory in use", () => {
  test("the pages processes own that cannot be purged, those wired down and those the compressor holds, by the page's size", () => {
    expect(reading(VM_STAT)).toEqual({ usedBytes: (536_493 - 22_685 + 123_746 + 100_716) * 16_384, totalBytes: 16 * GiB, limited: false, machineBytes: 16 * GiB });
    // Another reading of such a Mac, its lines in another order: about 12.7 GB.
    const other = ["Mach Virtual Memory Statistics: (page size of 16384 bytes)", "Pages occupied by compressor: 220383.", "Anonymous pages: 403771.", "Pages purgeable: 5016.", "Pages wired down: 156545.", "Pages free: 37842."].join("\n");
    expect(reading(other).usedBytes).toBe(12_708_790_272);
  });

  test("the page's size is the one the reading names: an Intel Mac's is a quarter of it", () => {
    expect(reading(VM_STAT.replace("page size of 16384 bytes", "page size of 4096 bytes")).usedBytes).toBe((536_493 - 22_685 + 123_746 + 100_716) * 4_096);
  });

  test("no figure where there is no such program, or its words are not that reading: none is made up from the rest", () => {
    expect(readMemoryUse(machine("darwin")).usedBytes).toBeNull();
    for (const [text, why] of [
      ["", "nothing printed"],
      ["vm_stat: something went wrong\n", "an error's words"],
      [VM_STAT.replace(/^Anonymous pages:.*\n/m, ""), "no anonymous pages"],
      [VM_STAT.replace(/^Pages purgeable:.*\n/m, ""), "no purgeable pages"],
      [VM_STAT.replace(/^Pages wired down:.*\n/m, ""), "no wired pages"],
      [VM_STAT.replace(/^Pages occupied by compressor:.*\n/m, ""), "no compressor's pages"],
      [VM_STAT.replace(/^Mach Virtual.*\n/, ""), "no page size"],
      [VM_STAT.replace("Anonymous pages:                              536493.", "Anonymous pages:                              many."), "a count that is no number"],
    ] as const) {
      expect(reading(text).usedBytes, why).toBeNull();
    }
    // The total is still the machine's.
    expect(reading("").totalBytes).toBe(16 * GiB);
  });

  test("each system is asked its own way: a Mac reads no /proc, Linux asks no program, and a system with no reader says nothing", () => {
    const meminfo = { "/proc/meminfo": `MemTotal: ${16 * 1024 * 1024} kB\nMemAvailable: ${10 * 1024 * 1024} kB\n` };
    const both = { files: meminfo, programs: { vm_stat: { text: VM_STAT, pid: 7 } } };
    expect(readMemoryUse(machine("linux", both)).usedBytes).toBe(6 * GiB);
    expect(readMemoryUse(machine("darwin", both)).usedBytes).toBe((536_493 - 22_685 + 123_746 + 100_716) * 16_384);
    expect(readMemoryUse(machine("darwin", { files: meminfo })).usedBytes).toBeNull();
    expect(readMemoryUse(machine("linux", { programs: { vm_stat: { text: VM_STAT, pid: 7 } } })).usedBytes).toBeNull();
    expect(readMemoryUse(machine("a system with no reader", both)).usedBytes).toBeNull();
  });
});

describe("on the machine this runs on", () => {
  test("a Mac says what is in use, and what this process started can be counted", () => {
    // The system's own programs, run for real: only where this is a Mac, which is where they are.
    if (process.platform !== "darwin") return;
    const real = readMemoryUse();
    expect(real.usedBytes).toBeGreaterThan(0);
    expect(real.usedBytes!).toBeLessThanOrEqual(real.totalBytes);
    expect(descendantsHeldBytes(SYSTEM)).toBeGreaterThanOrEqual(0);
  });
});

describe("what the processes this one started hold together", () => {
  const stat = (pid: number, name: string, parent: number) => `${pid} (${name}) S ${parent} ${pid} ${pid} 0 -1 4194560 100 0 0 0\n`;
  const status = (kib: number) => `Name:\tx\nVmPeak:\t  999999 kB\nVmRSS:\t  ${kib} kB\nThreads:\t1\n`;
  /** The daemon (100), two commands it started, a command of one of those, and a machine's other processes. */
  const PROC: Record<string, string> = {
    "/proc/meminfo": "MemTotal: 16777216 kB\n",
    "/proc/self/stat": stat(100, "nouride", 1),
    "/proc/1/stat": stat(1, "systemd", 0),
    "/proc/1/status": status(8_000),
    "/proc/100/stat": stat(100, "nouride", 1),
    "/proc/100/status": status(200_000),
    "/proc/200/stat": stat(200, "sh", 100),
    "/proc/200/status": status(1_024),
    // A name with spaces and brackets of its own, made to read as another process's line.
    "/proc/300/stat": "300 (build) S 1 (x) R 100 300 300 0 -1 4194560 100 0 0 0\n",
    "/proc/300/status": status(2_048),
    "/proc/400/stat": stat(400, "python3", 300),
    "/proc/400/status": status(4_096),
    "/proc/500/stat": stat(500, "sshd", 1),
    "/proc/500/status": status(9_999),
  };

  test("on Linux: its children and theirs, from /proc, without itself and without the machine's other processes", () => {
    expect(descendantsHeldBytes(machine("linux", { files: PROC }))).toBe((1_024 + 2_048 + 4_096) * KiB);
    // A process that started nothing holds nothing through others.
    expect(descendantsHeldBytes({ ...machine("linux", { files: PROC }), pid: () => 500 })).toBe(0);
  });

  test("a process that ended during the walk is left out, and what it had started is still counted", () => {
    const walked = {
      ...PROC,
      // Listed, and gone before its line was read.
      "/proc/600/cmdline": "",
      // Its line was read, and it was gone before its memory was: nothing for it, and its own child is still walked.
      "/proc/700/stat": stat(700, "node", 200),
      "/proc/800/stat": stat(800, "tsc", 700),
      "/proc/800/status": status(512),
      // A kernel's thread says no resident memory at all.
      "/proc/900/stat": stat(900, "kworker/0:1", 400),
      "/proc/900/status": "Name:\tkworker/0:1\nThreads:\t1\n",
    };
    expect(descendantsHeldBytes(machine("linux", { files: walked }))).toBe((1_024 + 2_048 + 4_096 + 512) * KiB);
  });

  test("on a Mac: from one ps, each line a process, its parent and its kilobytes, without the listing itself", () => {
    const ps = ["    1     0  19312", "  100     1 200000", "  200   100   1024", "  300   100   2048", "  400   300   4096", "  500     1   9999", " 9000   100   1500", "", "ps: not a line"].join("\n");
    expect(descendantsHeldBytes(machine("darwin", { programs: { ps: { text: ps, pid: 9000 } } }))).toBe((1_024 + 2_048 + 4_096) * KiB);
    // Listed by another process: the same line is then a command like any other.
    expect(descendantsHeldBytes(machine("darwin", { programs: { ps: { text: ps, pid: 9001 } } }))).toBe((1_024 + 2_048 + 4_096 + 1_500) * KiB);
  });

  test("nothing to say where the processes cannot be listed: no program, no /proc, one that names them and shows none, or a system with no reader", () => {
    expect(descendantsHeldBytes(machine("darwin"))).toBeNull();
    expect(descendantsHeldBytes(machine("linux"))).toBeNull();
    // Their numbers are there and not one line of them can be read: not known, which is not the same as nothing held.
    expect(descendantsHeldBytes(machine("linux", { files: { "/proc/100/cmdline": "", "/proc/200/cmdline": "" } }))).toBeNull();
    expect(descendantsHeldBytes(machine("a system with no reader", { files: PROC }))).toBeNull();
  });
});
