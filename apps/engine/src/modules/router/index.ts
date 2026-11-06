/**
 * Message routing — which agent, if any, answers this message.
 *
 * Ordered from most to least explicit: an addressed message goes where it was addressed,
 * then channel bindings, then a single obvious candidate, then the configured default.
 * If none of those apply the message is ignored — a multi-agent daemon that guesses will
 * eventually have two agents answer the same question, and users read that as a bug.
 */

import { createLogger, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import { escapeRegex } from "@/commons/text.ts";
import type { AgentRegistry } from "@nouride/persona";

const log = createLogger("router");

export type RouteReason =
  | "mention"
  /** A reply to something this agent said, on a platform that has replies. */
  | "reply"
  | "gateway_owner"
  | "channel_binding"
  | "sole_agent"
  /** Nobody addressed, and the orchestrator answers — `[daemon] orchestrator`. */
  | "orchestrator"
  /** A room several of our bots share, nobody addressed, and the orchestrator is its front desk. */
  | "front_desk"
  | "no_match"
  | "ambiguous"
  /** Somebody was tagged on a platform that resolves mentions, and it was not us. */
  | "addressed_elsewhere"
  | "no_agents";

export interface RouteDecision {
  agent: LoadedAgent | null;
  reason: RouteReason;
  /** Set when `ambiguous` — the candidates a mention would disambiguate between. */
  candidates?: string[];
}

export interface RouterOptions {
  /** `[daemon] orchestrator`: who answers a message that addresses nobody, where anybody may. */
  orchestrator?: string;
  /**
   * Agent that owns the connection a message arrived on, from
   * `[gateways.<platform>.<name>] agent`.
   *
   * This is the "one bot per agent" case, and it is the reason it ranks above channel
   * bindings: if you gave Nouva her own Telegram bot, everything that bot receives is hers,
   * and enumerating every chat id in a binding would be busywork that breaks the moment
   * someone starts a new conversation with her.
   */
  gatewayOwner?: string;
  /**
   * May *anyone* answer a message that addressed nobody?
   *
   * Gates the two fallbacks that do not name an agent: "the owner of this connection" and "the
   * orchestrator". Both are right for one bot on a platform — everything it receives is its
   * agent's, and a plain question in a DM should be answered. Both are wrong once several of our bots
   * share a room, because the platform hands the message to all of them and each fallback fires
   * independently: six connections, one untagged "tes", six identical replies.
   *
   * Split from `gatewayOwner` because that is also *the identity a platform tag resolves to* —
   * withholding it to stop the fallback stopped explicit mentions from resolving too, which was the
   * first attempt at this and it silenced the tagged agent.
   */
  answerUnaddressed?: boolean;
  /**
   * The agent that wrote the message this one is replying to.
   *
   * Ranks just under an explicit mention and above everything else, because it is nearly as explicit:
   * hitting reply on what Nouva said and typing "and the other one too" names Nouva as clearly as
   * typing her name would, and expecting a tag as well is expecting people to talk like a router.
   */
  repliedToAgent?: string;
  /**
   * Who answers a message that addressed nobody, in a room where nothing else may: the orchestrator, as the front desk.
   *
   * Only ever passed where `answerUnaddressed` is false — a room several of our bots share — and it can be the one
   * fallback there because it names the same agent on every connection: six copies of one message all reach it, and
   * the claim, keyed on (message, agent), lets one of them through. That is what the plain fallback to the orchestrator
   * could not be on its own, gated off with the owner fallback: the same rule, but without the claim, six times over.
   */
  frontDesk?: string;
}

export function routeMessage(
  envelope: MessageEnvelope,
  registry: AgentRegistry,
  options: RouterOptions = {},
): RouteDecision {
  // `enabled`, not `active`: a paused agent is still addressable so that `/start` reaches it.
  // Whether it answers is decided after hooks, by the pipeline.
  const active = registry.enabled();
  if (active.length === 0) return { agent: null, reason: "no_agents" };

  // The platform's own answer first, because it is the only unambiguous one: it resolved a tag to
  // *this* connection's bot, and the agent that owns the connection is who was addressed.
  if (envelope.mentionsSelf && options.gatewayOwner) {
    const owner = active.find((agent) => agent.config.id === options.gatewayOwner);
    if (owner) return { agent: owner, reason: "mention" };
  }

  const mentioned = findMentioned(envelope, active);
  if (mentioned) return { agent: mentioned, reason: "mention" };

  /**
   * A reply to what an agent said, before "somebody else was tagged" — so replying to Nix and tagging Nouva runs both:
   * Nouva on her copy, by the tag, Nix on his, by the reply (the owner, 2026-10-21). Before, the tag of another agent
   * silenced the reply, and the agent the person answered said nothing.
   *
   * Not in a one-to-one chat to another agent's line (0.7.17, nouride-releases#10): another agent's line can be there
   * without that agent being in the conversation — a peer `ask_agent` ran shows its progress in the asking agent's chat.
   * In a DM the owner answers instead, and can ask the other itself; `@name` still reaches it. A room keeps the rule.
   */
  const replyTakesIt = !(envelope.chatType === "dm" && options.gatewayOwner && options.repliedToAgent !== options.gatewayOwner);
  if (options.repliedToAgent && replyTakesIt) {
    const replied = active.find((agent) => agent.config.id === options.repliedToAgent);
    if (replied) return { agent: replied, reason: "reply" };
  }

  /**
   * Somebody was tagged and it was not us.
   *
   * Without this the next step is "my owner answers anything on this connection", which on a platform
   * that delivers every channel message to every bot means every bot answers a tag meant for one of
   * them. Observed with six agents in one Discord channel: one `@Nero`, six replies, none of them
   * from Nero having been addressed.
   *
   * Only when the platform actually resolved mentions. An empty list means the platform reported none,
   * not that it could not tell.
   */
  if (envelope.mentions && envelope.mentions.length > 0 && !envelope.mentionsSelf) {
    return { agent: null, reason: "addressed_elsewhere" };
  }

  if (options.gatewayOwner && options.answerUnaddressed !== false) {
    const owner = active.find((agent) => agent.config.id === options.gatewayOwner);
    if (owner) return { agent: owner, reason: "gateway_owner" };
    log.warn("gateway owner is not an active agent", {
      configured: options.gatewayOwner,
      gateway: envelope.gatewayId,
    });
  }

  const bound = active.filter((agent) =>
    (agent.config.channels[envelope.gatewayId] ?? []).includes(envelope.chatId),
  );
  if (bound.length === 1) return { agent: bound[0]!, reason: "channel_binding" };

  // Below a binding, which is the operator naming an agent for this channel; above the ambiguity, which is the silence
  // the front desk exists to fill. Among several bound agents it answers only when it is one of them.
  const desk = options.frontDesk ? active.find((agent) => agent.config.id === options.frontDesk) : undefined;
  if (options.frontDesk && !desk) log.warn("the orchestrator is not an active agent", { configured: options.frontDesk });
  if (desk && (bound.length === 0 || bound.includes(desk))) return { agent: desk, reason: "front_desk" };

  if (bound.length > 1) {
    // Several agents watch this channel and nobody was named. Answering with all of them
    // is noise; picking one is arbitrary. Say nothing and let the user address someone.
    return { agent: null, reason: "ambiguous", candidates: bound.map((a) => a.config.id) };
  }

  // A DM has no channel binding to match, and with one agent running there is no ambiguity
  // to resolve.
  if (envelope.chatType === "dm" && active.length === 1) {
    return { agent: active[0]!, reason: "sole_agent" };
  }

  // The last fallback, and it names nobody either — so it is off wherever an unaddressed message must
  // not be answered. Left on, it is what answered a one-word thread six times over: every connection
  // reached the same default and ran it.
  if (options.orchestrator && options.answerUnaddressed !== false) {
    const fallback = active.find((agent) => agent.config.id === options.orchestrator);
    if (fallback) return { agent: fallback, reason: "orchestrator" };
    log.warn("the orchestrator is not an active agent", { configured: options.orchestrator });
  }

  return { agent: null, reason: "no_match" };
}

/**
 * Was an agent addressed?
 *
 * Three ways, because platforms and humans differ, and in this order: a platform mention the gateway
 * already resolved to an agent id, a leading `name:` / `name,` — which is how people actually address
 * someone in a group chat — and then an `@name` anywhere in the text.
 *
 * The order is the fix, not an accident of listing. See the note on the leading form below.
 */
function findMentioned(envelope: MessageEnvelope, active: LoadedAgent[]): LoadedAgent | null {
  const byMentionList = active.find((agent) =>
    envelope.mentions?.some((mention) => matchesName(mention, agent)),
  );
  if (byMentionList) return byMentionList;

  const text = envelope.text.trim();
  if (!text) return null;

  /**
   * A leading `name:` outranks an `@name` further into the message.
   *
   * It used to be the other way round — the whole text was scanned for `@` first, and the prefix was
   * only consulted if nothing matched. So "nouva: tolong minta @nox benerin build" went to **Nox**:
   * the person addressed one agent and a third party mentioned in passing answered instead.
   *
   * Found live through `nouride chat nouva`, which addresses an agent by prefixing exactly this form.
   * The message asked Nouva to say something containing `@nox`, and Nox took the message, read it as
   * somebody impersonating Nouva, and answered with a prompt-injection warning. Nothing was wrong
   * with Nox's reasoning; it was never the intended recipient.
   *
   * The `@` form still wins when *it* comes first, and two `@`s are still resolved in text order —
   * this only decides between "who I am talking to" and "who I am talking about", and the opening
   * address is the better answer to the first.
   */
  const leading = /^([\p{L}\p{N}_-]+)\s*[:,]/u.exec(text);
  const leadingName = leading?.[1];
  if (leadingName) {
    const agent = active.find((candidate) => matchesName(leadingName, candidate));
    if (agent) return agent;
  }

  const atMention = /@([\p{L}\p{N}_-]+)/gu;
  for (const match of text.matchAll(atMention)) {
    const name = match[1];
    if (!name) continue;
    const agent = active.find((candidate) => matchesName(name, candidate));
    if (agent) return agent;
    // No enabled agent matched — worth a line, because the most common cause is an agent that
    // failed to load or was paused, and this is the only place that silence is observable.
    log.debug("@mention in text did not match any enabled agent", {
      mentioned: name,
      enabled: active.map((a) => a.config.id),
    });
  }

  return null;
}

/**
 * Every agent the text addresses, in the order it names them.
 *
 * `findMentioned` answers "who is this for" and stops at the first match, which is the right answer
 * for one routing decision. This is the other question — "who was asked" — and it exists because a
 * platform answers it for us and a shared connection does not.
 *
 * On Discord `@nero @nox cek ini` reaches both bots: each connection is handed its own copy, resolves
 * the tag to itself, and runs. Behind one connection there is one copy and one decision, so the
 * second name went nowhere. The caller fans out over this list to close that gap; the claim table is
 * what keeps the two arrangements from doubling up, since it is keyed on (message, agent).
 *
 * Platform-resolved mentions are folded in first, then the text is scanned. A leading `nero:` counts
 * — it is how people address somebody — but it is not given the precedence it has in `findMentioned`,
 * because there is no single winner to decide here.
 */
export function mentionedAgents(envelope: MessageEnvelope, active: LoadedAgent[]): LoadedAgent[] {
  const found = new Map<string, LoadedAgent>();

  for (const mention of envelope.mentions ?? []) {
    const agent = active.find((candidate) => matchesName(mention, candidate));
    if (agent) found.set(agent.config.id, agent);
  }

  const text = envelope.text.trim();
  const leading = /^([\p{L}\p{N}_-]+)\s*[:,]/u.exec(text)?.[1];
  if (leading) {
    const agent = active.find((candidate) => matchesName(leading, candidate));
    if (agent) found.set(agent.config.id, agent);
  }

  for (const match of text.matchAll(/@([\p{L}\p{N}_-]+)/gu)) {
    const name = match[1];
    if (!name) continue;
    const agent = active.find((candidate) => matchesName(name, candidate));
    if (agent) found.set(agent.config.id, agent);
  }

  return [...found.values()];
}

function matchesName(candidate: string, agent: LoadedAgent): boolean {
  const normalized = candidate.trim().toLowerCase().replace(/^@/, "");
  return (
    normalized === agent.config.id.toLowerCase() ||
    normalized === agent.config.displayName.toLowerCase()
  );
}

/**
 * Strip the address prefix from a routed message.
 *
 * Leaving "nouva: " in place means the model sees its own name as the first token of every
 * message and eventually starts echoing the pattern back.
 */
export function stripAddressPrefix(text: string, agent: LoadedAgent): string {
  const names = [agent.config.id, agent.config.displayName].map(escapeRegex);
  // The name ends where a letter, digit or `_` does not follow: "@NexaNourideBot" is a bot's handle, not "@Nexa" with
  // "NourideBot …" after it. Without it Nexa was handed "NourideBot Gading udah approve…" by Nouva's tag (2026-11-01).
  const pattern = new RegExp(`^\\s*@?(${names.join("|")})(?![\\p{L}\\p{N}_])\\s*[:,]?\\s*`, "iu");
  return text.replace(pattern, "").trimStart() || text.trim();
}

