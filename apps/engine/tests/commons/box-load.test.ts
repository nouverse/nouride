/**
 * Whether the machine is busy — `commons/box-load.ts` (0.8.0). Driven by the kernel's files as a test writes them, on a
 * clock of its own: each signal on and off, the minute the CPU is measured over, and a reading that fails meaning room.
 */

import { describe, expect, test } from "bun:test";
import { BoxLoad, type BoxFiles } from "@/commons/box-load.ts";

const SEC = 1_000;

/** The kernel's files as a map: a path's text, and a directory's names from the paths under it. */
function files(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const reader: BoxFiles = {
    read: (path) => map.get(path) ?? null,
    list: (dir) => [...new Set([...map.keys()].filter((path) => path.startsWith(`${dir}/`)).map((path) => path.slice(dir.length + 1).split("/")[0]!))],
  };
  return { map, reader };
}

/** `/proc/stat` with the given jiffies of work and of rest, spread over user and idle — and a per-CPU line, which is not read. */
const stat = (work: number, rest: number) => `cpu  ${work} 0 0 ${rest} 0 0 0 0 0 0\ncpu0 1 2 3 4 5 6 7 8 0 0\nintr 12345\n`;

/** A box on a test's clock, whose CPU works `share` of each step it is moved by. */
function cpuBox() {
  const fake = files();
  let now = 0;
  let work = 1_000;
  let rest = 1_000;
  fake.map.set("/proc/stat", stat(work, rest));
  const load = new BoxLoad(fake.reader, () => now);
  load.sample();
  /** `ms` pass with the CPU busy `share` of the time, read every 15 seconds as the timer does. */
  const run = (ms: number, share: number) => {
    for (let step = 0; step < ms; step += 15 * SEC) {
      now += 15 * SEC;
      work += Math.round(1_500 * share);
      rest += Math.round(1_500 * (1 - share));
      fake.map.set("/proc/stat", stat(work, rest));
      load.sample();
    }
  };
  return { load, run };
}

describe("the CPU, over the last minute", () => {
  test("busy past 70% of a minute, and says by how much", () => {
    const box = cpuBox();
    box.run(60 * SEC, 0.8);
    expect(box.load.busy()).toBe("the CPU was 80% busy over the last minute");
  });

  test("not busy at 70% or under", () => {
    const box = cpuBox();
    box.run(60 * SEC, 0.7);
    expect(box.load.busy()).toBeNull();
    box.run(60 * SEC, 0.3);
    expect(box.load.busy()).toBeNull();
  });

  test("not before a whole minute has been read — the first look after boot is room", () => {
    const box = cpuBox();
    box.run(45 * SEC, 1);
    expect(box.load.busy()).toBeNull();
    box.run(15 * SEC, 1);
    expect(box.load.busy()).toBe("the CPU was 100% busy over the last minute");
  });

  test("the last minute only: an idle minute before a busy one does not hide it, and a busy one that has passed does not count", () => {
    const busyNow = cpuBox();
    busyNow.run(60 * SEC, 0);
    busyNow.run(60 * SEC, 0.9);
    expect(busyNow.load.busy()).toBe("the CPU was 90% busy over the last minute");

    const busyBefore = cpuBox();
    busyBefore.run(60 * SEC, 1);
    busyBefore.run(60 * SEC, 0.1);
    expect(busyBefore.load.busy()).toBeNull();
  });

  test("waiting for the disk is rest, not work — and time a hypervisor took is work", () => {
    const fake = files();
    let now = 0;
    // user nice system idle iowait irq softirq steal: a minute mostly in iowait, then one mostly stolen.
    fake.map.set("/proc/stat", "cpu  100 0 0 100 0 0 0 0 0 0\n");
    const load = new BoxLoad(fake.reader, () => now);
    load.sample();
    now = 60 * SEC;
    fake.map.set("/proc/stat", "cpu  300 0 0 200 1500 0 0 0 0 0\n");
    load.sample();
    expect(load.busy()).toBeNull();
    now = 120 * SEC;
    fake.map.set("/proc/stat", "cpu  400 0 0 300 1500 0 0 1400 0 0\n");
    load.sample();
    expect(load.busy()).toBe("the CPU was 94% busy over the last minute");
  });

  test("a burst of a few seconds in a quiet minute is not a busy minute", () => {
    const box = cpuBox();
    box.run(15 * SEC, 1);
    box.run(45 * SEC, 0);
    expect(box.load.busy()).toBeNull();
  });
});

describe("heat", () => {
  const zone = (n: number, temp: string | null, trips: [string, string][]) => {
    const entries: Record<string, string> = {};
    const dir = `/sys/class/thermal/thermal_zone${n}`;
    if (temp !== null) entries[`${dir}/temp`] = temp;
    else entries[`${dir}/type`] = "x86_pkg_temp";
    trips.forEach(([type, at], i) => {
      entries[`${dir}/trip_point_${i}_type`] = `${type}\n`;
      entries[`${dir}/trip_point_${i}_temp`] = `${at}\n`;
    });
    return entries;
  };
  const busy = (entries: Record<string, string>) => new BoxLoad(files(entries).reader).busy();

  test("a zone at or past its passive trip point is busy, and named with both temperatures", () => {
    expect(busy(zone(0, "81000\n", [["passive", "80000"]]))).toBe("thermal_zone0 is at 81 °C, at or past its passive trip point of 80 °C");
    expect(busy(zone(0, "80000\n", [["passive", "80000"]]))).toBe("thermal_zone0 is at 80 °C, at or past its passive trip point of 80 °C");
  });

  test("below it, not busy", () => {
    expect(busy(zone(0, "79900\n", [["passive", "80000"]]))).toBeNull();
  });

  test("a fan's trip point is not counted — the cooling working is not the box in trouble", () => {
    expect(busy(zone(0, "60000\n", [["active", "50000"], ["passive", "85000"]]))).toBeNull();
  });

  test("the lowest of the counted trip points is the one", () => {
    expect(busy(zone(0, "80000\n", [["critical", "100000"], ["passive", "90000"], ["hot", "75000"]]))).toBe(
      "thermal_zone0 is at 80 °C, at or past its hot trip point of 75 °C",
    );
  });

  test("a trip point a driver left unset — at or below 0 °C — is no limit", () => {
    expect(busy(zone(0, "40000\n", [["passive", "-274000"], ["critical", "0"]]))).toBeNull();
  });

  test("a zone that will not say its temperature is passed over, and the next one counts", () => {
    expect(busy({ ...zone(0, null, [["passive", "1000"]]), ...zone(1, "95000", [["critical", "90000"]]), "/sys/class/thermal/cooling_device0/cur_state": "3" })).toBe(
      "thermal_zone1 is at 95 °C, at or past its critical trip point of 90 °C",
    );
  });
});

describe("memory pressure in the daemon's cgroup", () => {
  const psi = (avg60: number) => `some avg10=0.00 avg60=${avg60.toFixed(2)} avg300=0.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=45\n`;
  const busy = (entries: Record<string, string>) => new BoxLoad(files(entries).reader).busy();

  test("its own cgroup's `some avg60` at 10% or more is busy", () => {
    const unit = "/sys/fs/cgroup/system.slice/nouride.service";
    expect(busy({ "/proc/self/cgroup": "0::/system.slice/nouride.service\n", [`${unit}/memory.pressure`]: psi(12.5) })).toBe(
      "the daemon's cgroup waited for memory 12.5% of the last minute",
    );
    expect(busy({ "/proc/self/cgroup": "0::/system.slice/nouride.service\n", [`${unit}/memory.pressure`]: psi(9.99) })).toBeNull();
  });

  test("moved into its own daemon/ beside commands/, the unit's above both is read — the agents' commands run short there too", () => {
    const unit = "/sys/fs/cgroup/system.slice/nouride.service";
    expect(
      busy({
        "/proc/self/cgroup": "0::/system.slice/nouride.service/daemon\n",
        [`${unit}/memory.pressure`]: psi(30),
        [`${unit}/daemon/memory.pressure`]: psi(0),
        [`${unit}/commands/memory.pressure`]: psi(45),
      }),
    ).toBe("the daemon's cgroup waited for memory 30% of the last minute");
  });

  test("a container's own namespace — `0::/` — is the cgroup filesystem's root", () => {
    expect(busy({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.pressure": psi(20) })).toBe("the daemon's cgroup waited for memory 20% of the last minute");
  });
});

describe("a reading that fails is room", () => {
  test("a box with none of the files — macOS, a sandbox without /proc — is never busy, and keeps no timer", () => {
    const load = new BoxLoad(files().reader);
    expect(load.start()).toBeNull();
    expect(load.busy()).toBeNull();
  });

  test("where /proc/stat is read, a timer reads it — for shutdown to clear", () => {
    const load = new BoxLoad(files({ "/proc/stat": stat(1, 1) }).reader);
    const timer = load.start();
    expect(timer).not.toBeNull();
    clearInterval(timer!);
  });

  test("what cannot be parsed says nothing", () => {
    const fake = files({
      "/proc/stat": "cpu  lots of work\n",
      "/sys/class/thermal/thermal_zone0/temp": "hot\n",
      "/sys/class/thermal/thermal_zone0/trip_point_0_type": "passive\n",
      "/sys/class/thermal/thermal_zone0/trip_point_0_temp": "\n",
      "/proc/self/cgroup": "0::/x\n",
      "/sys/fs/cgroup/x/memory.pressure": "some avg60=lots\n",
    });
    let now = 0;
    const load = new BoxLoad(fake.reader, () => now);
    load.sample();
    now = 120 * SEC;
    load.sample();
    expect(load.busy()).toBeNull();
  });

  test("a reader that throws is no reading — and the signals after it are still read", () => {
    const reader: BoxFiles = {
      read: (path) => (path === "/proc/self/cgroup" ? "0::/\n" : path === "/sys/fs/cgroup/memory.pressure" ? "some avg10=0.00 avg60=50.00 avg300=0.00 total=1\n" : null),
      list: (dir) => {
        if (dir === "/sys/class/thermal") throw new Error("EACCES");
        return [];
      },
    };
    expect(new BoxLoad(reader).busy()).toBe("the daemon's cgroup waited for memory 50% of the last minute");
    const failing: BoxFiles = {
      read: () => {
        throw new Error("EIO");
      },
      list: () => {
        throw new Error("EIO");
      },
    };
    expect(new BoxLoad(failing).busy()).toBeNull();
  });
});
