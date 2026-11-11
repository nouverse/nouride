/**
 * How a chat turn ends before it finished.
 *
 * Whatever ends it — `/stop`, a provider error after its retries, the deadline, a shutdown stopping it at a
 * step or aborting it — what it did is folded into the conversation (`TurnContext.closeUnfinished`), its
 * record is closed with the status that says why, and its person is told what they need: nothing after
 * their own `/stop`; the error, and that the work is kept, after a failure; what finished and what was cut
 * off, after a restart.
 */

import type { ChatMessage, MessageButton, MessageEnvelope, SessionKey } from "@nouride/shared";
import { interruptionReport, keptSentence, retrySentence, type ClosedTurn, type InterruptCause } from "@/modules/turns/close.ts";
import { INBOX_FRESH_MS } from "./inbox.store.ts";
import type { TurnJournal } from "@/modules/turns/journal.store.ts";
import type { FinishTurn } from "@/modules/turns/turns.store.ts";
import type { ChatProgress } from "./chat-progress.ts";
import { continueButton } from "./resume-ask.ts";
import { RESTARTING, STOPPED_BY_PERSON, type TurnContext } from "./turn-context.ts";
import { handToButtons } from "./way-on.ts";

/**
 * Why the turn's signal says it ended — or the error, when nothing aborted it.
 *
 * An aborted turn is not a failure — somebody pressed stop, the deadline was reached, or the daemon is
 * going down — and a transcript that files them under one status cannot tell you which of your turns you
 * killed.
 */
export function causeOf(signal: AbortSignal, message: string): InterruptCause {
  if (signal.reason === STOPPED_BY_PERSON) return { kind: "stopped" };
  if (signal.reason === RESTARTING) return { kind: "restart" };
  if (signal.aborted) return { kind: "deadline" };
  return { kind: "error", message };
}

export async function endEarly(
  ctx: TurnContext,
  input: {
    key: SessionKey;
    history: ChatMessage[];
    asked: ChatMessage | undefined;
    journal: TurnJournal | undefined;
    cause: InterruptCause;
    envelope: MessageEnvelope;
    agentId: string;
    /** The turn's record, so what it tells its person is tracked like an answer (`boot/delivery.ts`). */
    turnId: string | undefined;
    /** What the person typed — a restart's report quotes it. */
    prompt: string;
    /** The error as the person is told it, after a failure. */
    message?: string;
    /** What the record keeps for an operator. */
    error: string;
    close: (patch: FinishTurn) => void;
    progress: ChatProgress | undefined;
    /** A provider that failed for a while, not one that refused: the turn is tried again — `provider-resume.ts`. */
    retryable?: boolean;
  },
): Promise<void> {
  // Scheduled before the turn closes, so the person is told in the same message that it will be tried again.
  const retrying =
    input.cause.kind === "error" &&
    input.retryable === true &&
    input.turnId !== undefined &&
    ctx.resumeLater?.({ id: input.turnId, agentId: input.agentId, gatewayId: input.envelope.gatewayId, chatId: input.envelope.chatId, prompt: input.prompt, messageId: input.envelope.id }) === true;
  // Work another agent handed over, ended with nobody to take it up: the room is offered a way on (`way-on.ts`).
  const wayOn = !retrying && wayOnFor(ctx, input);
  const told = (ending: ClosedTurn): string =>
    input.cause.kind === "restart"
      ? // The daemon is going down and cannot know for how long: what it says holds either way (`restart-resume.ts`).
        interruptionReport(ending, input.prompt, { kind: "if-soon", withinMs: INBOX_FRESH_MS })
      : retrying
        ? [withoutRetryAdvice(input.message), retrySentence(ending)].filter(Boolean).join(" ")
        : [input.message, keptSentence(ending), wayOn ? HAND_ON_WORDS : null].filter(Boolean).join(" ");
  const status = input.cause.kind === "restart" ? "interrupted" : input.cause.kind === "error" ? "failed" : "cancelled";
  const closed = ctx.closeUnfinished(input, (ending) => {
    // The promise as data on the turn, beside the words that make it: what the boot after a restart reads.
    input.close({ status, reply: told(ending), error: input.error, ...(retrying ? { retryPromised: true as const } : {}) });
    // Owed until it lands, like an answer — after `/stop` nothing is sent, so nothing is owed.
    if (input.cause.kind !== "stopped") ctx.awaitDelivery(input.turnId);
  });
  // `/stop` used to be followed by the agent reporting its own cancellation as an error. Nobody needs to
  // be told twice that the thing they stopped stopped.
  if (input.cause.kind === "stopped") return;
  await input.progress?.beforeAnswer("failed");
  // A restart's report is the agent's own account of its work; an error is the daemon speaking. Either is
  // what the person is waiting to hear, so one that never lands is sent after the restart.
  const delivered = (): void => ctx.markDelivered(input.turnId);
  if (wayOn && input.turnId) ctx.waysOn.offer(input.turnId);
  if (await ctx.voice.reply(input.envelope, told(closed), input.cause.kind === "restart" ? input.agentId : undefined, { onDelivered: delivered, ...(wayOn ? { buttons: wayOn } : {}) })) delivered();
}

/** Said with the buttons, and instead of them where a connection has none. */
const HAND_ON_WORDS = "Or tag another agent to hand it on.";

/**
 * Continue and Hand to, for a turn in a room that one of our agents' hand-overs began and that a failure or its
 * deadline ended: nobody is waiting on it the way a person waits on their own question, so the room is asked.
 * Null for any other turn, which says what it always said.
 */
function wayOnFor(
  ctx: TurnContext,
  input: { cause: InterruptCause; envelope: MessageEnvelope; agentId: string; turnId: string | undefined },
): MessageButton[] | null {
  const ended = input.cause.kind === "error" || input.cause.kind === "deadline";
  // A bot's message that got a turn is one of our agents': a stranger's bot never does (`classifyInbound`).
  const handedOver = input.envelope.senderIsBot === true || input.envelope.fromAgent !== undefined;
  if (!ended || !input.turnId || !handedOver || input.envelope.chatType === "dm") return null;
  const others = (ctx.otherAgentsFor(input.agentId, input.envelope)?.names ?? []).map((id) => ({ id, name: ctx.deps.registry.get(id)?.config.displayName || id }));
  return [continueButton(input.turnId), ...handToButtons(input.turnId, others)];
}

/** A provider error's own "try again", dropped where the daemon says in the same breath that it will. */
function withoutRetryAdvice(message: string | undefined): string | undefined {
  return message?.replace(/\s*(Give me a moment and try again|Try again shortly)\.\s*$/, "");
}
