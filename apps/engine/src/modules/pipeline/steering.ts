/**
 * Steering: what a person sends while their agent is working is read by that turn at its next step, rather
 * than waiting behind it — `[queue] steer`.
 *
 * Never mid-step. What is running — a tool, a model call — finishes; the message is put in front of the model
 * before its next call, after the round's tool results, so the turn adjusts while it is still doing the work.
 * A turn writing its last answer has no next call, so a message that comes then is not lost: it starts the
 * next turn the moment this one ends (`TurnContext.releaseTurn`). The same if a turn is stopped or the daemon
 * goes down — the inbox still holds the message, so a restart answers it.
 *
 * Two doors, because whose a message is gets settled at two different times:
 *
 * - **A one-to-one chat** steers on arrival (`steerTarget`), before the queue: the person is the only one the
 *   turn could be for.
 * - **A room** steers after routing (`whileBusy`, from `inbound.ts`), which is where it is first known which
 *   agent a message is for. Only the person who started the turn, and only when they addressed the agent —
 *   anybody else is told the agent is busy (`busyNotice`), once, instead of being refused in silence.
 */

import { type ChatMessage, clipTrimmed, type MessageEnvelope, oneLine } from "@nouride/shared";
import { formatDuration } from "@/modules/hooks/format.ts";
import { isSystemEvent, type PipelineDeps } from "./deps.ts";
import { isEdit, steerEditHeader } from "./edit-rules.ts";
import { secretsNote, withQuotedContext } from "./messages.ts";
import type { ActiveTurn } from "./turn-context.ts";

/** Messages one turn reads before the next ones wait for it to finish: a turn rewritten more is a conversation. */
export const STEER_CAP = 5;

/** What the person is told at once, so nobody waits in silence for a step to end. */
export const STEER_ACK = "↪ Got it, I'll read that before my next step.";

/**
 * The same, for a coding CLI that takes nothing into a running prompt (0.8.10): it reads it when that prompt ends. It
 * was told "before my next step" too, and read it hours later.
 */
export const STEER_ACK_AFTER_PROMPT = "↪ Got it, I'll read that once what I'm running now ends.";

/**
 * How words taken into an agent's turn reach it: its model's next step; its coding CLI's running prompt, where the CLI
 * takes one (`external-agents/steering.ts`); or once that prompt ends.
 */
export function steerReach(deps: Pick<PipelineDeps, "registry" | "externalAgents">, agentId: string): "next_step" | "into_cli" | "after_prompt" {
  if (!deps.registry.get(agentId)?.config.external) return "next_step";
  return deps.externalAgents?.steersMidPrompt?.(agentId) ? "into_cli" : "after_prompt";
}

/** "Got it", as true for this agent. */
export function steerAck(deps: Pick<PipelineDeps, "registry" | "externalAgents">, agentId: string): string {
  return steerReach(deps, agentId) === "after_prompt" ? STEER_ACK_AFTER_PROMPT : STEER_ACK;
}

/** The same, for an edit of a message they sent (G11): what they changed is what the turn goes by from its next step. */
export const STEER_ACK_EDIT = "↪ Got your edit, I'll go by it from my next step.";

/**
 * The same, while the turn waits on an approval in this chat: its next step is after the answer, and a "yes"
 * typed as a message must not read as one — an approval is answered with /approve or /deny.
 */
export const STEER_ACK_PARKED = "↪ Got it, I'll read that once the approval waiting here is answered: /approve or /deny.";

/**
 * In a room, without the commands: a bare /approve there is not certain to reach the agent that asked, and the
 * approval's own message says how to answer it.
 */
export const STEER_ACK_PARKED_ROOM = "↪ Got it, I'll read that once the approval waiting here is answered.";

/** A person's `tell` to a mission (0.8.10), put in front of its turn as a steer is — not a chat message. */
export function isTell(envelope: Pick<MessageEnvelope, "raw">): boolean {
  return (envelope.raw as { via?: unknown } | null | undefined)?.via === "tell";
}

/** Words only: a file or a picture is a message of its own, and is answered as one. */
const wordsOnly = (envelope: MessageEnvelope): boolean =>
  envelope.text.trim().length > 0 && (envelope.attachments?.length ?? 0) === 0;

/** The turn at work in this one-to-one chat that a person's message in words is for — whether or not it reads more. */
function workingFor(turns: Iterable<ActiveTurn>, envelope: MessageEnvelope, isCommand: (text: string) => boolean): ActiveTurn | null {
  if (envelope.chatType !== "dm" || isSystemEvent(envelope) || envelope.senderIsBot) return null;
  // A command is answered at once anyway.
  if (!wordsOnly(envelope) || isCommand(envelope.text)) return null;
  const working = [...turns].filter((turn) => turn.steers && turn.gatewayId === envelope.gatewayId && turn.chatId === envelope.chatId);
  return working.length === 1 ? working[0]! : null;
}

/** Read all it will: `STEER_CAP` messages read or waiting. */
const full = (turn: ActiveTurn): boolean => (turn.steered ?? 0) + turn.steers!.length >= STEER_CAP;

/** The turn this message steers — the one at work in its one-to-one chat — or null for the ordinary way. */
export function steerTarget(turns: Iterable<ActiveTurn>, envelope: MessageEnvelope, isCommand: (text: string) => boolean): ActiveTurn | null {
  const turn = workingFor(turns, envelope, isCommand);
  return turn && !full(turn) ? turn : null;
}

/**
 * That turn once it has read all it will (`STEER_CAP`). The message waits for it to end, as it always did — and its
 * sender is told so once, rather than left in silence for up to `queue_timeout_ms` (P9, `steer-accept.ts`).
 */
export function cappedTarget(turns: Iterable<ActiveTurn>, envelope: MessageEnvelope, isCommand: (text: string) => boolean): ActiveTurn | null {
  const turn = workingFor(turns, envelope, isCommand);
  return turn && full(turn) ? turn : null;
}

/**
 * What becomes of a message for an agent already at work in this chat, asked once routing has said whose it is.
 *
 * - `steer`: read by the turn at its next step. The person who started that turn, in words, addressed to the
 *   agent — in a room anybody else steering it would be answering a question for somebody who did not ask.
 * - `tell`: refused, and the sender is told the agent is busy and with what. Once per person per turn, so a
 *   busy agent does not become a noisy one.
 * - `quiet`: refused without a word, as before. A message that did not address the agent — a room with one bot
 *   hands it everything said there, most of it people talking to each other — one whose sender was already
 *   told, and the daemon's own events.
 */
export function whileBusy(
  turn: ActiveTurn | undefined,
  envelope: MessageEnvelope,
  o: {
    /** Named, tagged, or a reply to something it said — not merely overheard. A one-to-one chat always is. */
    addressed: boolean;
    /** A person, not another agent handing over: an agent does not rewrite another one's turn. */
    fromPerson: boolean;
    /** `[queue] steer`. */
    steer: boolean;
  },
): "steer" | "tell" | "quiet" {
  if (!turn || !o.addressed || isSystemEvent(envelope)) return "quiet";
  const started = turn.trigger;
  const starter = Boolean(envelope.senderId) && started !== undefined && !isSystemEvent(started) && started.senderId === envelope.senderId;
  if (o.steer && o.fromPerson && starter && turn.steers && wordsOnly(envelope) && (turn.steered ?? 0) + turn.steers.length < STEER_CAP) {
    return "steer";
  }
  return turn.told?.has(envelope.senderId) ? "quiet" : "tell";
}

/**
 * What the sender is told: who is busy, on what, for how long, and that this message was not taken. Written by
 * the daemon, so it is the same every time and costs no model call.
 *
 * Safe to say in a room, which is what most of this is for:
 *
 * - **The quote wakes nobody.** The router reads `@name` and a leading `name:` in a bot's message the way it
 *   does in a person's, so an `@` in the quoted request would hand the notice to whoever it named — and a
 *   platform's own mention markup would ping them. Both are taken out, and the line never starts with a name.
 * - **It quotes only what was said here.** The turn is this agent's in this chat, and an `ask_agent` turn is
 *   never counted as one, so the request quoted is one this room already saw.
 * - **Not the daemon's own words.** A turn the daemon started — taking up work a restart cut off, a job's
 *   result — would quote "[system] …"; that one says only how long.
 * - **No `/stop`.** It pauses the agent in every chat, not this turn, and is not the advice a stranger in a
 *   room should be handed.
 */
export function busyNotice(
  agent: { id: string; displayName: string },
  turn: ActiveTurn | undefined,
  o: {
    parked: boolean;
    now?: number;
    /** The message was kept and waits for the turn — a one-to-one chat past `STEER_CAP` — rather than refused. */
    queued?: boolean;
  },
): string {
  const started = turn?.trigger;
  const about = started && !isSystemEvent(started) ? quoted(started.text, [agent.id, agent.displayName]) : "";
  const since = turn?.startedAt === undefined ? "" : ` (${formatDuration(Math.max(0, Math.round(((o.now ?? Date.now()) - turn.startedAt) / 1000)))} so far)`;
  const waiting = o.parked ? ", and is waiting for an approval here" : "";
  const then = o.queued ? "this message waits for it, and is answered next" : "ask again once it's done";
  return `⏳ ${inert(agent.displayName || agent.id)} is still working${about ? ` on "${about}"` : ""}${since}${waiting}: ${then}.`;
}

/** At most this much of the request, on one line. */
const QUOTE_MAX = 80;

/** The request as a short, inert quote: its address off, nobody's name made into a mention, one line. */
function quoted(text: string, names: readonly string[]): string {
  return clipTrimmed(oneLine(inert(unaddressed(text, ...names))), QUOTE_MAX);
}

/** Without what makes text a mention: `@name`, and the platforms' `<@123>` markup. */
function inert(text: string): string {
  return text.replace(/<[@#!][^>\s]*>/g, "").replace(/@(?=[\p{L}\p{N}_])/gu, "");
}

/**
 * The words without the agent's name in front. A one-to-one chat needs no address, but the dashboard's and
 * the CLI's connection puts `<agent>: ` before what was typed so a room can route it, and the model read it
 * as part of the message. In a room, the `@nouva` a person addressed it with.
 */
export function unaddressed(text: string, ...names: string[]): string {
  const alternatives = names.filter(Boolean).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (alternatives.length === 0) return text;
  // `@nouva`, with or without a colon after it, or `nouva:` — never a bare name, which is "Nouva is right".
  const name = `(?:${alternatives.join("|")})`;
  return text.replace(new RegExp(`^\\s*(?:@${name}(?![\\p{L}\\p{N}_-])\\s*[:,]?|${name}\\s*[:,])\\s*`, "iu"), "");
}

/**
 * What the model reads: that it came while it worked, from whom, and the words — one user message for them all.
 * `names` are the agent's, taken off the front of each: the buffer keeps a message as it arrived, because one no
 * turn read becomes the agent's next turn as an ordinary message would (`TurnContext.returned`).
 *
 * An edit (G11) is a block of its own, after the rest, framed as what it is: a correction of the message the turn is
 * working on when `own` says so — its question, or one it read — or a change to one sent earlier.
 */
export function steerMessage(
  envelopes: readonly MessageEnvelope[],
  names: readonly string[] = [],
  replied: readonly string[] = [],
  own: (messageId: string) => boolean = () => false,
  /** The turn is a coding CLI's, whose own shell no handle reaches (`secretsNote`, 0.8.11). */
  options: { ownShell?: boolean } = {},
): ChatMessage {
  const who = envelopes[0]?.senderName?.trim() || "The person";
  // With what its handles stand for in front, and the message it replies to, as a turn's own question has them
  // (`secretsNote`, `withQuotedContext`): "I mean you yourself", sent as a reply to the progress line, says nothing alone.
  const words = (envelope: MessageEnvelope) =>
    [secretsNote(envelope.secrets, options), withQuotedContext(envelope, unaddressed(envelope.text, ...names).trim())].filter(Boolean).join("\n\n");
  const plain = envelopes.filter((envelope) => !isEdit(envelope) && !isTell(envelope));
  // A mission's `tell` (0.8.10): followed, as the person's word over the goal's details — never a new goal, which the page
  // holds. Said as "how to do the work" and nothing more, a model took a changed detail for a changed result and spent
  // fifteen calls finding out whether to ask (live, 2026-10-30).
  const told = envelopes
    .filter(isTell)
    .map(
      (envelope) =>
        `[${envelope.senderName?.trim() || "A person"} told this mission while you were working. Read it before your next step and follow it: it is the word of the person the mission works for, and it wins over the details of the goal. The checks still decide when it is done: if following it would fail them, or it asks for different work altogether, say so with \`mission\` action "ask".]\n${envelope.text.trim()}`,
    );
  // What the agent already told them (`steer-reply.ts`) — a guess, written in a second or two before this step read the
  // message, so this step goes by their words and corrects it rather than keeping to it. Handed over as "do what you said" (0.8.7, live), a line
  // that read "I mean you yourself" as being about a mission sent the turn to look into a mission nobody asked about.
  // In the header line, which the step the dashboard shows leaves out: it quotes only what the person wrote.
  const answered = replied.length
    ? ` A quick reply went to them in your name before you read this: ${replied.map((line) => `"${line}"`).join(" ")}. ` +
      "It was a guess at what they meant, written in a second or two from the conversation, your last few steps and this message, " +
      "not a promise. Go by their words: if the guess misread them, say so and do what they actually asked."
    : "";
  // A question in it is answered, not only acted on: said as what it may do to the work, "btw, is the artifacts work
  // pushed?" sent to Claude Code mid-turn was looked into — it checked the mission — and its reply never said (live, Nix,
  // 2026-10-31).
  const blocks = [
    ...told,
    ...(plain.length > 0
      ? [`[${who} sent this while you were working. Read it before your next step: it may add to, change or stop what you are doing. If it asks you something, answer it in your reply.${answered}]\n${plain.map(words).join("\n\n")}`]
      : []),
    ...envelopes
      .filter(isEdit)
      .map((edit, index) => `[${steerEditHeader(who, edit, own(edit.edit!.of))}${plain.length === 0 && index === 0 ? answered : ""}]\n${words(edit)}`),
  ];
  return { role: "user", content: blocks.join("\n\n"), timestamp: Date.now() };
}
