/**
 * The answers a mission's question offers to pick from, a button each (0.8.7): the person taps one rather than typing
 * `/mission answer msn_… B`, and a free answer still works the way it always did.
 *
 * The agent names them, as the `mission` tool's `options`; nothing reads them out of the question's words (0.8.22).
 * Read from its lines since 0.8.7, numbered ones too since 0.8.12, the four steps Nix numbered for the owner to follow
 * went out as four buttons above the question it actually asked ("on the charger or not?"), where a tap would have
 * answered it with a step (live, 2026-11-07). A numbered list is as often what to do as what to choose, and no rule
 * over the words tells them apart.
 */

import { type ButtonPress, clip, type MessageButton, type PressAnswer } from "@nouride/shared";
import { pressRefusal } from "./actions.ts";
import type { Missions } from "./missions.ts";
import { shortId } from "./page.ts";
import type { Answered } from "./types.ts";

export interface AnswerOption {
  key: string;
  text: string;
}

/** At most this many: a row of buttons past it is a menu nobody reads on a phone. */
export const MAX_OPTIONS = 6;
const LABEL_CHARS = 40;

function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * The question as the person reads it: its options listed under it, lettered as their buttons are. Where a chat has no
 * buttons the list is how they are seen, a typed "B" names one, and the agent reads its own question back with them.
 */
export function withOptions(question: string, options: readonly string[]): string {
  return options.length === 0 ? question : `${question.trim()}\n\n${options.map((text, index) => `${letter(index)}) ${text}`).join("\n")}`;
}

/** A question's options, lettered from A: none for a free answer, or one asked before the agent named them. */
export function optionsOf(asked: Pick<Answered, "options">): AnswerOption[] {
  return (asked.options ?? []).map((text, index) => ({ key: letter(index), text }));
}

/**
 * Mission, question (when it was asked, base 36), letter. A number is a button drawn before 0.8.22 from a numbered
 * line: pressed now, it finds no option on its question and its buttons go, rather than reading as a mission no longer
 * there.
 */
const DATA = /^mission:answer:(msn_[A-Za-z0-9]+):([0-9a-z]+):([A-F1-6])$/;

/**
 * A button per option, naming the question it answers by when it was asked: named by the letter alone, a button left
 * under an earlier question answered the one asked after it with that one's option of the same letter.
 */
export function optionButtons(missionId: string, options: readonly AnswerOption[], askedAt: number): MessageButton[] {
  return options.map((option) => {
    const label = `${option.key}: ${option.text}`;
    return { label: clip(label, LABEL_CHARS), data: `mission:answer:${missionId}:${askedAt.toString(36)}:${option.key}` };
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
    const option = optionsOf(asked).find((one) => one.key === match[3]);
    if (!option) return { notice: "That option is not on its question: answer it in your own words.", settled: `❓ Mission ${id}: that option is not on its question. Answer it in your own words.` };
    const acted = this.deps.missions.answer(mission.id, `${option.key}) ${option.text}`, press.senderName || press.senderId);
    if ("refused" in acted) return { notice: acted.refused };
    return { notice: `Answered ${option.key}.`, settled: `❓ Mission ${id}, answered by ${press.senderName || press.senderId}: ${option.key}) ${option.text}` };
  }
}
