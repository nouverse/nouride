/**
 * Taking up a turn a restart cut off — once, and only soon after.
 *
 * A turn the daemon stopped for a restart, or lost in a crash, is closed with what it did and its chat is
 * told (`modules/turns/close.ts`). That used to be where it ended: nothing ran again until somebody said
 * "continue", which for work left running overnight meant the morning. Now the daemon says it for them once
 * the gateways are up, on the conditions a person would want:
 *
 * - **Soon after.** Cut off within the last quarter of an hour — `INBOX_FRESH_MS`, the window the inbox
 *   answers late messages in. A daemon down for longer was stopped on purpose, or something is wrong, and
 *   work that dies with it is what should happen.
 * - **Once.** The turn that takes it up is marked — `resume:<turn>` as its message id — and a turn so marked
 *   is not taken up again: one that crashes the daemon would otherwise restart it for ever.
 * - **A conversation's.** A cron run has a schedule and a record of its own.
 */

import { type ApprovalRequest, clip, type MessageEnvelope, oneLine } from "@nouride/shared";
import { cutLine, type CutCall, type CutKind } from "@/modules/turns/cut-calls.ts";
import { SCHEDULED, type TurnRecord, type TurnsPort } from "@/modules/turns/turns.store.ts";
import { SYSTEM_SENDER } from "./deps.ts";
import { INBOX_FRESH_MS } from "./inbox.store.ts";
import { describeApprovalParams } from "./messages.ts";

const RESUME_PREFIX = "resume:";

/** A turn this boot found in its journal: cut off when the last thing in it happened. */
interface Recovered {
  turnId: string;
  kind: "chat" | "job";
  report: string | null;
  cutAt: number;
}

/** Which turns to take up: cut off within the window, a conversation's, and not themselves a resumption. */
export function turnsToResume(input: {
  recovered: readonly Recovered[];
  turns: Pick<TurnsPort, "get" | "interruptedSince" | "startedFor">;
  now: number;
}): TurnRecord[] {
  const since = input.now - INBOX_FRESH_MS;
  const found = new Set(input.recovered.map((turn) => turn.turnId));
  // Stopped by the last process's shutdown, which closed them as it stopped them…
  const stopped = input.turns.interruptedSince(since).filter((turn) => !found.has(turn.id));
  // …or lost in a crash, which this boot closed just now — so the cut is the journal's last moment, not now.
  const lost = input.recovered
    .filter((turn) => turn.kind === "chat" && turn.report !== null && turn.cutAt >= since)
    .flatMap((turn) => input.turns.get(turn.turnId) ?? []);
  return [...stopped, ...lost].filter(
    (turn) =>
      turn.status === "interrupted" &&
      !turn.chatId.startsWith("cron:") &&
      // A job's own turn in the chat whose history it keeps: the schedule runs it again, nobody asked it in words.
      turn.cause?.via !== SCHEDULED &&
      !isResumption(turn.messageId) &&
      // Taken up already, by a boot before this one in the same quarter of an hour: two restarts in a row
      // would otherwise take the same turn up twice.
      !input.turns.startedFor(`${RESUME_PREFIX}${turn.id}`, since),
  );
}

/** A turn that was itself taking another up — `resume:<turn>` as its message id. Never taken up again. */
export function isResumption(messageId: string | null | undefined): boolean {
  return messageId?.startsWith(RESUME_PREFIX) === true;
}

/** What cut a turn off: the daemon restarting, or its model provider failing for longer than a retry rides out. */
export type ResumeWhy = "restart" | "provider";

/** The call a restart cut the turn off in, read for what it may have done (`turns/cut-calls.ts`). */
export type Cut = { kind: CutKind; call: CutCall };

/**
 * What the agent is told: what it was doing, and to carry on — checking what was cut off before repeating it. With
 * `waiting`, the approvals it was cut off waiting on, which the restart kept and asked again (D8): the same call made
 * again waits on that question (`approvals-kept.ts`), so it is told to make it rather than to ask in words.
 */
export function restartResumeEnvelope(
  turn: Pick<TurnRecord, "id" | "agentId" | "gatewayId" | "chatId" | "prompt">,
  platform: MessageEnvelope["gateway"],
  chatType: MessageEnvelope["chatType"],
  why: ResumeWhy = "restart",
  waiting: readonly Pick<ApprovalRequest, "tool" | "params">[] = [],
  cut?: Cut,
): MessageEnvelope {
  const quoted = clip(oneLine(turn.prompt), 200);
  const open = waiting.map((request) => `\`${request.tool}\`${describeApprovalParams(request) ? ` ${describeApprovalParams(request)}` : ""}`);
  const kept = open.length
    ? ` The approval you were waiting on (${open.join("; ")}) is still open, and has been put in front of them again. If it ` +
      "is still needed, make that same call again: it waits for their answer instead of asking twice."
    : "";
  const what =
    why === "restart"
      ? `The daemon restarted while you were working on "${quoted}", and it is back.${cut ? ` ${cutLine(cut)}` : ""}${kept}`
      : `Your model provider failed while you were working on "${quoted}", and it has had a few minutes to recover.`;
  return {
    id: `${RESUME_PREFIX}${turn.id}`,
    timestamp: Date.now(),
    gateway: platform,
    gatewayId: turn.gatewayId,
    chatId: turn.chatId,
    chatType,
    senderId: SYSTEM_SENDER,
    senderName: "Nouride",
    // In a room, naming the agent is what routes this to the one that was working.
    mentions: [turn.agentId],
    text:
      `[system] ${what} What you had done, and what was cut off, is in the conversation above. Carry on from ` +
      "where you stopped: check what a cut-off step did before you repeat it. If the work is already done, or " +
      "something said since has changed what is wanted, say so in one line instead.",
    raw: { via: `${why} resumed`, turn: turn.id },
  };
}
