/**
 * How a conversation ends — the one place that decides what ending one clears.
 *
 * Four ways, and each was its own hand-kept list until 0.7.9: `/new` and `/reset` in their hooks, the rollover in
 * `session-lifecycle.ts`, and the dashboard's deletes in two routes. They disagreed, and every new store had to be
 * added to up to five of them. The deletes were the ones that fell behind: a conversation deleted from the dashboard
 * kept its `/model` override — the next conversation in that chat ran on it until a restart — and its spilled tool
 * output, which the next conversation could still read, because a session id is derived from the chat; and an
 * approval it was still waiting on stayed answerable, so a late "yes" woke the agent in a new conversation about a
 * command it had no context for.
 *
 * So the effects of each are one table, `ENDS`, read in one place; what the database keeps for a deleted conversation
 * is `ON_CONVERSATION_DELETE` in `db/keys.ts`, which the tests hold this to.
 */

import type { NotesPort } from "@/modules/notes/store.ts";
import { createLogger, sessionIdFor, type SessionKey } from "@nouride/shared";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import type { ModelOverrides } from "@/modules/hooks/registry.ts";
import type { ToolOutputSpill } from "@/modules/llm/spill.ts";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import type { ApprovalGate } from "@/modules/tools/approval.ts";
import type { TurnsPort } from "@/modules/turns/turns.store.ts";

const log = createLogger("pipeline.conversation-end");

/**
 * - `new` — `/new`: the conversation so far is filed into memory, and the next message starts a fresh one.
 * - `reset` — `/reset`: `new`, and the session-level state with it — a `/model` override, this agent's pending
 *   approvals (§9.4 SPEC). Un-pausing and reloading the agent are the hook's, being about the agent.
 * - `rollover` — `[rollover]`: a conversation gone stale, cleared before the next message joins it. Not filed here:
 *   memory is cut from the turn log, which the clear does not touch, so tonight's pass files it.
 * - `delete` — the dashboard: the conversation stops existing, its record with it.
 */
export type EndMode = "new" | "reset" | "rollover" | "delete";

/** What ending a conversation can do. */
export type EndEffect =
  /** File what was said into memory's episodes (`modules/memory`) — before the clear, so the reply can say so. */
  | "cutMemory"
  /** Stop this agent's turn in the chat: one finishing into a conversation that is gone is money spent on nothing. */
  | "stopTurns"
  /** Empty the context and restart its clock; the row stays, and the agent stays in the chat. */
  | "clearContext"
  /** Delete its turns, their rows in the event stream, and the session row itself. */
  | "deleteRecord"
  /**
   * The agent-to-agent hop count in this chat. Who wrote which message is kept: a reply to an answer from before the
   * reset is addressed to its author, and brings the quoted words with it — the history it needs.
   */
  | "resetHops"
  /**
   * The chat's notices — "several agents are here", "a message was dropped". Chat-scoped, not agent-scoped: kept,
   * they leave a fresh conversation whose only content is complaints about the one before it.
   */
  | "clearChatEvents"
  /** Spilled tool output: the next conversation in this chat has the same session id, and could still read it. */
  | "forgetSpill"
  /**
   * The work notes (0.7.26): `/reset` starts from nothing, and a deleted conversation leaves none behind. Not `/new` and
   * not the rollover — work outlives a day's conversation, which is what the notes are for.
   */
  | "clearNotes"
  /**
   * A `/model` and an `/effort`, kept on the conversation's row by its id (076): the same id the next conversation will
   * have, and the row `clearContext` keeps, so a choice not dropped here outlives the conversation and a restart too.
   */
  | "dropModelOverride"
  /** This agent's approvals pending in this chat: answered later, they would wake it in a conversation with no context. */
  | "expireApprovals"
  /**
   * An external agent's CLI session for this chat (0.8.1): kept, the CLI went on with everything said before `/new` —
   * Nouride's context empty, the CLI's not — and with the skills its session opened with, the Skills tab's changes
   * since never reaching it.
   */
  | "forgetCliSession"
  /** All this agent's pending approvals, wherever they were asked — `/reset`'s, per §9.4 SPEC. */
  | "expireAgentApprovals";

/**
 * Each way of ending, in the order it runs. Auto-approval is in none of them, on purpose: "stop asking me" is a standing
 * decision about a person, and re-asking for it after every reset is the friction it exists to remove.
 */
const ENDS: Readonly<Record<EndMode, readonly EndEffect[]>> = {
  new: ["cutMemory", "clearContext", "resetHops", "clearChatEvents", "forgetSpill", "forgetCliSession"],
  reset: ["cutMemory", "clearContext", "resetHops", "clearChatEvents", "forgetSpill", "clearNotes", "dropModelOverride", "expireAgentApprovals", "forgetCliSession"],
  rollover: ["clearContext", "resetHops", "forgetSpill", "dropModelOverride", "forgetCliSession"],
  delete: ["stopTurns", "deleteRecord", "resetHops", "clearChatEvents", "forgetSpill", "clearNotes", "dropModelOverride", "expireApprovals", "forgetCliSession"],
};

/** What ending one reaches — the stores, and the pipeline's own in-memory state. */
export interface ConversationEndDeps {
  sessions: Pick<SessionsPort, "clear" | "delete">;
  turns?: Pick<TurnsPort, "deleteForSession">;
  chatEvents?: Pick<ChatEventsPort, "deleteForChat">;
  spill?: Pick<ToolOutputSpill, "forget">;
  notes?: Pick<NotesPort, "clear">;
  approvals: Pick<ApprovalGate, "expireAll">;
  memory?: { cut(gatewayId: string, chatId: string): Promise<number> };
  /**
   * Who wrote which message, and the agent-to-agent hop count beside it. Ending a conversation resets the count — a
   * person ended it, and a person speaking is what refills the budget — and keeps who wrote what: Nouva wrote the message
   * before the `/reset` as much as after it, and a reply to it is addressed to her. Forgetting that was how a reply to
   * her answer in a WhatsApp group went unanswered, a minute after a `/reset` (2026-10-21).
   */
  authorship: { setHops(platform: string, chatId: string, hops: number): void };
  modelOverrides: Pick<ModelOverrides, "clear" | "clearEffort">;
  /** Stop this agent's turns in this chat, whichever connection started them; how many were. */
  stopTurns(agentId: string, chatId: string): number;
  /** The platform a gateway speaks for — what the authorship record is keyed by. */
  platformOf(gatewayId: string): string;
  /** Let an external agent's CLI session for this chat go. Absent: no agent is answered by a CLI. */
  forgetCliSession?(agentId: string, gatewayId: string, chatId: string): void;
}

/** Which conversation, and — when the caller holds its row — the id it was stored under. */
export type EndingConversation = SessionKey & { sessionId?: string };

/** What ending it did, for the reply or the audit row. */
export interface Ended {
  /** The episodes it was filed as — absent where memory is not wired, or could not be written (tonight's pass will). */
  cut?: { episodes: number };
  /** Turns stopped. */
  stopped: number;
  /** Turn records deleted. */
  turns: number;
  /** The chat's notices deleted. */
  notices: number;
  /** Approvals expired. */
  expired: number;
  /** Work-notes tasks cleared. */
  tasks: number;
}

/** End one conversation the way `mode` does. Never throws for memory: a reset must not fail because a cut could not be written. */
export async function endConversation(deps: ConversationEndDeps, conversation: EndingConversation, mode: EndMode): Promise<Ended> {
  const { agentId, gatewayId, chatId } = conversation;
  const key: SessionKey = { agentId, gatewayId, chatId };
  const sessionId = conversation.sessionId ?? sessionIdFor(key);
  const ended: Ended = { stopped: 0, turns: 0, notices: 0, expired: 0, tasks: 0 };

  for (const effect of ENDS[mode]) {
    switch (effect) {
      case "cutMemory": {
        if (!deps.memory) break;
        try {
          ended.cut = { episodes: await deps.memory.cut(gatewayId, chatId) };
        } catch (err) {
          log.warn("could not cut the conversation into memory: tonight's pass will", { chat_id: chatId, error: String(err) });
        }
        break;
      }
      case "stopTurns":
        ended.stopped = deps.stopTurns(agentId, chatId);
        break;
      case "clearContext":
        deps.sessions.clear(key);
        break;
      case "deleteRecord":
        ended.turns = deps.turns?.deleteForSession(sessionId) ?? 0;
        deps.sessions.delete(sessionId);
        break;
      case "resetHops":
        deps.authorship.setHops(deps.platformOf(gatewayId), chatId, 0);
        break;
      case "clearChatEvents":
        ended.notices = deps.chatEvents?.deleteForChat(gatewayId, chatId) ?? 0;
        break;
      case "forgetSpill":
        deps.spill?.forget({ agentId, sessionId });
        break;
      case "clearNotes":
        try {
          // A deleted conversation keeps no copy of them either.
          ended.tasks = (await deps.notes?.clear({ agentId, gatewayId, chatId }, { keep: mode !== "delete" })) ?? 0;
        } catch (err) {
          log.warn("could not clear the work notes", { chat_id: chatId, error: String(err) });
        }
        break;
      case "dropModelOverride":
        deps.modelOverrides.clear(sessionId);
        deps.modelOverrides.clearEffort(sessionId);
        break;
      case "expireApprovals":
        ended.expired = deps.approvals.expireAll(agentId, { gatewayId, chatId });
        break;
      case "expireAgentApprovals":
        ended.expired = deps.approvals.expireAll(agentId);
        break;
      case "forgetCliSession":
        deps.forgetCliSession?.(agentId, gatewayId, chatId);
        break;
    }
  }
  return ended;
}
