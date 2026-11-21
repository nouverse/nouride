/**
 * What a mission's commands left running, kept while the mission is open and ended when it ends.
 *
 * A mission's background jobs end with it (`Missions.end`). What one of its commands started and did not wait for was
 * nobody's: on a live box three build workers of a mission that had ended done ran on for eighteen hours, each at a
 * whole core, with no job on record. A command that ends with something still in its own process group is noted here
 * (`@nouride/runtime` `leftRunning`), and at the mission's end what is provably still that group is ended: asked
 * first, then made to. A program that set itself apart, a process manager or a daemon in a session of its own, is in
 * no command's group and is never noted.
 *
 * Kept in memory: after a restart nothing is noted, and nothing is ended. A restart ends the commands' cgroup anyway
 * where the daemon runs under a service manager.
 */

import { createLogger, type LeftProcess, type LeftRunning } from "@nouride/shared";

const log = createLogger("missions.left");

/** Groups kept for one mission at most: past it the oldest goes, with a line in the log. */
export const GROUPS_KEPT = 64;
/** How long what was asked to end is given before it is made to. */
export const GRACE_MS = 3_000;

export interface LeftDeps {
  /** The group's processes now, where it is provably still the group that was noted; none where it cannot be. */
  stillLeft: (left: LeftRunning) => LeftProcess[];
  /** Signal a group as the daemon. `refused`: its processes are the agent's own user's. */
  signal: (group: number, signal: "SIGTERM" | "SIGKILL") => "sent" | "gone" | "refused";
  /** The same signal sent as the agent, where agents run as their own users. */
  signalAs: (agentId: string, group: number, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  wait: (ms: number) => Promise<void>;
}

export class MissionLeft {
  private readonly byMission = new Map<string, LeftRunning[]>();

  constructor(private readonly deps: LeftDeps) {}

  /** A command of a mission's turn ended with something still in its group. */
  note(missionId: string, left: LeftRunning): void {
    const kept = this.byMission.get(missionId) ?? [];
    kept.push(left);
    if (kept.length > GROUPS_KEPT) {
      const dropped = kept.shift()!;
      log.warn("a mission left more groups running than are kept; the oldest is no longer watched", { mission: missionId, group: dropped.group });
    }
    this.byMission.set(missionId, kept);
  }

  /** How many groups a mission has noted: what a test and the log read. */
  noted(missionId: string): number {
    return this.byMission.get(missionId)?.length ?? 0;
  }

  /**
   * End what is still there of what the mission's commands left, and say what was ended, a name with its count
   * ("node (3)"). Asked to end first, and what is still there after `GRACE_MS` is made to. Never throws.
   */
  async end(mission: { id: string; agentId: string }): Promise<string[]> {
    const kept = this.byMission.get(mission.id) ?? [];
    this.byMission.delete(mission.id);
    const ended = new Map<string, number>();
    const asked: LeftRunning[] = [];
    for (const left of kept) {
      const now = this.deps.stillLeft(left);
      if (now.length === 0) continue;
      for (const one of now) ended.set(one.name, (ended.get(one.name) ?? 0) + 1);
      await this.send(mission.agentId, left.group, "SIGTERM");
      asked.push(left);
    }
    if (asked.length === 0) return [];
    await this.deps.wait(GRACE_MS);
    for (const left of asked) {
      if (this.deps.stillLeft(left).length > 0) await this.send(mission.agentId, left.group, "SIGKILL");
    }
    const said = [...ended].map(([name, count]) => (count > 1 ? `${name} (${count})` : name));
    log.info("ended what a mission's commands had left running", { mission: mission.id, agent_id: mission.agentId, processes: said });
    return said;
  }

  private async send(agentId: string, group: number, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    try {
      if (this.deps.signal(group, signal) === "refused") await this.deps.signalAs(agentId, group, signal);
    } catch (err) {
      log.warn("could not signal what a mission's command left running", { group, signal, error: String(err) });
    }
  }
}

/** What the mission's chat is told when something was ended: said, never done in silence. */
export function leftEndedNotice(called: string, ended: readonly string[]): string {
  const count = ended.reduce((sum, one) => sum + Number(/\((\d+)\)$/.exec(one)?.[1] ?? 1), 0);
  return `${called}: ${count === 1 ? "1 process" : `${count} processes`} its commands had left running ${count === 1 ? "was" : "were"} ended with it (${ended.join(", ")}). To keep something running after a mission ends, start it as a service of its own: a process manager, a container, or the system's.`;
}
