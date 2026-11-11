/**
 * A step that waits for a person, asked in the chat its job reports to: the card with Continue and Stop, a press on
 * one, and the card rewritten once it is answered, from wherever.
 *
 * As a proposal's card is (`proposal-cards.ts`), with one difference: what a press needs is the run's id, which the
 * button carries, and the run itself is in the database. So a card outlives a restart: a press after one still finds
 * its run, where a proposal's card is forgotten.
 *
 * Who may answer is who may answer an approval there (`approval-answerers.ts`): in a one-to-one chat the person in it,
 * in a room whoever turned the job on, or an admin. The dashboard answers too, and the card follows.
 */

import { createLogger, type ButtonPress, type Job, type JobStep, type MessageButton, type PressAnswer } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import { mayAnswer } from "@/modules/tools/approval-answerers.ts";
import { deliveryTarget } from "./addressing.ts";
import type { CronPort, RunState } from "./cron.store.ts";

const log = createLogger("cron.asks");

/** What a press carries: `run:go:<id>` or `run:no:<id>`, well under the 64 bytes the smallest platform takes. */
const PRESS = /^run:(go|no):(run_[A-Za-z0-9]+)$/;

/** How much of what the step before said the card shows: a card a person reads at a glance, on a phone. */
const SHOWN = 1200;

function askButtons(runId: string): MessageButton[] {
  return [
    { label: "Continue", data: `run:go:${runId}`, style: "positive" },
    { label: "Stop", data: `run:no:${runId}`, style: "negative" },
  ];
}

/** The card: which job waits, what it asks, what the step before said, and how to answer where there are no buttons. */
export function askCard(job: Pick<Job, "name">, ask: string, shown: string, until: string, buttons: boolean): string {
  const lines = [`⏸ **${job.name}** waits for you: ${ask.trim()}`];
  const said = shown.trim();
  if (said) lines.push("", said.length > SHOWN ? `${said.slice(0, SHOWN)}…` : said);
  lines.push("", buttons ? `With no answer by ${until}, it stops there.` : `Answer it on the dashboard, under Waiting for you. With no answer by ${until}, it stops there.`);
  return lines.join("\n");
}

/** The card once answered: what it asked, and how it went. */
export function answeredCard(job: Pick<Job, "name">, ask: string, how: string): string {
  return `**${job.name}**: ${ask.trim()}\n\n${how}`;
}

/** What a person's answer did, or why it did nothing. `settled`: what the card says from now on. */
export type AskAnswered = { ok: true; settled: string } | { refused: string; settled?: string };

export interface StepAsksDeps {
  store: Pick<CronPort, "get" | "waitingRun">;
  notifier: Pick<Notifier, "ask" | "settle">;
  /** The connection an agent speaks on in a chat: where its card goes, and so where a press on it comes from. */
  voice: (agentId: string, gatewayId: string) => string;
  /** An admin by People: in a room, who besides the person who turned the job on may answer. */
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
  /** The run taken up again with the answer, or why not: the scheduler's. */
  answer: (runId: string, go: boolean, by: string, via: "chat") => AskAnswered;
  /** A time a person reads, in the daemon's zone. */
  when: (at: number) => string;
}

export class StepAsks {
  constructor(private readonly deps: StepAsksDeps) {}

  owns(data: string): boolean {
    return PRESS.test(data);
  }

  /**
   * Ask, where the job reports and under its agent's own name. The card that was posted, when it has buttons to take
   * away later; nothing when the chat could not be told, or the job reports nowhere: the dashboard still asks.
   */
  async ask(job: Job, runId: string, step: Extract<JobStep, { kind: "approval" }>, shown: string, until: number): Promise<RunState["card"] | undefined> {
    if (job.delivery.mode === "none") return undefined;
    const target = deliveryTarget(job);
    const where = { gatewayId: this.deps.voice(job.agentId, target.gatewayId), chatId: target.chatId };
    const sent = await this.deps.notifier.ask(where, (buttons) => askCard(job, step.ask, shown, this.deps.when(until), buttons), askButtons(runId));
    if (!sent) {
      log.warn("a step's question was not delivered: it is answered from the dashboard", { job: job.id, run: runId, gateway_id: where.gatewayId });
      return undefined;
    }
    const messageId = sent.buttons ? sent.ids.at(-1) : undefined;
    log.info("a step asked a person", { job: job.id, run: runId, buttons: sent.buttons });
    return messageId ? { ...where, messageId } : undefined;
  }

  /** A press on a card — `Gateway.onPress`. */
  async press(press: ButtonPress): Promise<PressAnswer> {
    const match = PRESS.exec(press.data);
    if (!match) return { notice: "That button is not one I know any more." };
    const [, how, runId] = match as unknown as [string, "go" | "no", string];
    const waiting = this.deps.store.waitingRun(runId);
    const job = waiting ? this.deps.store.get(waiting.run.jobId) : null;
    if (!waiting || !job || waiting.state.wait.kind !== "approval") return { notice: "That is not waiting any more.", settled: "⌛ No longer waiting." };
    const card = waiting.state.card;
    if (card && (press.chatId !== card.chatId || press.gatewayId !== card.gatewayId)) return { notice: "That was not asked here." };
    const who = { chatType: press.chatType, senderId: press.senderId, isAdmin: () => this.deps.isAdmin({ gatewayId: press.gatewayId, senderId: press.senderId }) };
    if (!mayAnswer(who, { requestedBy: job.turnedOnBy ?? job.createdBy })) {
      return { notice: "Only whoever turned this on, or an admin, can answer it." };
    }
    const answered = this.deps.answer(runId, how === "go", press.senderName || press.senderId, "chat");
    if ("refused" in answered) return { notice: answered.refused, ...(answered.settled ? { settled: answered.settled } : {}) };
    return { notice: how === "go" ? "Carrying on." : "Stopped.", settled: answered.settled };
  }

  /** Answered elsewhere, or not at all: the card says how, and its buttons go. */
  settled(card: NonNullable<RunState["card"]>, text: string): void {
    void this.deps.notifier.settle(card, card.messageId, text);
  }
}
