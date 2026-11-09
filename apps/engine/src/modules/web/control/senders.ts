/**
 * Who said what, in a conversation that lives on a chat app: the people there are people, not the one reading. A turn
 * there carries its asker's name, and a group's transcript carries what people said in it whether or not an agent
 * answered — the lines its agents are given as context, kept in the room log as they arrive.
 *
 * A name is the one the rest of the dashboard shows: the person's under People, else the name their app gives them —
 * as a group's log last kept it, or, for someone met only in a private chat, as their access request did.
 * Nothing here for the dashboard's own conversations, where whoever asked is the person reading.
 */

import type { RoomMessage } from "@nouride/wire";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { personFor } from "@/modules/pipeline/known-rooms.ts";
import type { ControlDeps } from "./types.ts";

type Where = { gatewayId: string; chatId: string };

const onAnApp = (deps: Pick<ControlDeps, "local">, gatewayId: string) => Boolean(deps.local) && gatewayId !== deps.local!.id;

type Sources = Pick<ControlDeps, "ctx" | "roomMessages" | "local" | "access">;

function nameOf(deps: Sources, gatewayId: string, senderId: string): string | undefined {
  return (
    personFor(deps.ctx.config.people, gatewayId, senderId)?.name ??
    deps.roomMessages?.lastNameOf(gatewayId, senderId) ??
    deps.access?.get(gatewayId, senderId)?.senderName ??
    undefined
  );
}

/** A turn's asker, by name, where the turn is on a chat app and a person asked it. */
export function askedBy(deps: Sources, turn: Where & { senderId?: string }): { senderName?: string } {
  if (!turn.senderId || turn.senderId === SYSTEM_SENDER || !onAnApp(deps, turn.gatewayId)) return {};
  const name = nameOf(deps, turn.gatewayId, turn.senderId);
  return name ? { senderName: name } : {};
}

/** What people said in a group on a chat app, oldest first, each under the name the dashboard knows them by. */
export function groupLog(deps: Sources, chat: Where | null | undefined): RoomMessage[] {
  if (!chat || !deps.roomMessages || !onAnApp(deps, chat.gatewayId) || !deps.roomMessages.isRoom(chat.gatewayId, chat.chatId)) return [];
  return deps.roomMessages.forChat(chat.gatewayId, chat.chatId).map((message) => {
    const name = personFor(deps.ctx.config.people, message.gatewayId, message.senderId)?.name ?? message.senderName;
    return { ...message, ...(name ? { senderName: name } : {}) };
  });
}
