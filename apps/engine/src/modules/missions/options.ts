/**
 * A mission's question that names its options — "A) …", "B) …" — answered with a button each (0.8.7). The person
 * taps one rather than typing `/mission answer msn_… B`; a free answer still works the way it always did. The options
 * are read back from the question itself when a button is pressed, so nothing is kept between the two.
 */

import type { ButtonPress, MessageButton, PressAnswer } from "@nouride/shared";
import { pressRefusal } from "./actions.ts";
import type { Missions } from "./missions.ts";
import { shortId } from "./page.ts";

export interface AnswerOption {
  key: string;
  text: string;
}

/** At most this many: a row of buttons past it is a menu nobody reads on a phone. */
const MAX_OPTIONS = 6;
const LABEL_CHARS = 40;

/**
 * One option per line — `A) …`, `A. …`, `A: …`, `(A) …`, `- **A)** …` — or numbered the same ways, `1. …`: an agent
 * numbers them as often as it letters them, and a numbered question went out with no buttons (Discord, 0.8.12).
 */
const LINE = /^[ \t]*(?:[-*][ \t]+)?\(?\*{0,2}([A-F]|[1-6])\*{0,2}[).:]\*{0,2}[ \t]+(\S[^\n]*)$/gm;
/** All on one line — `A) this, B) that, or C) neither?` — split at each marker. */
const INLINE = /(?:^|[\s(,;])\(?([A-F]|[1-6])\)[ \t]+/g;

/**
 * The options in order from A or from 1, or none: fewer than two, out of order, or letters and numbers mixed, is not a
 * choice this reads.
 */
function inOrder(found: AnswerOption[]): AnswerOption[] {
  if (found.length < 2 || found.length > MAX_OPTIONS) return [];
  const lettered = found.every((option, index) => option.key === String.fromCharCode(65 + index));
  const numbered = found.every((option, index) => option.key === String(index + 1));
  return lettered || numbered ? found : [];
}

export function optionsIn(question: string): AnswerOption[] {
  const lines = inOrder([...question.matchAll(LINE)].map((match) => ({ key: match[1]!, text: match[2]!.trim() })));
  if (lines.length > 0) return lines;
  for (const line of question.split("\n")) {
    const markers = [...line.matchAll(INLINE)];
    if (markers.length < 2) continue;
    const found = markers.map((match, index) => {
      const start = match.index! + match[0].length;
      const end = markers[index + 1]?.index ?? line.length;
      return { key: match[1]!, text: line.slice(start, end).replace(/[\s,;]*(?:or|and)?[\s,;?]*$/i, "").trim() };
    });
    const ordered = inOrder(found);
    if (ordered.length > 0) return ordered;
  }
  return [];
}

/** Mission, question (when it was asked, base 36), letter or number. */
const DATA = /^mission:answer:(msn_[A-Za-z0-9]+):([0-9a-z]+):([A-F1-6])$/;

/**
 * A button per option, naming the question it answers by when it was asked: named by the letter alone, a button left
 * under an earlier question answered the one asked after it with that one's option of the same letter.
 */
export function optionButtons(missionId: string, options: readonly AnswerOption[], askedAt: number): MessageButton[] {
  return options.map((option) => {
    const label = `${option.key}: ${option.text}`;
    return { label: label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label, data: `mission:answer:${missionId}:${askedAt.toString(36)}:${option.key}` };
  });
}

export interface OptionPressDeps {
  missions: Pick<Missions, "get" | "answer">;
  /** An admin by People: in a room, who besides the person who started it may answer. */
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
}

/** A press on an option's button — `gateways/presses.ts` routes `mission:answer:…` here. */
export class OptionPresses {
  constructor(private readonly deps: OptionPressDeps) {}

  owns(data: string): boolean {
    return data.startsWith("mission:answer:");
  }

  async press(press: ButtonPress): Promise<PressAnswer> {
    const match = DATA.exec(press.data);
    const mission = match ? this.deps.missions.get(match[1]!) : null;
    if (!match || !mission) return { notice: "That mission is no longer on record." };
    // Where it was asked, by whom it may be answered: the one rule every mission button keeps (`actions.ts`).
    const refusal = pressRefusal(mission, press, this.deps.isAdmin);
    if (refusal) return { notice: refusal };
    const id = shortId(mission.id);
    const asked = mission.answers.at(-1);
    // Its own question, not one asked after it.
    if (!asked || asked.at.toString(36) !== match[2]) return { notice: "It has asked another question since: answer that one.", settled: `❓ Mission ${id}: asked something else since.` };
    if (asked.answer !== undefined) return { notice: "That question is already answered.", settled: `❓ Mission ${id}: already answered.` };
    // Closed, stopped or waiting on something else since it asked (accepted from the chat, say): the buttons go, as an
    // action button's do (`actions.ts`), rather than staying under a question nobody can answer any more.
    if (mission.status !== "waiting" || mission.waitKind !== "input") {
      const now = mission.status === "waiting" ? `waiting for ${mission.waitKind}` : mission.status;
      return { notice: `Mission ${id} has moved on (${now}), so this question no longer waits.`, settled: `❓ Mission ${id}: moved on before this was answered (${now}).` };
    }
    const option = optionsIn(asked.question).find((one) => one.key === match[3]);
    if (!option) return { notice: "That option is not on its question.", settled: `❓ Mission ${id}: that option is not on its question.` };
    const acted = this.deps.missions.answer(mission.id, `${option.key}) ${option.text}`, press.senderName || press.senderId);
    if ("refused" in acted) return { notice: acted.refused };
    return { notice: `Answered ${option.key}.`, settled: `❓ Mission ${id}, answered by ${press.senderName || press.senderId}: ${option.key}) ${option.text}` };
  }
}
