/**
 * The rooms the agents talk in — the Groups page (0.7.24): each WhatsApp or Telegram group, Discord channel or thread,
 * dashboard room, with its name and who is there. Spread into `api`, like People.
 */

import { control, post, request } from "./api.client";
import type { GroupRecord, KnownChat } from "@nouride/wire";

export const groupsApi = {
  /** Every chat some agent can send into, most recently active first (0.8.0). */
  chats: () => request<{ chats: KnownChat[] }>(`${control}/chats`),
  groups: () => request<{ groups: GroupRecord[] }>(`${control}/groups`),
  /** Rename a room. An admin's. An empty title clears the rename, and the platform's name is back. */
  renameGroup: (room: { gatewayId: string; chatId: string; title: string }) => post<{ ok: boolean; name?: string }>(`${control}/groups`, room),
  /**
   * Who answers a message that tags nobody in a room on a chat app: a tag is needed, one agent answers, or the room's
   * own setting is gone. An admin's. The setting `/mention` writes from the room.
   */
  setGroupMention: (room: { gatewayId: string; chatId: string } & ({ mention: "required" | "default" } | { mention: "agent"; agent: string })) =>
    post<{ ok: boolean } & Pick<GroupRecord, "mention" | "untagged">>(`${control}/groups/mention`, room),
};
