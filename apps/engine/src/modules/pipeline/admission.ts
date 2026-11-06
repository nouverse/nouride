/**
 * Who gets through, how often, and once.
 *
 * Three gates that share nothing but their shape — each answers a yes/no about one inbound message
 * and each owns a bounded table it has to sweep. They are together because that sweeping is the part
 * that goes wrong: every one of these maps has grown without bound at least once, and keeping them in
 * one file is what makes "does this table have a ceiling" a question you can answer by reading it.
 *
 * The gates run at different points on purpose. `admit` is before the queue, `withinRateLimit` and
 * `claim` are after routing — see the notes on each.
 */

import { createLogger, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import type { AccessMode } from "@nouride/shared";
import type { DropReason } from "@nouride/queue";
import { pairMessage } from "@/modules/access/access.store.ts";
import type { AgentMentionPolicy } from "@/modules/router/agent-mentions.ts";
import { mentionedAgents } from "@/modules/router/index.ts";
import {
  CLAIM_MAX_ENTRIES,
  CLAIM_TTL_MS,
  DROP_NOTICE_CAP,
  DROP_NOTICE_THROTTLE_MS,
  isSystemEvent,
  type PipelineDeps,
} from "./deps.ts";
import { quotedId } from "./edit-rules.ts";
import { droppedNotice } from "./messages.ts";

const log = createLogger("pipeline.admission");

export class Admission {
  /** Sender → recent message timestamps, for the per-sender rate limit (§10.1 SPEC). */
  private readonly recentBySender = new Map<string, number[]>();
  /** Chat → when it was last told a message of theirs was dropped. See `noticeDropped`. */
  private readonly lastDropNotice = new Map<string, number>();
  /**
   * Consecutive job wake-ups per conversation, with no person having spoken.
   *
   * The second unattended budget — see `AgentsSection.jobWakeMaxChain`. Kept here rather than on the
   * envelope, unlike the mention hop count, because a wake-up is invented by the daemon and there is
   * no inbound message to carry a number: the chain is a property of the *conversation*, not of a
   * message travelling through it.
   *
   * Bounded like every other map in this file, and cleared wholesale rather than per-entry. A count
   * lost to eviction restarts a chain at 1, which errs toward letting work continue — the right
   * direction for a runaway guard whose job is to catch a loop, not to police a long install.
   */
  private readonly wakeChain = new Map<string, number>();
  /** `noteRouted`: by `sameMessageKey`, the agents a copy addressed by name or reply, and when. */
  private readonly routedTo = new Map<string, { agents: Set<string>; at: number }>();
  /**
   * One turn per real-world message, per agent.
   *
   * A platform hands a channel message to every bot in the room, so with one bot per agent the daemon
   * sees six copies of one message and routes each independently. Where the routing signal is the same
   * everywhere — a name typed in the text, a reply, the orchestrator — all six reach the same
   * conclusion and the agent answers six times. Live, in a thread with one "tes" in it: six replies,
   * all from Nouva.
   *
   * Keyed by the *routed agent* as well as the message, because that is what makes it safe: two
   * connections that reach different conclusions (one was tagged, the others were not) are not in
   * conflict and both may act.
   */
  private readonly claimed = new Map<string, number>();

  constructor(
    private readonly deps: PipelineDeps,
    /** Which agent wrote the message this one replies to, if one of ours did — the outbound record. */
    private readonly repliedTo: (envelope: MessageEnvelope) => string | undefined = () => undefined,
  ) {}

  /** Rate-limit table size. Exposed so a test can catch the map growing without bound. */
  rateLimitEntries(): number {
    return this.recentBySender.size;
  }

  /** Wake-chain table size, exposed for the same reason. */
  wakeChainEntries(): number {
    return this.wakeChain.size;
  }

  /**
   * Count one job wake-up, and say whether the chain has run out of budget.
   *
   * Called as the wake-up is built, so the position reported to the agent is the one it is in.
   */
  noteJobWake(gatewayId: string, chatId: string): { position: number; limit: number } {
    const key = `${gatewayId}:${chatId}`;
    const position = (this.wakeChain.get(key) ?? 0) + 1;
    if (this.wakeChain.size >= DROP_NOTICE_CAP) this.wakeChain.clear();
    this.wakeChain.set(key, position);
    return { position, limit: this.deps.config.agents.jobWakeMaxChain };
  }

  /**
   * A person said something. The chain starts over.
   *
   * The same rule the mention budget follows, and for the same reason: the ceiling exists to bound
   * work nobody is watching, so somebody watching is exactly what lifts it.
   */
  resetJobWakeChain(gatewayId: string, chatId: string): void {
    this.wakeChain.delete(`${gatewayId}:${chatId}`);
  }

  /**
   * Whether this connection is the one a message is for: a one-to-one chat always, a room when its bot is
   * tagged, its agent is named (WhatsApp reports a tagged bot this way), or what its agent said is replied
   * to. A connection with no agent of its own answers for every agent behind it.
   *
   * Before routing, because a stranger never reaches routing — but the same evidence routing reads.
   */
  private addressedHere(envelope: MessageEnvelope): boolean {
    if (envelope.chatType === "dm" || envelope.mentionsSelf) return true;
    const owner = this.deps.config.gateways.find((gateway) => gateway.id === envelope.gatewayId)?.agent;
    const own = owner ? this.deps.registry.get(owner) : undefined;
    if (owner && !own) return false;
    if (mentionedAgents(envelope, own ? [own] : this.deps.registry.enabled()).length > 0) return true;
    const author = this.repliedTo(envelope);
    return author !== undefined && (owner === undefined || author === owner);
  }

  /**
   * The access mode for a message on this connection: its owner's `[agent] access` when that says
   * `pair` or `allowlist`, the daemon's otherwise. The owner because admission runs before routing and
   * the connection's configured agent is the only one known here — the one whose Access settings a
   * pairing request answers to. A connection with no owner, or one whose owner follows, takes the global.
   */
  private modeFor(gatewayId: string, global: AccessMode): AccessMode {
    const owner = this.deps.config.gateways.find((gateway) => gateway.id === gatewayId)?.agent;
    const own = owner ? this.deps.registry.get(owner)?.config.access : undefined;
    return own === "pair" || own === "allowlist" ? own : global;
  }

  /**
   * Whether a sender may reach the agents at all, checked before anything is queued: the access mode
   * (`pair`, `allowlist` or `open`, per `modeFor`), the static allowlist, and the pairing codes and
   * decisions in the access store.
   *
   * Rate limiting is deliberately *not* here. It used to be, on the reasoning that a limit
   * before the queue avoids spending an LLM call — but a message that no agent would have
   * answered costs nothing to begin with, and counting those had two visible consequences:
   * ordinary group chatter burned a sender's budget so their actual question was refused,
   * and the daemon answered "Please slow down." in channels it was never addressed in.
   * The limit now runs after routing, which is still before any model call.
   */
  admit(envelope: MessageEnvelope): boolean {
    const { access } = this.deps.config.security;

    // The `local` gateway is the operator's own terminal, reached through a token-guarded control
    // API. Making them pair with their own daemon would be theatre.
    if (envelope.gateway === "web") return true;

    /**
     * A bot is never offered a pairing code.
     *
     * Access control is about *people*: a code is something a human reads and forwards to whoever
     * runs the daemon. A bot does neither — so handing one to a bot produces a message that nothing
     * will ever act on, and on a platform that delivers every channel message to every bot, that
     * message is itself a new "unknown sender" for the other connections.
     *
     * That is not theoretical. Six agents shared a Discord channel; one mention of one of them
     * produced a pairing code from each bot present, each of those replies produced three more, and
     * the storm stopped only because a code is issued once per (gateway, sender). Twelve messages
     * for one "hidup?".
     *
     * Let through rather than dropped: whether *our* agent may answer another agent is a question
     * `classifyInbound` already decides, with mention rules and a hop budget. A stranger's bot is
     * dropped there as `foreign_bot`. Neither answer involves pairing.
     */
    if (envelope.senderIsBot) return true;

    const staticAllowlist = access.allowlist;
    const mode = this.modeFor(envelope.gatewayId, access.mode);
    const decision = this.deps.access.check({
      gatewayId: envelope.gatewayId,
      senderId: envelope.senderId,
      ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
      chatId: envelope.chatId,
      // A stranger is paired only by the connection they spoke to. The rest of a room's connections are
      // handed the same message and answer it as the allowlist would: no code, no request, no alert.
      mode: mode === "pair" && !this.addressedHere(envelope) ? "allowlist" : mode,
      staticAllowlist,
    });

    if (decision.action === "allow") return true;

    if (decision.action === "pair") {
      log.info("unknown sender given a pairing code", {
        gateway_id: envelope.gatewayId,
        sender: envelope.senderId,
      });
      /**
       * The code goes where they wrote, from the bot they wrote to.
       *
       * A room used to get no code at all. This gate fires once per connection, and a platform hands a
       * channel message to every bot in it, so every bot answered — a wall of codes, for messages that
       * often named no agent at all — and the fix was silence: the request reached the dashboard and
       * the person who asked heard nothing. Only the connection the message is for gets this far now
       * (`addressedHere`), so a room hears one code, quoted under the message that asked.
       */
      // Sent outside the queue on purpose: this message must not consume a turn slot, and it must not
      // be ordered behind work belonging to people who *are* authorized.
      void this.deps.notifier?.toChat(
        { gatewayId: envelope.gatewayId, chatId: envelope.chatId, ...(envelope.chatType === "dm" ? {} : { replyTo: quotedId(envelope) }) },
        pairMessage(decision.code),
      );
      // The operator is told too, so approving does not require watching the agent's chats.
      void this.deps.notifier?.alert(
        `pair_request:${envelope.gatewayId}:${envelope.senderId}`,
        `${envelope.senderName ?? envelope.senderId} wants to talk to ${envelope.gatewayId}. ` +
          `Approve on the dashboard's Access page or with \`nouride access approve ${decision.code}\`, or ignore them.`,
      );
      return false;
    }

    log.debug("sender not admitted", { sender: envelope.senderId, reason: decision.reason });
    return false;
  }

  /**
   * Per-sender rate limit, once we know a message is actually for an agent.
   *
   * Keyed per gateway instance and sender, and the entry is dropped when it empties —
   * otherwise the map keeps a row per person who has ever spoken to the daemon.
   */
  withinRateLimit(envelope: MessageEnvelope): boolean {
    // The daemon's own events — a mission's turn, a job's end, an answered approval, a restart's resume — are not a
    // sender writing: all are `nouride:system` on one connection, so a few at once shared one budget, and one refused
    // here never reached what it was for — a mission stayed `running` for good, a job's report was lost.
    if (isSystemEvent(envelope)) return true;
    const { rateLimit } = this.deps.config.security;
    const now = Date.now();
    const key = `${envelope.gatewayId}:${envelope.senderId}`;
    const recent = (this.recentBySender.get(key) ?? []).filter((at) => now - at < 60_000);

    if (recent.length >= rateLimit.messagesPerMinute) {
      this.recentBySender.set(key, recent);
      log.info("sender rate limited", { sender: envelope.senderId, in_last_minute: recent.length });
      return false;
    }

    recent.push(now);
    this.recentBySender.set(key, recent);

    // Drop rows that have aged out entirely, so the map does not keep an entry for every
    // person who has ever spoken to the daemon.
    for (const [otherKey, timestamps] of this.recentBySender) {
      if (otherKey !== key && timestamps.every((at) => now - at >= 60_000)) {
        this.recentBySender.delete(otherKey);
      }
    }

    return true;
  }

  /**
   * Claim this (message, agent) pair, or report that another connection already has it.
   *
   * Synchronous check-and-set: `handle` is async, but this runs to completion in one tick, so two
   * gateway callbacks cannot both win.
   */
  claim(envelope: MessageEnvelope, agentId: string): boolean {
    const now = Date.now();
    // Keyed on the platform, not the instance — the instance is exactly what differs between the
    // copies we are collapsing. A message id is unique within a platform's chat.
    const key = `${envelope.gateway}:${envelope.chatId}:${envelope.id}:${agentId}`;
    const seen = this.claimed.get(key);
    if (seen !== undefined && now - seen < CLAIM_TTL_MS) return false;

    this.claimed.set(key, now);
    // Swept opportunistically rather than on a timer: the table only grows while messages arrive, so
    // that is when it is worth walking.
    if (this.claimed.size > CLAIM_MAX_ENTRIES) {
      for (const [otherKey, at] of this.claimed) {
        if (now - at >= CLAIM_TTL_MS) this.claimed.delete(otherKey);
      }
      /**
       * A hard ceiling, not only a sweep (P13). Expiry alone bounded the table by the traffic of one TTL: a burst of
       * messages inside a minute — a busy room, a flood — kept every claim and grew past the cap. Past it, the oldest
       * go: a Map iterates in insertion order. The copies a claim collapses arrive within milliseconds of each other,
       * so the claim given up is one whose copies have long since come.
       */
      for (const otherKey of this.claimed.keys()) {
        if (this.claimed.size <= CLAIM_MAX_ENTRIES) break;
        if (otherKey !== key) this.claimed.delete(otherKey);
      }
    }
    return true;
  }

  /** Claim-table size, so a test can catch it growing without bound. */
  claimEntries(): number {
    return this.claimed.size;
  }

  /**
   * Who a message's copies routed it to by name or by reply — what the front desk stands back for (0.7.26).
   *
   * Telegram tells a bot nothing of a reply to another bot's message: only the bot replied to sees it. So in a group
   * where Nouva is the front desk, a reply to Nix reached Nouva's copy as a message addressed to nobody, and she
   * answered it (2026-10-21). The copy that knows says so here; the front desk waits a moment and looks.
   *
   * Keyed by the message as every copy has it: its id, or — where ids are per connection — its sender and time.
   */
  noteRouted(envelope: MessageEnvelope, agentId: string): void {
    const key = sameMessageKey(envelope);
    const now = Date.now();
    const seen = this.routedTo.get(key);
    this.routedTo.set(key, { agents: new Set([...(seen?.agents ?? []), agentId]), at: now });
    while (this.routedTo.size > CLAIM_MAX_ENTRIES) this.routedTo.delete(this.routedTo.keys().next().value!);
  }

  /** Whether another copy routed this message to an agent other than `desk`, by name or by reply. */
  routedElsewhere(envelope: MessageEnvelope, desk: string): boolean {
    const seen = this.routedTo.get(sameMessageKey(envelope));
    if (!seen || Date.now() - seen.at >= CLAIM_TTL_MS) return false;
    return [...seen.agents].some((agent) => agent !== desk);
  }

  mentionPolicy(): AgentMentionPolicy {
    return {
      enabled: this.deps.config.agents.mentionsEnabled,
      maxHops: this.deps.config.agents.mentionMaxHops,
    };
  }

  /**
   * Whether this sender is let in by name — on an allowlist, or paired — rather than through an open door.
   *
   * Asked by `/restart`, which reaches past the conversation it is typed in. Everyone who gets to a hook got
   * through `admit`, and on an `open` connection that says nothing about who they are; nor does a bot's. As
   * if the door were closed to everyone not named: what `allowlist` mode asks, which issues no pairing code.
   */
  admitsByName(envelope: MessageEnvelope): boolean {
    if (envelope.senderIsBot) return false;
    const { gatewayId, senderId, chatId } = envelope;
    const staticAllowlist = this.deps.config.security.access.allowlist;
    return this.deps.access.check({ gatewayId, senderId, chatId, mode: "allowlist", staticAllowlist }).action === "allow";
  }

  /**
   * Agents may narrow the daemon allowlist further (§17.2 item 7), with the two spellings the daemon's
   * own list takes (`matchesStatic` in `access.store.ts`): a bare id, or one qualified by the gateway
   * it arrives on. Only the bare one matched here, so `telegram:nouva:123` — the spelling to use once
   * a daemon runs bots on several platforms — refused the very person it named.
   */
  senderAuthorized(agent: LoadedAgent, envelope: MessageEnvelope): boolean {
    const allowlist = agent.config.senderAllowlist;
    if (allowlist.length === 0) return true;
    // The daemon's own events, for work a person started — a mission's turn, a job's end, an answered approval — are
    // `nouride:system`, on no allowlist: refused here, a mission stayed `running` for good and a job's report was lost.
    if (isSystemEvent(envelope)) return true;
    const qualified = `${envelope.gatewayId}:${envelope.senderId}`;
    return allowlist.some((entry) => entry === envelope.senderId || entry === qualified);
  }

  /**
   * Whether this chat should be told a message of theirs was dropped, and what to say.
   *
   * A drop used to be a `log.warn` and nothing else, so from the sender's side the message simply
   * vanished — no reply, no error, indistinguishable from the agent ignoring them. The reliable way to
   * hit it needed no load at all: an approval parks the turn, the turn holds this chat's queue key, and
   * anything sent in the meantime aged past `queue_timeout_ms` and was discarded on its way to the
   * handler.
   *
   * Throttled per chat, because the failure arrives in batches — twenty messages dropped by one full
   * queue must not become twenty apologies. One notice covers the burst; the rest are in the log.
   *
   * `duplicate` and `shutdown` say nothing: a duplicate is the *same* message the sender already sent,
   * and during shutdown the gateways are already closing, so the notice would fail on its way out.
   *
   * Returns the text rather than sending it. Speaking is the voice's job, and an admission gate that
   * could reach a gateway would be a gate that can start conversations.
   */
  noticeDropped(envelope: MessageEnvelope, reason: DropReason): string | null {
    const text = droppedNotice(reason);
    if (!text) return null;

    const key = `${envelope.gatewayId}:${envelope.chatId}`;
    const now = Date.now();
    const last = this.lastDropNotice.get(key) ?? 0;
    if (now - last < DROP_NOTICE_THROTTLE_MS) return null;

    // Bounded the same way the read-path set is: one entry per chat that has ever overflowed is small,
    // but "small" over months of uptime is still a leak with no upper bound.
    if (this.lastDropNotice.size >= DROP_NOTICE_CAP) this.lastDropNotice.clear();
    this.lastDropNotice.set(key, now);
    return text;
  }
}

/** One message as all its copies have it: the platform's id, or where each bot numbers it its own way, who and when. */
function sameMessageKey(envelope: MessageEnvelope): string {
  return envelope.idsPerConnection
    ? `${envelope.gateway}:${envelope.chatId}:${envelope.senderId}:${envelope.timestamp}`
    : `${envelope.gateway}:${envelope.chatId}:${envelope.id}`;
}
