/**
 * A conversation, shaped for something that has to draw it.
 *
 * Two sources, and the split is chronological rather than clever. Turns recorded by `TurnsPort` carry
 * everything a reader wants — the steps in order, how long each took, what the answer was, whether it
 * is still being written. Conversations that predate the records have only their stored messages: the
 * messages, and whatever can be inferred from the tool calls stored with them.
 *
 * So the transcript is the old-style messages up to the first recorded turn, then the records. No
 * matching, no overlaying, no guessing which assistant message belongs to which turn — the two halves
 * meet at a timestamp and neither pretends to be the other.
 */

import { describeToolCall } from "@/commons/activity.ts";
import { withoutReminders } from "@/modules/llm/executor/reminders.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import type { ChatMessage } from "@nouride/shared";
import type { TurnCause } from "@nouride/wire";
import type { TurnAttachment, TurnStep, TurnView } from "./turns.store.ts";

/** One step, plus how long it took — which is the part a person reads. */
export interface StepPayload extends TurnStep {
  /**
   * Milliseconds since the previous step, or since the turn began.
   *
   * Derived here rather than stored: it is a difference between two numbers already in the row, and a
   * stored duration is a number that can disagree with them.
   */
  ms: number;
}

/**
 * A file on a turn, as a client may see it.
 *
 * `path` is deliberately absent and `url` takes its place: the browser addresses a file by its
 * position on the turn, and the daemon is the only thing that knows where it lives. A payload that
 * carried the path would let a client ask for any file this process can open — and would put the
 * host's directory layout in a browser's network tab.
 */
export interface AttachmentPayload {
  name: string;
  mimeType: string;
  kind: string;
  bytes?: number;
  direction: "in" | "out";
  /** Where to fetch it, or absent when the bytes were never saved. */
  url?: string;
}

export interface TurnPayload {
  id: string;
  agentId: string;
  /** The chat inside the conversation — what `/stop` is addressed by. */
  chatId: string;
  /** The session that owns it — what a file URL has to name. See the note in `toTurnPayload`. */
  sessionId: string;
  /**
   * Nobody typed this. The daemon started it.
   *
   * A finished background job wakes its agent by pushing a message into the conversation, and that
   * turn is recorded like any other — so without this the wake-up text (`job xyz finished with exit
   * 0…`) is drawn as though the operator had typed it. It is the harness talking, and a transcript
   * that cannot tell the difference is a transcript that attributes words to people who never said
   * them.
   */
  system?: boolean;
  /** Why the daemon started it, as data — see `TurnCause`. */
  cause?: TurnCause;
  status: TurnView["status"];
  prompt: string;
  reply: string;
  error?: string;
  model?: string;
  toolCalls: number;
  /** Model round trips — see `TurnRecord.iterations`. */
  iterations?: number;
  inputTokens?: number;
  outputTokens?: number;
  startedAt: number;
  endedAt?: number;
  /** Wall clock. Absent while the turn runs — the client has `startedAt` and a clock of its own. */
  durationMs?: number;
  /** Files sent with the question, or back by the agent. */
  attachments?: AttachmentPayload[];
  steps: StepPayload[];
}

/** One message of the earlier part `messagesToTranscript` reads back — sent as the transcript's `earlier`. */
export interface EarlierMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  steps?: { name: string; text: string; at: number }[];
}

export function toTurnPayload(view: TurnView): TurnPayload {
  return {
    id: view.id,
    agentId: view.agentId,
    chatId: view.chatId,
    /**
     * The session this turn belongs to, which the client cannot work out for itself.
     *
     * A file is served from `/sessions/:id/turns/:turnId/files/:index`, and the session in that path
     * is a permission rather than decoration — the route refuses a turn that does not belong to it.
     * A page built those URLs from the *conversation* it had open, which is one session, and in a
     * room that is one member's: every attachment from any other member 404'd and rendered as a
     * broken image. Deterministic, not the race it looked like — whichever agent was not the
     * addressable one lost every file it sent.
     */
    sessionId: view.sessionId,
    ...(view.senderId === SYSTEM_SENDER ? { system: true } : {}),
    ...(view.cause ? { cause: view.cause } : {}),
    status: view.status,
    prompt: view.prompt,
    reply: view.reply,
    ...(view.error ? { error: view.error } : {}),
    ...(view.model ? { model: view.model } : {}),
    toolCalls: view.toolCalls,
    ...(view.iterations === undefined ? {} : { iterations: view.iterations }),
    ...(view.inputTokens === undefined ? {} : { inputTokens: view.inputTokens }),
    ...(view.outputTokens === undefined ? {} : { outputTokens: view.outputTokens }),
    startedAt: view.startedAt,
    ...(view.endedAt === undefined
      ? {}
      : { endedAt: view.endedAt, durationMs: Math.max(0, view.endedAt - view.startedAt) }),
    ...(view.attachments?.length
      ? { attachments: view.attachments.map((file, index) => toAttachmentPayload(view.id, file, index)) }
      : {}),
    steps: withDurations(view.steps, view.startedAt),
  };
}

/** One file, addressed by where it sits on the turn. */
function toAttachmentPayload(
  turnId: string,
  file: TurnAttachment,
  index: number,
): AttachmentPayload {
  return {
    name: file.name,
    mimeType: file.mimeType,
    kind: file.kind,
    ...(file.bytes === undefined ? {} : { bytes: file.bytes }),
    direction: file.direction,
    ...(file.path ? { url: `turns/${encodeURIComponent(turnId)}/files/${index}` } : {}),
  };
}

/**
 * Step durations, from the timestamps already there.
 *
 * `since` is the turn's start for the first step. Without it the first step reads as instantaneous,
 * which hides the most interesting number in a slow turn: the wait before anything happened.
 */
export function withDurations(steps: TurnStep[], since: number): StepPayload[] {
  let previous = since;
  return steps.map((step) => {
    const ms = Math.max(0, step.at - previous);
    previous = step.at;
    return { ...step, ms };
  });
}

/**
 * A conversation's earlier part as the session holds it: user and assistant messages, with tool calls
 * folded into the assistant message they preceded.
 *
 * Not history from before turn records — those exist since 29ff7f7d, before the first release. It is
 * what the session's context still carries from before the oldest turn the log keeps: turns are swept
 * after `[retention] session_days`, while an active conversation keeps up to `max_conversation_turns`
 * of context, so a long one reaches further back than its turns do. The steps are inferred from what
 * was stored for the *model*, so there are no timings in it and there never will be.
 */
export function messagesToTranscript(
  messages: ChatMessage[],
  /**
   * Where the recorded turns take over.
   *
   * Both halves are needed, and the second one is not obvious. A turn's `startedAt` is *after* the
   * message that triggered it — the envelope is stamped when it arrives, the record when the turn
   * begins — so cutting on the clock alone leaves the question inside the boundary and the transcript
   * shows it twice: once as a legacy message, once as the turn's own prompt. Matching the prompt is
   * what closes that gap — at the end of the stored message, because the record stores what the
   * person wrote and the store keeps that behind whatever context was composed in front of it.
   */
  boundary?: { before: number; prompt?: string },
): EarlierMessage[] {
  const out: EarlierMessage[] = [];
  let steps: { name: string; text: string; at: number }[] = [];

  for (const message of messages) {
    const at = message.timestamp ?? 0;
    if (boundary && at >= boundary.before) break;

    // Stored as it was sent, with the turn's clock note and reminders at the end
    // (`llm/executor/reminders.ts`). A person reads what was written — and the cut below matches the
    // record's prompt at the end of the message, where those notes now are.
    const text = textOf(message.role === "user" ? withoutReminders(message) : message);
    if (message.role === "user") {
      steps = [];
      if (text.trim()) out.push({ role: "user", content: text, timestamp: at });
      continue;
    }
    if (message.role !== "assistant") continue;

    for (const call of message.toolCalls ?? []) {
      steps.push({ name: call.name, text: describeToolCall(call.name, call.arguments ?? {}), at });
    }
    if (text.trim()) {
      out.push({
        role: "assistant",
        content: text,
        timestamp: at,
        ...(steps.length > 0 ? { steps: [...steps] } : {}),
      });
      steps = [];
    }
  }

  /**
   * The one message the clock cannot exclude: the question the first recorded turn answered.
   *
   * It is stamped when it arrives and the record is stamped when the turn *begins*, so it always
   * falls just inside the boundary — and it is already on screen as that turn's prompt.
   *
   * Only the trailing one, and only if it is a user message. Matching anywhere in the list would
   * truncate a conversation at the first time somebody asked the same thing twice, which with the
   * suggested prompts in the dashboard is not hypothetical: two identical questions a week apart
   * would have hidden everything between them.
   *
   * Matched at the *end*, which is where the person's words are.
   *
   * `startsWith` was the first attempt and it only holds when nothing was composed in front of the
   * question. `composeQuestion` puts the context blocks first and the message last — the room's
   * events, then what the room said, then what the person typed — so a group conversation stored a
   * user message the record's prompt could not be a prefix of, the cut missed, and the transcript
   * showed the harness's own scaffolding as something somebody had said.
   *
   * That was visible in a dashboard room on the first message: a bubble reading "[1 thing happened in
   * this room since your last message…]" above the same question asked properly. It applies to every
   * group chat with an overheard block, and the dashboard is simply where anybody reads one.
   */
  const prompt = boundary?.prompt?.trim();
  const last = out[out.length - 1];
  if (prompt && last?.role === "user" && last.content.trim().endsWith(prompt)) out.pop();

  return out;
}

/** Content is a string on every message this daemon writes, and an array on some it reads back. */
function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
  }
  return "";
}

/**
 * Which cursor to honour.
 *
 * A sequence number means nothing without knowing which turn it counted. A client polling at step 40
 * of one turn, then answered about the *next* turn, would be handed everything after step 40 of a turn
 * that has four steps — so it would see none of them, and the live view would sit empty while the
 * agent worked. The cursor applies only when the turn matches; otherwise the answer starts at the
 * beginning, which is what a client asking about a turn it has never seen actually wants.
 */
export function resolveCursor(input: {
  /** The turn the client believes it is following. Absent on a first poll. */
  requested?: string | undefined;
  /** The turn the daemon is actually going to answer about. */
  latest: string;
  /** The client's `after`. */
  asked: number;
}): number {
  // A count with no turn named is a count of nobody knows what: the start, like a turn the client has not seen.
  if (input.requested && input.requested === input.latest) return Math.max(0, input.asked);
  return 0;
}

/**
 * The finished turns. One turn has one owner: the history, or the live view.
 *
 * Both owning it was a bug with a very visible shape. A reload asked for the transcript, got the
 * *running* turn in it, drew it as a finished exchange — `… 0 steps` and an empty answer — and then
 * suppressed the live feed because the turn was "already in the history". The page sat frozen while
 * the daemon finished the work and wrote a 2,500-character answer nobody was shown.
 */
export function historyOf(views: TurnView[]): TurnView[] {
  return views.filter((view) => view.status !== "running");
}
