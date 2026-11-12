/**
 * Whether this message gets a turn at all, and whose.
 *
 * Everything here is a decision that costs nothing: authorship, the agent-to-agent hop budget,
 * routing, the one-turn-per-message claim, the per-sender rate limit, slash commands, and closing a
 * stale conversation before the new message joins it. Every early return is a case where no model is
 * called — which is why they are together and why the *order* of them is commented at each step
 * rather than left to the reader to reconstruct.
 *
 * `runTurn` is the other half, in `turn.ts`, and it starts only once all of this has said yes.
 */

import {
  createLogger,
  type ChatType,
  type GatewayInstanceConfig,
  type GatewayName,
  type LoadedAgent,
  type MessageEnvelope,
  type SessionKey, sessionIdFor, toUserMessage} from "@nouride/shared";
import { mentionedAgents, routeMessage, stripAddressPrefix } from "@/modules/router/index.ts";
import { frontDeskFor, unaddressedFallback } from "@/modules/router/front-desk.ts";
import {
  agentMayAnswer,
  type AgentMessageVerdict,
  classifyInbound,
  exhaustedEvent,
  exhaustedNotice,
} from "@/modules/router/agent-mentions.ts";
import { HookRegistry, parseCommand } from "@/modules/hooks/registry.ts";
import { withQuotedContext } from "./messages.ts";
import { requireMentionHere } from "./room-mention.ts";
import { isSystemEvent } from "./deps.ts";
import type { Admission } from "./admission.ts";
import type { SessionLifecycle } from "./session-lifecycle.ts";
import { atWork, lapsedHandover } from "./at-work.ts";
import { isEdit } from "./edit-rules.ts";
import { TurnContext } from "./turn-context.ts";
import type { TurnRunner } from "./turn.ts";

const log = createLogger("pipeline.inbound");

/** How long the front desk waits for the other copies of a message to say whom it was for (`noteRouted`). */
const FRONT_DESK_WAIT_MS = 1_500;

export class InboundRouter {
  constructor(
    private readonly ctx: TurnContext,
    private readonly admission: Admission,
    private readonly lifecycle: SessionLifecycle,
    private readonly hooks: HookRegistry,
    private readonly turns: TurnRunner,
  ) {}

  /**
   * The agents that could answer a message here without being addressed.
   *
   * This used to count *connections* — "how many of our bots are on this platform" — and that is the
   * right count for one arrangement and silently wrong for the other.
   *
   * With one bot per agent the two are the same thing: six Discord connections means six agents, the
   * platform hands every channel message to all of them, and each independently concludes "my owner
   * answers anything here". Six replies to one word, which is the bug the count was added for.
   *
   * Behind a **shared** connection they are not the same thing at all. One connection, every agent
   * reachable on it by name — the dashboard's `web:dashboard`, or one bot token with several agents bound
   * to channels. The count came back as one, the guard did not fire, and an untagged message in a
   * room fell through to the orchestrator: a single reply, from whoever happens to be it, to
   * something addressed to the room rather than to them. `groups_require_mention` ships **off**, so
   * that was the out-of-the-box behaviour of a shared room and not an edge case.
   *
   * So the question is asked directly. A connection that names an owner contributes that one agent. A
   * connection that names none is addressable by every enabled agent, so it contributes all of them —
   * and `web:dashboard` is not in `[gateways]` at all, which is that same case.
   *
   * Deliberately about the arriving connection rather than a filtered list of live ones: a disabled
   * instance is still found by id and its owner is still handed to the router, so counting only
   * `enabled` connections found none and fell through to "every agent", which silenced an owner that
   * a test had been asserting for. The enabled filter belongs on the *siblings*, which are the copies
   * that will actually be delivered.
   *
   * One consequence worth stating: an install with one owner-less bot and several agents used to let
   * the orchestrator answer untagged group chatter and now does not. That arrangement had the same
   * ambiguity as the room and was resolved by picking a name out of config, which is the thing the
   * router's own header says a multi-agent daemon must not do.
   */
  private couldAnswerUnaddressed(
    envelope: MessageEnvelope,
    instance: GatewayInstanceConfig | undefined,
  ): Set<string> {
    const candidates = new Set<string>();

    /**
     * The connection it actually arrived on. An owner means one agent answers for everything here;
     * no owner means every agent does, because every agent answers to its own name on it — and a
     * built-in connection `[gateways]` never mentions, which is what `web:dashboard` is, is that case.
     *
     * "Every agent" narrows to the room's members where the room has any. A dashboard room built out
     * of two agents has two candidates, not six, and the difference decides whether an untagged
     * message is answered at all: counted as six it behaves like a six-agent room and stays silent
     * when it did not have to. `roomAgents` returns null when nothing knows — every platform chat —
     * and this falls back to the whole registry there.
     */
    if (instance?.agent) candidates.add(instance.agent);
    else {
      const reachable =
        this.ctx.roomAgents(envelope) ??
        this.ctx.deps.registry.enabled().map((agent) => agent.config.id);
      for (const agentId of reachable) candidates.add(agentId);
    }

    // Then every *other* live connection on the same platform, because the platform hands each of
    // them its own copy of this same message and each will reach this decision independently. This
    // is the six-replies half: six Discord bots, six owners, one untagged word.
    for (const other of this.ctx.deps.config.gateways) {
      if (!other.enabled || other.platform !== envelope.gateway) continue;
      if (other.id === instance?.id) continue;
      if (other.agent) candidates.add(other.agent);
    }

    return candidates;
  }

  /**
   * Whose message this is, by everything the router weighs: a tag, a reply, the connection's owner, the front desk.
   *
   * May an unaddressed message be answered here at all? Yes for one bot on a platform — everything it receives is its
   * agent's — and yes in a DM, where a private message to Nero's bot is unambiguously Nero's however many other bots
   * exist. No in a room shared by several of our own bots. The platform hands every message to every one of them, so
   * any rule that does not name an agent fires once per connection: "my owner answers anything here" is true six times
   * over, and so is "fall back to the orchestrator". Both shipped, both produced six replies to one message. In that
   * arrangement a channel message has to be addressed — by a platform tag, by name in the text, or by replying to what
   * an agent said — or it goes to the front desk.
   *
   * One method for `handle` and for `untaggedAnswerer`, so what the dashboard says about a room cannot drift from what
   * happens in it.
   */
  private route(envelope: MessageEnvelope, instance: GatewayInstanceConfig | undefined, repliedTo?: string): ReturnType<typeof routeMessage> {
    // The group's own `/mention`, then this connection's setting, then the daemon's — which a room made in the dashboard
    // is not held to: its members decide, below (`room-mention.ts`).
    const here = requireMentionHere(this.ctx.deps, envelope);
    const groupsRequireMention = here.requireMention;
    const members = this.ctx.roomAgents(envelope);
    // The agent the room named with `/mention <agent>`. In a room with a member list, only while it is one of them: a
    // room made in the dashboard keeps its members' rule. One removed or switched off since is no agent to the router,
    // which then routes the message as it would have with nobody named.
    const roomAnswerer = here.answerer && (!members || members.includes(here.answerer)) ? here.answerer : undefined;
    const answerUnaddressed =
      envelope.chatType === "dm" ||
      (!groupsRequireMention && this.couldAnswerUnaddressed(envelope, instance).size <= 1);
    // Where nobody may answer an unaddressed message, the orchestrator is the one who does — the room's front desk. Not
    // for a slash command: `/new` clears one agent's history and `/model` changes one agent's model, so the room is told
    // which names would work rather than having one chosen for it.
    const frontDesk = frontDeskFor({
      orchestrator: parseCommand(envelope.text) ? undefined : this.ctx.deps.config.daemon.orchestrator,
      chatType: envelope.chatType,
      answerUnaddressed,
      groupsRequireMention,
      members: answerUnaddressed ? null : members,
    });
    // The last fallback, kept to the room where it has members: the orchestrator only as one of them, a room of one its member.
    const fallback = unaddressedFallback(this.ctx.deps.config.daemon.orchestrator, members);
    return routeMessage(envelope, this.ctx.deps.registry, {
      ...(fallback ? { orchestrator: fallback } : {}),
      ...(instance?.agent ? { gatewayOwner: instance.agent } : {}),
      answerUnaddressed,
      ...(repliedTo ? { repliedToAgent: repliedTo } : {}),
      ...(frontDesk ? { frontDesk } : {}),
      ...(roomAnswerer ? { roomAnswerer } : {}),
    });
  }

  /**
   * Who answers a message in this room that tags nobody and replies to nothing, or null when nobody does: what the
   * dashboard says under a room's members. Routed as such a message is, so the sentence is the router's own answer.
   */
  untaggedAnswerer(input: { gateway: GatewayName; gatewayId: string; chatId: string }): string | null {
    const envelope: MessageEnvelope = { id: "", timestamp: 0, ...input, chatType: "group", senderId: "", senderName: "", text: "", raw: null };
    const instance = this.ctx.deps.config.gateways.find((gateway) => gateway.id === input.gatewayId);
    return this.route(envelope, instance).agent?.config.id ?? null;
  }

  async handle(envelope: MessageEnvelope): Promise<void> {
    // Handed to a running turn and never read (`TurnContext.releaseTurn`): its agent's next turn. Routed and
    // claimed once already — doing either again would drop it, or answer it twice in a room that named two.
    const returnedTo = this.ctx.deps.registry.get(this.ctx.returned.get(envelope) ?? "");
    if (returnedTo) {
      // A hand-over that waited for its agent (`holdHandover`) is an agent's message still, at its depth in the chain.
      const handed = this.ctx.handed.get(envelope);
      if (handed && (await lapsedHandover(this.ctx, returnedTo, envelope, handed))) return;
      return await this.admit(returnedTo, envelope, this.ctx.verdictOf(envelope), { addressees: 1, addressed: true, claimed: true });
    }

    const instance = this.ctx.deps.config.gateways.find((g) => g.id === envelope.gatewayId);

    // Who wrote it, from what we recorded when we sent it. The platform cannot answer this when
    // several agents share one bot token, and the message id can.
    //
    // A miss here does not yet mean "not ours" — that record is written after our own send() call
    // resolves, and this connection's copy of the same message can arrive first. Falling back to
    // the sender's own account id catches exactly that race, for the one-bot-per-agent case.
    const authored =
      this.ctx.voice.outbound.authorOf(envelope.gateway, envelope.chatId, envelope.id) ??
      (envelope.senderIsBot
        ? this.ctx.voice.agentForSender(envelope.gateway, envelope.senderId)
        : undefined);
    const enriched: MessageEnvelope = authored ? { ...envelope, fromAgent: authored } : envelope;

    // How deep the agent-to-agent chain is here. The platform carries no field for it, so it cannot
    // ride on the message; it lives beside the message ids in the registry, which is already bounded
    // and already cleared per conversation.
    const depth = this.ctx.voice.outbound.hops(envelope.gateway, envelope.chatId);
    const verdict = classifyInbound(
      enriched.fromAgent ? { ...enriched, agentHops: depth } : enriched,
      this.admission.mentionPolicy(),
    );
    // The count is advanced in `admit`, once the claim says this copy of the message is the one
    // being answered — see the comment there. It cannot be advanced here: every connection on the
    // platform reaches this line with the same message, and each one read the count the previous
    // one had just written.
    // A human speaking resets the budget. They are the reason the agents are talking at all, and a
    // chain that stays exhausted after the operator joins in is a chain that has stopped working.
    // A person joining in is what a fresh budget is *for*: without this, two agents that used their
    // four exchanges this morning would be mute for the rest of the day.
    if (verdict.kind === "human") this.ctx.voice.outbound.setHops(envelope.gateway, envelope.chatId, 0);

    if (verdict.kind === "foreign_bot") {
      log.debug("ignoring a message from a bot that is not ours", { chat_id: envelope.chatId });
      return;
    }
    // The exhausted notice is *not* sent here.
    //
    // It reads "nouva and I have gone back and forth four times", so the "I" is the agent that would
    // have answered — and nothing knows who that is until the message has been routed. Sent from here
    // it went out on whichever connection received the trigger, wearing the wrong name and describing
    // itself in the third person.
    //
    // Worse since authorship became platform-wide: every connection now recognises the message as
    // ours, so every one of them reached this branch and posted its own copy. It is handled after
    // routing and after the claim, where exactly one connection is left holding it.

    // A human replied to something an agent said. No mention, no name — the platform gives a message
    // id, and that is enough to send it back to whoever wrote it. Without this the message reaches
    // nobody, which reads as the agent ignoring them.
    const repliedTo = verdict.kind === "human" ? this.ctx.voice.replyAuthor(envelope, instance?.agent) : undefined;

    const decision = this.route(enriched, instance, repliedTo);
    // What this copy knows of whom the message is for, left for the other copies — the front desk's (`noteRouted`).
    if (decision.agent && (decision.reason === "mention" || decision.reason === "reply")) this.admission.noteRouted(envelope, decision.agent.config.id);
    if (repliedTo) this.admission.noteRouted(envelope, repliedTo);

    // A message from an agent is routed by an explicit mention or not at all.
    //
    // This is the rule the whole design rests on — the tag is the baton, and a reply without one ends
    // the exchange. Without it the fallbacks quietly defeat that: "SIP okay Nox, nanti review Sam
    // dulu" mentions nobody, so routing would fall through to the channel binding or the default
    // agent and wake somebody up. The closing line would start a new turn, which is the exact
    // opposite of closing.
    if (verdict.kind === "agent" && decision.reason !== "mention") {
      log.debug("an agent said something without addressing anyone: the exchange ends here", {
        chat_id: envelope.chatId,
        from: verdict.from,
      });
      return;
    }

    if (
      verdict.kind === "agent" &&
      decision.agent &&
      isNarrationNotAddress({
        chatType: envelope.chatType,
        named: decision.agent.config.id,
        inboundOwner: instance?.agent,
        platform: envelope.gateway,
        gateways: this.ctx.deps.config.gateways,
      })
    ) {
      log.debug("an agent named another agent in a DM: narration, not an address", {
        chat_id: envelope.chatId,
        from: verdict.from,
        named: decision.agent.config.id,
      });
      return;
    }

    /**
     * A slash command is not chatter, so the rule that keeps chatter from waking people does not
     * apply to it.
     *
     * `groups_require_mention` exists so an untagged sentence in a busy channel does not start a
     * turn. A command is a different kind of thing: it is addressed to the *harness* about an agent,
     * answered without a model call, and `/stop` is how somebody ends a turn that is running too
     * long. On the box an untagged `/status` in a room reached nobody and said nothing at all.
     *
     * It still needs an unambiguous target, because every one of these acts on one agent's
     * conversation — `/new` clears a history, `/model` changes a model. One member: that one. Several:
     * say which names would work, rather than picking one.
     *
     * Rooms only, deliberately. On a platform the daemon cannot see who is in the channel, the
     * commands are published as native platform commands anyway, and every connection reaches this
     * line — so a hint here would be six copies of the same sentence.
     */
    const members = this.ctx.roomAgents(envelope);
    if (!decision.agent && members) {
      const asCommand = parseCommand(envelope.text);
      if (asCommand && this.hooks.has(asCommand.command)) {
        const sole = members.length === 1 ? this.ctx.deps.registry.get(members[0]!) : undefined;
        if (sole) {
          await this.admit(sole, envelope, verdict, { addressees: 1, addressed: true });
          return;
        }
        this.ctx.deps.chatEvents?.record({
          gatewayId: envelope.gatewayId,
          chatId: envelope.chatId,
          audience: "ui",
          kind: "ambiguous",
          text:
            `${asCommand.command} acts on one agent, and this room has ${members.length}. ` +
            `Name one: ${members.map((id) => `@${id} ${asCommand.command}`).join(", ")}.`,
          ...(envelope.senderId ? { actor: envelope.senderId } : {}),
          details: { command: asCommand.command, candidates: members },
        });
        return;
      }
    }

    if (!decision.agent) {
      log.debug("no agent for message", { reason: decision.reason, chat_id: envelope.chatId });
      if (decision.reason === "ambiguous") {
        const hint = `Several agents are here (${decision.candidates?.join(", ")}). Address one by name.`;
        await this.ctx.voice.reply(envelope, hint);
        /**
         * Recorded as a room event, which is the thing it could not be before.
         *
         * It belongs to nobody: the router declined to choose, so there is no agent to attribute it
         * to and no session to write it into — which is exactly why it was spoken and then lost. On
         * the local gateway "spoken" means handed to a waiting HTTP caller or to nothing at all, so
         * the dashboard never showed it.
         *
         * `ui`: the reader needs to address someone, and putting "several agents are here" into an
         * agent's context would tell it about a message that was never routed to it.
         */
        this.ctx.deps.chatEvents?.record({
          gatewayId: envelope.gatewayId,
          chatId: envelope.chatId,
          audience: "ui",
          kind: "ambiguous",
          text: hint,
          ...(envelope.senderId ? { actor: envelope.senderId } : {}),
          ...(decision.candidates ? { details: { candidates: decision.candidates } } : {}),
        });
      }
      return;
    }

    /**
     * The chain ran out of budget. One notice for the room, not one per agent it was about.
     *
     * Claimed on the routed agent because that is who the sentence is spoken as — and because every
     * connection on the platform reaches this line with the same message, so without a claim a room
     * with six bots in it posts the notice six times.
     */
    if (verdict.kind === "exhausted") {
      if (!this.admission.claim(envelope, decision.agent.config.id)) return;
      // Said out loud, once. A chain that stops silently looks like an agent that crashed, and the
      // operator would go looking for a failure that never happened.
      log.info("agent conversation reached its hop budget", {
        from: verdict.from,
        hops: verdict.hops,
        agent_id: decision.agent.config.id,
        chat_id: envelope.chatId,
      });
      // Attributed to the agent that would have answered: it is speaking about itself, and a human
      // replying to it should reach it rather than whoever carried the message.
      const maxHops = this.admission.mentionPolicy().maxHops;
      const notice = exhaustedNotice(verdict.from, maxHops);
      // Continue under it delivers what was not, the count begun again (`way-on.ts`): what a person speaking does.
      const carryOn = this.ctx.waysOn.keepChain({ envelope: { ...envelope, fromAgent: verdict.from }, to: decision.agent.config.id, from: verdict.from, notice });
      await this.ctx.voice.reply(envelope, notice, decision.agent.config.id, { buttons: [carryOn] });
      /**
       * Written down, because being unmissable is the entire job of this line.
       *
       * It exists so a chain that stops does not read as an agent that crashed. On a transport with
       * no chat to leave it in, an unrecorded notice stops in exactly the way it was written to
       * prevent — the room goes quiet and nothing anywhere says why.
       *
       * A room event rather than a note on one agent's turn, which is where it used to go. What
       * happened happened *between two agents*: attributing it to whichever one was about to answer
       * put a shared fact in one agent's session, so the other one's transcript did not have it —
       * the bug class `cd6e375` was about. `audience: "agents"` because both of them benefit from
       * knowing why they stopped, and the wording is third person for that reason.
       */
      this.ctx.deps.chatEvents?.record({
        gatewayId: envelope.gatewayId,
        chatId: envelope.chatId,
        audience: "agents",
        kind: "hop_budget",
        text: exhaustedEvent(verdict.from, decision.agent.config.id, maxHops),
        details: { from: verdict.from, to: decision.agent.config.id, maxHops, hops: verdict.hops },
      });
      return;
    }
    /**
     * The front desk answers what nobody was addressed in — and a reply to another agent was addressed, though this copy
     * may not know it: Telegram shows a reply to another bot's message to that bot alone. So it waits a moment for the
     * other copies of the message to say whom they routed it to, and stands back if one named someone (0.7.26, live in
     * a group where Nouva answered a reply to Nix).
     */
    // The room's own agent stands back the same way where another of our bots has a copy of the message: "a reply
    // still wins" is only true if the copy that saw the reply is heard first. Alone in the room, nobody else has one.
    const forNobody =
      decision.reason === "front_desk" || (decision.reason === "room_answerer" && this.couldAnswerUnaddressed(envelope, instance).size > 1);
    if (forNobody && envelope.chatType !== "dm") {
      // The desk's own bot's copy says it; the others, which only stand by for it, quietly. Where ids are per connection
      // only that copy goes on at all (`admit`), so the rest need not wait.
      const own = this.ctx.voice.voiceGatewayId(decision.agent.config.id, envelope.gatewayId) === envelope.gatewayId;
      if (own || !envelope.idsPerConnection) {
        await new Promise<void>((resolve) => setTimeout(resolve, FRONT_DESK_WAIT_MS));
        if (this.admission.routedElsewhere(envelope, decision.agent.config.id)) {
          const said = { chat_id: envelope.chatId, desk: decision.agent.config.id };
          if (own) log.info("the front desk stands back: another copy of the message was for someone", said);
          else log.debug("the front desk stands back: another copy of the message was for someone", said);
          return;
        }
      }
    }
    /**
     * Everyone the message addressed, not just the first.
     *
     * A platform does this for us and a shared connection cannot: on Discord `@nero @nox cek ini`
     * is delivered to both bots, each resolves the tag to itself, and both run. Behind one connection
     * there is one copy and one routing decision, so the second name reached nobody — and worse than
     * nobody, because `stripAddressPrefix` then removed the first name and handed Nero a message that
     * read `@nox cek ini`. Its own reasoning step said "Ignoring unaddressed message", which was the
     * correct reading of what it had been given.
     *
     * Run in parallel, which is what the platform arrangement does — six connections do not take
     * turns. `allSettled`, so one agent failing does not cancel the others: they are separate
     * conversations that happen to share a message.
     */
    const targets = this.addressees(envelope, decision.agent, repliedTo);
    if (targets.length > 1) {
      // A room's fan-out is otherwise invisible: nothing else says how many agents one message woke,
      // and "only one of the two answered" is exactly the report that needs this line to diagnose.
      log.info("one message, several agents", {
        chat_id: envelope.chatId,
        agents: targets.map((target) => target.config.id),
      });
    }
    // Named, tagged, or answering what the agent said — what a busy agent's room may steer or be told about.
    const addressed = envelope.chatType === "dm" || targets.length > 1 || decision.reason === "mention" || decision.reason === "reply";
    const outcomes = await Promise.allSettled(
      targets.map((target) => this.admit(target, envelope, verdict, { addressees: targets.length, addressed })),
    );
    /**
     * Rejections reported, not swallowed.
     *
     * `allSettled` is right — one agent failing must not cancel the others, they are separate
     * conversations sharing a message — but discarding the results made a thrown `admit` completely
     * silent: no turn, no error, nothing in the log. Chasing "only one agent answered" without this
     * meant guessing at which of a dozen steps had thrown.
     */
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status !== "rejected") continue;
      log.error("admitting an agent failed", {
        agent_id: targets[index]?.config.id,
        chat_id: envelope.chatId,
        error: String(outcome.reason),
      });
      if (targets[index]) await this.abandoned(targets[index], envelope, outcome.reason);
    }
  }

  /**
   * A turn that threw before its own end could run: its place in the chat given back, its record closed, the person told.
   *
   * Left as it was, the conversation stayed held by a turn that would never run — on 0.8.14 a provider whose key was
   * not set yet threw while the turn was being built (`secondLookFor` read it eagerly), and every later message was
   * steered into it: "↪ Got it" and a line from the steer reply, never an answer, until a restart (2026-11-02, a fresh
   * Docker install under Nix's benchmark). Only a place this message took: a turn of its own that is running is left.
   */
  private async abandoned(agent: LoadedAgent, envelope: MessageEnvelope, reason: unknown): Promise<void> {
    const key = TurnContext.turnKey(agent.config.id, envelope.chatId, envelope.gatewayId);
    if (this.ctx.activeTurns.get(key)?.trigger !== envelope) return;
    this.ctx.releaseTurn(key);
    const running = this.ctx.deps.turns?.runningFor(agent.config.id, envelope.gatewayId, envelope.chatId);
    if (running) this.ctx.deps.turns?.finish(running, { status: "failed", error: `the turn could not start: ${String(reason)}` });
    await this.ctx.voice.reply(envelope, toUserMessage(reason), agent.config.id).catch(() => false);
  }

  /**
   * Which agents this message should run, given the one routing already chose.
   *
   * Only ever widens on an explicit mention — a fallback (`gateway_owner`, `orchestrator`) names one
   * agent by definition, and widening there would answer an unaddressed message several times over,
   * which is the six-replies bug this daemon already has scars from.
   *
   * And only to agents that **share this connection**. An agent with its own bot on this platform is
   * handed its own copy of the message and will route it itself; running it from here as well would
   * be two connections racing for one turn. The claim table would pick a winner, but the loser has
   * already paid for a session lookup and a rollover check — and the predicate is free, because it is
   * the same one `emitHandovers` uses to decide whether a handover needs re-injecting at all.
   */
  private addressees(envelope: MessageEnvelope, routed: LoadedAgent, repliedTo?: string): LoadedAgent[] {
    // The daemon's own events name the one agent they are for in `mentions`, and their text quotes what nobody chose to
    // address — a job's log, its command. An `@name` printed by a job ran that agent too (0.7.17, found live on #10).
    if (isSystemEvent(envelope)) return [routed];
    /**
     * Named and replied to: both answer. On a platform that tells every copy of the reply, each
     * runs the one it was replied to as well as the one named, and the claim keeps it to one turn each; where only the
     * replied bot's copy knows, it is that copy that runs it.
     */
    const replied = repliedTo && repliedTo !== routed.config.id ? this.ctx.deps.registry.enabled().find((agent) => agent.config.id === repliedTo) : undefined;
    if (replied) return [routed, replied];
    /**
     * Matched against the room's members, not every agent on the daemon.
     *
     * Caught by its own test: tagging `@nox` in a room Nox is not in ran Nox, which is the exact
     * failure the membership list was added to prevent — reached this time through the new door. The
     * prompt does not offer a non-member either, so the only way to write that tag is to know a name
     * the room never mentioned, and it should read as a word in a sentence rather than an address.
     *
     * `roomAgents` returns null where nothing knows — every platform chat — and the fallback is the
     * whole registry, which is the behaviour a Discord channel has always had.
     */
    const reachable = this.ctx.roomAgents(envelope);
    const candidates = reachable
      ? this.ctx.deps.registry.enabled().filter((agent) => reachable.includes(agent.config.id))
      : this.ctx.deps.registry.enabled();
    const mentioned = mentionedAgents(envelope, candidates);
    if (mentioned.length <= 1) return [routed];

    const shared = mentioned.filter(
      (agent) =>
        this.ctx.voice.voiceGatewayId(agent.config.id, envelope.gatewayId) === envelope.gatewayId,
    );
    // The routed agent is always in, whether or not it shares the connection: routing already said
    // this message is for it, and a filter that could drop it would silence the one certain answer.
    const targets = shared.some((agent) => agent.config.id === routed.config.id)
      ? shared
      : [routed, ...shared];
    if (targets.length <= 1) {
      // Several names matched and only one survived the connection filter. On a shared connection
      // that should never happen, so it is worth a line rather than a silent narrowing.
      log.debug("several agents addressed, one reachable", {
        chat_id: envelope.chatId,
        mentioned: mentioned.map((agent) => agent.config.id),
        reachable: targets.map((agent) => agent.config.id),
      });
    }
    return targets.length > 0 ? targets : [routed];
  }

  /**
   * One agent's admission and turn: the claim, the checks that are about *it*, and the run.
   *
   * Split from `handle` when a message became able to address several agents. Everything above it
   * decides things about the *message* — who wrote it, how deep the chain is, whether anyone was
   * addressed — and happens once; everything here is per agent and happens as many times as the
   * message named somebody.
   *
   * `addressees` is the count, passed rather than recomputed, and it decides one thing: whether the
   * agent's own tag is stripped from the text it sees. `addressed` is whether the message named the agent
   * rather than reaching it by default, which is what an agent already at work answers differently.
   * `claimed` is a message this connection already claimed for this agent — one a turn handed back.
   */
  private async admit(
    agent: LoadedAgent,
    envelope: MessageEnvelope,
    verdict: AgentMessageVerdict,
    how: { addressees: number; addressed: boolean; claimed?: boolean },
  ): Promise<void> {
    const { addressees, addressed } = how;
    /**
     * Lifted above the notices below, which each say something into this conversation and have to be
     * able to write it down.
     *
     * A reply that exists only in the transport is gone on the next reload — the lesson `note()` was
     * added for, one screen down, when a `/status` answer vanished and left the question with nothing
     * under it. The dashboard is the case that makes it unavoidable rather than untidy: the local
     * gateway hands a reply to a waiting HTTP caller or to nobody at all, so a notice sent through it
     * outside a turn is not merely lost on reload, it is never seen.
     */
    const key: SessionKey = {
      agentId: agent.config.id,
      chatId: envelope.chatId,
      gatewayId: envelope.gatewayId,
    };
    const noteToChat = (prompt: string, reply: string) =>
      this.ctx.deps.turns?.note({
        sessionId: sessionIdFor(key),
        agentId: agent.config.id,
        gatewayId: envelope.gatewayId,
        chatId: envelope.chatId,
        messageId: envelope.id,
        senderId: envelope.senderId,
        prompt,
        reply,
      });

    /**
     * Where ids are per connection, the agent's own connection is the only one that can answer.
     *
     * The claim cannot collapse the copies — each carries a different id — and the reply quotes an id
     * only the receiving bot knows, while the answer goes out through the agent's own. `voiceGatewayId`
     * falls back to this connection when the agent has none of its own here, or it is down, so this
     * never leaves a message nobody takes.
     */
    if (
      envelope.idsPerConnection &&
      this.ctx.voice.voiceGatewayId(agent.config.id, envelope.gatewayId) !== envelope.gatewayId
    ) {
      log.debug("left to the agent's own connection", {
        agent_id: agent.config.id,
        gateway_id: envelope.gatewayId,
        chat_id: envelope.chatId,
      });
      return;
    }

    // The agent's own bot's copy first, so its conversation in a room is one, kept under its own connection.
    if (!how.claimed) await this.admission.ownCopyFirst(envelope, agent.config.id, this.ctx.voice.voiceGatewayId(agent.config.id, envelope.gatewayId) === envelope.gatewayId);

    // Before anything with a side effect — a hook, a turn, a session write. Every copy of this message
    // reaches here; only the first one carries on.
    if (!how.claimed && !this.admission.claim(envelope, agent.config.id)) {
      log.debug("another connection already has this message", {
        agent_id: agent.config.id,
        gateway_id: envelope.gatewayId,
        chat_id: envelope.chatId,
      });
      return;
    }


    // An agent never answers itself. A model writing about itself mentions its own name constantly,
    // and without this each of those would be a loop of one — bounded by the hop budget, but only
    // after spending it.
    if (verdict.kind === "agent" && !agentMayAnswer(agent.config.id, verdict.from)) {
      log.debug("an agent mentioned itself, not routing", { agent_id: agent.config.id });
      return;
    }

    /**
     * One handover, one hop — counted here and nowhere earlier.
     *
     * It used to be counted in `handleInbound`, before routing. Every connection on the platform is
     * handed every message, so a room with six of our bots in it ran that line six times for one
     * handover, and each pass read the depth the previous pass had just written: 0, 1, 2, 3, 4, 5.
     * A budget of five was therefore spent by a single message. Observed live in a Discord thread
     * where the first delegation of the conversation was refused with "we have gone back and forth
     * 5 times" — nobody had gone anywhere.
     *
     * Here, past the claim, exactly one connection is left holding the message. `verdict.hops` was
     * computed from the depth read before any of this, so several agents addressed in one message
     * write the same number rather than one each — one message is one hop however many it woke.
     *
     * A message that reaches no agent now costs nothing, which is the other half of the same
     * mistake: an agent's progress line and its reply to a person are not handovers, and both were
     * being charged as one.
     */
    if (verdict.kind === "agent") {
      this.ctx.voice.outbound.setHops(envelope.gateway, envelope.chatId, verdict.hops);
    }

    if (!this.admission.senderAuthorized(agent, envelope)) {
      log.info("sender not authorized for this agent", {
        agent_id: agent.config.id,
        sender: envelope.senderId,
      });
      return;
    }

    // A message a turn handed back was counted when it came in; it is not the sender writing again.
    if (!how.claimed && !this.admission.withinRateLimit(envelope)) {
      const cooldown = this.ctx.deps.config.security.rateLimit.cooldownReply;
      await this.ctx.voice.reply(envelope, cooldown);
      // Same reason as the notice above: "you are sending these too fast" is not useful advice if the
      // only copy of it is in a response the client already threw away.
      noteToChat(envelope.text, cooldown);
      return;
    }

    // Stripped before the command is parsed, not after.
    //
    // In a group you have to address the agent to be routed to it at all — "nouva: /new" — so a
    // parser that only sees text starting with "/" makes every slash command unusable outside a
    // DM, and sends it to the model instead, which cannot act on it.
    const text = addressees === 1 ? stripAddressPrefix(envelope.text, agent) : envelope.text;

    // An edit is words, never a command (`edits.ts`): arrival stops one that reads as a command, and so does this.
    const command = isEdit(envelope) ? null : parseCommand(text);
    if (command && this.hooks.has(command.command)) {
      const result = await this.hooks.run(command.command, command.args, agent, envelope);
      if (result.reply) {
        await this.ctx.voice.reply(envelope, result.reply);
        /**
         * Written down like a turn, because from the conversation's side it is one.
         *
         * The dashboard's transcript is made of turn records, and a `/status` that existed only in the
         * HTTP response to the send was gone on the next reload — the question still on screen with
         * nothing under it. Recorded after the send, so a command whose reply never left is not
         * remembered as answered.
         */
        this.ctx.deps.turns?.note({
          sessionId: sessionIdFor(key),
          agentId: agent.config.id,
          gatewayId: envelope.gatewayId,
          chatId: envelope.chatId,
          messageId: envelope.id,
          senderId: envelope.senderId,
          prompt: text.trim() || command.command,
          reply: result.reply,
        });
      }
      if (result.handled) return;
    }

    /**
     * A paused agent stops answering but keeps its connection and its history (§9.4 SPEC).
     *
     * Said out loud in a room, which took a live confusion to see. `/stop` **pauses the agent** — it
     * is not "stop this turn" — and one of my own tests had left Nero paused. Every later message
     * tagging Nero in a room then did nothing at all: no turn, no reply, no line above `debug`. The
     * report was "only Nouva answered", and the cause was invisible from the transcript, the live
     * feed and the journal alike.
     *
     * A DM never had this problem because the send route refuses a paused agent up front. A room
     * cannot do that — the other members are answerable — so the refusal has to arrive as part of the
     * conversation instead.
     */
    if (this.ctx.deps.registry.isPaused(agent.config.id)) {
      // Asleep (0.8.0): what the daemon sent it waits for it to wake; a person is told, once an hour (`asleep.ts`).
      if (isSystemEvent(envelope)) {
        log.info("agent asleep, kept for when it wakes", { agent_id: agent.config.id, chat_id: envelope.chatId });
        this.ctx.asleep.hold(agent.config.id, envelope);
        return;
      }
      log.info("agent asleep, not answering", { agent_id: agent.config.id, chat_id: envelope.chatId });
      const notice = this.ctx.asleep.notice({ id: agent.config.id, displayName: agent.config.displayName }, envelope);
      if (notice) await this.ctx.voice.reply(envelope, notice, agent.config.id);
      this.ctx.deps.chatEvents?.record({
        gatewayId: envelope.gatewayId,
        chatId: envelope.chatId,
        audience: "ui",
        kind: "dropped",
        text: `${agent.config.id} is asleep, so it did not see that. Wake it with @${agent.config.id} /wake.`,
        agentId: agent.config.id,
        ...(envelope.senderId ? { actor: envelope.senderId } : {}),
        details: { reason: "agent_paused", messageId: envelope.id },
      });
      return;
    }

    /**
     * Already working here. Said out loud, and nothing queued behind it.
     *
     * A room runs several turns at once — that is the point of a room, and the whole reason the chat
     * queue no longer serialises one. So the thing that keeps an agent from answering two questions
     * at the same time has to be this check rather than the queue's ordering, which used to do it by
     * accident.
     *
     * **After the slash commands**, which was the first placement's mistake. `/status` and `/stop`
     * are answered by the harness without a model call — they exist precisely for a conversation that
     * is busy, and `/stop` is how you end the turn this guard is reporting. Refusing them made the
     * one command anybody would reach for in this situation the one that stopped working.
     *
     * Before `rollOverIfStale`, which mutates: a refused message must not have closed a conversation
     * on its way out.
     *
     * Refused rather than queued, deliberately. A message that waits behind a two-minute turn is a
     * message the person has forgotten writing by the time it runs, answered against a conversation
     * that has moved on. Telling them now is the useful answer, and the room is where they are
     * looking.
     *
     * Except from the person who started the turn, who steers it as they would in a one-to-one chat —
     * this is the first place a room message is known to be for this agent, which is why a room could
     * not be steered on arrival. And "telling them" used to mean a line only the dashboard drew: on a
     * platform the refusal was silence. `atWork` says it in the chat now.
     */
    const working = this.ctx.turnIn(agent.config.id, envelope.chatId, envelope.gatewayId);
    if (working) {
      await atWork(this.ctx, agent, envelope, working, { addressed, fromPerson: verdict.kind === "human", ...(verdict.kind === "agent" ? { handed: verdict } : {}) });
      return;
    }


    /**
     * A conversation that is not a chat's — a mission's (0.8.0): the mission decides whether this turn runs, and hands
     * it its page to start from. Nothing to roll over: such a turn keeps only itself.
     */
    if (this.ctx.deps.shaper?.shapes(envelope)) {
      const shape = this.ctx.deps.shaper.shapeFor(agent.config.id, envelope);
      if (shape) await this.turns.runTurn(agent, envelope, key, shape.text, shape);
      return;
    }

    // After the command check, so `/new` does not capture twice, and before the turn, so the incoming
    // message joins the fresh conversation rather than the one being closed.
    await this.lifecycle.rollOverIfStale(agent, key);

    // The quote joins the text *here* — after routing, after the command parser, and only for the
    // model. Everything above reads `envelope.text`, so a quote folded into it earlier turned a
    // replied-to `/approve` into ordinary chat and let a quoted `@othername` reroute the message. See
    // `MessageEnvelope.quotedText`.
    await this.turns.runTurn(agent, envelope, key, withQuotedContext(envelope, text));
  }
}

/**
 * An agent named another agent in a one-to-one chat, and that is narration rather than an address.
 *
 * In a DM the only agent with any standing is the one whose bot the person is talking to. A name in
 * the text — "Nox says the PR is up" — is a report about a peer turn, and a group is the only place
 * it can also be a hand-off, because a group is the only place the other agent is present.
 *
 * Without this, an agent finishing a peer turn and reporting what the other said gets that report
 * echoed back through the inbound handler, past the mention gate, and the named agent takes a
 * regular turn in a chat it has no presence in — speaking through the first agent's connection,
 * under the first agent's name.
 *
 * ## Why this asks the config and not `voiceGatewayId`
 *
 * The question is "does this agent have a place on this platform", which is a fact about
 * configuration. `voiceGatewayId` answers a different one — "where should it speak from right now"
 * — and returns the inbound connection in *three* cases: the agent has no gateway of its own, its
 * own **is** the inbound one, and **its own exists but is not currently connected**. Reading it
 * here would make a momentary disconnect indistinguishable from having no presence at all, and
 * silently drop a legitimate hand-off with nothing but a debug line to show for it.
 *
 * A pure function rather than a branch inside `handle`, because the decision is worth testing on
 * its own: reaching it through the router means building five collaborators to assert one boolean.
 */
export function isNarrationNotAddress(input: {
  chatType: ChatType;
  /** The agent named in the text. */
  named: string;
  /** The agent that owns the connection this arrived on, if any. */
  inboundOwner?: string;
  platform: GatewayName;
  gateways: readonly { enabled: boolean; platform: string; agent?: string }[];
}): boolean {
  if (input.chatType !== "dm") return false;
  if (input.inboundOwner === input.named) return false;
  // Enabled, not connected: a bot configured here has a place here whether or not it is reachable
  // this second.
  return !input.gateways.some(
    (g) => g.enabled && g.platform === input.platform && g.agent === input.named,
  );
}
