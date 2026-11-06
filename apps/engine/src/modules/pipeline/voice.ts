/**
 * Which bot an agent speaks with, and how what it says gets onto the wire.
 *
 * Owns the outbound registry — who wrote which message — because that is the record a reply creates
 * and the record a reply is looked up in. Splitting the two would mean two objects that are only ever
 * correct together.
 */

import { holdsDashboardLink } from "@/modules/web/links.ts";
import { createLogger, newId, type Gateway, type GatewayName, type MessageEnvelope } from "@nouride/shared";
import { OutboundRegistry } from "@nouride/persona";
import { isSystemEvent, type PipelineDeps } from "./deps.ts";
import { quotedId } from "./edit-rules.ts";
import { cronJobOfChat } from "@/modules/cron/session.ts";

const log = createLogger("pipeline.voice");

/** The pattern the router uses at L165 — duplicated here to keep the module self-contained. */
const AT_MENTION = /@([\p{L}\p{N}_-]+)/gu;

export class Voice {
  /**
   * Which agent wrote which message.
   *
   * Owned here rather than by the pipeline: a reply is what writes to it and a reply is what reads
   * from it, so the two belong to the same object. Bounded and in memory — see `OutboundRegistry`.
   */
  readonly outbound = new OutboundRegistry();

  private handoverCb: ((envelope: MessageEnvelope) => void) | null = null;
  private ownMessageCb: ((envelope: MessageEnvelope) => void) | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  /**
   * Register the callback the pipeline uses to re-inject a synthetic envelope for internal handovers.
   *
   * When an agent's reply mentions another agent that shares the same bot (no gateway of its own on
   * this platform), the platform will never deliver the message to the mentioned agent — the bot
   * filters its own echo. This callback lets the pipeline push the message back through the inbound
   * path so the mentioned agent can see it.
   *
   * Rooms only. A one-to-one chat has one bot in it and one person, and putting a second agent into
   * it was the bug this stopped being — see `emitHandovers`.
   */
  onInternalHandover(cb: (envelope: MessageEnvelope) => void): void {
    this.handoverCb = cb;
  }

  /**
   * Register the callback that records what an agent said, for a gateway that will not tell us.
   *
   * **Room memory only. This must never reach the router**, or an agent's reply would be routed as an
   * inbound message and could wake somebody — which is what `onInternalHandover` is for, under the
   * mention rules, with a hop budget on it. This one is a record, and overhearing is not obeying.
   *
   * Needed because `RoomMemory.observe` runs on *inbound* messages, and on a platform an agent's reply
   * becomes one: Discord hands it to every other bot in the room. The local gateway hands it to nobody,
   * so a dashboard room recorded the humans and none of the agents — a second agent tagged after an
   * exchange saw one message of context where there had been four.
   */
  onOwnMessage(cb: (envelope: MessageEnvelope) => void): void {
    this.ownMessageCb = cb;
  }

  /**
   * Which bot identity an agent speaks with.
   *
   * An agent that has its own connection speaks through it, whichever connection the message it is
   * answering arrived on. Without this an agent answers through whatever bot happened to receive the
   * trigger — and with one bot per agent that is somebody else's face and name. Seen on Discord:
   * Nestor was asked something, handed it to Nexa, and Nexa's answer was posted by Nestor's bot,
   * signed "Halo! Nexa di sini". Two identities, one account.
   *
   * Same platform only. A Telegram bot cannot post into a Discord channel, and reaching for one would
   * turn a wrong name into a message that never arrives.
   */
  voiceFor(agentId: string, envelope: MessageEnvelope): { id: string; gateway: Gateway } {
    const id = this.voiceGatewayId(agentId, envelope.gatewayId);
    return { id, gateway: this.deps.gateways.get(id)! };
  }

  /**
   * The connection id an agent should speak through, given where a message arrived.
   *
   * Public because an agent's identity has to hold on *everything* it says, and three different paths
   * say things: the answer, the live progress line, and the approval prompt. Only the first went
   * through here at first, so a turn that stopped to ask for approval announced itself under whichever
   * bot happened to receive the trigger — Nexa's request, posted by Nouva, with Nouva's avatar on it.
   *
   * Falls back to the inbound connection when the agent has none of its own on this platform, or when
   * its own is not connected. It cannot tell whether that bot was invited to *this room* — nothing in
   * config says which channels a bot is in — so a send may still fail, and each caller decides what to
   * do about that.
   */
  voiceGatewayId(agentId: string, inboundGatewayId: string): string {
    const inbound = this.deps.config.gateways.find((g) => g.id === inboundGatewayId);
    if (!inbound) return inboundGatewayId;

    const owned = this.deps.config.gateways.find(
      (g) => g.enabled && g.platform === inbound.platform && g.agent === agentId,
    );
    if (!owned || owned.id === inboundGatewayId) return inboundGatewayId;

    const gateway = this.deps.gateways.get(owned.id);
    if (!gateway || gateway.status !== "connected") return inboundGatewayId;
    return owned.id;
  }

  /**
   * The agent a person's reply is addressed to: whoever our record says wrote the quoted message, else — when the
   * platform says it was this connection's own (`repliesToSelf`) — the agent that owns the connection.
   *
   * The record first, because it is the only answer when several agents share one bot; the platform's word when the
   * record has nothing, which it does after a restart and for anything older than the last sixty messages of a chat.
   *
   * Where ids are per connection — a Telegram basic group numbers each message per bot — the record is keyed by the
   * platform and the number is not: Nix's 14 and Nouva's 14 are two messages. A hit there is believed only for an
   * agent who speaks through this very connection, whose numbering it is. Live (2026-10-21): a reply to Nix's message
   * read as one to Nouva's, Nix's copy left it to Nouva's connection, and Nix never answered.
   */
  replyAuthor(envelope: MessageEnvelope, owner: string | undefined): string | undefined {
    const recorded = this.outbound.authorOf(envelope.gateway, envelope.chatId, envelope.replyTo) ?? undefined;
    if (recorded && (!envelope.idsPerConnection || this.voiceGatewayId(recorded, envelope.gatewayId) === envelope.gatewayId)) return recorded;
    return envelope.repliesToSelf ? owner : undefined;
  }

  /**
   * Which agent's own bot sent a message, when the per-message registry does not know yet.
   *
   * `outbound.authorOf` is precise but keyed by message id, and that record is written only after
   * this daemon's own `send()` call resolves. A sibling connection's inbound copy of the very same
   * message can reach the router before that write lands — an HTTP response and a websocket push
   * are two independent completions with nothing ordering them, so "recorded late" is not a rare
   * edge case, it is the outcome whenever the write happens to lose that race. Seen live: Nero
   * posted a report tagging Nox, and Nox's own connection classified it `foreign_bot` and dropped
   * it before the record existed.
   *
   * A bot's own account id has no such race — every connection knows its own identity as soon as
   * it connects. This only answers "whose bot is this", so it resolves the "one bot per agent"
   * shape every agent here actually uses; several agents sharing one token still need the
   * message-id registry to say *which* of them wrote it, and this is never consulted in place of
   * that, only when it comes back empty.
   */
  agentForSender(platform: GatewayName, senderId: string): string | undefined {
    for (const instance of this.deps.config.gateways) {
      if (!instance.enabled || instance.platform !== platform || !instance.agent) continue;
      if (this.deps.gateways.get(instance.id)?.selfId === senderId) return instance.agent;
    }
    return undefined;
  }

  /** Whether this connection is the agent's own — the bot that answers as it. */
  private owns(agentId: string, gatewayId: string): boolean {
    return this.deps.config.gateways.some((instance) => instance.id === gatewayId && instance.agent === agentId);
  }

  /**
   * How to tag each agent on this platform: agent id → the token to write.
   *
   * Taken from each agent's own connection, because that is the only thing that knows its handle. An
   * agent with no connection of its own on this platform is left out, and the prompt falls back to its
   * id — which the text matcher understands, and which is all that ever worked before.
   */
  agentMentionTokens(platform: GatewayName): Record<string, string> {
    const tokens: Record<string, string> = {};
    for (const instance of this.deps.config.gateways) {
      if (!instance.enabled || instance.platform !== platform || !instance.agent) continue;
      const token = this.deps.gateways.get(instance.id)?.selfMention;
      if (token) tokens[instance.agent] = token;
    }
    return tokens;
  }

  /**
   * A reply in a cron session goes where the job delivers, or nowhere when it delivers to no chat.
   *
   * The turn stays in the session — it has the run's context — and only the words move. Sent to
   * `cron:<jobId>` as they were, they failed on every platform, so a background job started by an isolated
   * scheduled run reported its result to nobody.
   */
  private async replyFromCronSession(
    jobId: string,
    envelope: MessageEnvelope,
    text: string,
    fromAgent?: string,
    delivery?: { onDelivered?: () => void },
  ): Promise<boolean> {
    const job = this.deps.cronJobs?.get(jobId) ?? null;
    if (!job) {
      log.warn("a reply in a cron session whose job is gone", { job: jobId });
      return false;
    }
    if (job.delivery.mode !== "announce") {
      // Quiet by the job's own setting: `none` delivers nothing, and `webhook` carries a run's result only.
      log.info("a follow-up in a cron session stays there: the job delivers to no chat", { job: jobId, mode: job.delivery.mode });
      return true;
    }
    const target =
      job.delivery.gatewayId && job.delivery.chatId
        ? { gatewayId: job.delivery.gatewayId, chatId: job.delivery.chatId }
        : job.target;
    return await this.reply({ ...envelope, gatewayId: target.gatewayId, chatId: target.chatId }, text, fromAgent, delivery);
  }

  /**
   * Send a reply, and say whether it landed — `true` when the platform took it now. A reply buffered for a
   * connection that is down lands later, and `onDelivered` is called then (`turn_records.delivered_at`). `onSent` is
   * told the connection it went out on and the platform's ids, for a caller that rewrites it later (`steer-accept.ts`).
   */
  async reply(
    envelope: MessageEnvelope,
    text: string,
    fromAgent?: string,
    delivery?: { onDelivered?: () => void; onSent?: (gatewayId: string, ids: readonly string[]) => void },
  ): Promise<boolean> {
    const cronJob = cronJobOfChat(envelope.chatId);
    if (cronJob !== null) return await this.replyFromCronSession(cronJob, envelope, text, fromAgent, delivery);
    if (!this.deps.gateways.get(envelope.gatewayId)) {
      log.error("no gateway to reply through", { gateway: envelope.gatewayId });
      return false;
    }

    // The daemon's own notices keep the inbound connection: they are not anyone's words, so there is
    // no identity to speak with.
    const voice = fromAgent ? this.voiceFor(fromAgent, envelope) : {
      id: envelope.gatewayId,
      gateway: this.deps.gateways.get(envelope.gatewayId)!,
    };

    const send = (via: { id: string; gateway: Gateway }) =>
      via.gateway.send({
        gatewayId: via.id,
        chatId: envelope.chatId,
        text,
        // An agent's reply that holds a dashboard link, as the daemon's notices do: no card of the login page (0.8.11).
        ...(holdsDashboardLink(this.deps.config.dashboard, text) ? { suppressPreview: true } : {}),
        ...(delivery?.onDelivered ? { onDelivered: delivery.onDelivered } : {}),
        // Quoting the trigger is what keeps a group chat readable when several people are
        // talking to the same agent.
        //
        // Except when there is no trigger to quote. A system event — a finished background job, a late
        // approval, a cron dispatch — is a message this daemon invented, and its id names nothing the
        // platform has ever seen. That was invisible while those envelopes all claimed to be DMs; the
        // moment one of them says "channel", quoting it asks Telegram to reply to a message that does
        // not exist, and the answer is refused rather than delivered.
        // An edit quotes the message it changes, which is what the person sees (`quotedId`).
        ...(envelope.chatType === "dm" || isSystemEvent(envelope) ? {} : { replyTo: quotedId(envelope) }),
      });

    let ids: string[];
    let via = voice;
    try {
      ids = await send(voice);
    } catch (err) {
      // The agent's own bot may not be in this channel — nothing in config says which rooms a bot was
      // invited to. Falling back to the connection the message came in on keeps the answer arriving,
      // under the wrong name, which beats silence.
      if (voice.id !== envelope.gatewayId) {
        log.warn("an agent's own connection could not deliver here, falling back", {
          agent_id: fromAgent,
          own_gateway: voice.id,
          inbound_gateway: envelope.gatewayId,
          error: String(err),
        });
        const inbound = { id: envelope.gatewayId, gateway: this.deps.gateways.get(envelope.gatewayId)! };
        try {
          ids = await send(inbound);
          via = inbound;
        } catch (fallbackErr) {
          log.error("reply delivery failed", {
            gateway: envelope.gatewayId,
            error: String(fallbackErr),
          });
          return false;
        }
      } else {
        // A double-fault here (the error reply itself failing) must not propagate — the caller is
        // often the catch block of runTurn(), and throwing from there would leave the user with
        // nothing at all.
        log.error("reply delivery failed", { gateway: envelope.gatewayId, error: String(err) });
        return false;
      }
    }
    delivery?.onSent?.(via.id, ids);

    // Remembered only when an agent wrote it. The daemon's own notices — a pairing code, a cost-cap
    // refusal — are not something to route a reply back to; there is nobody on the other end of them.
    // The dashboard and the CLI read a reply from the turn's record, so for them sending it is delivering it.
    const delivered = ids.length > 0 || envelope.gateway === "web";
    if (!fromAgent) return delivered;

    // The gateway the reply actually went out on — may differ from the inbound one when the agent
    // has its own connection.
    const outboundGatewayId = this.voiceGatewayId(fromAgent, envelope.gatewayId);

    for (const id of ids) {
      // Keyed by the connection it actually went out on, not the one that triggered it: a human
      // hitting reply on this message arrives on *that* connection, and looking it up under the other
      // one would find nothing.
      this.outbound.record({
        // The platform, not the connection it went out on: with one bot per agent every other
        // connection sees this same message and has to be able to tell it is ours.
        platform: envelope.gateway,
        chatId: envelope.chatId,
        messageId: id,
        agentId: fromAgent,
      });
    }

    /**
     * Tell room memory what was just said, when the transport will not.
     *
     * A room's shared history is built out of inbound messages, and on every chat platform an agent's
     * reply *is* one — the platform hands it to every other bot. Where that does not happen the engine
     * is the only thing that knows, so it says so itself.
     *
     * Gated on the declared capability rather than on the platform name, and skipped in a DM where
     * there is no room to have a history. `senderIsBot` and `fromAgent` are both set, so this is
     * recorded as the agent's own line and not as a stranger's.
     */
    const echoes = this.deps.gateways.get(outboundGatewayId)?.echoesOwnMessages ?? true;
    /**
     * One id for the echo and the handover, so room memory holds this message once — it dedupes on
     * id, and both paths observe it.
     *
     * The platform's where it gave one and it means the same thing to every connection; a fresh one
     * where it gave none, or where ids are per connection and the platform's would name some other
     * message to the next bot along.
     */
    const ownId = ids[0] && !envelope.idsPerConnection ? ids[0] : newId("msg");
    if (!echoes && envelope.chatType !== "dm" && this.ownMessageCb) {
      this.ownMessageCb({
        id: ownId,
        timestamp: Date.now(),
        gateway: envelope.gateway,
        gatewayId: outboundGatewayId,
        chatId: envelope.chatId,
        chatType: envelope.chatType,
        senderId: `agent:${fromAgent}`,
        senderName: fromAgent,
        senderIsBot: true,
        fromAgent,
        text,
        raw: { via: "own_message_echo" },
      });
    }

    // Internal handover: if the reply mentions another agent that shares this bot, the platform
    // will never deliver it (the bot filters its own echo). Re-inject it as a synthetic envelope
    // so the inbound pipeline can route it to the mentioned agent.
    if (this.handoverCb) {
      this.emitHandovers(text, fromAgent, outboundGatewayId, envelope, { ids, ownId, echoes });
    }
    return delivered;
  }

  /**
   * Check for @mentions in the outbound text and emit synthetic envelopes for agents that share
   * the same bot — the ones that would never see this message through the platform.
   *
   * A room only ever. In a DM the handover is `ask_agent`, and nothing is re-injected.
   */
  private emitHandovers(
    text: string,
    fromAgent: string,
    outboundGatewayId: string,
    envelope: MessageEnvelope,
    sent: { ids: string[]; ownId: string; echoes: boolean },
  ): void {
    const { ids, ownId, echoes } = sent;
    const seen = new Set<string>();
    const unseen: string[] = [];
    // The platform handle each agent is told to write — `@RenNourideBot` on Telegram — read back.
    // Matching only ids and names missed the one token the prompt asks for.
    const byHandle = new Map(
      Object.entries(this.agentMentionTokens(envelope.gateway)).map(([agentId, token]) => [
        token.replace(/^@/, "").toLowerCase(),
        agentId,
      ]),
    );
    for (const match of text.matchAll(AT_MENTION)) {
      const name = match[1];
      if (!name) continue;
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const agent = this.deps.registry.enabled().find(
        (a) =>
          a.config.id.toLowerCase() === normalized ||
          a.config.displayName.toLowerCase() === normalized ||
          byHandle.get(normalized) === a.config.id,
      );
      if (!agent) continue;
      // Self-mention is not a handover.
      if (agent.config.id === fromAgent) continue;
      /**
       * A DM is never handed over.
       *
       * It used to be, on the reasoning that the mentioned agent's own bot has a separate
       * conversation with the user and would never see this message. True, and the conclusion was
       * wrong: re-injecting it put a *second* agent into a one-to-one chat. It answered under the
       * first agent's bot when it had none of its own, or into its own DM when it did — and either
       * way the person watching got another agent's progress lines, approval prompts and tool
       * output in a conversation they had opened with somebody else. The screenshots that started
       * this were two agents answering the same question under one name.
       *
       * What replaces it is `ask_agent`: the peer runs behind the chat, and the agent the person is
       * actually talking to relays what came back. Nothing to re-inject, so nothing to deliver here.
       */
      if (envelope.chatType === "dm") continue;
      /**
       * Where the platform hands one bot's message to the others, the mentioned agent's own bot is
       * handed this one and routes it itself.
       *
       * Telegram does not: a bot never receives another bot's messages, privacy mode or not. Skipped
       * there, Nouva's `@RenNourideBot tolong cek cluster` was posted, read by the person, and never
       * reached Nero. So it is re-injected on the connection the agent speaks through, which keeps it
       * in that agent's own session.
       */
      const targetGatewayId = this.voiceGatewayId(agent.config.id, outboundGatewayId);
      // Its own bot cannot read this room (`Gateway.sees`): neither the platform nor a re-injection reaches it, and it could
      // not answer here. Live on Discord (0.8.12) Nouva tagged Nexa so, from an earlier message of its own, although its
      // prompt said Nexa was out of the room — and nothing came back. Said in the room below.
      if (targetGatewayId !== outboundGatewayId && this.deps.gateways.get(targetGatewayId)?.sees?.(envelope.chatId) === false) {
        unseen.push(agent.config.id);
        continue;
      }
      if (echoes && targetGatewayId !== outboundGatewayId) continue;

      log.info("internal handover", {
        from: fromAgent,
        to: agent.config.id,
        gateway: targetGatewayId,
      });

      this.handoverCb!({
        /**
         * The outbound message's id where the platform gave one, a fresh id where it did not.
         *
         * Reusing the platform's id is load-bearing and not laziness: every other connection on that
         * platform receives its own copy of this same message, and the queue dedupes on
         * `gatewayId:chatId:id` — so the synthetic envelope and the platform's copy collapse into one
         * turn instead of running the handover twice.
         *
         * There is no such copy when the gateway returns no ids, and the local gateway never does —
         * `send` returns `[]` because a dashboard reply is read from the turn record, not addressed on
         * a platform. `ids[0]!` then asserted an id that was not there and produced `undefined`, which
         * every downstream key concatenated verbatim: two handovers in one room became
         * `local:dev:room-1:undefined` twice, and the second was dropped as a duplicate inside the
         * one-second window. The exchange this feature exists for — A tags B, B tags A back — died on
         * its second leg, logged as `message dropped: duplicate` and nowhere else.
         *
         * Where ids are per connection the platform's names another message on the target's bot, so
         * it takes the echo's id instead — one line in room memory, and nothing to quote.
         */
        id: envelope.idsPerConnection ? ownId : (ids[0] ?? newId("msg")),
        timestamp: Date.now(),
        gateway: envelope.gateway,
        gatewayId: targetGatewayId,
        chatId: envelope.chatId,
        chatType: envelope.chatType,
        senderId: `agent:${fromAgent}`,
        senderName: fromAgent,
        senderIsBot: true,
        fromAgent: fromAgent,
        text: text,
        // Carried to the agent's own bot because its handle was written: that bot was addressed, as
        // surely as if the platform had delivered the tag to it. Also when the tag went out on that same
        // bot — an agent with none of its own speaking through it, tagging the agent whose bot it is:
        // `targetGatewayId !== outboundGatewayId` alone left that copy naming nobody, and a room several
        // agents share hands such a message to none (0.8.12, live in the sandbox).
        ...(this.owns(agent.config.id, targetGatewayId) ? { mentionsSelf: true } : {}),
        raw: { via: "internal_handover" },
      });
    }
    if (unseen.length > 0) this.sayUnseen(unseen, outboundGatewayId, envelope);
  }

  /** One line under a tag that reaches nobody: the person sees why nothing comes back, and the agent reads it next turn. */
  private sayUnseen(agents: string[], gatewayId: string, envelope: MessageEnvelope): void {
    const one = agents.length === 1;
    const text = `⚠ ${agents.join(", ")} cannot read this channel, so the tag above reaches nobody. Let ${one ? "its bot" : "their bots"} into this channel, or ask ${one ? "it" : "them"} elsewhere.`;
    log.info("a tag reaches an agent whose bot cannot read the room", { agents, gateway: gatewayId, chat: envelope.chatId });
    void this.deps.gateways
      .get(gatewayId)
      ?.send({ gatewayId, chatId: envelope.chatId, text })
      .catch((err: unknown) => log.warn("could not say a tag reaches nobody", { gateway: gatewayId, error: String(err) }));
  }
}
