/**
 * Whether the machine is busy — the one question background work asks before it takes the box (0.8.0).
 *
 * The nightly memory pass, its embedding and a helper started in the background make room for the machine: while it is
 * busy they wait (`room-wait.ts`), and a turn somebody is waiting for never asks. Busy is any one of three signals, each
 * read from the kernel's own files and counted only where its file is there — so on macOS, or in a sandbox without
 * `/proc`, nothing is ever busy, and no code asks which system it is on:
 *
 * - **CPU** — the share of the last minute every CPU together spent working, from `/proc/stat` read every few seconds.
 *   Not the load average: it counts processes waiting on a disk too, so a box with idle cores and a slow disk reads as
 *   loaded.
 * - **Heat** — a thermal zone at or past a trip point where the kernel acts on it (`/sys/class/thermal`).
 * - **Memory pressure** — the share of the last minute something in the daemon's cgroup waited for memory, from the
 *   cgroup's own `memory.pressure` (PSI).
 *
 * Every threshold below is a design constant, chosen and said why — not a figure measured on a box.
 *
 * A reading that fails is no reading: the box is not busy. A wait that never ends because a file could not be read is
 * worse than background work run on a busy box, which is what happened before any of this.
 */

import { listDir, readTextFileSync } from "@nouride/runtime";
import { contained, createLogger } from "@nouride/shared";

const log = createLogger("box-load");

/** The CPUs together busier than this share of the last minute: the figure the feature was specified with (0.8.0). */
const CPU_BUSY_SHARE = 0.7;
/** "For a minute": usage is read over at least this long, so a burst of a few seconds — a build's link step — does not count. */
const CPU_WINDOW_MS = 60_000;
/** How often `/proc/stat` is read: four small reads a minute, and the minute is measured to within this. */
const CPU_SAMPLE_MS = 15_000;

/**
 * The trip points that count: where the kernel itself acts on the heat — `passive` slows the CPU down, `hot` says a
 * shutdown is near, `critical` is the shutdown. Of these, a zone's lowest. Not `active`: crossing one turns a fan on or
 * up, which is the cooling at work, and a box whose fan runs has room.
 */
const COUNTED_TRIPS = new Set(["passive", "hot", "critical"]);

/**
 * `some avg60` in a cgroup's `memory.pressure`, in percent: the share of the last minute in which at least one of its
 * tasks was stalled waiting for memory — reclaim, swap, pages read back. A cgroup that never waits for memory reads 0.00.
 * Ten is roughly six seconds of the last minute (the kernel's figure is a running average, not a window): past a passing
 * blip, and short of the `full` stalls where everything waits. The one-minute average, not the ten-second one, so a
 * single burst does not stop the night's work; and `some`, not `full`, so the work steps aside before the person's turns
 * are stalled too.
 */
const MEMORY_PRESSURE_PCT = 10;

const PROC_STAT = "/proc/stat";
const THERMAL = "/sys/class/thermal";
const SELF_CGROUP = "/proc/self/cgroup";
const CGROUP_ROOT = "/sys/fs/cgroup";

/** The kernel's files, read through this — the real ones, or a test's. */
export interface BoxFiles {
  /** A file's text, or null when it is not there or cannot be read. */
  read(path: string): string | null;
  /** The names in a directory; none when it cannot be listed. */
  list(dir: string): string[];
}

/** What background work asks. */
export interface BoxBusy {
  /** Why the box is busy now, said for a person — or null: not busy, or nothing could tell. Never throws. */
  busy(): string | null;
}

const HOST_FILES: BoxFiles = {
  read: (path) => {
    try {
      return readTextFileSync(path);
    } catch {
      return null;
    }
  },
  list: (dir) => listDir(dir).map((entry) => entry.name),
};

interface CpuSample {
  at: number;
  /** Jiffies spent working, and in all, since boot — every CPU together. */
  work: number;
  total: number;
}

export class BoxLoad implements BoxBusy {
  /** The newest sample at least a minute old, and every one since: the window's start is the first. */
  private readonly samples: CpuSample[] = [];

  constructor(
    private readonly files: BoxFiles = HOST_FILES,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Reads the CPU's time every `CPU_SAMPLE_MS` from now — where `/proc/stat` can be read at all. The timer, for shutdown
   * to clear; null where there is nothing to read, and then no timer is kept.
   */
  start(): ReturnType<typeof setInterval> | null {
    const read = contained(log, "could not read the CPU's time", () => this.sample());
    read();
    if (this.samples.length === 0) return null;
    const timer = setInterval(read, CPU_SAMPLE_MS);
    timer.unref?.();
    return timer;
  }

  /** One reading of the CPU's time, kept while the window needs it. */
  sample(): void {
    const times = cpuTimes(this.files.read(PROC_STAT));
    if (!times) return;
    const at = this.now();
    this.samples.push({ at, ...times });
    // The second sample is a minute old too: the first is no longer the window's start.
    while (this.samples.length > 1 && at - this.samples[1]!.at >= CPU_WINDOW_MS) this.samples.shift();
  }

  busy(): string | null {
    for (const signal of [() => this.cpu(), () => this.heat(), () => this.memoryPressure()]) {
      try {
        const reason = signal();
        if (reason) return reason;
      } catch (err) {
        // Not busy: a reading that throws is no reading.
        log.debug("a reading of the box's load failed", { error: String(err) });
      }
    }
    return null;
  }

  /** The CPUs' busy share between the window's start and the newest sample — null until a minute has been read. */
  private cpu(): string | null {
    const first = this.samples[0];
    const newest = this.samples.at(-1);
    if (!first || !newest || newest.at - first.at < CPU_WINDOW_MS) return null;
    const total = newest.total - first.total;
    if (total <= 0) return null;
    const share = (newest.work - first.work) / total;
    return share > CPU_BUSY_SHARE ? `the CPU was ${Math.round(share * 100)}% busy over the last minute` : null;
  }

  private heat(): string | null {
    for (const zone of this.files.list(THERMAL)) {
      if (!/^thermal_zone\d+$/.test(zone)) continue;
      const dir = `${THERMAL}/${zone}`;
      const temp = milli(this.files.read(`${dir}/temp`));
      if (temp === null) continue;
      const trip = lowestTrip(this.files, dir);
      if (trip && temp >= trip.temp) return `${zone} is at ${celsius(temp)}, at or past its ${trip.type} trip point of ${celsius(trip.temp)}`;
    }
    return null;
  }

  private memoryPressure(): string | null {
    const dir = this.cgroupDir();
    if (!dir) return null;
    const avg60 = Number(/^some\b.*\bavg60=([\d.]+)/m.exec(this.files.read(`${dir}/memory.pressure`) ?? "")?.[1]);
    if (!Number.isFinite(avg60) || avg60 < MEMORY_PRESSURE_PCT) return null;
    return `the daemon's cgroup waited for memory ${avg60}% of the last minute`;
  }

  /**
   * The cgroup the daemon was started in. When boot moved it into a `daemon/` of its own beside `commands/`
   * (`isolateCommands`, 0.7.19), the one above both: the agents' commands are in it too, and it is the one that runs
   * short. Pressure is counted for a cgroup's whole subtree.
   */
  private cgroupDir(): string | null {
    const path = (this.files.read(SELF_CGROUP) ?? "").split("\n").find((line) => line.startsWith("0::"))?.slice(3).trim();
    if (path === undefined) return null;
    const here = `${CGROUP_ROOT}${path === "/" ? "" : path}`;
    if (here.endsWith("/daemon")) {
      const unit = here.slice(0, -"/daemon".length);
      if (this.files.list(unit).includes("commands")) return unit;
    }
    return here;
  }
}

/**
 * The `cpu` line's time, in jiffies: idle and waiting for disk as rest, the rest — user, nice, system, interrupts, and
 * time a hypervisor took — as work. Guest time is already inside user and nice, so it is not added again.
 */
function cpuTimes(text: string | null): Omit<CpuSample, "at"> | null {
  const fields = /^cpu[ \t]+([\d \t]+)$/m.exec(text ?? "")?.[1]?.trim().split(/\s+/).map(Number);
  if (!fields || fields.length < 4) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  const work = user + nice + system + irq + softirq + steal;
  return { work, total: work + idle + iowait };
}

/** A zone's lowest trip point of a counted type. */
function lowestTrip(files: BoxFiles, dir: string): { temp: number; type: string } | null {
  let lowest: { temp: number; type: string } | null = null;
  for (const name of files.list(dir)) {
    const n = /^trip_point_(\d+)_type$/.exec(name)?.[1];
    if (n === undefined) continue;
    const type = files.read(`${dir}/${name}`)?.trim() ?? "";
    if (!COUNTED_TRIPS.has(type)) continue;
    const temp = milli(files.read(`${dir}/trip_point_${n}_temp`));
    // At or below 0 °C is not a limit: it is how a driver leaves a trip point unset (the kernel's own mark for one is below absolute zero).
    if (temp === null || temp <= 0) continue;
    if (!lowest || temp < lowest.temp) lowest = { temp, type };
  }
  return lowest;
}

/** A sysfs temperature: millidegrees Celsius, one number. */
function milli(text: string | null): number | null {
  const value = Number(text?.trim());
  return text !== null && text.trim() !== "" && Number.isFinite(value) ? value : null;
}

const celsius = (milli: number): string => `${Math.round(milli / 100) / 10} °C`;
