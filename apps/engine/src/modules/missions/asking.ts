/**
 * A mission's question for its person, from the moment it is asked.
 *
 * `ask` used to be kept until the turn's end: the chat was told then, and the mission waited. A mission on a model ends
 * a turn every step or two, so that was at once. A coding CLI's mission is one turn of hours, and a mission with work
 * left that did not depend on the answer had one way to ask and go on: `send_message`, which put its question in a chat
 * nobody had open, and left the mission "running" with nothing to say it had asked.
 *
 * So the question leaves when it is asked. As before the turn then ends and the mission waits. With `keep_working` the
 * turn goes on instead: the mission stays at work with its question open, its person is told it works on meanwhile, and
 * their answer is handed to the running turn the way a `tell` is (`person.ts` `answerMission`). A turn that ends with
 * the question still open leaves the mission waiting for it, said once. One question is open at a time.
 */

import { clip, createLogger, hoursAndMinutes } from "@nouride/shared";
import { carryWait } from "./carry.ts";
import type { MissionsDeps } from "./deps.ts";
import { ANSWERS_KEPT, SAME_QUESTION } from "./limits.ts";
import type { Missions } from "./missions.ts";
import { asksMeanwhileNotice, finishedWaitsNotice, needsYouNotice, nowWaitsNotice, paged } from "./notices.ts";
import { buttonsOf, withOptions } from "./options.ts";
import { isFinal, type Answered, type Mission } from "./types.ts";

const log = createLogger("missions");

/** How an answer given while the turn is at work reaches it: `MissionsDeps.answerReach`. */
export type AnswerReach = "next_step" | "into_cli" | "after_prompt";

/**
 * What an `ask` led to: sent, with how an answer will reach the turn; refused, in words for the agent; or, the same
 * question a third time in a row, not sent again, with why the mission is stuck.
 */
export type Asked = { asked: string; meanwhile: boolean; reach: AnswerReach | null } | { refused: string } | { stuck: string };

/**
 * The question it asked that nobody has answered: one asked since questions leave at the call, or the one a mission of
 * an earlier version is waiting on. Not an old unanswered line of a mission doing something else, which no notice ever
 * carried: the third of three alike used to be kept on the record of a mission that was then stuck, never sent.
 */
export function openQuestion(mission: Pick<Mission, "answers" | "status" | "waitKind">): Answered | null {
  const last = mission.answers.at(-1);
  if (!last || last.answer !== undefined || isFinal(mission.status)) return null;
  return last.asked !== undefined || (mission.status === "waiting" && mission.waitKind === "input") ? last : null;
}

export class Asking {
  /** The same question asked again in a row, by mission. In memory: a restart starts the count again, as it always did. */
  private readonly repeats = new Map<string, number>();

  constructor(
    private readonly missions: Pick<Missions, "now" | "wait">,
    private readonly deps: MissionsDeps,
  ) {}

  /** Missions whose repeated questions it counts: `Missions.tables`. */
  entries(): number {
    return this.repeats.size;
  }

  /** A person said to go on, or the mission ended: its count of questions alike starts again. */
  forget(id: string): void {
    this.repeats.delete(id);
  }

  /** `ask` from inside a turn: the question to its chat now, with its options' buttons. `meanwhile`: the turn goes on. */
  ask(mission: Mission, asked: { question: string; options: readonly string[]; meanwhile: boolean }): Asked {
    const now = this.missions.now();
    const open = openQuestion(mission);
    if (open) {
      return {
        refused:
          `Your last question has no answer yet (asked ${hoursAndMinutes(Math.max(0, now - open.at))} ago): "${clip(open.question.trim(), 300)}". ` +
          "One question waits at a time: end your turn and the mission waits for it, or go on with what does not depend on it.",
      };
    }
    const question = withOptions(asked.question, asked.options);
    const last = mission.answers.at(-1);
    const alike = last !== undefined && last.question.trim().toLowerCase() === question.trim().toLowerCase();
    const repeats = alike ? (this.repeats.get(mission.id) ?? 0) + 1 : 1;
    this.repeats.set(mission.id, repeats);
    if (repeats >= SAME_QUESTION) return { stuck: `it asked the same question ${SAME_QUESTION} times in a row, going round in circles: "${question}"` };

    const entry: Answered = { question, at: now, asked: asked.meanwhile ? "meanwhile" : "wait", ...(asked.options.length > 0 ? { options: [...asked.options] } : {}) };
    mission.answers = [...mission.answers, entry].slice(-ANSWERS_KEPT);
    mission.updatedAt = now;
    this.deps.store.save(mission);
    this.deps.changed?.(mission);
    log.info("a mission asked its person", { mission: mission.id, meanwhile: asked.meanwhile, options: asked.options.length });
    const notice = asked.meanwhile ? asksMeanwhileNotice(mission, question) : needsYouNotice(mission, "input", question);
    void this.deps.tell(mission, paged(notice, this.deps.pageOf?.(mission)), buttonsOf(mission.id, entry));
    this.carry(mission, question);
    return { asked: question, meanwhile: asked.meanwhile, reach: this.deps.answerReach?.(mission) ?? null };
  }

  /**
   * A turn ended with nothing claimed: with its question still open, the mission waits for the answer. True where it
   * does. The question was told when it was asked; one asked to work on meanwhile is said to wait now, since its person
   * read that it went on.
   *
   * `finished`: the turn said the mission was done. With the question still open it waits for the answer all the same,
   * before any check runs: a mission that asked and finished the rest went to its checks and then to its person to
   * accept, as if the question had never been asked, and the answer could no longer change the work. The question is
   * marked so, for the turn its answer starts, and the chat is told once that everything else is finished.
   */
  waitsOn(mission: Mission, finished = false): boolean {
    const open = openQuestion(mission);
    if (!open) return false;
    if (finished) open.finished = true;
    this.missions.wait(mission, "input", open.question, false);
    const notice = finished ? finishedWaitsNotice(mission, open.question) : open.asked === "meanwhile" ? nowWaitsNotice(mission, open.question) : null;
    if (notice) void this.deps.tell(mission, paged(notice, this.deps.pageOf?.(mission)), buttonsOf(mission.id, open));
    return true;
  }

  /** The chat's notes say its mission asked, so its agent there knows an answer when it reads one (`carry.ts`). */
  private carry(mission: Mission, question: string): void {
    if (!this.deps.notes) return;
    void carryWait(this.deps.notes, mission, question).catch((err: unknown) => log.warn("a chat's line for its mission's question could not be written", { mission: mission.id, error: String(err) }));
  }
}
