/**
 * A turn cut off too long ago to be taken up unasked: its person is asked, once.
 *
 * A turn a restart cut off is taken up by itself only when it was cut off within the last quarter of an hour
 * (`restart-resume.ts`): a command run hours later may be stale. Past that nothing happened at all, and the person had
 * been told the work would carry on. A power cut of an hour is ordinary, and whoever was waiting does not know to say
 * "continue". So at boot each such turn's chat is told what was cut off and how long ago, and asked:
 *
 * - **Never taken up unasked.** The window stands. The question is all the daemon does by itself.
 * - **Once.** The time it was asked is on the turn's record (`turn_records.resume_asked_at`), and a turn with one is
 *   neither asked about again nor taken up by a later boot.
 * - **Not about last week.** Only a turn cut off within `ASK_WITHIN_MS`.
 * - **A conversation's, still waiting.** Not a scheduled run, which its schedule runs again; not a turn already taken
 *   up; not where something started in the chat since, because then the person has moved on.
 *
 * Where the connection carries buttons the question has one, Continue, and a press on it takes the turn up the way
 * the daemon would have inside the window. Saying "continue" does the same without one.
 */

import { createLogger, type ButtonPress, type MessageButton, type PressAnswer } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import { mayAnswer } from "@/modules/tools/approval-answerers.ts";
import { resumeQuestion, resumeSettled } from "@/modules/turns/close.ts";
import { SCHEDULED, type TurnRecord, type TurnsPort } from "@/modules/turns/turns.store.ts";
import { INBOX_FRESH_MS, INBOX_KEEP_MS } from "./inbox.store.ts";
import { isResumption, resumptionId } from "./restart-resume.ts";

const log = createLogger("pipeline");

/**
 * How long ago a turn may have been cut off and still be asked about: two days, as long as the inbox remembers a
 * chat's messages (`INBOX_KEEP_MS`). A starting value. Past it the question would be about work nobody is waiting on.
 */
export const ASK_WITHIN_MS = INBOX_KEEP_MS;

const PRESS = "carry-on:";

/** The button under the question. Its data names the turn, so a press needs nothing this process remembers. */
function continueButton(turnId: string): MessageButton {
  return { label: "Continue", data: `${PRESS}${turnId}`, style: "positive" };
}

/**
 * Whether a turn lost in a crash is one its person is asked about: cut off longer ago than the window and within
 * `ASK_WITHIN_MS`, in a chat somebody reads, and not a schedule's own.
 */
export function asksAfterCrash(turn: { agoMs: number; chatId: string; scheduled: boolean }): boolean {
  return turn.agoMs > INBOX_FRESH_MS && turn.agoMs <= ASK_WITHIN_MS && !turn.chatId.startsWith("cron:") && !turn.scheduled;
}

/**
 * The turns the last process's shutdown stopped that are asked about now: cut off longer ago than the window, and
 * everything the header says. One lost in a crash is not here: its report, written as this boot closed it, is the
 * question (`boot/durable.ts`).
 */
export function turnsToAsk(input: { turns: Pick<TurnsPort, "interruptedBetween" | "startedFor" | "startedInChatSince">; now: number }): TurnRecord[] {
  const from = input.now - ASK_WITHIN_MS;
  return input.turns.interruptedBetween(from, input.now - INBOX_FRESH_MS).filter(
    (turn) =>
      !turn.chatId.startsWith("cron:") &&
      turn.cause?.via !== SCHEDULED &&
      !isResumption(turn.messageId) &&
      !input.turns.startedFor(resumptionId(turn.id), from) &&
      // Anything begun in the chat after the cut: they wrote again, or the work went on another way.
      !input.turns.startedInChatSince(turn.gatewayId, turn.chatId, turn.endedAt ?? turn.startedAt),
  );
}

type Asker = Pick<Notifier, "ask">;

/** Say `text` in the turn's chat with Continue under it where the connection carries buttons. Whether it was said. */
export async function postWithContinue(notifier: Asker, turn: Pick<TurnRecord, "id" | "gatewayId" | "chatId">, text: string): Promise<boolean> {
  return (await notifier.ask({ gatewayId: turn.gatewayId, chatId: turn.chatId }, () => text, [continueButton(turn.id)])) !== null;
}

/**
 * Ask each turn's chat, and mark the ones that were asked: one that could not be said is asked at the next boot.
 * `onAsked` is told each question as it was said: it is no turn's reply, so the record of the chat has it nowhere else.
 */
export async function askToCarryOn(input: {
  toAsk: readonly TurnRecord[];
  turns: Pick<TurnsPort, "markResumeAsked">;
  notifier: Asker;
  onAsked: (turn: TurnRecord, question: string) => void;
  now: number;
}): Promise<number> {
  let asked = 0;
  for (const turn of input.toAsk) {
    const question = resumeQuestion(turn.prompt, input.now - (turn.endedAt ?? turn.startedAt));
    if (!(await postWithContinue(input.notifier, turn, question))) continue;
    input.turns.markResumeAsked(turn.id, input.now);
    input.onAsked(turn, question);
    asked += 1;
  }
  if (asked > 0) log.info("asked whether to carry on with turns cut off a while ago", { turns: asked });
  return asked;
}

/**
 * A press on Continue: the turn is taken up, once, for whoever may say so — in a one-to-one chat the person in it, in
 * a room the person whose turn it was or an admin, the rule an approval's buttons go by.
 */
export function continuePresses(deps: {
  turns: Pick<TurnsPort, "get" | "startedFor">;
  /** Take the turn up — `Pipeline.resumeTurn`. False where its connection is gone. */
  resume: (turn: TurnRecord) => boolean;
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
  // The shape a connection's presses are routed by (`gateways/presses.ts`), said here so this domain needs no other's type.
}): { owns(data: string): boolean; press(press: ButtonPress): Promise<PressAnswer> } {
  return {
    owns: (data) => data.startsWith(PRESS),
    async press(press: ButtonPress): Promise<PressAnswer> {
      const turn = deps.turns.get(press.data.slice(PRESS.length));
      if (!turn || turn.status !== "interrupted" || turn.gatewayId !== press.gatewayId || turn.chatId !== press.chatId) {
        return { notice: "That is not waiting any more." };
      }
      const who = { chatType: press.chatType, senderId: press.senderId, isAdmin: () => deps.isAdmin(press) };
      if (!mayAnswer(who, { requestedBy: turn.senderId ?? "" })) return { notice: "Only the person who asked for it, or an admin, can say that here." };
      // Taken up already: by an earlier press, or by the daemon inside its window.
      if (deps.turns.startedFor(resumptionId(turn.id), turn.startedAt)) return { notice: "I have carried on with that already.", settled: resumeSettled(turn.prompt, false) };
      if (!deps.resume(turn)) return { notice: `I could not pick that up from here. Say "continue" instead.` };
      log.info("taking up a turn its person asked to carry on", { turn_id: turn.id, agent_id: turn.agentId });
      return { notice: "Carrying on.", settled: resumeSettled(turn.prompt, true) };
    },
  };
}
