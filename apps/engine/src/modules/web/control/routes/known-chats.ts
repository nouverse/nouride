/**
 * The chats a job's results can go to, with what each is (0.8.0): a one-to-one and with whom, or a group and its name.
 * The Schedule and Webhooks forms offered bare chat ids, and nobody could tell `5550001111` from `-1005550002`. Anyone
 * signed in reads it, as they read People and Groups, which say the same names.
 */

import type { ControlApp, ControlDeps } from "../types.ts";

export function registerKnownChatRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/chats", (c) =>
    c.json({
      chats: deps.pipeline.reachableChats().map((chat) => ({
        gatewayId: chat.gatewayId,
        chatId: chat.chatId,
        platform: chat.platform,
        kind: chat.kind,
        ...(chat.title ? { title: chat.title } : {}),
        people: chat.people.map((person) => person.name),
        lastActive: chat.lastActive,
      })),
    }),
  );
}
