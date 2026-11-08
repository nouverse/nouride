/**
 * The chats the daemon knows, as the dashboard asks for them — the part of the pipeline the Groups page, the Schedule
 * and Webhooks forms, the knowledge base and a link in a chat reach: what kind of chat one is, the rooms and their
 * names, the chats a job's results can go to, and a line said in one for an agent outside any turn.
 */

import type { ChatType } from "@nouride/shared";
import type { PipelineDeps } from "./deps.ts";
import type { ChatTypes } from "./chat-types.ts";
import type { TurnContext } from "./turn-context.ts";
import { knownRooms, renameRoom, type KnownRoom, type RoomSources } from "./known-rooms.ts";
import { reachableChats, sayInChat } from "./send-message.ts";

export class ChatDirectory {
  constructor(
    private readonly o: {
      deps: RoomSources & Pick<PipelineDeps, "registry">;
      chatTypes: Pick<ChatTypes, "of">;
      /** What a line said outside a turn is kept through, as a turn's own words are. */
      turnContext: TurnContext;
    },
  ) {}

  /** A chat's type as its messages said it, or undefined before one did — whether a mission's link goes there (0.8.11). */
  chatTypeOf(gatewayId: string, chatId: string): string | undefined {
    return this.o.chatTypes.of(gatewayId, chatId);
  }

  /** The chats a job's results can go to, and what each is — `GET /chats` (0.8.0). */
  reachableChats(): ReturnType<typeof reachableChats> {
    return reachableChats(this.o.deps, this.o.chatTypes);
  }

  /** The rooms the daemon knows, for the Groups page, and a rename there (0.7.24) — `known-rooms.ts`. */
  knownRooms(): KnownRoom[] {
    const { deps } = this.o;
    const rooms = knownRooms(deps, this.o.chatTypes);
    // A room nobody has written in since 0.7.24 has no name yet: listing it asks its platform, in the background, so the
    // page has the names the next time it is opened (`refresh` is throttled and never throws).
    for (const room of rooms) {
      const gateway = room.name ? undefined : deps.gateways.get(room.gatewayId);
      if (gateway) void deps.roomNames?.refresh(gateway, room.chatId);
    }
    return rooms;
  }

  renameRoom(gatewayId: string, chatId: string, title: string): ReturnType<typeof renameRoom> {
    return renameRoom(this.o.deps, gatewayId, chatId, title);
  }

  /** A line said in a chat for an agent outside any turn, and kept in its conversation there (`send-message.ts`, 0.8.23). */
  sayInChat(chat: { agentId: string; gatewayId: string; chatId: string; chatType: ChatType }, text: string, note: string): Promise<boolean> {
    return sayInChat(this.o.turnContext, chat, text, note);
  }
}
