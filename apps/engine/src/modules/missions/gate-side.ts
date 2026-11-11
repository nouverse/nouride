/**
 * What the approval gate and its prompts ask of a mission's turn: which mission asked, where its prompt goes, and the
 * "approve similar from this mission" a person may give it. Every answer is null for a turn that is not a mission's.
 */

import { MISSION_GATEWAY_ID } from "./gateway.ts";
import type { MissionsPort } from "./missions.store.ts";
import { shortId } from "./page.ts";
import { similarKind, similarLabel, type SimilarAllowed } from "./similar.ts";
import { isFinal } from "./types.ts";

export function gateSide(store: Pick<MissionsPort, "get">, similar: SimilarAllowed) {
  return {
    /** The mission whose turn asked, as its prompt names it. */
    missionOf: (request: { gateway: string; chatId: string }) => {
      const mission = request.gateway === MISSION_GATEWAY_ID ? store.get(request.chatId) : null;
      return mission ? { id: shortId(mission.id), goal: mission.goal } : null;
    },
    /** *Approve similar from this mission*: the kind a request is, and the yes that allows it there. */
    similar: {
      kindOf: (request: { gateway: string; tool: string; params: Record<string, unknown> }) => {
        const kind = request.gateway === MISSION_GATEWAY_ID ? similarKind(request.tool, request.params) : null;
        return kind ? similarLabel(kind) : null;
      },
      allow: (request: { gateway: string; chatId: string; tool: string; params: Record<string, unknown> }) => {
        const kind = request.gateway === MISSION_GATEWAY_ID ? similarKind(request.tool, request.params) : null;
        const mission = kind ? store.get(request.chatId) : null;
        if (kind && mission && !isFinal(mission.status)) similar.allow(mission.id, kind);
      },
    },
    /** Whether a mission's call is covered by such a yes — who gave it, for the gate (`allowedBefore`). */
    allowedBefore: (ask: { gatewayId: string; chatId: string; tool: string; params: Record<string, unknown> }) =>
      ask.gatewayId === MISSION_GATEWAY_ID && similar.allows(ask.chatId, ask.tool, ask.params) ? "approve similar from this mission" : null,
    /** The approval prompts of a mission's turn go to the chat it reports to (`ApprovalPromptsDeps.askedIn`). */
    askedIn: (request: { gateway: string; chatId: string }) => {
      if (request.gateway !== MISSION_GATEWAY_ID) return null;
      const mission = store.get(request.chatId);
      return mission ? { gatewayId: mission.gatewayId, chatId: mission.chatId } : null;
    },
  };
}
