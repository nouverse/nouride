/**
 * What a room has been saying, whether or not anyone was addressed.
 *
 * Held here rather than in the session store because it belongs to the *room* and not to any one
 * agent's conversation — see `sessions/group-context.ts` for why it is in memory.
 *
 * Reads the outbound registry to tell our own bots from strangers', which is why it is handed the
 * voice rather than owning a second copy of that record.
 */

import { createLogger, type ChatMessage, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import {
  formatOverheard,
  GroupContext,
  lastAddressedAt,
  resolveGroupContextLimit,
} from "@/modules/sessions/group-context.ts";
import { formatRoomEvents } from "@/modules/chat-events/format.ts";
import { speakerName } from "@/modules/people/match.ts";
import { ownAttachmentRefs } from "@/modules/attachments/chat-attachments.store.ts";
import type { CarriedFile } from "./attachments.ts";
import { isSystemEvent, type PipelineDeps } from "./deps.ts";
import { isSideAnswer, isSideQuestion } from "./side-question.ts";
import type { Voice } from "./voice.ts";

const log = createLogger("pipeline.room-memory");

/**
 * How far back to look when the agent has no previous message in this conversation.
 *
 * `lastAddressedAt` answers **0** for a history with no user message in it — a fresh conversation, or
 * one a `/reset` has just cleared — and 0 as a lower bound means *the beginning of time*. The events
 * block reads a table rather than a live buffer, so that turned into "3 things happened in this room
 * since your last message" about things from last week.
 *
 * Fifteen minutes: longer than the gap between something happening and somebody asking about it, far
 * shorter than the gap that makes a conversation a different sitting.
 */
const NO_HISTORY_LOOKBACK_MS = 15 * 60_000;

/**
 * How many files one window may offer.
 *
 * Read, filtered to images and then capped again by `AttachmentIntake.pictures`, so this is only the
 * width of the query. Small because a busy channel can hold a great many files and the useful ones
 * are the recent ones — the rest are a `attachment_read` away, which now hands back the picture.
 */
const CARRIED_FILES_LIMIT = 8;

/**
 * The lower bound for "since this agent last spoke".
 *
 * The agent's last message where there is one, and a bounded lookback where there is not — never the
 * beginning of time. And never before the conversation began: after `/new`, a picture from the last
 * sitting is not "posted while nobody was talking to you". Live, a DM reset at 00:32 opened with four
 * screenshots from three days earlier in context, and the agent answered from them as if just sent.
 */
function since(history: ChatMessage[], now: number, startedAt = 0): number {
  const at = lastAddressedAt(history);
  return Math.max(at > 0 ? at : now - NO_HISTORY_LOOKBACK_MS, began(startedAt, now));
}

/**
 * When this conversation began, if it began before the message being answered — a `/new` or a
 * rollover. A session created *for* this message starts after it, and flooring there would drop
 * the chatter the message is pointing at.
 */
function began(startedAt: number, messageAt: number): number {
  return startedAt > 0 && startedAt < messageAt ? startedAt : 0;
}

export class RoomMemory {
  private readonly groupContext = new GroupContext();

  constructor(
    private readonly deps: PipelineDeps,
    private readonly voice: Voice,
  ) {}

  /** Rooms held in the group-context buffer, so a test can catch that map growing without bound. */
  groupContextRooms(): number {
    return this.groupContext.size();
  }

  /**
   * Remember a group message, whoever it was for.
   *
   * **Runs before `admit`, and before routing.** Both of those exist to decide who may *act* through
   * this daemon, and both would defeat this feature if they ran first: routing throws away everything
   * unaddressed, which is exactly what is worth remembering, and `admit` in its default `pair` mode
   * throws away everyone the operator has not paired — which in a group of friends is everyone. A
   * buffer filled only with paired senders' messages would look like it worked and hold nothing.
   *
   * The line that keeps that safe: **overhearing is not obeying.** Nothing downstream reads this
   * buffer as an instruction or as a reason to run a turn. An unpaired sender still cannot start a
   * turn, reach a tool or draw a reply; their words can only ever appear as labelled background on a
   * turn that somebody admitted started. That is a real widening of what reaches the model, which is
   * why it is a setting and why `[agents] group_context_messages` says so.
   *
   * Three things are left out. A DM, because a DM in its entirety is already the agent's own session.
   * Somebody else's bot — the same category `classifyInbound` drops, applied here because this runs
   * long before there is a verdict to consult, and a channel with a CI bot in it would otherwise spend
   * the whole window on build notifications. And anything the daemon synthesised: a job wake-up is not
   * something a person said in the room. That last one is not reachable today — wake-ups go straight to
   * the queue — but this is the wrong place to find that out if one ever arrives through a gateway.
   *
   * The `local` gateway comes through here too, and `POST /message` lets its caller name the chat
   * type — so this path is reachable without a platform, defaulting to `dm` and thus to no capture.
   */
  observe(envelope: MessageEnvelope): void {
    if (envelope.chatType === "dm") return;
    if (isSystemEvent(envelope)) return;

    const limit = this.groupContextLimit(envelope.gatewayId);
    if (limit <= 0) return;

    /**
     * Who wrote it: what the envelope says first, then the message-id lookup.
     *
     * The lookup is platform-wide, so an agent's own message is recognised as ours on every connection
     * that was handed a copy of it — the same resolution `handle` uses. But it can only answer for a
     * message the platform gave an id to, and two paths produce ours without one: an internal handover
     * (a synthetic envelope, no platform message behind it) and the engine's own echo on a gateway that
     * does not return ids at all.
     *
     * Both set `fromAgent` explicitly, and both were being thrown away one line below as "a bot we have
     * no record of" — so a dashboard room recorded the humans and none of the agents.
     */
    const fromAgent =
      envelope.fromAgent ??
      this.voice.outbound.authorOf(envelope.gateway, envelope.chatId, envelope.id);
    if (envelope.senderIsBot && !fromAgent) return;
    // A side question and its answer stay beside the conversation (`/btw`, 0.8.17): the next turn does not overhear them.
    if (isSideQuestion(envelope.text) || (fromAgent && isSideAnswer(envelope.text))) return;

    this.groupContext.record(envelope, limit, fromAgent ?? undefined);
  }

  /**
   * A message the room heard, edited: what the buffer holds and the room's record of it say what it says now,
   * whoever it was for — so an edit that addresses nobody still changes what the next agent overhears, and starts
   * nothing. Where `observe` runs, before `admit`, for the reason given there: what was said is the room's.
   */
  revise(envelope: MessageEnvelope): void {
    if (envelope.chatType === "dm" || isSystemEvent(envelope) || !envelope.edit) return;
    this.groupContext.revise(envelope.gateway, envelope.chatId, envelope.edit.of, envelope.text);
    this.deps.roomMessages?.revise(envelope.gatewayId, envelope.chatId, envelope.edit.of, envelope.text);
  }

  /**
   * The group-context block for this turn, or an empty string when there is nothing to replay.
   *
   * Empty is the common case and is meant to be: in a DM there is no room to overhear, and in a group
   * where the agent was addressed twice in a row there is nothing between the two.
   */
  overheardBefore(
    agent: LoadedAgent,
    envelope: MessageEnvelope,
    history: ChatMessage[],
    startedAt = 0,
  ): string {
    if (envelope.chatType === "dm") return "";
    // Taken as this agent's now, so a window that falls back to the buffer — after a rollover — never offers it again.
    this.groupContext.answering(envelope, agent.config.id);

    const overheard = this.groupContext.since({
      gateway: envelope.gateway,
      chatId: envelope.chatId,
      after: Math.max(lastAddressedAt(history), began(startedAt, envelope.timestamp)),
      before: envelope.timestamp,
      // The raw envelope text rather than the composed question: the composed one has the quote
      // folded in with `> ` markers, and what has to be matched is the message as the room said it.
      carried: [envelope.text, ...(envelope.quotedText ? [envelope.quotedText] : [])],
      limit: this.groupContextLimit(envelope.gatewayId),
      excludeAgent: agent.config.id,
    });

    if (overheard.length === 0) return "";
    log.debug("replaying group context", {
      agent_id: agent.config.id,
      chat_id: envelope.chatId,
      messages: overheard.length,
    });
    // An agent's line keeps the agent's name; a person's is their `[[people]]` name, read now so a rename applies.
    const people = this.deps.config.people;
    return formatOverheard(overheard.map((message) => (message.fromAgent ? message : { ...message, senderName: speakerName(people, message) })));
  }

  /**
   * The room events this agent has not been shown, as a block for the prompt.
   *
   * Same window as `overheardBefore` and deliberately so: everything since this agent was last
   * spoken to, up to the message being answered. The block is composed into the user message and
   * stored with it, so an event is replayed exactly once — it becomes part of the conversation like
   * anything else, and the next window starts after the message that carried it.
   *
   * Not gated on `chatType`, unlike the chatter. A DM has no room to overhear, but it does have
   * things happen to it — a restart mid-conversation, a message the queue dropped — and an agent
   * asked "so what happened?" in a DM should be able to answer.
   */
  eventsBefore(agent: LoadedAgent, envelope: MessageEnvelope, history: ChatMessage[], startedAt = 0): string {
    const store = this.deps.chatEvents;
    if (!store) return "";

    const events = store.since({
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
      after: since(history, envelope.timestamp, startedAt),
      before: envelope.timestamp,
    });
    if (events.length === 0) return "";

    log.debug("replaying room events", {
      agent_id: agent.config.id,
      chat_id: envelope.chatId,
      events: events.length,
    });
    return formatRoomEvents(events);
  }

  /**
   * Files that arrived in the room while nobody was talking to this agent.
   *
   * The same window `overheardBefore` uses, and that is the point: the chatter from that window is
   * already replayed into the prompt, and this is the half of it that was being dropped. A person who
   * posts a screenshot and then tags an agent in the next message was pointing at the screenshot —
   * the agent saw the sentence and not the picture, and the only thing it could do about it was ask
   * for a written description.
   *
   * `ChatAttachmentIndex.since` was written for exactly this and had no caller at all. What was
   * missing was not the query.
   *
   * The triggering message's own files are excluded by ref, not by the clock: those are already
   * described by the intake notice in the same prompt, and announcing them twice under two labels is
   * how a model ends up reporting one photo as two.
   */
  filesBefore(envelope: MessageEnvelope, history: ChatMessage[], startedAt = 0): CarriedFile[] {
    const index = this.deps.attachmentIndex;
    if (!index?.since) return [];

    return index.since({
      // The conversation's own files: in a DM, another of our bots' DM with the same person is not this one (#12).
      gateway: envelope.gateway,
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
      chatType: envelope.chatType,
      // Bounded like the events block: 0 here was the beginning of time, so a fresh conversation was
      // handed the chat's oldest pictures.
      after: since(history, envelope.timestamp, startedAt),
      before: envelope.timestamp,
      exclude: ownAttachmentRefs(envelope),
      limit: CARRIED_FILES_LIMIT,
    });
  }

  /** The connection's own setting where it has one, otherwise the daemon's. */
  groupContextLimit(gatewayId: string): number {
    const instance = this.deps.config.gateways.find((gateway) => gateway.id === gatewayId);
    return resolveGroupContextLimit(
      instance?.groupContextMessages,
      this.deps.config.agents.groupContextMessages,
    );
  }
}
