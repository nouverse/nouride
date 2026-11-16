/**
 * A mission's own folder, as boot hands it to the missions (`boot/missions.ts`): the folder the daemon made for it under
 * its agent's own, and what is asked of it once the mission has ended or been stopped.
 */

import { freeDiskBytes } from "@nouride/runtime";
import type { GlobalConfig } from "@nouride/shared";
import { privateWorkspace, type AgentRegistry } from "@nouride/persona";
import type { MissionsDeps } from "@/modules/missions/deps.ts";
import type { Mission } from "@/modules/missions/types.ts";
import { inOwnFolder, ownFolderOf, ownFolders, removeExtraWorktrees, removeLeftFolder, removeOwnFolder, uncommittedIn, type AsAgent } from "@/modules/missions/worktree.ts";
import { DISK_WARN_MB } from "./maintenance.ts";

/**
 * What the missions ask of the folder the daemon made for each: removed once it is old, read for work nobody
 * committed, swept where no record names it, tidied of the worktrees a mission made itself. Every one runs as the
 * mission's agent and touches only that folder: `newMission`'s default, or the worktree inside it.
 */
export function ownFolderPorts(
  params: { config: () => GlobalConfig; registry: Pick<AgentRegistry, "get" | "enabled"> },
  asTheAgent: (agentId: string) => AsAgent,
): Pick<MissionsDeps, "remove" | "unsaved" | "folders" | "removeLeft" | "diskLow" | "tidy"> {
  const privateOf = (agentId: string) => privateWorkspace(params.config().daemon.workspaceDir, agentId);
  const ownOf = (mission: Pick<Mission, "agentId" | "id">) => ownFolderOf(privateOf(mission.agentId), mission.id);
  return {
    remove: async (mission, how) => {
      // For a draft that never started, the folder its brief was written to, whatever folder it would have worked in.
      const own = ownOf(mission);
      if ((!inOwnFolder(mission.workdir, own) && mission.startedAt !== null) || !params.registry.get(mission.agentId)) return null;
      return await removeOwnFolder(own, asTheAgent(mission.agentId), how);
    },
    unsaved: async (mission) => {
      const own = ownOf(mission);
      if (!inOwnFolder(mission.workdir, own) || !params.registry.get(mission.agentId)) return [];
      return await uncommittedIn(own, asTheAgent(mission.agentId));
    },
    folders: () => params.registry.enabled().flatMap((agent) => ownFolders(privateOf(agent.config.id)).map((folder) => ({ agentId: agent.config.id, ...folder }))),
    removeLeft: (agentId, missionId) => removeLeftFolder(ownFolderOf(privateOf(agentId), missionId), asTheAgent(agentId)),
    // Where missions work — the workspace's disk — against the daemon's own disk warning, a starting value.
    diskLow: () => {
      const free = freeDiskBytes(params.config().daemon.workspaceDir);
      const freeMb = free === null ? null : Math.round(free / (1024 * 1024));
      return freeMb !== null && freeMb < DISK_WARN_MB ? freeMb : null;
    },
    tidy: async (mission) => {
      if (!params.registry.get(mission.agentId)) return { removed: [], kept: [] };
      return await removeExtraWorktrees(ownOf(mission), asTheAgent(mission.agentId));
    },
  };
}
