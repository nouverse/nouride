/**
 * `GET /chats` — where a job's results can go, with what each chat is (0.8.0): the Schedule and Webhooks forms offered
 * bare ids, and nobody could tell `5550001111` from `-1005550002`. An admin reads every chat; anyone else their own
 * one-to-ones and the groups they spoke in (`whose.ts`).
 */

import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerKnownChatRoutes } from "@/modules/web/control/routes/known-chats.ts";

function mount(role: "admin" | "viewer", spoke: string[] = []) {
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: role, role, user: { id: "u1", username: role } });
    await next();
  });
  registerKnownChatRoutes(control as never, {
    pipeline: {
      reachableChats: () => [
        { gatewayId: "telegram:nouva", chatId: "5550001111", platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 2 },
        { gatewayId: "telegram:nouva", chatId: "-1005550002", platform: "telegram", kind: "group", title: "Nouride", people: [{ name: "Gading" }, { name: "Mira" }], lastActive: 1 },
      ],
    },
    ctx: { config: { people: [{ key: "mira", name: "Mira", ids: ["web:u1", "telegram:77"] }] } },
    sessions: { openerOfChat: () => undefined },
    roomMessages: { spokeIn: (ids: string[]) => new Set(ids.includes("telegram:77") ? spoke.map((chat) => `telegram\u0000${chat}`) : []) },
  } as never);
  return control;
}

test("each chat says whether it is a one-to-one or a group, its name, and who is there — every chat, for an admin", async () => {
  const response = await mount("admin").request("/chats");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    chats: [
      { gatewayId: "telegram:nouva", chatId: "5550001111", platform: "telegram", kind: "dm", people: ["Gading"], lastActive: 2 },
      { gatewayId: "telegram:nouva", chatId: "-1005550002", platform: "telegram", kind: "group", title: "Nouride", people: ["Gading", "Mira"], lastActive: 1 },
    ],
  });
});

test("anyone else reads their own: Gading's one-to-one is not Mira's, and a group is hers once she spoke there", async () => {
  const ids = async (spoke: string[]) => ((await (await mount("viewer", spoke).request("/chats")).json()) as { chats: { chatId: string }[] }).chats.map((chat) => chat.chatId);
  expect(await ids([])).toEqual([]);
  expect(await ids(["-1005550002"])).toEqual(["-1005550002"]);
});
