/**
 * A line in the agent's own words in place of the "↪ Got it" a steered message gets — `[queue] steer_reply`.
 *
 * "Got it" is the daemon's: instant, the same every time, and true whatever happens next. This is the agent's:
 * "siap, abis exec ini gw ganti ke DB staging" — what it means to do with the message, in the person's language,
 * a second or two later, written over "Got it" where the connection can rewrite a message and under it where it
 * cannot. "Got it" never waits on a model, and a reply that fails or is late is simply not written: the person was
 * already told their message was taken.
 *
 * Cheap, and in the conversation: the agent's persona (IDENTITY and SOUL, cut short) so it sounds like itself, the
 * sender's notes from People (what to call them, how they like to be spoken to), the conversation so far, cut short
 * (`aside-context.ts`), then the request the turn is working on, its last few steps, the message they replied to, and
 * the new message: a few thousand tokens in and one sentence out. Run beside the turn, never in its way. Without the
 * conversation it read "yg ini bisa ga sih kita akalim supaya diinstall armbian", a question about a TV box, as one
 * about Nouride's own OS, and the turn said so a step later (live, 2026-11-05). So it sees what `/btw` sees.
 *
 * A turn quicker than its reply: the moment the turn reads the message, answers, or ends, the call is aborted
 * (`ActiveTurn.replyAbort`) — what the turn does with the message is the answer then, and a line arriving after it
 * would promise what is already done or settled. The same for a reply past `steer_reply_timeout_ms`, even from a
 * server that ignores the abort. A coding CLI's turn, which would take the message the moment no tool call is open,
 * waits for the line instead (`external-agents/steering.ts`).
 *
 * What it said is put in front of the model with the message (`steerMessage`) — as a guess to correct where it
 * misread them, never as a promise to keep: it was written in a second or two, before the turn read the message. It
 * is not stored as a message
 * of the conversation: the turn's next step is where the message is really answered. The dashboard draws it from
 * the turn's record (`steer-accept.ts`).
 */

import { clipTrimmed, createLogger, helperModel, type ChatParams, type LLMProvider, type MessageEnvelope, oneLine, type TokenUsage } from "@nouride/shared";
import { meter } from "@/modules/llm/metered.ts";
import { conversationSoFar } from "./aside-context.ts";
import { isSystemEvent } from "./deps.ts";
import { unaddressed } from "./steering.ts";
import type { ActiveTurn, TurnContext } from "./turn-context.ts";

const log = createLogger("pipeline.steering");

/**
 * Room for one sentence — and for a reasoning model's thinking before it, which counts against the same ceiling.
 * At 120, found live on a box running Gemini through Nougate, nothing was ever said: the line is cut on the way
 * out (`LINE_MAX`) whatever the model writes, so the ceiling only has to leave the answer room to exist.
 */
const MAX_TOKENS = 1024;
/** Steps shown, newest last: enough to say "after this one", not a transcript. */
const STEPS = 4;
/** Cut to this, on the way in and the way out. */
const LINE_MAX = 280;
/** Of the persona: who the agent is and how it talks, which is what one sentence needs of it. */
const PERSONA_MAX = 4000;
/** Of the sender's notes: what to call them and how, which comes first in any notes worth keeping. */
const NOTES_MAX = 1500;
/** Of the conversation, the newest kept: what "this one" and "that" in their message point at, for one sentence. */
const CONVERSATION_MAX = 6000;

export interface SteerReplyInput {
  provider: LLMProvider;
  model: string;
  agentName: string;
  /** IDENTITY and SOUL, as written. */
  persona: string;
  /** Who sent it: the person People matched, or the name the platform gives. */
  sender: string;
  /** Their notes in People, when they are somebody it knows. */
  senderNotes?: string;
  /** The conversation before this turn, as lines (`conversationSoFar`); empty in one just begun. */
  conversation: string;
  /** The request the turn is working on, or empty for one the daemon started. */
  working: string;
  /** The turn's steps so far, oldest first. */
  steps: readonly { kind: string; text: string }[];
  /** What they just sent. */
  said: string;
  /** The message theirs replies to, when the platform says (`MessageEnvelope.quotedText`), and who wrote it. */
  repliedTo?: { text: string; sender?: string };
  /** `[queue] steer_reply_timeout_ms`. */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The request: who the agent is and what it was told not to do, then the turn and the message. */
function steerReplyParams(input: Omit<SteerReplyInput, "provider" | "timeoutMs">): ChatParams {
  const steps = input.steps
    .filter((step) => step.kind === "tool" || step.kind === "tool_done" || step.kind === "note")
    .slice(-STEPS)
    .map((step) => `- ${clipTrimmed(oneLine(step.text), 160)}`);
  const persona = input.persona.trim().slice(0, PERSONA_MAX);
  return {
    model: input.model,
    system:
      (persona ? `${persona}\n\n---\n\n` : "") +
      `You are ${input.agentName}, in the middle of a task. ${input.sender} just sent you a message, and you will ` +
      "act on it at your next step. Right now, reply with ONE short sentence saying what you will do with it, " +
      "in their language, their register and the voice described above, like a colleague answering without stopping work. " +
      'Never say it is done, never answer a question with facts you have not checked, and do not start with "Got it" or ' +
      "a greeting: that was already said. If they asked you to stop, say you will stop after the current step. " +
      // Read with the conversation, and still not certain: "I mean you yourself" read as being about a mission once
      // (0.8.7, live), and the turn took the guess for its plan.
      "Read their message in the light of the conversation and the task. If what they mean is still not clear, do not guess at it: " +
      "say you will look at it properly at your next step." +
      (input.senderNotes?.trim() ? `\n\nAbout ${input.sender}, from your notes:\n${input.senderNotes.trim().slice(0, NOTES_MAX)}` : ""),
    messages: [
      {
        role: "user",
        content: [
          input.conversation ? `The conversation before this task:\n${input.conversation}` : "",
          input.working ? `Working on: ${clipTrimmed(oneLine(input.working), LINE_MAX)}` : "Working on a task you started yourself.",
          steps.length ? `Latest steps:\n${steps.join("\n")}` : "",
          // What a reply points at — without it, "this one" or "you" in their message is a guess.
          input.repliedTo?.text.trim()
            ? `Their message replies to this one${input.repliedTo.sender ? ` from ${input.repliedTo.sender}` : ""}: "${clipTrimmed(oneLine(input.repliedTo.text), 1000)}"`
            : "",
          `Their message: ${clipTrimmed(oneLine(input.said), 1000)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    maxTokens: MAX_TOKENS,
    ...(input.signal ? { signal: input.signal } : {}),
  };
}

/** The sentence, or why there is none: the model failed, ran late, or said nothing. */
async function steerReply(
  input: SteerReplyInput,
  onUsage?: (usage: TokenUsage, model: string) => void,
): Promise<{ line: string } | { line: null; why: string }> {
  const signal = AbortSignal.any([AbortSignal.timeout(input.timeoutMs), ...(input.signal ? [input.signal] : [])]);
  try {
    const response = await input.provider.chat(steerReplyParams({ ...input, signal }));
    onUsage?.(response.usage, response.model);
    // A server, or a fetch, that finished anyway: late is late.
    if (signal.aborted) return { line: null, why: `no answer within ${input.timeoutMs} ms, or the turn moved on` };
    const line = clipTrimmed(oneLine(response.text.replace(/^["“']|["”']$/g, "")), LINE_MAX);
    return line ? { line } : { line: null, why: `the model said nothing (stop: ${response.stopReason})` };
  } catch (err) {
    return { line: null, why: signal.aborted ? `no answer within ${input.timeoutMs} ms, or the turn moved on` : String(err) };
  }
}

/** Who sent it, as People knows them when it does — the name and notes the turn itself would be given. */
function senderOf(ctx: TurnContext, envelope: MessageEnvelope): { sender: string; senderNotes?: string } {
  const person = ctx.personFor(envelope);
  const sender = person?.name || envelope.senderName?.trim() || "The person";
  return person?.notes ? { sender, senderNotes: person.notes } : { sender };
}

/**
 * Ask for the line and hand it to `answer`, which says it where "Got it" was said. Fire and forget: nothing here is
 * awaited by the message's path, and a turn that ends, or reads the message, before the line is ready gets none — a
 * reply the model never saw could promise what its next step does not do.
 *
 * One at a time per turn: messages sent while a line is being written get "Got it" alone.
 */
export function replyToSteer(ctx: TurnContext, turn: ActiveTurn, envelope: MessageEnvelope, answer: (line: string) => Promise<unknown>): void {
  const queue = ctx.deps.config.queue;
  if (!queue.steerReply || turn.replying) return;
  const agent = ctx.deps.registry.get(turn.agentId);
  if (!agent) return;
  turn.replying = true;
  const abort = new AbortController();
  turn.replyAbort = abort;
  void (async () => {
    try {
      const names = [agent.config.id, agent.config.displayName];
      const started = turn.trigger && !isSystemEvent(turn.trigger) ? unaddressed(turn.trigger.text, ...names) : "";
      const provider = agent.config.llm.provider;
      const startedAt = Date.now();
      const reply = await steerReply(
        {
          provider: ctx.deps.providers.get(provider),
          // A model, or a tier of the agent's (0.8.0); empty is the agent's own.
          model: helperModel(queue.steerReplyModel, agent.config.llm, ctx.deps.config.llm.defaults) || agent.config.llm.model,
          agentName: agent.config.displayName || agent.config.id,
          persona: [agent.persona.identity, agent.persona.soul ?? ""].join("\n\n"),
          ...senderOf(ctx, envelope),
          conversation: conversationSoFar(ctx.deps.sessions.load({ agentId: turn.agentId, gatewayId: turn.gatewayId, chatId: turn.chatId }).messages, CONVERSATION_MAX),
          working: started,
          steps: stepsSoFar(ctx, turn),
          said: unaddressed(envelope.text, ...names),
          ...(envelope.quotedText?.trim()
            ? { repliedTo: { text: envelope.quotedText, ...(envelope.quotedSender ? { sender: envelope.quotedSender } : {}) } }
            : {}),
          timeoutMs: queue.steerReplyTimeoutMs,
          signal: AbortSignal.any([turn.controller.signal, abort.signal]),
        },
        // The steered turn's, so a reply in the agent's words is counted with the turn it spoke for.
        meter(ctx.deps.usage, { agentId: agent.config.id, provider, purpose: "steer_reply", ...(turn.recordId ? { turnId: turn.recordId } : {}) }),
      );
      const at = { agent_id: agent.config.id, chat_id: turn.chatId, ms: Date.now() - startedAt };
      // Said once per steered message, because nothing else shows why a "Got it" stood alone.
      // Moved on — read the message, answered or ended — is the turn being quick, not the reply failing.
      if (reply.line === null) return abort.signal.aborted ? log.info("steering reply dropped: the turn moved on first", at) : log.warn("no steering reply", { ...at, why: reply.why });
      // Still waiting to be read, by a turn still at work — otherwise the line would answer for a step it cannot shape.
      if (turn.answered || !turn.steers?.includes(envelope)) return log.info("steering reply too late to send", at);
      (turn.replied ??= []).push(reply.line);
      await answer(reply.line);
      log.info("steering reply sent", at);
    } catch (err) {
      log.warn("steering reply not sent", { error: String(err) });
    } finally {
      turn.replying = false;
      if (turn.replyAbort === abort) delete turn.replyAbort;
    }
  })();
}

/**
 * What the turn has done so far, as it is recorded (`turns.stepsSince`) — a helper's and a peer's steps among them. The
 * in-memory activity window it read before 0.7.8 kept sixty rows per chat and took a "thinking" line every three
 * seconds of generation, so after three minutes it held no tool step at all. A turn with no record — no store, or an
 * insert that failed — has nothing to speak for, and the reply says only what it was told.
 */
function stepsSoFar(ctx: TurnContext, turn: ActiveTurn): readonly { kind: string; text: string }[] {
  return turn.recordId && ctx.deps.turns ? ctx.deps.turns.stepsSince(turn.recordId) : [];
}
