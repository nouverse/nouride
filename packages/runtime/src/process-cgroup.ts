/**
 * Keeping the daemon answering while what its agents run eats the machine (0.7.19).
 *
 * Every command an agent started ran in the daemon's own cgroup, under the unit's one `MemoryHigh`. On a 2 GB box an
 * agent's audit ran a typecheck and a test suite beside the daemon — 1.7 GB together — and held the whole unit over
 * its ceiling for three quarters of an hour: the kernel throttled every process in it, the daemon too, `/health` took
 * longer than 20 s and every gateway went quiet. Nothing crashed and nothing restarted; from a chat it was dead.
 *
 * So where the unit hands its cgroup over (`Delegate=yes`, which it says with `NOURIDE_CGROUP=delegated`), the daemon
 * splits it in two at boot:
 *
 *   daemon/     the daemon — its memory protected (`memory.min`), and first on the CPU (`cpu.weight`)
 *   commands/   every command an agent runs, background job, terminal session and MCP server — capped (`memory.max`)
 *               below the unit's ceiling, so the unit never reaches the line that throttles the daemon, and a command
 *               that outgrows the share is what the kernel kills: alone, with an exit the agent reads and reports.
 *
 * Memory and CPU, not a sandbox: a command reaches what it reached before. It is moved by the `sh` that starts it,
 * before it `exec`s, so whatever it forks is born in `commands/` too. Anywhere else — not Linux, no cgroup v2, a unit
 * from before 0.7.19, a container's read-only cgroup filesystem — nothing moves, commands run beside the daemon as
 * they always did (first in line for the OOM killer, `withOomPreference`), and the report says why.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CommandIsolation {
  /** Whether agents' commands run in a cgroup of their own. */
  isolated: boolean;
  /** Whether a systemd unit runs the daemon — where they would, so where their not doing it is something to fix. */
  systemd: boolean;
  /** Why they do not, said for a person. */
  reason?: string;
  /** What every command together may hold before the kernel kills one, in bytes. */
  commandsMaxBytes?: number;
  /** The daemon's memory the kernel does not take back for them, in bytes. */
  daemonMinBytes?: number;
  /** Whether the daemon is ahead of them on the CPU — only where the unit was handed the CPU controller. */
  cpu?: boolean;
}

/** `<cgroup>/commands` once `isolateCommands` made it; null leaves a command where the daemon is. */
let commandsDir: string | null = null;

const MiB = 1024 * 1024;

/** A cgroup's limit file: a number, or `max` for none. */
const limit = (text: string | null): number | null => {
  const value = Number(text?.trim());
  return text !== null && Number.isFinite(value) && value > 0 ? value : null;
};

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Whether `controller` is now on for the cgroups below `cgroup`. */
function enable(cgroup: string, controller: string): boolean {
  try {
    writeFileSync(`${cgroup}/cgroup.subtree_control`, `+${controller}`, { flag: "a" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The share (pure). The ceiling is the least of the unit's `memory.max`, its `memory.high` and the machine's memory:
 * the daemon keeps a fifth of it, between 256 and 512 MiB — what it holds on a busy box, with room — and the commands
 * the rest, never less than half.
 */
function share(limits: { max: number | null; high: number | null; total: number | null }): { commandsMaxBytes: number; daemonMinBytes: number } | null {
  const known = [limits.max, limits.high, limits.total].filter((value): value is number => value !== null);
  if (known.length === 0) return null;
  const ceiling = Math.min(...known);
  const reserve = Math.min(Math.max(ceiling / 5, 256 * MiB), 512 * MiB);
  const commandsMaxBytes = Math.floor(Math.max(ceiling - reserve, ceiling / 2) / MiB) * MiB;
  return { commandsMaxBytes, daemonMinBytes: Math.floor((ceiling - commandsMaxBytes) / MiB) * MiB };
}

/**
 * Split this process's cgroup into `daemon/` and `commands/`, and move this process into the first. Once, at boot,
 * before anything is spawned. Never throws: what it could not do is the report's `reason`, and commands then run
 * where the daemon is.
 *
 * `root`, `self` and `meminfo` are where the cgroup filesystem, `/proc/self/cgroup` and `/proc/meminfo` are read —
 * the real ones unless a test points them at files of its own.
 */
export function isolateCommands(options: { env?: Record<string, string | undefined>; root?: string; self?: string; meminfo?: string } = {}): CommandIsolation {
  const env = options.env ?? process.env;
  const systemd = env.NOURIDE_SERVICE_KIND === "systemd";
  const not = (reason: string): CommandIsolation => ({ isolated: false, systemd, reason });
  if (!options.root && process.platform !== "linux") return not("not Linux");
  if (env.NOURIDE_CGROUP !== "delegated") {
    return not(systemd ? "the service unit does not hand its cgroup over: it was written before 0.7.19" : "not started by a service unit that hands its cgroup over");
  }
  // cgroup v2 is one line, `0::<path>` — `/` inside a cgroup namespace (`ProtectControlGroups=private`).
  const line = (read(options.self ?? "/proc/self/cgroup") ?? "").split("\n").find((entry) => entry.startsWith("0::"));
  if (line === undefined) return not("no cgroup v2 here");
  const mount = options.root ?? "/sys/fs/cgroup";
  let here = `${mount}${line.slice(3) === "/" ? "" : line.slice(3)}`;
  // Already moved, by a daemon before this one in the same unit.
  if (here.endsWith("/daemon") && existsSync(`${dirname(here)}/commands`)) here = dirname(here);
  if (!existsSync(`${here}/cgroup.controllers`)) return not(`no cgroup v2 filesystem at ${mount}`);
  try {
    // systemd hands over the directory and its files together; a read-only mount refuses both.
    accessSync(here, constants.W_OK);
  } catch {
    return not("its cgroup is not writable: the unit needs Delegate=yes, and no ProtectControlGroups=true");
  }
  const available = (read(`${here}/cgroup.controllers`) ?? "").trim().split(/\s+/);
  if (!available.includes("memory")) return not("the unit was not handed the memory controller");

  try {
    mkdirSync(`${here}/daemon`, { recursive: true });
    mkdirSync(`${here}/commands`, { recursive: true });
    // A cgroup with controllers for its children may hold no process itself: everything in it moves, which at boot is
    // the daemon alone.
    for (const pid of (read(`${here}/cgroup.procs`) ?? "").split("\n").filter(Boolean)) {
      try {
        // Appended, as the shell's `>>`: a cgroup file takes each write as one move.
        writeFileSync(`${here}/daemon/cgroup.procs`, pid, { flag: "a" });
      } catch (err) {
        // Gone since it was listed.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
    // Memory is the point; the CPU and the process count are worth having, and a box that will not enable them still
    // gets the rest.
    writeFileSync(`${here}/cgroup.subtree_control`, "+memory", { flag: "a" });
    const controllers = ["memory", ...["cpu", "pids"].filter((name) => available.includes(name) && enable(here, name))];

    const kb = /^MemTotal:\s+(\d+)\s+kB/m.exec(read(options.meminfo ?? "/proc/meminfo") ?? "")?.[1];
    const sized = share({ max: limit(read(`${here}/memory.max`)), high: limit(read(`${here}/memory.high`)), total: kb ? Number(kb) * 1024 : null });
    if (sized) {
      writeFileSync(`${here}/commands/memory.max`, String(sized.commandsMaxBytes));
      writeFileSync(`${here}/daemon/memory.min`, String(sized.daemonMinBytes));
    }
    // Ten to one when both want the CPU; nothing when only one does.
    const cpu = controllers.includes("cpu");
    if (cpu) writeFileSync(`${here}/daemon/cpu.weight`, "1000");
    // Room for the daemon's own threads, however many processes the commands start.
    const tasks = limit(read(`${here}/pids.max`));
    if (controllers.includes("pids") && tasks !== null && tasks > 1024) writeFileSync(`${here}/commands/pids.max`, String(tasks - 256));

    commandsDir = `${here}/commands`;
    return { isolated: true, systemd, ...(sized ?? {}), cpu };
  } catch (err) {
    return not(`could not split its cgroup: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * `cmd`, run in `commands/` — moved there by the shell that starts it, before it starts, so nothing it forks is born
 * beside the daemon. Unchanged where `isolateCommands` made no `commands/`; a move that fails runs it where it is.
 */
export function inCommandsCgroup(cmd: string[]): string[] {
  return commandsDir ? ["/bin/sh", "-c", '{ echo $$ > "$0"; } 2>/dev/null; exec "$@"', `${commandsDir}/cgroup.procs`, ...cmd] : cmd;
}

/**
 * How many processes the kernel has stopped for memory in `commands/` so far, or null where there is none. Read before
 * and after a command: a rise is what its exit cannot say — `tail` killed in `head | tail | wc -c` leaves `wc` to exit
 * 0 with what it was given, and an agent reported that, on the live box, as the command having worked.
 */
export function commandsOomKills(): number | null {
  if (!commandsDir) return null;
  const count = /^oom_kill (\d+)$/m.exec(read(`${commandsDir}/memory.events`) ?? "")?.[1];
  return count === undefined ? null : Number(count);
}

/** The rise in `commandsOomKills` since `before`, when there was one. */
export function oomKillsSince(before: number | null): number | undefined {
  const after = commandsOomKills();
  return before !== null && after !== null && after > before ? after - before : undefined;
}

/** Commands run where the daemon is again. For a test that split a cgroup of its own making. */
export function forgetCommandIsolation(): void {
  commandsDir = null;
}
