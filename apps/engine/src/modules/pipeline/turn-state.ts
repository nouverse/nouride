/**
 * One turn's state: what it was given, what it opened, and what it has done so far — what flows between the phases of
 * `TurnRunner.runTurn` (`turn.ts`). The turn's opening phase is here too, since it is what makes the state, and the two
 * endings any phase may reach: the mission told how the turn ended, and the record closed.
 */

import {
  createLogger,
  resolveTurnDurationMs,
  type ChatMessage,
  type Gateway,
  type LoadedAgent,
  type MessageEnvelope,
  type Session,
  type SessionKey,
} from "@nouride/shared";
import { APPLIANCE_REPLY_FLUSH, TurnRecorder } from "@/modules/turns/recorder.ts";
import type { TurnJournal } from "@/modules/turns/journal.store.ts";
import type { TurnCause } from "@/modules/turns/turns.store.ts";
import type { ChatProgress } from "./chat-progress.ts";
import type { Preamble } from "./preamble.ts";
import type { TurnNudges } from "./budget-nudges.ts";
import { TurnContext } from "./turn-context.ts";
import { turnClock, type TurnClock } from "./turn-clock.ts";
import type { TurnOutcome, TurnShape } from "./turn-shape.ts";
import { editCause } from "./edit-rules.ts";
import { wakeCause } from "./job-wakes.ts";

const log = createLogger("pipeline.turn");

/** What a turn is started with: the agent, the message, its conversation and what the person wrote. */
export interface TurnGiven {
  agent: LoadedAgent;
  envelope: MessageEnvelope;
  key: SessionKey;
  /** What the person wrote, the address taken off by the caller. */
  text: string;
  /** A turn that is not a chat's — a mission's (`turn-shape.ts`): its page, its person, its parked approvals. */
  shape: TurnShape | undefined;
}

export interface TurnState extends TurnGiven {
  /** The turn's identity in the running table — one spelling, `TurnContext.turnKey`'s. */
  readonly turnKey: string;
  readonly controller: AbortController;
  /** When the turn's clock runs out — the approval gate leaves the model room to react before it. */
  readonly deadlineAt: number;
  readonly clock: TurnClock;
  readonly session: Session;
  /** What the turn starts from: the conversation so far — or, for a mission's turn, nothing but its page (MISSIONS §4). */
  readonly history: ChatMessage[];
  /** Who the turn is for: the sender — or the person who started the mission, whose level and People entry apply. */
  readonly person: { gatewayId: string; senderId: string };
  /** The message as that person's. */
  readonly asPerson: MessageEnvelope;
  readonly gateway: Gateway | undefined;
  /** What the daemon pushed this for, when nobody typed it — or the edit it answers. */
  readonly cause: TurnCause | undefined;
  /** The durable record of this turn — see `modules/turns/turns.store.ts`. */
  readonly record: TurnRecorder | undefined;
  /** Told once, however the turn ends — the mission decides its next step from it. */
  told: boolean;
  /** Closed once: the first ending that reaches the record is the one it keeps. */
  finished: boolean;
  /**
   * The message this turn is answering, once it has been composed.
   *
   * On the state because the only thing that can save it is the failure path, and the failure path is a `catch`
   * around everything that builds it. Undefined means the turn died before there was a question to keep — nothing
   * composed, nothing to lose.
   */
  asked?: ChatMessage;
  /** Opened with the question, for the same reason `asked` is on the state. */
  journal?: TurnJournal;
  /** Whether the bubble ends as a failure. */
  failed: boolean;
  /** What a compaction before the answer left, kept if the turn ends early: the summary is paid for either way. */
  upkept?: ChatMessage[];
  /** The agent's own connection, where everything it emits goes — its bubble, its typing, its words. */
  voiceGateway: Gateway | undefined;
  /** The in-chat progress line, where the connection can edit a message. */
  progress: ChatProgress | undefined;
  /** The opening line before long work (`preamble.ts`). */
  preamble: Preamble | undefined;
  /** The long reply's nudges (`budget-nudges.ts`). */
  nudges: TurnNudges | undefined;
}

/**
 * The turn's opening: its identity, its clock started and its place in the running table taken, its conversation
 * loaded, and its record begun.
 *
 * The record is opened before the cost cap is checked, so a refused turn is a row that says why rather than a message
 * that appears in one chat window and exists nowhere else. Everything after this reports into it: the steps, the
 * answer as it is written, and how it ended.
 */
export function beginTurn(ctx: TurnContext, given: TurnGiven): TurnState {
  const { agent, envelope, key, text, shape } = given;
  // One spelling, shared with `TurnContext.isBusy` — two copies of a turn's identity is two answers
  // to "is this agent working", and the guard would pass while the map said otherwise.
  const turnKey = TurnContext.turnKey(key.agentId, key.chatId, key.gatewayId);
  const controller = new AbortController();
  // A stated cap, not one derived from iterations × tool timeout — that arithmetic came to 12.5
  // minutes by default, which is long enough that the chat looks broken rather than busy.
  // The agent's own clock when it names one, the daemon's otherwise — resolved once so the
  // deadline and the timer that enforces it cannot disagree.
  const turnMs = resolveTurnDurationMs(
    agent.config.llm.maxTurnDurationMs,
    ctx.deps.config.llm.limits.maxTurnDurationMs,
  );
  const deadlineAt = Date.now() + turnMs;
  // A coding CLI's mission turn is stopped after the turn's time without a step, not after the turn's time (0.8.7).
  const clock = turnClock(turnMs, () => controller.abort(), shape !== undefined && agent.config.external !== undefined);
  ctx.activeTurns.set(turnKey, {
    controller, agentId: key.agentId, chatId: key.chatId, gatewayId: key.gatewayId,
    steers: [], steered: 0, startedAt: Date.now(), trigger: envelope,
  });

  const session = ctx.deps.sessions.load(key);
  const history = shape ? [] : session.messages;
  const person = shape?.person ?? { gatewayId: envelope.gatewayId, senderId: envelope.senderId };
  const asPerson: MessageEnvelope = shape ? { ...envelope, gatewayId: person.gatewayId, senderId: person.senderId } : envelope;
  const gateway = ctx.deps.gateways.get(envelope.gatewayId);
  // Or the edit it answers (G11): a message corrected while it waited, or an edit of one already answered.
  const cause = wakeCause(envelope) ?? editCause(envelope);
  const record = TurnRecorder.begin(ctx.deps.turns, {
    sessionId: session.id,
    agentId: agent.config.id,
    gatewayId: envelope.gatewayId,
    chatId: envelope.chatId,
    messageId: envelope.id,
    senderId: envelope.senderId,
    // What the person actually wrote. The overheard-context block and the attachment notice are the
    // harness talking, and a transcript that shows them as the question is a transcript of a
    // conversation nobody had.
    prompt: text.trim() || "(attachment)",
    // What the daemon pushed this for, when nobody typed it — the transcript's heading for it.
    ...(cause ? { cause } : {}),
    // Metadata only, and taken from the envelope rather than from what the store managed to save:
    // a file that failed to download was still *sent*, and a transcript that hides it explains
    // nothing about the answer that follows.
    ...(envelope.attachments?.length
      ? {
          attachments: envelope.attachments.map((attachment) => ({
            name: attachment.filename ?? "file",
            mimeType: attachment.mimeType,
            kind: attachment.type,
            ...(attachment.size === undefined ? {} : { bytes: attachment.size }),
            direction: "in" as const,
            // The upload path, replaced below with the durable copy once the intake has run. Kept
            // here so a turn that dies before the intake still says what arrived with it.
            ...(attachment.url ? { path: attachment.url } : {}),
          })),
        }
      : {}),
  }, ctx.deps.appliance?.() ? APPLIANCE_REPLY_FLUSH : undefined);
  return {
    ...given, turnKey, controller, deadlineAt, clock, session, history, person, asPerson, gateway, cause, record,
    told: false, finished: false, failed: false,
    voiceGateway: undefined, progress: undefined, preamble: undefined, nudges: undefined,
  };
}

/** The mission told how its turn ended, once — whichever ending gets there first. */
export function tell(turn: TurnState, outcome: TurnOutcome): void {
  if (turn.told || !turn.shape) return;
  turn.told = true;
  try {
    turn.shape.ended(outcome);
  } catch (err) {
    log.error("a shaped turn's end could not be taken in", { agent_id: turn.agent.config.id, chat_id: turn.envelope.chatId, error: String(err) });
  }
}

/** The turn's record closed, once — whichever ending gets there first. */
export function close(turn: TurnState, patch: Parameters<TurnRecorder["finish"]>[0]): void {
  if (turn.finished) return;
  turn.finished = true;
  turn.record?.finish(patch);
}
