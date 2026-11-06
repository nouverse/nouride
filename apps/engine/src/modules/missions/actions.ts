/**
 * What a person can do about a waiting mission, as buttons under its notice (0.8.7): Accept, Continue, Stop — answered
 * by the daemon, checked against who pressed. Before, every one of them was a command typed with the mission's id, and
 * on a phone the person typed `/mission accept …` into the mission's question as an answer, where it meant nothing.
 *
 * A button names the wait it was drawn for: pressed after the mission moved on — continued from the dashboard, waiting
 * on something else now — it does nothing and says so, rather than accepting a mission the person never looked at again.
 */

import type { ButtonPress, MessageButton, PressAnswer } from "@nouride/shared";
import type { Missions } from "./missions.ts";
import { optionButtons, optionsOf } from "./options.ts";
import { shortId } from "./page.ts";
import type { Mission, WaitKind } from "./types.ts";

type Verb = "accept" | "continue" | "stop";

const DATA = /^mission:do:(msn_[A-Za-z0-9]+):(accept|continue|stop):([a-z_]+)$/;

function button(mission: Pick<Mission, "id">, verb: Verb, kind: WaitKind, label: string, style?: MessageButton["style"]): MessageButton {
  return { label, data: `mission:do:${mission.id}:${verb}:${kind}`, ...(style ? { style } : {}) };
}

/**
 * The buttons for what a mission waits on. A question has its options' buttons instead (`options.ts`), and an approval
 * the prompt's own; a limit, a loop or a cut-off call can go on, be accepted as it stands, or end.
 */
function actionButtons(mission: Pick<Mission, "id" | "startedAt">, kind: WaitKind): MessageButton[] {
  switch (kind) {
    case "accept":
      // Continue and Stop too, as the dashboard has them (0.8.10): a review that could not judge it left the owner with
      // Accept alone in the chat, where sending it back to be reviewed again meant typing the command.
      return mission.startedAt === null
        ? [button(mission, "accept", kind, "Start it", "positive"), button(mission, "stop", kind, "Drop it", "negative")]
        : [button(mission, "accept", kind, "Accept", "positive"), button(mission, "continue", kind, "Continue"), button(mission, "stop", kind, "Stop", "negative")];
    case "limit":
    case "stuck":
      return [button(mission, "continue", kind, "Continue"), button(mission, "accept", kind, "Accept as it is", "positive"), button(mission, "stop", kind, "Stop", "negative")];
    case "unknown_outcome":
      return [button(mission, "continue", kind, "Continue"), button(mission, "stop", kind, "Stop", "negative")];
    case "retry":
      return [button(mission, "continue", kind, "Retry now"), button(mission, "stop", kind, "Stop", "negative")];
    case "input":
    case "approval":
      return [];
  }
}

/**
 * The buttons under what a waiting mission tells its chat — the wait's notice, the proposal's, the follow-up hours later:
 * a question's options, else what can be done about the wait. None where nothing waits, or nothing can be tapped.
 */
export function buttonsFor(mission: Pick<Mission, "id" | "status" | "waitKind" | "answers" | "startedAt">): MessageButton[] | undefined {
  if (mission.status !== "waiting" || !mission.waitKind) return undefined;
  const asked = mission.waitKind === "input" ? mission.answers.at(-1) : undefined;
  const options = asked ? optionsOf(asked) : [];
  const buttons = asked && options.length > 0 ? optionButtons(mission.id, options, asked.at) : actionButtons(mission, mission.waitKind);
  return buttons.length > 0 ? buttons : undefined;
}

/** Where a mission's buttons may be pressed, and by whom — its chat, and in a room the person who started it or an admin. */
export function pressRefusal(mission: Pick<Mission, "chatId" | "startedBy">, press: Pick<ButtonPress, "gatewayId" | "chatId" | "chatType" | "senderId">, isAdmin: (who: { gatewayId: string; senderId: string }) => boolean): string | null {
  if (mission.chatId !== press.chatId) return "That mission does not report to this chat.";
  if (press.chatType !== "dm" && mission.startedBy !== press.senderId && !isAdmin(press)) return "Only the person who started this mission, or an admin, can answer it.";
  return null;
}

export interface ActionPressDeps {
  missions: Pick<Missions, "get" | "accept" | "continueMission" | "stop">;
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
}

const DONE: Record<Verb, string> = { accept: "accepted", continue: "told to go on", stop: "stopped" };

/** A press on a mission's action button — `gateways/presses.ts` routes `mission:do:…` here. */
export class ActionPresses {
  constructor(private readonly deps: ActionPressDeps) {}

  owns(data: string): boolean {
    return data.startsWith("mission:do:");
  }

  async press(press: ButtonPress): Promise<PressAnswer> {
    const match = DATA.exec(press.data);
    const mission = match ? this.deps.missions.get(match[1]!) : null;
    if (!match || !mission) return { notice: "That mission is no longer on record." };
    const refusal = pressRefusal(mission, press, this.deps.isAdmin);
    if (refusal) return { notice: refusal };
    const verb = match[2] as Verb;
    const id = shortId(mission.id);
    if (mission.status !== "waiting" || mission.waitKind !== match[3]) {
      const now = mission.status === "waiting" ? `waiting for ${mission.waitKind}` : mission.status;
      return { notice: `Mission ${id} has moved on (${now}), so this button no longer applies.`, settled: `Mission ${id}: moved on before this was answered (${now}).` };
    }
    const who = press.senderName || press.senderId;
    const as = { gatewayId: press.gatewayId, senderId: press.senderId };
    const acted = verb === "accept" ? this.deps.missions.accept(mission.id, who, as) : verb === "continue" ? this.deps.missions.continueMission(mission.id, who, undefined, as) : this.deps.missions.stop(mission.id, who);
    if ("refused" in acted) return { notice: acted.refused };
    const what = verb === "accept" && mission.startedAt === null ? "started" : DONE[verb];
    return { notice: `Mission ${id} ${what}.`, settled: `Mission ${id}: ${what} by ${who}.` };
  }
}
