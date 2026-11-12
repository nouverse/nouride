/**
 * The rooms the agents talk in — the Groups page (0.7.24), beside People.
 *
 * A flat list: a WhatsApp group, a Telegram group, a Discord channel or thread, a dashboard room — each with its name,
 * the agents with a conversation there and who spoke there lately (`pipeline/known-rooms.ts`). A rename is an admin's,
 * as an edit on People is: it is what `send_message` takes a group's name as.
 *
 * And who answers a message there that tags nobody: the room's own setting, the one `/mention` writes from the room
 * (`pipeline/room-mention.store.ts`), read and set here, so what either says the other shows. An admin's, as in the
 * chat. A room made in the dashboard has none to set: its members decide (`pipeline/room-mention.ts`).
 */

import type { GatewayName } from "@nouride/shared";
import type { GroupRecord } from "@nouride/wire";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { mayOpen, readerOf, Spoke } from "../whose.ts";

/** A room's own setting where it has one, and who answers a message there that tags nobody now, by the router. */
function answerOf(deps: ControlDeps, group: Pick<GroupRecord, "platform" | "gatewayId" | "chatId">): Pick<GroupRecord, "mention" | "untagged"> {
  const own = deps.pipeline.roomMention(group.platform, group.chatId);
  const untagged = deps.pipeline.untaggedAnswerer({ gateway: group.platform as GatewayName, gatewayId: group.gatewayId, chatId: group.chatId });
  return {
    ...(own ? { mention: { requireTag: own.requireMention, ...(own.answerer ? { answerer: own.answerer } : {}) } } : {}),
    ...(untagged ? { untagged } : {}),
  };
}

export function registerGroupRoutes(control: ControlApp, deps: ControlDeps): void {
  /** Every group for an admin; for anyone else the ones their person spoke in, and the rooms they may open (`whose.ts`). */
  control.get("/groups", (c) => {
    const reader = readerOf(c.get("principal"), deps.ctx.config.people);
    const spoke = new Spoke(deps, reader);
    const groups = deps.pipeline
      .knownRooms()
      .filter((group) => reader.everyone || (group.dashboard ? mayOpen(deps, reader, group, spoke) : spoke.in(group.gatewayId, group.chatId)))
      .map((group) => ({ ...group, ...answerOf(deps, group) }));
    return c.json({ groups } satisfies { groups: GroupRecord[] });
  });

  /**
   * Who answers a message that tags nobody in one room: `{ gatewayId, chatId, mention }`, `mention` one of `required`
   * (a tag is needed), `default` (the room's own setting gone) or `agent` with the `agent` that answers.
   */
  control.post("/groups/mention", async (c) => {
    if (!atLeast(c.get("principal"), "admin")) return c.json({ error: "admin only" }, 403);
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const gatewayId = typeof body.gatewayId === "string" ? body.gatewayId.trim() : "";
    const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";
    if (!gatewayId || !chatId) return c.json({ error: "gatewayId and chatId are required" }, 400);
    const group = deps.pipeline.knownRooms().find((one) => one.gatewayId === gatewayId && one.chatId === chatId);
    if (!group) return c.json({ error: "no such room", plain: "That room is not there any more. Reload the page." }, 404);
    if (group.dashboard) {
      return c.json({ error: "a dashboard room keeps its members' rule", plain: "A room made in the dashboard is answered by its members: the orchestrator when it is one of them." }, 400);
    }
    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    if (body.mention !== "required" && body.mention !== "default" && body.mention !== "agent") {
      return c.json({ error: "mention is one of `required`, `default`, `agent`" }, 400);
    }
    if (body.mention === "agent" && !deps.registry.enabled().some((one) => one.config.id === agent)) {
      return c.json({ error: `no agent \`${agent}\``, plain: "That agent is not there any more. Reload the page." }, 400);
    }
    const choice = body.mention === "default" ? null : body.mention === "required" ? ({ requireMention: true } as const) : ({ requireMention: false, answerer: agent } as const);
    if (!deps.pipeline.setRoomMention(group.platform, chatId, choice, c.get("principal").actor)) {
      return c.json({ error: "no room settings on this daemon", plain: "This cannot be changed on this server." }, 400);
    }
    deps.audit.record({ action: "room_mention_set", actor: c.get("principal").actor, details: { gatewayId, chatId, mention: body.mention, ...(body.mention === "agent" ? { agent } : {}) } });
    return c.json({ ok: true, ...answerOf(deps, group) } satisfies { ok: boolean } & Pick<GroupRecord, "mention" | "untagged">);
  });

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
