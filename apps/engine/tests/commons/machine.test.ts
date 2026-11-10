/**
 * How much work a machine is given at once where nothing is set (`commons/machine.ts`): four at most, fewer where its
 * cores or its memory are few; a number somebody set always wins, 0 included. And the words that say the machine and
 * where a limit came from, since each is read by a model or a person who acts on it.
 */

import { describe, expect, test } from "bun:test";
import { isolateCommands } from "@nouride/runtime";
import { atOnceBy, atOnceWords, backgroundInForce, backgroundLimitWords, machineAtBoot, machineWords, type Machine } from "@/commons/machine.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/** A machine by its cores and GiB, and the commands' own cap where its unit gives them a cgroup. */
const machine = (cores: number, gib: number, commandsGib?: number): Machine => ({
  cores,
  memoryBytes: Math.round(gib * GiB),
  ...(commandsGib === undefined ? {} : { commandsBytes: Math.round(commandsGib * GiB) }),
});

/**
 * What the service unit leaves the commands of a machine with `gib` of memory: its ceiling is four fifths of the
 * machine, and the daemon keeps a fifth of that, between 256 and 512 MiB (`runtime`'s `process-cgroup.ts`).
 */
function underTheUnit(cores: number, gib: number): Machine {
  const ceiling = gib * GiB * 0.8;
  const reserve = Math.min(Math.max(ceiling / 5, 256 * MiB), 512 * MiB);
  return { cores, memoryBytes: gib * GiB, commandsBytes: Math.floor(Math.max(ceiling - reserve, ceiling / 2) / MiB) * MiB };
}

describe("how much runs at once on a machine nobody set a number for", () => {
  test("four at most, fewer where the memory is small: a 2 GB box one, a 4 GB box two, an 8 GB box four", () => {
    const table: [string, Machine, number][] = [
      ["4 cores, 2 GB", machine(4, 2), 1],
      ["4 cores, 4 GB", machine(4, 4), 2],
      ["6 cores, 8 GB", machine(6, 8), 4],
      ["16 cores, 64 GB", machine(16, 64), 4],
      // What machines sold as that size report, a little under it.
      ["4 cores, 1.8 GiB", machine(4, 1.8), 1],
      ["4 cores, 3.7 GiB", machine(4, 3.7), 2],
      ["8 cores, 7.6 GiB", machine(8, 7.6), 4],
    ];
    for (const [name, box, expected] of table) expect([name, atOnceBy(box)]).toEqual([name, expected]);
  });

  test("the same answer where the unit gives the commands a cgroup of their own: its cap is the memory counted", () => {
    expect(underTheUnit(4, 2).commandsBytes).toBe(1310 * MiB);
    const table: [string, Machine, number][] = [
      ["4 cores, 2 GB", underTheUnit(4, 2), 1],
      ["4 cores, 4 GB", underTheUnit(4, 4), 2],
      ["6 cores, 8 GB", underTheUnit(6, 8), 4],
      ["16 cores, 64 GB", underTheUnit(16, 64), 4],
    ];
    for (const [name, box, expected] of table) expect([name, atOnceBy(box)]).toEqual([name, expected]);
    // A cap set far below the machine is what the commands may hold: the machine's 64 GB is not theirs.
    expect(atOnceBy(machine(16, 64, 2.5))).toBe(2);
  });

  test("fewer where the cores are few: all but one, which stays with the daemon and the turn somebody waits on", () => {
    expect([1, 2, 3, 4, 5, 6, 32].map((cores) => atOnceBy(machine(cores, 64)))).toEqual([1, 1, 2, 3, 4, 4, 4]);
  });

  test("never less than one, and a machine that will not say its memory is promised no more than that", () => {
    expect(atOnceBy(machine(1, 0.5))).toBe(1);
    expect(atOnceBy(machine(16, 0))).toBe(1);
  });

  test("the machine as boot reads it: its cores and memory, and the commands' cap where the cgroup was split", () => {
    expect(machineAtBoot({ commandsMaxBytes: 1310 * MiB }, { cores: 4, memoryBytes: 2 * GiB })).toEqual({ cores: 4, memoryBytes: 2 * GiB, commandsBytes: 1310 * MiB });
    // No cgroup of their own: nothing is said of one. What `isolateCommands` reports where it could not split.
    const beside = isolateCommands({ env: {}, root: "/nonexistent" });
    expect(beside.isolated).toBe(false);
    expect(machineAtBoot(beside, { cores: 4, memoryBytes: 2 * GiB })).toEqual({ cores: 4, memoryBytes: 2 * GiB });
    // The real machine: read, with at least a core.
    expect(machineAtBoot().cores).toBeGreaterThanOrEqual(1);
  });
});

describe("the machine in words, every figure as it was read", () => {
  test("cores and memory, and the commands' share only where there is one", () => {
    expect(machineWords(machine(6, 8))).toBe("6 cores, 8.0GB of memory");
    expect(machineWords(underTheUnit(6, 8))).toBe("6 cores, 8.0GB of memory (5.9GB of it for the agents' commands)");
    expect(machineWords(machine(1, 0.5))).toBe("1 core, 512.0MB of memory");
    // No memory read is no memory said, and no share of it either.
    expect(machineWords({ cores: 4, memoryBytes: 0, commandsBytes: GiB })).toBe("4 cores");
  });
});

describe("the helpers an agent may have in the background", () => {
  const delegate = (maxBackground?: number) => ({ maxBackground });
  const small = machine(4, 2);
  const large = machine(16, 64);

  test("nothing set: what the machine gives", () => {
    expect(backgroundInForce(delegate(), small, undefined)).toEqual({ limit: 1, from: "machine" });
    expect(backgroundInForce(delegate(), large, undefined)).toEqual({ limit: 4, from: "machine" });
  });

  test("a number set in the config wins on any machine, 0 included, which turns them off", () => {
    expect(backgroundInForce(delegate(2), large, undefined)).toEqual({ limit: 2, from: "config" });
    expect(backgroundInForce(delegate(4), small, undefined)).toEqual({ limit: 4, from: "config" });
    expect(backgroundInForce(delegate(0), large, undefined)).toEqual({ limit: 0, from: "config" });
  });

  test("an agent's own number wins over both, 0 included", () => {
    expect(backgroundInForce(delegate(2), large, 3)).toEqual({ limit: 3, from: "agent" });
    expect(backgroundInForce(delegate(), small, 4)).toEqual({ limit: 4, from: "agent" });
    expect(backgroundInForce(delegate(), large, 0)).toEqual({ limit: 0, from: "agent" });
  });

  test("a refusal names the setting that holds, or says that none does and the machine decided", () => {
    expect(backgroundLimitWords({ limit: 2, from: "config" })).toBe("`[delegate] max_background = 2`");
    expect(backgroundLimitWords({ limit: 1, from: "agent" })).toBe("`[delegate] max_background = 1`");
    expect(backgroundLimitWords({ limit: 4, from: "machine" })).toBe("4, what this machine has room for: `[delegate] max_background` is not set");
  });
});

describe("both limits in one line, as doctor and config check say them", () => {
  test("each number with where it came from, and the machine it was read against", () => {
    expect(atOnceWords({ machine: "6 cores, 8.0GB of memory", helpers: { limit: 4, auto: true }, missions: { limit: 3, auto: false } })).toBe(
      "4 helpers in the background for each agent (from this machine), 3 missions at once (set in the config); this machine: 6 cores, 8.0GB of memory",
    );
    expect(atOnceWords({ machine: "4 cores, 2.0GB of memory", helpers: { limit: 0, auto: false }, missions: { limit: 1, auto: true } })).toBe(
      "no helpers in the background (set in the config), 1 mission at once (from this machine); this machine: 4 cores, 2.0GB of memory",
    );
  });
});
