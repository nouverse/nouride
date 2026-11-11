/**
 * Rooms: a conversation with one person and several agents in it.
 *
 * Its own domain rather than fields on `/message`, because creating a room and speaking in one are
 * different acts with different consequences — one records who may be tagged here, the other spends
 * money. Folding them together is how "send a message" grows a side effect nobody expects.
 *
 * ## Only where the daemon owns the answer
 *
 * Every write here is refused for a gateway that is not the local one, and that is the whole reason
 * these routes are narrow. On Discord a room's members are the bots the operator invited to that
 * channel; `voice.ts` records that we cannot see them, so a membership list written for a platform
 * chat would be a guess — and both readers of that list (`TurnContext.roomAgents`, and through it the
 * prompt and the unaddressed-message guard) would then narrow on something that disagrees with the
 * platform. Recording nothing is the honest answer there, and it is what the fallback in
 * `roomAgents` already handles.
 */

import type { Room } from "@nouride/wire";
import { newId } from "@nouride/shared";
import { atLeast } from "@/modules/users/auth.ts";
import type { ControlApp, ControlDeps } from "../types.ts";
import { jsonBody } from "../payloads.ts";
import { CHAT_OFF } from "../plain.ts";

/** A room's chat id, generated here so the client never invents one. Matches the DM prefix shape. */
const newChatId = () => `web-${Date.now()}-${newId("room").slice(-6)}`;

export function registerRoomRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * Where a room may be created, and it is one place.
   *
   * Returned rather than assumed by the client: the local gateway's id is `web:dashboard` today and the
   * client that hard-coded it would be wrong the day that changes — the same reasoning as `writable`
   * on the transcript payload.
   */
  const localId = () => deps.local?.id ?? null;

  function guard(gatewayId: string): string | null {
    const local = localId();
    if (!local) return "the local gateway is not enabled: set [control] chat = true";
    if (gatewayId !== local) {
      return (
        `rooms can only be created on ${local}. On a chat platform the members are the bots the ` +
        `operator invited to that channel, which this daemon cannot see, so a membership list here ` +
        `would be a guess, and both readers of it would narrow on something the platform disagrees with`
      );
    }
    return null;
  }

  /**
   * Every room, with when it was last used.
   *
   * `updatedAt` is joined on here rather than stored, because it is derivable and a stored copy is a
   * second thing to keep in step with every message. The sidebar sorts rooms among the one-to-one
   * conversations, which are ordered by their own last activity — a room ordered by its *creation*
   * would sink down the list while it was the one being used.
   *
   * Falls back to the creation time for a room nobody has spoken in, which is the only thing that
   * has happened to it.
   */
  control.get("/rooms", (c) => {
    const local = localId();
    if (!deps.rooms || !local) return c.json({ rooms: [] });
    const rooms = deps.rooms.list(local).map((room) => {
      const said = deps.roomMessages?.forChat(local, room.chatId, 1) ?? [];
      const turn = deps.turns?.forChat(local, room.chatId, 1) ?? [];
      return {
        ...room,
        updatedAt: Math.max(
          room.createdAt,
          said.at(-1)?.at ?? 0,
          turn.at(-1)?.endedAt ?? turn.at(-1)?.startedAt ?? 0,
        ),
        /**
         * Whether an agent is working in it right now.
         *
         * Reported here because the history list has no other way to know: a one-to-one conversation
         * carries `running` on its session row, and a room's turns belong to its members' sessions —
         * which that list deliberately hides, so a three-agent room is one entry rather than four.
         * Without this the sidebar showed a spinner for a DM and nothing at all for a room, which
         * reads as the room having finished.
         */
        running: (deps.turns?.runningForChat(local, room.chatId) ?? []).length > 0,
      };
    });
    return c.json({
      gatewayId: local,
      rooms: rooms.sort((a, b) => b.updatedAt - a.updatedAt),
    });
  });

  control.get("/rooms/:chatId", (c) => {
    const local = localId();
    if (!deps.rooms || !local) return c.json({ error: "rooms are not available" }, 501);
    const room = deps.rooms.get(local, c.req.param("chatId"));
    if (!room) return c.json({ error: "no such room" }, 404);
    return c.json({ room } satisfies { room: Room });
  });

  /**
   * Create one.
   *
   * The chat id is minted here and returned, so the client posts its first message into a room that
   * already exists. Creating it lazily on the first send was the alternative and it inverts the
   * dependency: the membership list is what the router reads to decide who may answer, so a message
   * that arrives before the list does is a message routed against the wrong set.
   */
  control.post("/rooms", async (c) => {
    if (!deps.rooms) return c.json({ error: "rooms are not available" }, 501);
    /**
     * A room is a write, so a viewer account may not make one. `operator` rather than `admin`: a
     * room is one person's conversation with some agents, not a daemon-wide policy.
     */
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const local = localId();
    const refusal = guard(local ?? "");
    if (refusal) return c.json({ error: refusal, plain: local ? "Rooms are made in the dashboard's own chat, not in a chat app." : CHAT_OFF }, local ? 400 : 501);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const requested = Array.isArray(body.agentIds) ? body.agentIds.filter(isString) : [];
    if (requested.length === 0) {
      return c.json({ error: "agentIds must name at least one agent" }, 400);
    }

    /**
     * Checked against the registry before anything is written.
     *
     * A room whose member list names an agent that does not exist narrows the prompt and the router
     * onto a name nothing can deliver to — the exact failure the membership list was added to
     * prevent, arrived at through the door that creates it.
     */
    const unknown = requested.filter((id) => !deps.registry.get(id));
    if (unknown.length > 0) {
      const known = deps.registry.enabled().map((agent) => agent.config.id);
      return c.json(
        { error: `unknown agent(s): ${unknown.join(", ")}. Available: ${known.join(", ") || "none"}` },
        400,
      );
    }

    const principal = c.get("principal");
    const actor = principal.user?.username ?? principal.actor;
    const chatId = newChatId();
    const title = isString(body.title) && body.title.trim() ? body.title.trim() : undefined;

    const room = deps.rooms.create({
      gatewayId: local!,
      chatId,
      agentIds: requested,
      ...(title ? { title } : {}),
      createdBy: actor,
    });

    /**
     * The room's first history, written as it is built.
     *
     * `audience: "agents"` so an agent tagged later reads who it is here with — which is the same
     * question the OTHER AGENTS section answers, arriving through the conversation rather than the
     * prompt, and the reason `joined` was in the event enum before anything could emit it.
     */
    deps.chatEvents?.record({
      gatewayId: local!,
      chatId,
      audience: "agents",
      kind: "joined",
      text: `${actor} started this room with ${requested.join(", ")}.`,
      actor,
      details: { members: requested },
    });

    deps.audit.record({
      action: "room_created",
      actor: principal.actor,
      chatId,
      details: { members: requested, ...(title ? { title } : {}) },
    });

    return c.json({ room } satisfies { room: Room }, 201);
  });

  /** Add an agent to a room that already exists. */
  control.post("/rooms/:chatId/members", async (c) => {
    if (!deps.rooms) return c.json({ error: "rooms are not available" }, 501);
    /**
     * A room is a write, so a viewer account may not make one. `operator` rather than `admin`: a
     * room is one person's conversation with some agents, not a daemon-wide policy.
     */
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const local = localId();
    const refusal = guard(local ?? "");
    if (refusal) return c.json({ error: refusal, plain: local ? "Rooms are made in the dashboard's own chat, not in a chat app." : CHAT_OFF }, local ? 400 : 501);

    const chatId = c.req.param("chatId");
    if (!deps.rooms.get(local!, chatId)) return c.json({ error: "no such room" }, 404);

    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    if (!isString(body.agentId)) return c.json({ error: "agentId is required" }, 400);
    if (!deps.registry.get(body.agentId)) {
      return c.json({ error: `there is no agent called "${body.agentId}"` }, 400);
    }

    const principal = c.get("principal");
    const actor = principal.user?.username ?? principal.actor;
    // The boolean is what decides whether anything happened: adding somebody twice is not an event,
    // and a room whose history says "Nero joined" three times is a history nobody trusts.
    const added = deps.rooms.add({ gatewayId: local!, chatId, agentId: body.agentId, addedBy: actor });

    if (added) {
      deps.chatEvents?.record({
        gatewayId: local!,
        chatId,
        audience: "agents",
        kind: "joined",
        text: `${actor} added ${body.agentId} to this room.`,
        agentId: body.agentId,
        actor,
      });
      deps.audit.record({
        action: "room_member_added",
        actor: principal.actor,
        agentId: body.agentId,
        chatId,
      });
    }

    const room = deps.rooms.get(local!, chatId);
    if (!room) return c.json({ error: "no such room" }, 404);
    return c.json({ room, added } satisfies { room: Room; added: boolean });
  });

  /**
   * Remove one. Admin is not required: a room is one person's conversation, and the person who can
   * speak in it is the person who decides who is in it.
   */
  control.delete("/rooms/:chatId/members/:agentId", (c) => {
    if (!deps.rooms) return c.json({ error: "rooms are not available" }, 501);
    /**
     * A room is a write, so a viewer account may not make one. `operator` rather than `admin`: a
     * room is one person's conversation with some agents, not a daemon-wide policy.
     */
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const local = localId();
    const refusal = guard(local ?? "");
    if (refusal) return c.json({ error: refusal, plain: local ? "Rooms are made in the dashboard's own chat, not in a chat app." : CHAT_OFF }, local ? 400 : 501);

    const chatId = c.req.param("chatId");
    const agentId = c.req.param("agentId");
    const principal = c.get("principal");
    const actor = principal.user?.username ?? principal.actor;
    const removed = deps.rooms.remove(local!, chatId, agentId);

    if (removed) {
      /**
       * Its conversation here is deliberately left alone.
       *
       * Removing an agent means it stops receiving messages; deleting what it already said is a
       * destructive answer to a question nobody asked, and the transcript a person is reading is
       * partly that agent's words.
       */
      deps.chatEvents?.record({
        gatewayId: local!,
        chatId,
        audience: "agents",
        kind: "left",
        text: `${actor} removed ${agentId} from this room.`,
        agentId,
        actor,
      });
      deps.audit.record({ action: "room_member_removed", actor: principal.actor, agentId, chatId });
    }

    const room = deps.rooms.get(local!, chatId);
    if (!room) return c.json({ error: "no such room" }, 404);
    return c.json({ room, removed } satisfies { room: Room; removed: boolean });
  });

  /**
   * Delete the whole room: its membership, its name, its events, and every member's conversation.
   *
   * All of it, because a room is the unit a person made and the unit they mean when they say get rid
   * of it. Deleting the room row alone would leave the sessions behind as loose one-to-one
   * conversations in the history with a chat id nothing explains, and leaving the events behind would
   * leave a transcript of notices about messages nobody can read.
   *
   * Running turns are cancelled first, every one in the room — a member removed while it worked included. Deleting the
   * session a turn is writing into leaves the turn finishing into a conversation that no longer exists, which is the
   * same reason `DELETE /sessions/:id` cancels before it deletes. Each member's conversation then ends the way any
   * deleted one does (`pipeline/conversation-end.ts`); what is the room's — its messages, files, name — goes after.
   */
  control.delete("/rooms/:chatId", async (c) => {
    if (!deps.rooms || !deps.sessions) return c.json({ error: "rooms are not available" }, 501);
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const local = localId();
    const refusal = guard(local ?? "");
    if (refusal) return c.json({ error: refusal, plain: local ? "Rooms are made in the dashboard's own chat, not in a chat app." : CHAT_OFF }, local ? 400 : 501);

    const chatId = c.req.param("chatId");
    const room = deps.rooms.get(local!, chatId);
    if (!room) return c.json({ error: "no such room" }, 404);

    let stopped = deps.pipeline.cancelTurnsInChat(local!, chatId);
    let turns = 0;
    let events = 0;
    for (const member of room.members) {
      const ended = await deps.pipeline.endConversation({ agentId: member.agentId, gatewayId: local!, chatId }, "delete");
      stopped += ended.stopped;
      turns += ended.turns;
      events += ended.notices;
    }
    events += deps.chatEvents?.deleteForChat(local!, chatId) ?? 0;
    const messages = deps.roomMessages?.deleteForChat(local!, chatId) ?? 0;
    /**
     * The file list too, or a deleted room leaves refs behind that resolve to files on disk.
     *
     * A room, so keyed on the *platform* rather than the connection, which is what the index keys a room
     * on — one room is one conversation however many of this daemon's bots are connected to it.
     */
    const files =
      deps.attachmentIndex?.deleteForChat({ gateway: local!.split(":")[0] ?? local!, gatewayId: local!, chatId, chatType: "group" }) ?? 0;
    deps.rooms.delete(local!, chatId);

    deps.audit.record({
      action: "room_deleted",
      actor: c.get("principal").actor,
      chatId,
      details: { members: room.members.map((member) => member.agentId), turns, events, messages, files, stopped },
    });

    return c.json({ ok: true, turns, events, messages, files, stopped } satisfies { ok: true; turns: number; events: number; messages: number; files: number; stopped: number });
  });

  /** Rename it. An empty title clears the name and the client falls back to the member list. */
  control.put("/rooms/:chatId/title", async (c) => {
    if (!deps.rooms) return c.json({ error: "rooms are not available" }, 501);
    /**
     * A room is a write, so a viewer account may not make one. `operator` rather than `admin`: a
     * room is one person's conversation with some agents, not a daemon-wide policy.
     */
    if (!atLeast(c.get("principal"), "operator")) return c.json({ error: "operator only" }, 403);
    const local = localId();
    const refusal = guard(local ?? "");
    if (refusal) return c.json({ error: refusal, plain: local ? "Rooms are made in the dashboard's own chat, not in a chat app." : CHAT_OFF }, local ? 400 : 501);

    const chatId = c.req.param("chatId");
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const title = isString(body.title) && body.title.trim() ? body.title.trim() : null;
    if (title && title.length > 200) return c.json({ error: "title is too long" }, 400);

    if (!deps.rooms.rename(local!, chatId, title)) {
      return c.json({ error: "no such room" }, 404);
    }

    const principal = c.get("principal");
    const actor = principal.user?.username ?? principal.actor;
    deps.chatEvents?.record({
      gatewayId: local!,
      chatId,
      audience: "agents",
      kind: "topic",
      text: title ? `${actor} named this room "${title}".` : `${actor} cleared this room's name.`,
      actor,
      // As data too, so the dashboard says it in its own words rather than reading them out of the sentence.
      details: { title },
    });

    const room = deps.rooms.get(local!, chatId);
    if (!room) return c.json({ error: "no such room" }, 404);
    return c.json({ room } satisfies { room: Room });
  });

}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
