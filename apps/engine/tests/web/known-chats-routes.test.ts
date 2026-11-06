/**
 * `GET /chats` — where a job's results can go, with what each chat is (0.8.0): the Schedule and Webhooks forms offered
 * bare ids, and nobody could tell `5550001111` from `-1005550002`. Anyone signed in reads it.
 */

import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerKnownChatRoutes } from "@/modules/web/control/routes/known-chats.ts";

test("each chat says whether it is a one-to-one or a group, its name, and who is there — for anyone signed in", async () => {
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "viewer", role: "viewer", user: { username: "viewer" } });
    await next();
  });
  registerKnownChatRoutes(control as never, {
    pipeline: {
      reachableChats: () => [
        { gatewayId: "telegram:nouva", chatId: "5550001111", platform: "telegram", kind: "dm", people: [{ key: "gading", name: "Gading" }], lastActive: 2 },
        { gatewayId: "telegram:nouva", chatId: "-1005550002", platform: "telegram", kind: "group", title: "Nouride", people: [{ name: "Gading" }, { name: "Mira" }], lastActive: 1 },
      ],
    },
  } as never);
  const response = await control.request("/chats");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    chats: [
      { gatewayId: "telegram:nouva", chatId: "5550001111", platform: "telegram", kind: "dm", people: ["Gading"], lastActive: 2 },
      { gatewayId: "telegram:nouva", chatId: "-1005550002", platform: "telegram", kind: "group", title: "Nouride", people: ["Gading", "Mira"], lastActive: 1 },
    ],
  });
});
