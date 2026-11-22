/**
 * What a mission's commands left running, bound to the daemon's parts (`modules/missions/left-running.ts`): noted
 * from a mission's own turn as its command ends, and ended, with a word to its chat, as the mission ends.
 */

import { signalGroup, stillLeft } from "@nouride/runtime";
import { createLogger, type LeftRunning } from "@nouride/shared";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { leftEndedNotice, MissionLeft } from "@/modules/missions/left-running.ts";
import { called } from "@/modules/missions/notices.ts";
import type { Mission } from "@/modules/missions/types.ts";

const log = createLogger("missions.left");

export function missionLeft(deps: {
  /** A command run as an agent: its own user where agents have one. */
  asAgent: (agentId: string) => (argv: string[]) => Promise<unknown>;
  /** A word to the chat a mission reports to, kept as its notices are. */
  tell: (mission: Mission, text: string) => Promise<void>;
}): { endLeft: (mission: Mission) => void; commandLeft: (at: { gatewayId: string; chatId: string }) => ((left: LeftRunning) => void) | undefined } {
  const left = new MissionLeft({
    stillLeft,
    signal: signalGroup,
    // Where agents run as their own users the daemon may not signal their processes, and the agent's own `kill` does.
    signalAs: async (agentId, group, signal) => void (await deps.asAgent(agentId)(["sh", "-c", 'kill -s "$1" -- "-$2"', "sh", signal.slice(3), String(group)])),
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  });
  return {
    endLeft: (mission) =>
      void left
        .end(mission)
        // Its chat is told what was ended, as any notice of the mission's: said, never done in silence.
        .then((ended) => (ended.length > 0 ? deps.tell(mission, leftEndedNotice(called(mission), ended)) : undefined))
        .catch((err: unknown) => log.warn("what a mission's commands left running could not be ended", { mission: mission.id, error: String(err) })),
    // A taker for a mission's own turn and its own jobs alone: nobody else's commands are read for it.
    commandLeft: (at) => (at.gatewayId === MISSION_GATEWAY_ID ? (seen) => left.note(at.chatId, seen) : undefined),
  };
}
