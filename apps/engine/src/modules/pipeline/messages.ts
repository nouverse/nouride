/**
 * Pure text: what the daemon says when the model, the queue or the platform leaves a gap.
 *
 * Every function here is a function of its arguments and nothing else — no config, no gateway, no
 * clock. That is deliberate: these are the strings a person actually reads, they get reworded often,
 * and each rewording has been driven by someone misreading the previous one. Testable in isolation
 * is the point.
 */

import type { DropReason } from "@nouride/queue";
import {
  type ApprovalRequest,
  type Attachment,
  type AudioRefPart,
  clip,
  type ImageRefPart,
  type MessageContent,
  type MessageEnvelope,
  plural,
  type TakenSecret,
} from "@nouride/shared";
import { duration } from "@/modules/jobs/wake-text.ts";

/**
 * Under an answer whose requests went without this chat's `/effort` level, because the model refused it (0.8.17): once,
 * with the answer that met it (`ModelOverrides.refused`). Only what was sent: a model that takes the level and ignores
 * it cannot be told apart, so nothing here says the model now thinks harder or less.
 */
export function effortRefusedNote(refusal: { effort: string; model: string }): string {
  return `\`${refusal.model}\` refused effort \`${refusal.effort}\`, so it is sent none. \`/effort default\` clears this chat's level.`;
}

/**
 * The user message for a turn: what was said, and what the room said before it.
 *
 * The case that needs the most care is the one with **no text at all**. `@Nouva` on its own is how a
 * person points at the message above — the tag *is* the request — and until the Discord adapter stopped
 * dropping it, that arrived here as an empty string. An empty user message is not something to send to a
 * provider, and it is not something a model can act on either.
 *
 * So the harness says what happened, in one line, deterministically. Two variants because there are two
 * situations and telling them apart is the whole value: with the room replayed the tag has something to
 * point at, and without it the only honest move is to ask. The note also has to *override* the group
 * block's own "do not answer these" — that instruction is right when there is a question underneath it
 * and exactly wrong when the replayed messages are all the agent has.
 */
export function composeQuestion(params: {
  text: string;
  overheard: string;
  /**
   * What happened *to* the room since this agent last spoke — see `chat-events/format.ts`.
   *
   * Its own parameter rather than concatenated into `overheard` by the caller, because the two
   * blocks carry different labels and the order between them is a decision this function owns:
   * events first, then the chatter. What changed about the room is the frame for what was said in
   * it, and reading them the other way round means re-reading the chatter once the frame arrives.
   */
  events?: string;
  hasAttachments: boolean;
  /**
   * The line in front of what was said when it is a person's edit of a message already answered (`edit-rules.ts`),
   * after the room's blocks, so it reads as part of the question it frames.
   */
  edit?: string;
  /**
   * What the handles in it stand for (`secretsNote`) — in front of the words that hold them, as every block composed
   * into a question is: the person's words stay last, which is where the dashboard finds them (`messagesToTranscript`).
   */
  secrets?: string;
  /**
   * Who is asking, in a room (`speakerName`): their words are written `Name: …`, the same shape as the room's lines above
   * them, so the question is never read as the last background line going on. Absent in a DM, where there is one person.
   */
  speaker?: string;
  /**
   * What the thread this conversation is in was started from (`threadOpenerNote`), on its first question only — before
   * everything else, because it is what the whole thread is about.
   */
  opener?: string;
}): string {
  // Every block, in that order, with whatever is present.
  const context = [params.opener, params.events, params.overheard].filter(Boolean).join("\n\n");
  const typed = params.text.trim();
  const words = typed && params.speaker ? `${params.speaker}: ${typed}` : typed;
  const worded = words && params.edit ? `${params.edit}\n${words}` : words;
  const said = worded && params.secrets ? `${params.secrets}\n\n${worded}` : worded;
  if (said) return context ? `${context}\n\n${said}` : said;

  // A photo with no caption is not a bare tag: `attachmentNotice` describes it, and that is the message.
  if (params.hasAttachments) {
    const sent = params.speaker ? `${params.speaker} sent this:` : "";
    return [context, sent].filter(Boolean).join("\n\n");
  }

  const note = params.overheard
    ? "(You were tagged with no words. The tag is pointing at the messages above: read them and respond to what is actually being asked, rather than treating them as background.)"
    : "(You were tagged with no words, and there is nothing before it to go on. Say hello and ask what they need.)";

  return context ? `${context}\n\n${note}` : note;
}

/** How much of a thread's opening message a first question carries — the gist, not a pasted document. */
const OPENER_CHARS = 2_000;

/**
 * The line a thread's first question opens with (0.7.24): the message the thread was started from, and who wrote it —
 * `name` is theirs by `[[people]]` (`speakerName`), the platform's display name otherwise.
 */
export function threadOpenerNote(opener: { name: string; text: string; where?: string | undefined }): string {
  const text = opener.text.trim();
  const said = clip(text, OPENER_CHARS, OPENER_CHARS);
  return `[This thread was started from a message${opener.where ? ` in ${opener.where}` : ""} by ${opener.name}: ${said}]`;
}

/**
 * The question before the files sent with it are in: its words, and those files by name. What a turn's journal
 * opens with, before the downloads — thirty seconds a file — so a crash among them closes a turn with its question
 * instead of leaving a record with nothing behind it. The composed question replaces it once there is one; a turn
 * taken up from this one is told what never arrived, and can ask for it again.
 */
export function arrivingQuestion(text: string, attachments: MessageEnvelope["attachments"]): string {
  const said = composeQuestion({ text, overheard: "", hasAttachments: Boolean(attachments?.length) });
  if (!attachments?.length) return said;
  const names = attachments.map((attachment) => attachment.filename ?? attachment.type).join(", ");
  const note = `[Sent with this message, and still arriving when this was written: ${names}. If they are not in this conversation, ask for them again.]`;
  return said ? `${said}\n\n${note}` : note;
}

/**
 * What the model is told about the credentials taken out of a message (`chat-secrets.ts`): which handle stands for
 * what, and the one way to use one. With the message rather than in the system prompt — there only where a handle is,
 * and stored with it, so a turn reading the message back later still knows what the handle is.
 *
 * `ownShell`, for a coding CLI's turn (0.8.11, RFC Part C §C.6): its commands run in its own shell, whose environment
 * is the one its process started with, so a handle there is empty — a CLI told the exec line sent
 * `Authorization: Bearer ` with nothing after it. What does reach it is a credential kept with `secret_save`: the CLI is
 * started again with it at the agent's next turn (`ExternalAgents.connection`).
 */
export function secretsNote(taken: readonly TakenSecret[] | undefined, options: { ownShell?: boolean } = {}): string {
  if (!taken?.length) return "";
  const list = taken.map((secret) => `${secret.handle} (${secret.label})`).join(", ");
  const handle = taken[0]!.handle;
  const head = `[The daemon took ${plural(taken.length, "a credential", "credentials")} out of the message below before you saw it: ${list}. `;
  if (options.ownShell) {
    return (
      head +
      `The handle does not reach your own shell: your commands run with the environment your CLI started with, so "${handle}" is empty there. ` +
      "Where the person wants it used, keep it under a name with secret_save: it is in your commands' environment from your next turn on. " +
      "You never see the value. Each handle lasts an hour. Keep one only if the person asks you to.]"
    );
  }
  return (
    head +
    `In an exec command the handle is the credential: the shell expands "${handle}" to its value from the environment, so ` +
    `\`curl -H "Authorization: Bearer ${handle}" …\` works. You never see the value, and output that prints it comes back masked. ` +
    "Each lasts an hour. Keep one under a name with secret_save only if the person asks you to.]"
  );
}

/**
 * What the model sees: the quoted message, then what the person actually wrote.
 *
 * Quoted lines are marked with `> ` so the two cannot be confused — "what about this?" and the
 * message it points at are different claims, and a model that merges them answers the wrong one.
 */
export function withQuotedContext(envelope: MessageEnvelope, text: string): string {
  const quoted = envelope.quotedText?.trim();
  if (!quoted) return text;

  const attribution = envelope.quotedSender ? `[${envelope.quotedSender}]: ` : "";
  const block = `> ${attribution}${quoted.replace(/\n/g, "\n> ")}`;
  return text.trim() ? `${block}\n\n${text}` : block;
}

/**
 * The command a request was about, short enough to sit in a wake-up line.
 *
 * `exec` is the case that matters — an operator reading "the exec call" learns nothing, and the agent
 * needs to know *which* one it is being handed back. Anything else falls back to nothing rather than
 * dumping a JSON blob into the prompt.
 */
export function describeApprovalParams(request: Pick<ApprovalRequest, "params">): string {
  const argv = request.params?.command;
  // A command arrives as argv or as one line for the shell — the same call either way.
  const line = typeof argv === "string" ? argv : Array.isArray(argv) && argv.every((part) => typeof part === "string") ? argv.join(" ") : null;
  if (line !== null) {
    return `\`${clip(line, 200, 200)}\``;
  }
  const path = request.params?.path;
  return typeof path === "string" ? `\`${path}\`` : "";
}

export function mergeEnvelopes(base: MessageEnvelope, next: MessageEnvelope): MessageEnvelope {
  const texts = [base.text, next.text].filter((t) => t && t.trim().length > 0);
  const uniqueTexts = Array.from(new Set(texts));
  const mergedText = uniqueTexts.join("\n\n");

  // Each file keeps the message it came with: its ref is that message's, not the burst's (`Attachment.from`).
  const attachments = [...withOrigin(base), ...withOrigin(next)];
  const mentions = Array.from(new Set([...(base.mentions ?? []), ...(next.mentions ?? [])]));

  // An edit is of one message: the several a burst became are not an edit of it.
  const { edit: _edit, ...rest } = base;
  return {
    ...rest,
    id: next.id,
    mergedIds: [...(base.mergedIds ?? []), base.id],
    timestamp: next.timestamp,
    text: mergedText || base.text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    mentionsSelf: base.mentionsSelf || next.mentionsSelf,
    // Outside content in either is outside content in the one they became.
    ...(base.forwarded || next.forwarded ? { forwarded: true } : {}),
    // And a handle in either stands for what it did (`chat-secrets.ts`).
    ...(base.secrets || next.secrets ? { secrets: [...(base.secrets ?? []), ...(next.secrets ?? []).filter((secret) => !base.secrets?.some((had) => had.handle === secret.handle))] } : {}),
    ...outsideOf({ outsideContent: [...(base.outsideContent ?? []), ...(next.outsideContent ?? [])] }),
  };
}

function withOrigin(envelope: MessageEnvelope): Attachment[] {
  return (envelope.attachments ?? []).map((attachment, position) => (attachment.from ? attachment : { ...attachment, from: { message: envelope.id, position } }));
}

/**
 * What a message's own text carried from outside, named for the record a memory write after it carries: a
 * forwarded message — the platform's word for it — and what the engine named where it built the message.
 */
export function outsideOf(envelope: Pick<MessageEnvelope, "forwarded" | "outsideContent">): { outsideContent?: string[] } {
  const named = [...new Set([...(envelope.forwarded ? ["a forwarded message"] : []), ...(envelope.outsideContent ?? [])])];
  return named.length > 0 ? { outsideContent: named } : {};
}

/**
 * What to say when a turn ends with nothing to say.
 *
 * Written to be actionable rather than apologetic: the sender can usually fix this, but only if they
 * are told what actually happened.
 *
 * The previous version guessed, and the guess was wrong in the case that mattered. Any turn with a
 * tool call in it was reported as "most likely an approval timed out or was denied" — printed live to
 * a Discord channel after twenty-two tool calls that had all succeeded, with no approval anywhere in
 * the turn. It sent the operator to `nouride approvals`, which showed an empty queue, which read as
 * the daemon being broken in some second way.
 *
 * So `aborted` is passed in rather than inferred. It is the one fact that separates "ran out of time
 * — and anything it was waiting on died with it" from "the model genuinely returned nothing", and
 * those two need different next steps from the reader.
 */
export function emptyTurnMessage(
  stopReason: string,
  toolCalls: number,
  aborted: boolean,
  approvalsRefused: number,
): string {
  if (aborted) {
    /**
     * An approval is named only when one was actually refused.
     *
     * The previous wording said "anything I was waiting on — an approval, a long command — went with
     * it" on every timeout, and an operator read that as the agent having asked something they never
     * saw. It had not: that turn made sixteen tool calls against a slow remote host and simply ran
     * out of clock. Third time this message has misdescribed a turn by guessing at its cause, which is
     * why the count is threaded through from the executor rather than inferred here.
     */
    return approvalsRefused > 0
      ? "I ran out of time on that one and stopped part-way, and an approval I was waiting on expired " +
          "with it. Ask me again and I will pick it up, or `/status` to see where I am."
      : "I ran out of time on that one and stopped part-way. It was still working, not stuck on you. " +
          "Ask me again and I will pick it up, or `/status` to see where I am.";
  }
  if (stopReason === "length") {
    return "I ran out of room before I could answer. Try asking for a smaller piece of it.";
  }
  if (toolCalls > 0) {
    return (
      "I did the work but came back with nothing to say, which is a fault on my side rather than " +
      "yours. Ask me what I found and I will summarize it."
    );
  }
  return "I did not manage to produce an answer for that. Try rephrasing, or `/status` to check my state.";
}

/**
 * What to say when a message never reached the handler.
 *
 * Names the cause and what to do about it. "Something went wrong" would be worse than the silence it
 * replaces: at least silence does not claim to be an explanation.
 */
export function droppedNotice(reason: DropReason): string | null {
  if (reason === "timeout") {
    return (
      "I never got to your last message: it waited behind the one before it for too long and was " +
      "dropped. Send it again and I will pick it up."
    );
  }
  if (reason === "queue_full") {
    return (
      "Messages are arriving faster than I can answer them, so some of the older ones were dropped. " +
      "Resend anything I have not replied to."
    );
  }
  // `duplicate` is the same message the sender already sent; `shutdown` means the gateways are
  // already closing and the notice would not reach anyone.
  return null;
}

/**
 * A question about something recent or changing in the world, to an agent that can search: search first.
 *
 * The harness says it (CHECK BEFORE YOU ANSWER); this is the same rule next to the question, where a
 * model deep into a conversation still weighs it. Worded as a condition, because the words that
 * trigger it ("hari ini", "harga") also turn up in ordinary chat, and there it should cost nothing.
 *
 * Not for a question naming Nouride: that is answered from the `nouride` tool, and the harness says so —
 * a reminder that sent it to the web would point the wrong way.
 */
const WEB_CHECK =
  "(If this is about something recent or changing in the world, such as news, prices, releases, schedules, scores or weather, check with `web_search` before you answer, and answer from what it returns: what you know is older than today.)";

const RECENT = /\b(latest|newest|news|today|this week|price|prices|release[sd]?|weather|score|stocks?|exchange rate|terbaru|terkini|berita|hari ini|minggu ini|harga|kurs|rilis|cuaca|skor|saham)\b/i;

/**
 * Reminders for one turn: short notes placed after the message being answered.
 *
 * The harness block states the rules once, at the top of a long prompt, and a model deep into a
 * conversation weighs what it read last. A rule that keeps losing there can be restated here, next
 * to the question it applies to. The executor appends these to what it sends (`withReminders`), and
 * the session keeps the message as it was sent so the next turn's request repeats it byte for byte —
 * `llm/executor/reminders.ts` says why, and what keeps them out of what a person reads.
 *
 * Each reminder is triggered by the message itself and cheap to decide — no model call. Add one only
 * for a rule that a live turn showed the prompt alone does not hold.
 */
export function turnReminders(text: string, tools: { name: string }[], helpers?: { running: readonly RunningHelper[]; now: number }): string[] {
  const reminders: string[] = [];
  if (tools.some((tool) => tool.name === "web_search") && RECENT.test(text) && !/\bnou(ride|gate)\b/i.test(text)) reminders.push(WEB_CHECK);
  const working = helpers ? helpersNote(helpers.running, helpers.now) : null;
  if (working) reminders.push(working);
  return reminders;
}

/** A helper still working in the background, as the next turn in its conversation is told about it. */
export interface RunningHelper {
  id: string;
  goal: string;
  startedAt: number;
}

/**
 * What is still working in the background for this conversation, on every turn while it does (0.7.15).
 *
 * "Before starting one, check what is already running" is a rule the harness can state and only this can make
 * answerable without a round trip: the harness is cached and cannot list what changes by the minute, and a model asked
 * to look would call a tool to find out. It also answers "how is it going?" with what is true — running, for this long,
 * no result yet — rather than with a guess. Nothing is said when nothing runs.
 */
function helpersNote(running: readonly RunningHelper[], now: number): string | null {
  if (running.length === 0) return null;
  const list = running.map((helper) => `${helper.id} "${helper.goal}" (${duration(Math.max(0, now - helper.startedAt))} so far)`).join("; ");
  return (
    `(Still working in the background for you: ${list}. Each one's result comes to you as a message of its own when ` +
    `it finishes. Do not start the same work again, and do not say what it found before it reports.)`
  );
}

/**
 * One message's content: the text, and the pictures and voice notes that came with it.
 *
 * A plain string when there are none, and that is not laziness — a one-element parts array
 * changes the bytes of every request for nothing, and several OpenAI-compatible servers handle the
 * two shapes differently.
 */
export function composeContent(text: string, media: readonly (ImageRefPart | AudioRefPart)[]): MessageContent {
  if (media.length === 0) return text;
  return [{ type: "text" as const, text }, ...media];
}
