/**
 * Conversations: what has been said, what is being said now, and how to stop it.
 */

import type { Session } from "@nouride/shared";
import { TurnContext } from "@/modules/pipeline/turn-context.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import type { LocalTurnRequest } from "@/modules/gateways/local.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { jsonBody, parseAttachments } from "../payloads.ts";
import type { ControlApp, ControlDeps } from "../types.ts";

/** A query parameter read as a number, with a default for absent and for nonsense. */
function clampNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.floor(value), max));
}

/**
 * Why nobody answered a local message, as far as the daemon can tell. An agent addressed by name and paused is the
 * common case — `/stop` survives a restart since 0.7.11 — and "check routing" sent the person to the wrong place.
 */
export function silenceNote(deps: Pick<ControlDeps, "registry">, agent: string | undefined): string {
  if (agent && deps.registry.get(agent) && deps.registry.isPaused(agent)) return `${agent} is asleep: /wake wakes it`;
  return "no agent answered: check routing with `nouride agents`";
}

/**
 * Conversations at work that have no row yet, as the list shows a row.
 *
 * A session's row is written when its first turn ends, so for as long as that turn ran the list did not have the
 * conversation — eleven minutes, for Nix on Claude Code on the live box (2026-11-02) — while the Office showed the agent
 * working in it. Each is read from its running turn, held to the list's own filters: the agent, the search (the first
 * thing asked, or the chat id, as the rows are searched), and never a mission's conversation.
 */
function firstTurnsAtWork(deps: ControlDeps, running: Set<string>, filter: { agent?: string; query?: string }): Session[] {
  if (!deps.turns || !deps.sessions) return [];
  const needle = filter.query?.toLowerCase();
  const found: Session[] = [];
  for (const id of running) {
    if (deps.sessions.find(id)) continue;
    const turn = deps.turns.latestForSession(id);
    if (!turn || turn.status !== "running" || turn.gatewayId === MISSION_GATEWAY_ID) continue;
    if (filter.agent && turn.agentId !== filter.agent) continue;
    if (needle && !turn.prompt.toLowerCase().includes(needle) && !turn.chatId.toLowerCase().includes(needle)) continue;
    found.push({
      id,
      agentId: turn.agentId,
      chatId: turn.chatId,
      gatewayId: turn.gatewayId,
      sessionType: "main",
      status: "active",
      contextTokenCount: 0,
      createdAt: turn.startedAt,
      startedAt: turn.startedAt,
      updatedAt: turn.startedAt,
    });
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function registerConversationRoutes(control: ControlApp, deps: ControlDeps): void {
  /**
   * Stop the turn running in a conversation.
   *
   * The escape hatch for a turn that has gone wrong — twenty iterations into the wrong idea, or
   * spending money on a loop. The abort signal is already threaded through the executor and every
   * tool; this is the button that pulls it. Answers how many turns it stopped rather than `ok`,
   * because "nothing was running" and "one turn cancelled" are different outcomes and a bare success
   * would report them identically.
   */
  control.post("/stop", async (c) => {
    const body = ((await jsonBody(c)) ?? {}) as Record<string, unknown>;
    const chatId = typeof body.chatId === "string" ? body.chatId : "";
    if (!chatId) return c.json({ error: "chatId is required" }, 400);

    const gatewayId = typeof body.gateway === "string" ? body.gateway : (deps.local?.id ?? "");
    /**
     * One agent, or everything in the chat.
     *
     * A room can have several turns running at once, and "stop" then has two meanings a person could
     * want. The one they usually want is the narrow one: the card in front of them, which is a
     * particular agent working — so the request says which, and the whole-chat form is what the
     * composer's own button sends when there is nothing more specific to name.
     */
    const agentId = typeof body.agent === "string" ? body.agent : "";
    const stopped = agentId
      ? deps.pipeline.cancelTurn(TurnContext.turnKey(agentId, chatId, gatewayId))
        ? 1
        : 0
      : deps.pipeline.cancelTurnsInChat(gatewayId, chatId);

    deps.audit.record({
      action: "turn_cancelled",
      actor: c.get("principal").actor,
      chatId,
      ...(agentId ? { agentId } : {}),
      details: { stopped, ...(agentId ? { agent: agentId } : {}) },
    });
    return c.json({ stopped });
  });

  /**
   * The conversation list.
   *
   * Two facts are joined on here that the sessions table does not hold, and both are things a person
   * scanning a list needs: whether a conversation is *working* — the row that should be showing a
   * spinner, and which used to be indistinguishable from an idle one — and what it was about, since
   * `web-1757000` names nothing. Both come from one query each, not one per row.
   */
  control.get("/sessions", (c) => {
    const agent = c.req.query("agent");
    const query = c.req.query("q")?.trim();
    /**
     * A page, not the whole history.
     *
     * It used to be a flat hundred with no way to ask for the next one, so a dashboard with more than
     * that displayed a list that simply stopped — and the badge said `100` whether there were a
     * hundred conversations or nine hundred. `total` is the real number; `before` walks back through
     * the rest.
     */
    const limit = clampNumber(c.req.query("limit"), 50, 1, 200);
    const before = clampNumber(c.req.query("before"), 0, 0, Number.MAX_SAFE_INTEGER);

    // A mission's own conversation is not one of a person's chats (0.8.0): it is on its mission's page, and listed here
    // it could be deleted from the chat list by mistake, taking a running mission with it.
    const options = {
      notGateway: MISSION_GATEWAY_ID,
      ...(agent ? { agentId: agent } : {}),
      ...(query ? { query } : {}),
      ...(before > 0 ? { before } : {}),
    };
    const sessions = deps.sessions?.list({ ...options, limit }) ?? [];
    const running = deps.turns?.runningSessions() ?? new Set<string>();
    const titles = deps.turns?.titles() ?? new Map<string, string>();
    // Newest of all, so only on the first page; a later page is read from rows alone.
    const firsts = before > 0 ? [] : firstTurnsAtWork(deps, running, { ...(agent ? { agent } : {}), ...(query ? { query } : {}) });

    return c.json({
      sessions: [
        ...firsts.map((session) => ({ ...session, running: true, title: (titles.get(session.id) ?? "").slice(0, 120) })),
        ...sessions.map((session) => ({
          ...session,
          running: running.has(session.id),
          ...(titles.has(session.id)
            ? { title: titles.get(session.id)!.slice(0, 120) }
            : {}),
        })),
      ],
      total: (deps.sessions?.count(options) ?? 0) + firsts.length,
      /**
       * The cursor for the next page, or nothing when this was the last one.
       *
       * Sent by the daemon rather than derived in the browser: the client would have to know that the
       * cursor is `updated_at` of the final row, which is exactly the sort of detail that goes wrong
       * quietly the day the ordering changes.
       */
      ...(sessions.length === limit
        ? { nextBefore: sessions[sessions.length - 1]!.updatedAt }
        : {}),
    });
  });

  /**
   * The command line's, and only its: `nouride chat` and `nouride acp` send with the control token and say who speaks. A
   * dashboard account sends with `/chat/send`, which takes the sender from its login. Here the sender is the body's, so an
   * account below admin wrote `/approve` as the admin's account and answered what only an admin may (0.8.9). It is
   * refused to every account, not only to that one sender.
   */
  control.post("/message", async (c) => {
    if (c.get("principal").kind !== "token") {
      return c.json({ error: "POST /message is the command line's. A dashboard account sends with /chat/send" }, 403);
    }
    if (!deps.local) {
      return c.json({ error: "the local gateway is not enabled: set [control] chat = true" }, 409);
    }

    const json = await jsonBody(c);
    if (!json) return c.json({ error: "body must be a JSON object" }, 400);
    const body = json as LocalTurnRequest;
    // The daemon's own sender is its events', which pass a pack's allowlist and every rate limit: not the token's to borrow.
    if (body.senderId === SYSTEM_SENDER) return c.json({ error: `${SYSTEM_SENDER} is the daemon's own sender. Name another` }, 400);
    // Text or attachments: the same rule the platform adapters use. A `nouride chat` that can only
    // send text could not exercise the attachment path at all, which is how that path stayed broken.
    const attachments = parseAttachments(body.attachments);
    if ((typeof body.text !== "string" || !body.text.trim()) && attachments.length === 0) {
      return c.json({ error: "`text` or `attachments` is required" }, 400);
    }

    const result = await deps.local.ask(
      { ...body, ...(attachments.length > 0 ? { attachments } : {}) },
      () => deps.pipeline.idle(),
    );
    return c.json({
      replies: result.replies,
      answered: result.answered,
      // An empty reply array is a decision — nobody matched, or the agent is paused — and a
      // caller cannot tell that apart from a failure without being told.
      ...(result.answered ? {} : { note: silenceNote(deps, body.agent) }),
    });
  });
}
