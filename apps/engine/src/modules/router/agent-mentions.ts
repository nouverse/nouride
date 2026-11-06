/**
 * When one agent may answer another, and when the conversation has to stop.
 *
 * The shape the operator asked for, and it reads like people talking:
 *
 * ```
 * Nouva: "@nox kerjain ini, disuruh Gading"
 * Nox:   …work…
 * Nox:   "udah kelar @nouva, PR di xxx"
 * Nouva: "SIP okay Nox, nanti kita butuh review Gading dulu ya"
 * ```
 *
 * The last line ends it, and nothing here makes that happen: the router only routes on a mention, so
 * a reply without one reaches nobody. **The tag is the baton.** `Nox` in that sentence is a word, not
 * an address.
 *
 * ## Two brakes, because one of them is a model
 *
 * The convention above is soft. It lives in the prompt and it depends on the model choosing not to
 * tag — and a model cannot be relied on to *not* do something. So there is a hard one: every
 * agent-to-agent message carries a hop count, and past the budget the mention is ignored no matter
 * what anyone wrote. Each hop is a paid provider call, and two agents being polite at each other
 * overnight is a bill.
 *
 * When the budget runs out the daemon says so in the chat. A chain that stops silently looks like an
 * agent that died, and the operator would go looking for a crash that never happened.
 *
 * ## What is deliberately not enforced
 *
 * "Only for delegating work" cannot be checked. There is no way for code to tell a handover from
 * small talk, and pretending otherwise would mean a classifier that is wrong in both directions. The
 * budget is the honest limit: whatever they are doing, they get four turns of it.
 */

import type { MessageEnvelope } from "@nouride/shared";
import { cutAtWord } from "@/commons/cut-at-word.ts";

export interface AgentMentionPolicy {
  /** Whether agents may address each other at all. */
  enabled: boolean;
  /** Agent-to-agent messages allowed in one chain before mentions stop being followed. */
  maxHops: number;
}

export type AgentMessageVerdict =
  /** Not from one of our agents — ordinary routing applies. */
  | { kind: "human" }
  /** From one of our agents, within budget. */
  | { kind: "agent"; from: string; hops: number }
  /** From one of our agents, and the chain has gone far enough. */
  | { kind: "exhausted"; from: string; hops: number }
  /** Somebody else's bot. */
  | { kind: "foreign_bot" };

/**
 * Classify an inbound message.
 *
 * `fromAgent` is resolved before this by looking the message id up in what we sent — that is the only
 * way to know *which* agent wrote it when several share a bot token, and it is also what distinguishes
 * our bots from a stranger's.
 */
export function classifyInbound(
  envelope: MessageEnvelope,
  policy: AgentMentionPolicy,
): AgentMessageVerdict {
  if (!envelope.senderIsBot) return { kind: "human" };

  // A bot we have no record of. Dropped, which is what the blanket filter used to do for everything —
  // the category was never the problem, only its breadth.
  if (!envelope.fromAgent) return { kind: "foreign_bot" };

  // Off: an agent's message is treated as another bot's and ignored, so the daemon behaves exactly as
  // it did before this feature existed.
  if (!policy.enabled) return { kind: "foreign_bot" };

  const hops = (envelope.agentHops ?? 0) + 1;
  if (hops > policy.maxHops) return { kind: "exhausted", from: envelope.fromAgent, hops };
  return { kind: "agent", from: envelope.fromAgent, hops };
}

/**
 * Whether an agent may answer this, given who sent it.
 *
 * An agent never answers itself. Without this a single message mentioning its own name — which a model
 * writing about itself does constantly — would be a loop of one, and the hop budget would only make it
 * a short one.
 */
export function agentMayAnswer(target: string, from: string | undefined): boolean {
  return target !== from;
}

/**
 * The same fact, in the third person, for the room's event log.
 *
 * `exhaustedNotice` below is written as one agent speaking — "nero and **I**" — which is right for a
 * line delivered into the chat under that agent's name and wrong for a room event, because an
 * `audience: "agents"` event is read by every agent in the room and none of them is the "I". A first
 * person sentence in a shared record is one every reader but one will misattribute.
 */
export function exhaustedEvent(from: string, to: string, maxHops: number): string {
  return (
    `${from} and ${to} exchanged ${maxHops} messages without anyone else speaking, so the chain ` +
    `stopped there. Say something in the room to let them continue.`
  );
}

/** What the daemon says when a chain has run out of budget. Said once, in the chat, by name. */
export function exhaustedNotice(from: string, maxHops: number): string {
  return (
    `(${from} and I have gone back and forth ${maxHops} times, so I am leaving it there rather than ` +
    `carrying on. Say something if you want us to continue.)`
  );
}

/** One peer's line, at most — its name and a role, not a biography. */
const PEER_LINE_MAX = 180;
/** Every peer's lines together. Past it the rest are listed by id alone, as all of them were before. */
const PEER_LINES_TOTAL = 1200;

/** What a peer's line is read from: its display name and its IDENTITY.md — a `LoadedAgent` is one. */
export interface PeerPack {
  config: { displayName: string };
  persona: { identity: string };
}

/** Stripped of list and bold marks and of anything that reads as a section delimiter. */
function plain(line: string): string {
  return line.replace(/<<<|>>>/g, "").replace(/^\s*[-*+]\s+/, "").replace(/\*\*|__/g, "").trim();
}

/**
 * What a pack is for, in one line of its own IDENTITY.md: the `Headline:` field `agent_create` and setup write (`Role:`
 * before 0.7.18, which 0.7.x rewrote and 0.8.0 does not read as one), or failing one, the first line that is neither a
 * heading nor the name or emoji field.
 *
 * A pack has no description of its own, and its IDENTITY is the one file every pack must have — so this is the line
 * an operator already wrote to say what the agent is. Stripped of list and bold marks and of anything that reads as a
 * section delimiter; `peerLine` cuts it at a word.
 */
export function identityLine(identity: string): string | undefined {
  const lines = identity
    .split("\n")
    .map(plain)
    .filter((line) => line && !line.startsWith("#"));
  const headline = lines.find((line) => /^headline\s*:/i.test(line))?.replace(/^headline\s*:\s*/i, "");
  return headline || lines.find((l) => !/^(name|emoji|created by)\s*:/i.test(l));
}

/**
 * One peer's capability line: its display name, then what its IDENTITY.md says it is for — or the name alone when the
 * pack says nothing. The name is there because a person says "ask Lyra" and a model reads ids; one line carries both.
 */
function peerLine(pack: PeerPack): string {
  const name = plain(pack.config.displayName.replace(/\s+/g, " "));
  const purpose = identityLine(pack.persona.identity);
  const line = purpose && purpose !== name ? `${name}. ${purpose}` : name;
  return cutAtWord(line, PEER_LINE_MAX, 41);
}

/**
 * Each peer's line, in the order given, until the lines together would pass `PEER_LINES_TOTAL`.
 *
 * Read from the packs as they are loaded — no counts, no times, nothing a turn moves — because this is part of the
 * harness and the harness is in the cached prefix: it changes when a pack's IDENTITY does, and not otherwise.
 */
export function describePeers(ids: string[], packOf: (id: string) => PeerPack | undefined): Record<string, string> {
  const about: Record<string, string> = {};
  let total = 0;
  for (const id of ids) {
    const pack = packOf(id);
    if (!pack) continue;
    const line = peerLine(pack);
    if (total + line.length > PEER_LINES_TOTAL) break;
    about[id] = line;
    total += line.length;
  }
  return about;
}

/** The peers' lines under the list that names them, or nothing when no peer's pack is loaded. */
function purposeLines(others: string[], about: Record<string, string> | undefined): string[] {
  const described = others.filter((id) => about?.[id]);
  if (described.length === 0) return [];
  return ["- Who each is, and what its own IDENTITY.md says it is for. Ask the one whose work it is:", ...described.map((id) => `  - ${id}: ${about![id]}`)];
}

/**
 * The convention, for the system prompt.
 *
 * Stated as what the marks *mean* rather than as a rule to obey. A model told "do not tag" will tag;
 * a model told "tagging is how you hand work over" has a reason not to when it is finishing.
 */
export function mentionConventionLines(input: {
  others: string[];
  /** Agent id → the exact text to write to tag it, from that agent's own connection. */
  mentions?: Record<string, string>;
  /** Agent id → what it is for (`describePeers`). */
  about?: Record<string, string>;
  /** This agent is the orchestrator: the room's front desk. */
  frontDesk?: boolean;
  /** Agents whose own bot cannot read this room — not tagged, but named, so a person who asks for one hears why. */
  absent?: string[];
  maxHops: number;
}): string[] {
  const absent = input.absent?.length
    ? [
        `- Not in this chat: ${input.absent.join(", ")}. Their bot cannot read it, so a tag here reaches nobody. Asked to`,
        "  bring one in, say so: someone who runs the server lets that bot into this channel. Or ask them elsewhere.",
      ]
    : [];
  if (input.others.length === 0) return absent.length > 0 ? ["OTHER AGENTS", ...absent, ""] : [];
  // The platform's own handle where there is one, the agent id where there is not.
  //
  // `@nero` works only because the text matcher compares against ids and display names, and that is
  // exactly what broke live: a Discord bot is tagged by id, and the *name* the platform shows is the
  // application's — "Nero | Infra Agent", which matches neither. An id cannot be renamed out from
  // under a mention.
  const token = (id: string) => input.mentions?.[id] ?? `@${id}`;
  return [
    "OTHER AGENTS",
    // Written as the exact token to type, because a model shown a bare name addresses it however it
    // reads best in a sentence — "Nox", "nox_bot", "the other agent" — and none of those arrive.
    `- You share this chat with: ${input.others.map((id) => `${id} (write ${token(id)})`).join(", ")}.`,
    ...purposeLines(input.others, input.about),
    ...absent,
    // The orchestrator's part in a room: the untagged message is its, and the lines above say whose work it may be.
    ...(input.frontDesk
      ? [
          "- You are the orchestrator: where this room does not require a mention, a message that tags, names or",
          "  replies to nobody comes to you alone. Answer it yourself, or hand it to the agent whose line above",
          "  fits (with its token), and say you did.",
        ]
      : []),
    "- Addressing one means writing that exact token in the message. Anything else (describing them,",
    "  naming them without it, retyping their display name) does not reach them.",
    "- A mention hands the work over: they will see the message and act on it. Only use one when you",
    "  actually want them to do something.",
    "- When you are finishing (acknowledging, agreeing, summarising), reply WITHOUT a mention. Naming",
    "  someone in a sentence is fine; the @ is what wakes them.",
    `- After ${input.maxHops} exchanges between agents the mentions stop being delivered, so do not`,
    "  rely on a long back-and-forth. Say what you need in one message.",
    "",
  ];
}

/**
 * The same convention, for a chat where a mention would reach nobody.
 *
 * A DM is one person and one bot. Whatever an agent writes there, no other agent's connection will
 * ever see it — Telegram and Discord both give each bot its own private conversation — so the tag
 * that is a baton in a channel is just a word here. The engine used to paper over that by re-injecting
 * the message internally, and the result was the thing this replaces: a second agent answering into a
 * conversation the user opened with the first, its progress lines, its approval prompts and its
 * unrelated tool output all arriving under a name the user was not talking to.
 *
 * So in a DM the handover goes behind the chat instead. `ask_agent` runs the other agent for real —
 * its persona, its tools, its own permissions — and hands its answer back as a tool result. The agent
 * the person is actually talking to stays the only one that speaks.
 */
export function busConventionLines(input: {
  others: string[];
  /**
   * Whether this agent actually holds `ask_agent`.
   *
   * Passed in rather than assumed, because assuming it was wrong on the first live turn: the section
   * told Nouva to call the tool, her pack enumerated its tools and did not list it, and the model
   * reasoned its way around a promise the harness had just made and could not keep. A prompt that
   * names a tool the schema does not carry is worse than one that says nothing — the model trusts it
   * and spends a turn finding out.
   */
  hasTool: boolean;
  /** Whether it holds `delegate` — the wrong door is only worth closing when it is there. Default yes. */
  hasDelegate?: boolean;
  /** Agent id → what it is for (`describePeers`). */
  about?: Record<string, string>;
}): string[] {
  if (input.others.length === 0) return [];
  const head = [
    "OTHER AGENTS",
    `- The other agents on this daemon are: ${input.others.join(", ")}. They are not in this`,
    "  conversation: this is a one-to-one chat, and nothing you write here reaches them.",
    ...purposeLines(input.others, input.about),
    // Said as plainly as possible, because the failure it prevents is invisible from the model's
    // side: it writes the tag, the message goes out, and nothing at all happens.
    "- Writing @their-name here does nothing. It is text in a message to the person you are",
    "  talking to, and no other agent will ever read it.",
  ];
  return input.hasTool
    ? [
        ...head,
        "- To hand work to one of them, call `ask_agent`. It runs them for real (their own skills,",
        "  tools and permissions) and returns what they say to YOU, not to this chat.",
        "- You are the only voice in this conversation. When `ask_agent` comes back, report the result",
        "  yourself, in your own words, and say who did the work.",
        "",
      ]
    : [
        ...head,
        // The dead end, said out loud. Without this the model goes looking — the live turn reached
        // for `delegate`, which runs a blank helper as *itself*, and reported the result as though
        // the other agent had done it.
        ...(input.hasDelegate === false
          ? ["- You have no way to reach them from this conversation. If the work genuinely needs one of", "  them, say so and let the person bring them in."]
          : [
              "- You have no way to reach them from this conversation. `delegate` is not it: that runs a",
              "  helper as YOU, not them. If the work genuinely needs one of them, say so and let the",
              "  person bring them in.",
            ]),
        "",
      ];
}
