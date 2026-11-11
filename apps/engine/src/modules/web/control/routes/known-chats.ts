/**
 * The chats a job's results can go to, with what each is (0.8.0): a one-to-one and with whom, or a group and its name.
 * The Schedule and Webhooks forms offered bare chat ids, and nobody could tell `5550001111` from `-1005550002`. Anyone
 * signed in reads it, as they read People and Groups, which say the same names.
 */

import type { KnownChat } from "@nouride/wire";
import type { ControlApp, ControlDeps } from "../types.ts";
import { readerOf, Spoke } from "../whose.ts";

export function registerKnownChatRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/chats", (c) => {
    // The reader's own for anyone but an admin (`whose.ts`): their one-to-ones, by who opened them or by their person,
    // and the groups they spoke in. A job reports to a chat its maker reads.
    const reader = readerOf(c.get("principal"), deps.ctx.config.people);
    const spoke = new Spoke(deps, reader);
    const theirs = (chat: ReturnType<typeof deps.pipeline.reachableChats>[number]) => {
      if (reader.everyone) return true;
      if (chat.kind === "group") return spoke.in(chat.gatewayId, chat.chatId);
      const opener = deps.sessions?.openerOfChat(chat.gatewayId, chat.chatId);
      return (opener !== undefined && reader.ids.includes(opener)) || chat.people.some((person) => person.key !== undefined && person.key === reader.person);
    };
    return c.json({
      chats: deps.pipeline.reachableChats().filter(theirs).map((chat) => ({
        gatewayId: chat.gatewayId,
        chatId: chat.chatId,
        platform: chat.platform,
        kind: chat.kind,
        ...(chat.title ? { title: chat.title } : {}),
        people: chat.people.map((person) => person.name),
        lastActive: chat.lastActive,
      })),
    } satisfies { chats: KnownChat[] });
  });
}
