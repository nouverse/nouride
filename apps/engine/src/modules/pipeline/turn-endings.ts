/**
 * How a chat turn ends before it finished.
 *
 * Whatever ends it — `/stop`, a provider error after its retries, the deadline, a shutdown stopping it at a
 * step or aborting it — what it did is folded into the conversation (`TurnContext.closeUnfinished`), its
 * record is closed with the status that says why, and its person is told what they need: nothing after
 * their own `/stop`; the error, and that the work is kept, after a failure; what finished and what was cut
 * off, after a restart.
 */

import type { ChatMessage, MessageEnvelope, SessionKey } from "@nouride/shared";
import { interruptionReport, keptSentence, retrySentence, type ClosedTurn, type InterruptCause } from "@/modules/turns/close.ts";
import type { TurnJournal } from "@/modules/turns/journal.store.ts";
import type { FinishTurn } from "@/modules/turns/turns.store.ts";
import type { ChatProgress } from "./chat-progress.ts";
import { RESTARTING, STOPPED_BY_PERSON, type TurnContext } from "./turn-context.ts";

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
  const told = (ending: ClosedTurn): string =>
    input.cause.kind === "restart"
      ? interruptionReport(ending, input.prompt)
      : retrying
        ? [withoutRetryAdvice(input.message), retrySentence(ending)].filter(Boolean).join(" ")
        : [input.message, keptSentence(ending)].filter(Boolean).join(" ");
  const status = input.cause.kind === "restart" ? "interrupted" : input.cause.kind === "error" ? "failed" : "cancelled";
  const closed = ctx.closeUnfinished(input, (ending) => {
    input.close({ status, reply: told(ending), error: input.error });
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
  if (await ctx.voice.reply(input.envelope, told(closed), input.cause.kind === "restart" ? input.agentId : undefined, { onDelivered: delivered })) delivered();
}

/** A provider error's own "try again", dropped where the daemon says in the same breath that it will. */
function withoutRetryAdvice(message: string | undefined): string | undefined {
  return message?.replace(/\s*(Give me a moment and try again|Try again shortly)\.\s*$/, "");
}
