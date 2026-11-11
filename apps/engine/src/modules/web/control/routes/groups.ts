/**
 * The rooms the agents talk in — the Groups page (0.7.24), beside People.
 *
 * A flat list: a WhatsApp group, a Telegram group, a Discord channel or thread, a dashboard room — each with its name,
 * the agents with a conversation there and who spoke there lately (`pipeline/known-rooms.ts`). A rename is an admin's,
 * as an edit on People is: it is what `send_message` takes a group's name as.
 */

import type { GroupRecord } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";

export function registerGroupRoutes(control: ControlApp, deps: ControlDeps): void {
  control.get("/groups", (c) => c.json({ groups: deps.pipeline.knownRooms() } satisfies { groups: GroupRecord[] }));

  /** Rename one: `{ gatewayId, chatId, title }`. An empty title clears the rename, and the platform's name is back. */
  control.post("/groups", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const gatewayId = typeof body.gatewayId === "string" ? body.gatewayId.trim() : "";
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    if (!gatewayId || !chatId) return c.json({ error: "gatewayId and chatId are required" }, 400);
    if (typeof body.title !== "string") return c.json({ error: "title is required (empty clears the name)" }, 400);
    const renamed = deps.pipeline.renameRoom(gatewayId, chatId, body.title);
    if (!renamed.ok) {
      const plain =
        renamed.why === "long"
          ? "That name is too long. Try a shorter one."
          : renamed.why === "connection"
            ? "That room's chat connection is not there any more. Reload the page."
            : "Room names cannot be changed on this server.";
      return c.json({ error: renamed.reason, plain }, 400);
    }
    deps.audit.record({ action: "room_renamed", actor: c.get("principal").actor, details: { gatewayId, chatId, title: body.title.trim() || null } });
    return c.json({ ok: true, ...(renamed.name ? { name: renamed.name } : {}) } satisfies { ok: boolean; name?: string });
  });
}
