/**
 * Scheduled work an agent proposes, and a person turns on (0.8.0).
 *
 * An agent asked for "every Monday at 9, sum up the customer mail for the team" used to run `nouride cron add …` and a
 * person approved a raw command line. Now it proposes: a job written whole and kept off, and a card in the chat that
 * says what it does, when, and where it reports — with Turn on and Discard. An agent proposes and never turns on,
 * widens or edits one that runs: a change is a new proposal naming the job it replaces, which keeps its history.
 *
 * Every kind goes this way — a reminder, a script, an agent's turn, a mission — so a person sees each in words before
 * it runs with nobody there.
 */

import type { Job, JobPayload, JobProposal, JobStep, MessageButton, StepGo } from "@nouride/shared";
import type { CronPort, JobInput } from "./cron.store.ts";

/** Proposals an agent may have waiting at once: past it, the oldest is the person's to answer first. */
const OPEN_PROPOSALS = 10;

/** What a press on a card carries: `job:on:<id>` or `job:no:<id>`, well under Telegram's 64 bytes. */
const PRESS = /^job:(on|no):(cron_[A-Za-z0-9]+)$/;

export function proposalButtons(id: string): MessageButton[] {
  return [
    { label: "Turn on", data: `job:on:${id}`, style: "positive" },
    { label: "Discard", data: `job:no:${id}`, style: "negative" },
  ];
}

export function proposalPressed(data: string): { id: string; on: boolean } | null {
  const match = PRESS.exec(data);
  return match ? { on: match[1] === "on", id: match[2]! } : null;
}

/**
 * What a job does, in a line a person decides on — the command written out whole, since it runs with no model. A job
 * of several steps says each on a line of its own, numbered, in the order they run, with where the run goes from it
 * when that is not simply the next step: every one is read before a yes.
 */
function doesLine(agentId: string, payload: JobPayload | JobStep): string {
  switch (payload.kind) {
    case "systemEvent":
      return `sends the text "${payload.text}"`;
    case "agentTurn":
      return `${("agentId" in payload && payload.agentId) || agentId} works on: "${payload.message}"`;
    case "command":
      return `runs \`${payload.argv.join(" ")}\` on this machine, with no model`;
    case "mission": {
      const checks = payload.checks?.length ? `, done when \`${payload.checks.join("`, `")}\` pass` : "";
      const review = payload.review === false ? ", no reviewer" : ", then a reviewer agrees";
      return `a mission for ${("agentId" in payload && payload.agentId) || agentId}: "${payload.goal}"${checks}${review}`;
    }
    case "approval":
      return `waits for a person's yes to: "${payload.ask}"`;
    case "steps":
      return [
        "in order, each handed what the one before said:",
        ...payload.steps.map((step, index) => `${index + 1}. ${doesLine(agentId, step)}${exitsLine(step, index, payload.steps)}`),
      ].join("\n");
  }
}

/** Where a run goes from a step, said only where it is not what a person would expect of a list. */
function exitsLine(step: JobStep, index: number, steps: readonly JobStep[]): string {
  const place = (go: StepGo): string => (go === "end" ? "the run ends there" : `the run goes to step ${go === "next" ? index + 2 : steps.findIndex((one) => one.id === go.to) + 1}`);
  const last = index === steps.length - 1;
  const said: string[] = [];
  if (step.then !== undefined && step.then !== "next" && !last) said.push(`Once done, ${place(step.then)}.`);
  if (step.kind === "approval") {
    said.push(step.whenFailed === undefined || step.whenFailed === "end" || last ? "On a no, or no answer, the run ends." : `On a no, or no answer, ${place(step.whenFailed)}.`);
    return ` ${said.join(" ")}`;
  }
  if (step.whenFailed !== undefined && step.whenFailed !== "end" && !last) said.push(`If it fails, ${place(step.whenFailed)}.`);
  if (step.kind === "command" || step.kind === "agentTurn") {
    said.push(step.whenEmpty === undefined || step.whenEmpty === "end" || last ? "With nothing to say, the run ends there." : `With nothing to say, ${place(step.whenEmpty)}.`);
  }
  return said.length > 0 ? ` ${said.join(" ")}` : "";
}

/** The card: who proposes what, when it runs, and where it reports — and how to answer it without buttons. */
export function proposalCard(job: Job, when: string, shown: { buttons: boolean }): string {
  const change = job.proposal?.replaces ? ` (a change to job ${job.proposal.replaces})` : "";
  const lines = [
    `📋 **${job.proposal?.by ?? job.agentId}** proposes ${job.trigger.kind === "webhook" ? "a webhook" : job.trigger.kind === "manual" ? "work started by hand" : "a scheduled job"}: **${job.name}**${change}`,
    `When: ${job.trigger.kind === "webhook" ? "a request to its own URL, shown once it is on" : job.trigger.kind === "manual" ? "when somebody presses Run now" : when}`,
    `Does: ${doesLine(job.agentId, job.payload)}`,
    "Results: here",
    "It stays off until somebody turns it on.",
  ];
  if (!shown.buttons) lines.push(`Turn on: /schedule on ${job.id}, or /schedule discard ${job.id}`);
  return lines.join("\n");
}

export function settledCard(job: Pick<Job, "name">, on: boolean, who: string): string {
  return on ? `✅ **${job.name}** turned on by ${who}.` : `🗑 **${job.name}** discarded by ${who}.`;
}

/** Why an agent may not propose this now, or null: too many waiting, or a change to a job that is not there to change. */
export function proposalRefusal(store: Pick<CronPort, "list" | "get">, agentId: string, input: Pick<JobInput, "trigger">, replaces?: string): string | null {
  // By who proposed, not by who would run it: counted by the runner, an agent proposing for another had no ceiling.
  const waiting = store.list({ includeDisabled: true }).filter((job) => job.proposal?.by === agentId).length;
  if (waiting >= OPEN_PROPOSALS) return `${OPEN_PROPOSALS} of your proposals are waiting already. A person answers those first.`;
  if (replaces === undefined) return null;
  const replaced = store.get(replaces);
  if (!replaced || replaced.proposal) return `There is no job ${replaces} to change.`;
  // A webhook keeps its URL and a schedule its clock: one cannot become the other in place.
  if ((replaced.trigger.kind === "webhook") !== (input.trigger.kind === "webhook")) {
    return "A change keeps the job's trigger a webhook, or a schedule, as it was: propose a new job for the other.";
  }
  return null;
}

/**
 * Why a person who is not an admin may not turn this change on, or null. A change keeps the job's agent, so one to
 * another agent's job — or to one reporting to another chat — would let an agent asked in one person's DM rewrite work
 * that runs as somebody else's agent, for readers who never saw the card.
 */
export function changeRefusal(store: Pick<CronPort, "get">, job: Job): string | null {
  const replaced = job.proposal?.replaces ? store.get(job.proposal.replaces) : null;
  if (!replaced) return null;
  if (replaced.agentId === job.proposal?.by && replaced.target.gatewayId === job.target.gatewayId && replaced.target.chatId === job.target.chatId) return null;
  return "It changes a job of another agent, or one that reports to another chat: only an admin can turn that on.";
}

/**
 * A person's yes: the job is on, runs as them, and is theirs (`by.owner`, the person as People writes an id). A change takes the shape of the job it replaces — whose history
 * and URL it keeps — and the proposal goes.
 */
export function turnOnProposal(store: CronPort, id: string, by: { actor: string; as: string; owner?: string }): { job: Job } | { refused: string } {
  const job = store.get(id);
  if (!job?.proposal) return { refused: "That proposal is no longer waiting." };
  const replaces = job.proposal.replaces;
  if (replaces) {
    // Changed first, the proposal let go after: a change the store refuses leaves the proposal there to discard.
    const changed = store.update(replaces, { name: job.name, trigger: job.trigger, payload: job.payload, target: job.target, delivery: job.delivery, session: job.session }, by.actor);
    if (!changed) return { refused: `The job it would change, ${replaces}, is gone.` };
    // What it was allowed always was a yes to its old shape: the new one asks again.
    for (const grant of changed.allowed ?? []) store.disallow(replaces, grant.keys[0]!, by.actor);
    store.delete(id, by.actor);
    store.settleProposal(replaces, by.as, by.owner);
    return { job: store.get(replaces)! };
  }
  store.settleProposal(id, by.as, by.owner);
  return { job: store.setEnabled(id, true, by.actor)! };
}

/** What a proposal is for, kept for whoever answers it: the agent, the chat its card went to, and who asked. */
export function proposalFor(agentId: string, where: { gatewayId: string; chatId: string; senderId: string }, at: number, replaces?: string): JobProposal {
  return { by: agentId, gatewayId: where.gatewayId, chatId: where.chatId, for: where.senderId, at, ...(replaces ? { replaces } : {}) };
}
