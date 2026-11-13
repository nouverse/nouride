/**
 * A proposal's card in the chat it was asked in (0.8.0), its Turn on and Discard, and the card rewritten once answered —
 * the way an approval's prompt is (`tools/approval-prompts.ts`), and answered by the same rule for who may
 * (`approval-answerers.ts`): in a one-to-one chat the person in it, in a room the person it was proposed for or an admin.
 *
 * Without buttons — WhatsApp — the card says the words instead: `/schedule on <id>` (`hooks/builtins/schedule.ts`).
 * The dashboard answers it too, and its card follows.
 */

import { createLogger, ownerIdentity, type ButtonPress, type ChatType, type Job, type PressAnswer } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import { mayAnswer } from "@/modules/tools/approval-answerers.ts";
import type { CronPort } from "./cron.store.ts";
import { changeRefusal, proposalButtons, proposalCard, proposalPressed, settledCard, turnOnProposal } from "./proposals.ts";

const log = createLogger("cron.proposals");

export interface ProposalCardsDeps {
  store: CronPort;
  notifier: Pick<Notifier, "ask" | "settle">;
  /** The connection an agent speaks on in a chat: where its card goes, and so where a press on it comes from. */
  voice: (agentId: string, gatewayId: string) => string;
  /** An admin by People: in a room, who besides the person it was proposed for may answer. */
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
  /** Whether a job's owner is this sender, by People: whose yes a change to that job takes. */
  isOwner: (who: { gatewayId: string; senderId: string }, owner: string | undefined) => boolean;
  /** When a job runs, in words — `describeTrigger` in the daemon's zone. */
  when: (job: Job) => string;
  /** Where a job's results go when that is not the chat it reports from, in words; null for there. */
  results: (job: Job) => string | null;
}

/** Who answered, from a chat: where they said it, who they are there, and what kind of chat it is. */
export interface Answerer {
  gatewayId: string;
  chatId: string;
  chatType: ChatType;
  senderId: string;
  name: string;
  /** Written by a bot — one of our own agents', since a stranger's is dropped before any command runs. */
  bot?: boolean;
}

export class ProposalCards {
  /** Each waiting proposal's card with buttons, by its job id. A restart forgets them; a late press says so. */
  private readonly posted = new Map<string, { gatewayId: string; chatId: string; messageId: string }>();

  constructor(private readonly deps: ProposalCardsDeps) {}

  /** A press is this one's when its data is a proposal's (`job:on:…`, `job:no:…`). */
  owns(data: string): boolean {
    return proposalPressed(data) !== null;
  }

  /** Into the chat the proposal was asked in, under its agent's own name. False when it could not be said there. */
  async post(job: Job): Promise<boolean> {
    const proposal = job.proposal;
    if (!proposal) return false;
    const target = { gatewayId: this.deps.voice(proposal.by, proposal.gatewayId), chatId: proposal.chatId };
    const results = this.deps.results(job) ?? undefined;
    const sent = await this.deps.notifier.ask(target, (buttons) => proposalCard(job, this.deps.when(job), { buttons, results }), proposalButtons(job.id));
    if (!sent) {
      log.warn("a proposal's card was not delivered: answer it from the dashboard", { job: job.id, gateway_id: target.gatewayId });
      return false;
    }
    const messageId = sent.buttons ? sent.ids.at(-1) : undefined;
    if (messageId) this.posted.set(job.id, { ...target, messageId });
    log.info("a proposal's card posted", { job: job.id, agent_id: proposal.by, buttons: sent.buttons });
    return true;
  }

  /** A press on a card — `Gateway.onPress`. */
  async press(press: ButtonPress): Promise<PressAnswer> {
    const pressed = proposalPressed(press.data);
    if (!pressed) return { notice: "That button is not one I know any more." };
    // The card pressed is settled by the answer to the press, not rewritten a second time by `settled`.
    const card = this.posted.get(pressed.id);
    if (card?.messageId === press.messageId) this.posted.delete(pressed.id);
    const answered = this.answer(pressed.id, pressed.on, { ...press, name: press.senderName || press.senderId });
    if ("refused" in answered) {
      // Refused to this person: the card stays as it was, buttons and all, for whoever may answer it.
      if (card && !answered.settled) this.posted.set(pressed.id, card);
      return { notice: answered.refused, ...(answered.settled ? { settled: answered.settled } : {}) };
    }
    return { notice: pressed.on ? "Turned on." : "Discarded.", settled: answered.settled };
  }

  /** Turn on or discard, said in a chat — a press, or `/schedule on|discard <id>`: from the chat it was asked in, by whoever may. */
  answer(id: string, on: boolean, who: Answerer): { job: Job | null; settled: string } | { refused: string; settled?: string } {
    const job = this.deps.store.get(id);
    const proposal = job?.proposal;
    if (!job || !proposal) return { refused: "That proposal is no longer waiting.", settled: "⌛ No longer waiting." };
    // An agent's bot posting `/schedule on` ran as a hook: one agent could record its bot as who asked, then answer
    // for it — a job turned on with no person there.
    if (who.bot) return { refused: "Only a person answers a proposal." };
    const voice = this.deps.voice(proposal.by, proposal.gatewayId);
    if (who.chatId !== proposal.chatId || (who.gatewayId !== proposal.gatewayId && who.gatewayId !== voice)) {
      return { refused: "That proposal was not made here." };
    }
    if (!mayAnswer({ chatType: who.chatType, senderId: who.senderId, isAdmin: () => this.deps.isAdmin(who) }, { requestedBy: proposal.for })) {
      return { refused: "Only the person it was proposed for, or an admin, can answer this one." };
    }
    const settled = settledCard(job, on, who.name);
    if (!on) {
      this.deps.store.delete(id, who.name);
      log.info("a proposal discarded", { job: id, by: who.senderId });
      this.settled(id, settled);
      return { job: null, settled };
    }
    const admin = this.deps.isAdmin(who);
    // A call from outside sets a webhook off: an admin's to turn on, as making one is — and on the dashboard.
    if (job.trigger.kind === "webhook" && !admin) return { refused: "A webhook is an admin's to turn on, as making one is." };
    // An admin could make that change themselves; so may an operator on the dashboard, which does not ask this.
    const refused = admin ? null : changeRefusal(this.deps.store, job);
    if (refused) return { refused };
    const owner = ownerIdentity(who.gatewayId, who.senderId);
    const result = turnOnProposal(this.deps.store, id, { actor: who.name, as: who.senderId, ...(owner ? { owner } : {}), mayChange: (replaced) => admin || this.deps.isOwner(who, replaced.owner) });
    if ("refused" in result) return result;
    log.info("a proposal turned on", { job: result.job.id, by: who.senderId });
    this.settled(id, settled);
    return { job: result.job, settled };
  }

  /** Answered elsewhere — the dashboard, the CLI, another copy: its card says how, and its buttons go. */
  settled(id: string, text: string): void {
    const posted = this.posted.get(id);
    if (!posted) return;
    this.posted.delete(id);
    void this.deps.notifier.settle(posted, posted.messageId, text);
  }
}
