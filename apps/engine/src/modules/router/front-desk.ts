/**
 * The front desk: who answers a room message that addressed nobody, when several of our bots share the room.
 *
 * Without it, nobody does (`answerUnaddressed`, `pipeline/inbound.ts`): every bot in the room is handed its own copy,
 * so any rule that names no agent answers once per bot, and the two that shipped — the connection's owner, the default
 * agent — each produced six replies to one word. The orchestrator (`[daemon] orchestrator`, 0.7.18) fills that
 * silence: the same agent on every copy, so the per-(message, agent) claim lets exactly one through. It needs no switch
 * of its own — naming an orchestrator is the choice — and a room that requires a mention keeps its silence.
 */

import type { ChatType } from "@nouride/shared";

/**
 * The agent to pass the router as `frontDesk`, or nothing.
 *
 * Only where the router would otherwise answer nobody: a room (a DM has its owner), with `answerUnaddressed` false.
 * `groups_require_mention` still wins — an operator who asked for a tag in groups asked for silence without one — and
 * a room with a member list the orchestrator is not on is not its room to answer in.
 */
export function frontDeskFor(input: {
  orchestrator: string | undefined;
  chatType: ChatType;
  /** What the router is told: may the ordinary fallbacks answer here. True means the desk is not needed. */
  answerUnaddressed: boolean;
  groupsRequireMention: boolean;
  /** The room's members where the daemon knows them (`roomAgents`), `null` on a platform chat. */
  members: string[] | null;
}): string | undefined {
  if (!input.orchestrator) return undefined;
  if (input.chatType === "dm" || input.answerUnaddressed || input.groupsRequireMention) return undefined;
  if (input.members && !input.members.includes(input.orchestrator)) return undefined;
  return input.orchestrator;
}
