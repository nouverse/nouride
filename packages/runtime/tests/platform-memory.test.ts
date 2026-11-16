/**
 * What a system says of memory (`platform-memory.ts`): a Mac's memory in use, read from `vm_stat`.
 *
 * The System page said of a Mac that how much of its memory is in use "is not something Nouride can tell here": only
 * Linux's figures were read.
 */

import { describe, expect, test } from "bun:test";
import { readMemoryUse, type MachineSource } from "../src/machine.ts";

const GiB = 1024 ** 3;

/** A machine of 16 GB: its platform, the files it has and what its programs print. */
function machine(platform: string, has: { files?: Record<string, string>; programs?: Record<string, { text: string; pid: number }> } = {}): MachineSource {
  const files = has.files ?? {};
  return {
    cores: () => 8,
    memoryBytes: () => 16 * GiB,
    platform: () => platform,
    read: (path) => files[path] ?? null,
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
  test("a Mac says what is in use", () => {
    // The system's own programs, run for real: only where this is a Mac, which is where they are.
    if (process.platform !== "darwin") return;
    const real = readMemoryUse();
    expect(real.usedBytes).toBeGreaterThan(0);
    expect(real.usedBytes!).toBeLessThanOrEqual(real.totalBytes);
  });
});
