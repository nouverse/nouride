/**
 * The queue a chat's messages wait in — the part of the pipeline what arrives from the gateways goes through: what a
 * message is keyed and deduplicated by, which ones go ahead of the line, how many turns run at once, what is done with
 * a message when its turn comes, and what a dropped one leaves behind.
 */

import { KeyedQueue } from "@nouride/queue";
import { createLogger, type MessageEnvelope } from "@nouride/shared";
import { parseCommand, type HookRegistry } from "@/modules/hooks/registry.ts";
import type { PipelineDeps } from "./deps.ts";
import type { Admission } from "./admission.ts";
import type { Voice } from "./voice.ts";
import type { TurnContext } from "./turn-context.ts";
import type { InboxDesk } from "./inbox-desk.ts";
import type { InboundRouter } from "./inbound.ts";
import { jobOfCompletionWake } from "./job-wakes.ts";
import { answerGroupCommand } from "./room-mention.ts";
import { conversationSlots } from "./fair-share.ts";

const log = createLogger("pipeline");

export function chatQueue(parts: {
  deps: Pick<PipelineDeps, "config" | "rooms" | "registry" | "gateways" | "jobWakes" | "chatEvents">;
  hooks: HookRegistry;
  turnContext: Pick<TurnContext, "returned">;
  inbound: Pick<InboundRouter, "handle">;
  admission: Pick<Admission, "noticeDropped">;
  voice: Pick<Voice, "reply">;
  /** The inbox, built after the queue it puts messages back into — read when a message is taken or dropped. */
  inbox: () => Pick<InboxDesk, "track" | "dropped">;
}): KeyedQueue<MessageEnvelope> {
  const { deps, hooks, turnContext, inbound, admission, voice } = parts;
  const groupCommand = {
    hooks,
    registry: deps.registry,
    config: deps.config,
    reply: (to: MessageEnvelope, text: string, fromAgent: string) => voice.reply(to, text, fromAgent),
    connected: (gatewayId: string) => deps.gateways.get(gatewayId)?.status === "connected",
  };
  return new KeyedQueue<MessageEnvelope>({
    // Sequential per (agent-bearing chat), parallel across chats. The key deliberately
    // excludes the agent: two agents in one chat still take turns, because they are
    // talking to the same person.
    key: (envelope) => `${envelope.gatewayId}:${envelope.chatId}`,
    // Not a message a turn handed back unread: in a room it came through here a moment ago (`TurnContext.returned`).
    dedupId: (envelope) => (turnContext.returned.has(envelope) ? null : `${envelope.gatewayId}:${envelope.chatId}:${envelope.id}`),
    // Slash commands answer immediately, outside the ordering.
    //
    // They were parsed inside this queue's handler, which made `/approve` useless for the one thing
    // it exists for: the turn waiting on that approval holds this conversation's key, so the answer
    // queued behind the question and neither could move until the approval timed out five minutes
    // later. Seen live on Telegram — three `/approve` messages, no reply to any of them.
    //
    // Deliberately narrow: only text that *already* starts with `/` and names a hook we have. A
    // group message like "nouva: /approve" still queues, because deciding otherwise needs the routed
    // agent and getting it wrong would run two turns at once in one chat — which loses messages.
    // Everything here is cheap and touches no session, so running it beside a turn is safe.
    urgent: (envelope) => {
      const command = parseCommand(envelope.text.trim());
      return command !== null && hooks.has(command.command);
    },
    /**
     * One turn at a time in a one-to-one chat; several in a room.
     *
     * The key is the *chat*, and for a DM that is the right unit: two turns at once means one agent
     * answering two things simultaneously, interleaving writes to one session.
     *
     * A room's conversations are per agent — each member has its own session — so serialising the
     * chat makes every member wait for whichever one was asked first. Asked to compare two models,
     * Nouva ran for a minute and a message to Nero sat behind it doing nothing, in a room whose
     * whole point is that the other agents are free.
     *
     * The global ceiling (`maxConcurrentTurns`) still bounds the spend, which is what it is for —
     * the per-key cap looks like it is doing that job and is not. A room's share of it is its agents, at
     * most half the ceiling, so one room cannot take every slot (`fair-share.ts`, P12).
     */
    maxConcurrentPerKey: (envelope) => conversationSlots(envelope, deps),
    maxConcurrentTotal: deps.config.queue.maxConcurrentTurns,
    maxQueueDepth: deps.config.queue.maxQueueDepth,
    queueTimeoutMs: deps.config.queue.queueTimeoutMs,
    /**
     * The inbox follows the message through: taken by a turn, then handled — however it was handled. A
     * message whose turn the daemon could not finish is closed with its work kept and its person told,
     * which is handled too: it must not be answered again from the inbox after a restart.
     */
    handler: (envelope) => {
      // Taken from the queue: a finished job's result is now in front of its agent (`069_baseline.sql`).
      const woken = jobOfCompletionWake(envelope);
      if (woken) deps.jobWakes?.markWoken(woken, Date.now());
      // A command about the group (`/mention`) before routing: untagged in a shared room, routing would answer nobody.
      return parts.inbox().track(envelope, async () => {
        if (!(await answerGroupCommand(groupCommand, envelope))) await inbound.handle(envelope);
      });
    },
    onDropped: (envelope, reason) => {
      // A shutdown keeps what was waiting: it stays in the inbox and is answered after the restart.
      if (parts.inbox().dropped(envelope, reason)) return;
      log.warn("message dropped", {
        chat_id: envelope.chatId,
        gateway: envelope.gatewayId,
        reason,
      });
      const notice = admission.noticeDropped(envelope, reason);
      if (notice) {
        void voice.reply(envelope, notice).catch((err: unknown) =>
          log.error("drop notice failed", { chat_id: envelope.chatId, error: String(err) }),
        );
      }
      /**
       * Recorded whether or not a notice was sent, and that difference is the point.
       *
       * `noticeDropped` throttles to one notice per chat per minute, because a full queue drops
       * many messages at once and an apology per message would itself be the flood. Every drop
       * still happened, though, and "my message never got an answer" is the question this table
       * can now answer — the throttled ones are exactly the ones nothing told anybody about.
       *
       * `ui`: the message was never routed, so no agent was ever told about it, and putting it in
       * an agent's context would describe a conversation it did not have.
       */
      deps.chatEvents?.record({
        gatewayId: envelope.gatewayId,
        chatId: envelope.chatId,
        audience: "ui",
        kind: "dropped",
        text: notice ?? dropSentence(reason),
        ...(envelope.senderId ? { actor: envelope.senderId } : {}),
        details: { reason, messageId: envelope.id, throttled: !notice },
      });
    },
  });
}

/**
 * What to record for a drop the chat was never told about.
 *
 * `noticeDropped` returns nothing once it has apologised for this chat in the last minute, and the
 * drops it stays quiet about are the ones most worth a row: a burst is when messages go missing
 * fastest and when the chat is told least. Written from the reason rather than reusing the chat
 * wording, which is addressed to the sender and reads oddly as a record.
 */
function dropSentence(reason: string): string {
  switch (reason) {
    case "queue_full":
      return "A message was dropped: this conversation had too many waiting to be answered.";
    case "timeout":
      return "A message was dropped: it waited in the queue longer than the timeout allows.";
    case "duplicate":
      return "A duplicate copy of a message was ignored.";
    case "shutdown":
      return "A message was dropped: the daemon was shutting down.";
    default:
      return `A message was dropped (${reason}).`;
  }
}
