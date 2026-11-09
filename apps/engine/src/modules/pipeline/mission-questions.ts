/**
 * What the agent's own missions in this chat are waiting for the person to answer, said beside the person's message.
 *
 * A mission's question goes to the chat it reports to, and says "reply to this in your own words" (`missions/notices.ts`):
 * the reply reaches the agent, which answers the mission for the person. But the agent's turn was not told a question
 * was waiting. Nix's mission asked Sam for three keys; Sam sent them in Nix's chat, and Nix began "the key you just
 * sent is the same as before" — a repeat, not the answer its mission was waiting for (2026-11-02).
 */

import { clip } from "@nouride/shared";
import type { Mission } from "@/modules/missions/types.ts";

/** At most this much of a question in the note: the whole is on the mission's page. */
const QUESTION_CHARS = 600;
/** Missions named at most — a chat with more waiting is rare, and the rest are on `/mission`. */
const MOST = 3;

export function missionQuestions(missions: readonly Mission[], agentId: string, tools: readonly { name: string }[]): string[] {
  const work = tools.some((tool) => tool.name === "work");
  return missions
    .filter((mission) => mission.agentId === agentId && mission.status === "waiting" && mission.waitKind === "input")
    .flatMap((mission) => {
      const open = [...mission.answers].reverse().find((entry) => entry.answer === undefined);
      if (!open?.question.trim()) return [];
      const question = open.question.trim();
      const shown = clip(question, QUESTION_CHARS, QUESTION_CHARS);
      const pass = work
        ? `pass the answer on with work (action "answer", id ${mission.id}) and say that you did`
        : `tell them to send it with /mission answer ${mission.id} <answer> (you cannot pass it on)`;
      return [
        `[Your mission ${mission.id} is waiting for this person's answer to its question: "${shown}" If this message ` +
          `answers it, ${pass}: it is the answer the mission asked for, not a repeat.]`,
      ];
    })
    .slice(0, MOST);
}
