/**
 * The machine the daemon runs on, and how much work it is given at once by default.
 *
 * An agent was told nothing of the box under it, and the two limits on work behind a turn were the same on every
 * machine: two helpers in the background for each agent, and missions by the number of agents. A phone with 4 GB and
 * a server with 64 were handed the same number. Read once at boot (`runtime`'s `readMachine`, and the cgroup the
 * agents' commands run in where the unit gives them one), said in the prompt, and the default of both limits where the
 * config sets neither.
 */

import { readMachine, type CommandIsolation, type MachineSpec } from "@nouride/runtime";
import { formatBytes, plural, resolveMaxBackground, type DelegateSection } from "@nouride/shared";

export interface Machine extends MachineSpec {
  /** What every command the agents run may hold together, where they run in a cgroup of their own (`isolateCommands`). */
  commandsBytes?: number;
}

/** The machine as boot found it: its cores and memory, and the commands' own cap where there is one. */
export function machineAtBoot(commands?: Pick<CommandIsolation, "commandsMaxBytes">, spec: MachineSpec = readMachine()): Machine {
  return { ...spec, ...(commands?.commandsMaxBytes ? { commandsBytes: commands.commandsMaxBytes } : {}) };
}

/** The most the machine's default gives, however large the machine: the fan-out one `delegate` call has. */
const MOST_AT_ONCE = 4;

const GiB = 1024 ** 3;

/**
 * Where the commands have no cgroup of their own they share the machine with the daemon and the system. Seven tenths
 * of it is counted as theirs: an estimate, close to what the service unit's own split leaves them.
 */
const SHARED_MEMORY_SHARE = 0.7;

/**
 * How many helpers, and how many missions, run at once where the config names no number: four at most, fewer on a
 * small machine. A starting value, to be measured on real boxes, not a figure from one.
 *
 * - **Memory:** one for each whole GiB the agents' commands may hold. Work behind a turn is a model call and the
 *   commands it runs, and the heavy ones are builds and test suites: a typecheck and a test suite together held
 *   1.7 GB on a 2 GB box and took the daemon down with them, so two of them is past what such a box has.
 * - **Cores:** all but one, which stays with the daemon and the turn a person is waiting on.
 *
 * The lower of the two, and never less than one: a machine too small for one helper is still asked for one, which the
 * person can turn off. A machine that will not say its memory is promised no more than that.
 */
export function atOnceBy(machine: Machine): number {
  const room = machine.commandsBytes ?? machine.memoryBytes * SHARED_MEMORY_SHARE;
  const byMemory = Math.floor(room / GiB);
  const byCores = machine.cores - 1;
  return Math.max(1, Math.min(MOST_AT_ONCE, byMemory, byCores));
}

/** The machine in a few words, every figure as read: `6 cores, 8.0GB of memory (5.9GB of it for the agents' commands)`. */
export function machineWords(machine: Machine): string {
  const memory = machine.memoryBytes > 0 ? `, ${formatBytes(machine.memoryBytes)} of memory` : "";
  const commands = machine.commandsBytes ? ` (${formatBytes(machine.commandsBytes)} of it for the agents' commands)` : "";
  return `${machine.cores} ${plural(machine.cores, "core")}${memory}${memory ? commands : ""}`;
}

/** A limit as it holds now, and who said it: the agent's own pack, the daemon's config, or nobody, so the machine. */
export interface InForce {
  limit: number;
  from: "agent" | "config" | "machine";
}

/**
 * How many helpers and asks one agent may have in the background (`[delegate] max_background`): its pack's number, the
 * daemon's, or what the machine gives. A number that was set always wins, 0 included, which turns them off.
 */
export function backgroundInForce(delegate: DelegateSection, machine: Machine, own: number | undefined): InForce {
  const from = own !== undefined ? "agent" : delegate.maxBackground !== undefined ? "config" : "machine";
  return { limit: resolveMaxBackground(own, delegate.maxBackground ?? atOnceBy(machine)), from };
}

/**
 * Both limits on work at once as they hold for the whole daemon, with the machine they were read against: what
 * `/status` carries, and what `doctor` and `config check` say. `auto`: nobody set it, so the machine decided.
 */
export interface AtOnce {
  machine: string;
  helpers: { limit: number; auto: boolean };
  missions: { limit: number; auto: boolean };
}

/** The two limits in one line, each with where its number came from. */
export function atOnceWords(view: AtOnce): string {
  const from = (auto: boolean) => (auto ? "from this machine" : "set in the config");
  const helpers = view.helpers.limit === 0 ? "no helpers in the background" : `${view.helpers.limit} ${plural(view.helpers.limit, "helper")} in the background for each agent`;
  return `${helpers} (${from(view.helpers.auto)}), ${view.missions.limit} ${plural(view.missions.limit, "mission")} at once (${from(view.missions.auto)}); this machine: ${view.machine}`;
}

/** The background limit as a refusal names it: the setting that holds, or that none does and the machine decided. */
export function backgroundLimitWords(inForce: InForce): string {
  return inForce.from === "machine"
    ? `${inForce.limit}, what this machine has room for: \`[delegate] max_background\` is not set`
    : `\`[delegate] max_background = ${inForce.limit}\``;
}
