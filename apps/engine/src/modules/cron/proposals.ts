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

import { oneLine, type CommandRuns, type Job, type JobPayload, type JobProposal, type JobStep, type MessageButton, type StepGo, type TogetherStep } from "@nouride/shared";
import { variableOf } from "@/modules/tools/exec-secrets.ts";
import type { CronPort, JobInput } from "./cron.store.ts";
import { lastsWords } from "./parse.ts";

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
function doesLine(agentId: string, payload: JobPayload | JobStep | TogetherStep): string {
  switch (payload.kind) {
    case "systemEvent":
      return `sends the text "${payload.text}"`;
    case "agentTurn":
      return `${("agentId" in payload && payload.agentId) || agentId} works on: "${payload.message}"`;
    case "command":
      return payload.script ? scriptLine(payload) : `runs \`${payload.argv.join(" ")}\` on this machine, with no model`;
    case "mission": {
      const checks = payload.checks?.length ? `, done when \`${payload.checks.join("`, `")}\` pass` : "";
      const review = payload.review === false ? ", no reviewer" : ", then a reviewer agrees";
      return `a mission for ${("agentId" in payload && payload.agentId) || agentId}: "${payload.goal}"${checks}${review}`;
    }
    case "approval":
      return `waits for a person's yes to: "${payload.ask}"`;
    case "parallel":
      return ["at the same time, their words joined:", ...payload.steps.map((part) => `   - ${doesLine(agentId, part)}`)].join("\n");
    case "steps": {
      const lines = payload.steps.map((step, index) => stepLine(agentId, step, index, payload.steps));
      // A list of one is that one thing, said as it is: a watch is a single script, and its card read "in order,
      // each handed what the one before said: 1." with nothing before it and nothing after.
      return lines.length === 1 ? lines[0]! : ["in order, each handed what the one before said:", ...lines.map((line, index) => `${index + 1}. ${line}`)].join("\n");
    }
  }
}

/** A line with what is said of it after: a full stop between them where the line does not end in one, inside a quote or not. */
const withSaid = (line: string, said: readonly string[]): string => (said.length === 0 ? line : `${line}${/[.!?]["”]?$/.test(line) ? "" : "."} ${said.join(" ")}`);

/**
 * A step of a list on the card: what it does, then what is said of the step itself (that it goes on only when it
 * differs, where the run goes from it). For a script those come before its text: a sentence after the end of a
 * fence is no sentence to a chat app, and every script in a list lost its paths that way.
 */
function stepLine(agentId: string, step: JobStep, index: number, steps: readonly JobStep[]): string {
  const said = [...(step.onlyChanged ? ["It goes on only when this differs from the last run."] : []), ...exitsOf(step, index, steps)];
  if (step.kind === "command" && step.script) return scriptLine(step, said);
  if (step.kind !== "parallel") return withSaid(doesLine(agentId, step), said);
  // Said of all of them, so on their heading: after the last of them it read as that one's alone.
  const [heading, ...each] = doesLine(agentId, step).split("\n");
  return [said.length > 0 ? withSaid(heading!.replace(/:$/, ""), said) : heading!, ...each].join("\n");
}

/** The most of a script's text a card holds: a chat's message is a few thousand characters, and the card says the rest. */
const SCRIPT_SHOWN = 2_400;

/** A fence inside a script's text would end the card's own: said with straight quotes there, on the card only. */
const FENCE = "```";

/**
 * A script on a card: what it is said to do, then what the daemon knows without being told (the program, how long the
 * text is, which secrets it is handed, by the variables they arrive as), then the text whole. A text too long for a
 * message is not shown in part: the part left out would be the part nobody read before saying yes.
 */
function scriptLine(command: Pick<CommandRuns, "argv" | "script">, said: readonly string[] = []): string {
  const script = command.script!;
  const lines = script.text.trimEnd().split("\n").length;
  const secrets = script.secrets?.length ? `, handed ${script.secrets.map((name) => `$${variableOf(name)}`).join(", ")}` : "";
  const facts = `a script run by \`${command.argv.join(" ")}\` on this machine, with no model: ${lines} ${lines === 1 ? "line" : "lines"}${secrets}`;
  const text =
    script.text.length <= SCRIPT_SHOWN
      ? `${FENCE}\n${script.text.split(FENCE).join("'''").trimEnd()}\n${FENCE}`
      : "(Its text is too long for a message: read it on the Automations page before you turn it on.)";
  return `${withSaid(oneLine(script.about), said)}\n   ${facts}\n${text}`;
}

/** Where a run goes from a step, a sentence each, said only where it is not what a person would expect of a list. */
function exitsOf(step: JobStep, index: number, steps: readonly JobStep[]): string[] {
  const place = (go: StepGo): string => (go === "end" ? "the run ends there" : `the run goes to step ${go === "next" ? index + 2 : steps.findIndex((one) => one.id === go.to) + 1}`);
  const last = index === steps.length - 1;
  const said: string[] = [];
  if (step.then !== undefined && step.then !== "next" && !last) said.push(`Once done, ${place(step.then)}.`);
  if (step.kind === "approval") {
    said.push(step.whenFailed === undefined || step.whenFailed === "end" || last ? "On a no, or no answer, the run ends." : `On a no, or no answer, ${place(step.whenFailed)}.`);
    return said;
  }
  if (step.whenFailed !== undefined && step.whenFailed !== "end" && !last) said.push(`If it fails, ${place(step.whenFailed)}.`);
  if (step.kind === "command" || step.kind === "agentTurn" || step.kind === "parallel") {
    said.push(step.whenEmpty === undefined || step.whenEmpty === "end" || last ? "With nothing to say, the run ends there." : `With nothing to say, ${place(step.whenEmpty)}.`);
  }
  return said;
}

/** The card: who proposes what, when it runs, and where it reports — and how to answer it without buttons. */
export function proposalCard(job: Job, when: string, shown: { buttons: boolean; /** Where its results go when not here, in words. */ results?: string | undefined }): string {
  const change = job.proposal?.replaces ? ` (a change to job ${job.proposal.replaces})` : "";
  const lines = [
    `📋 **${job.proposal?.by ?? job.agentId}** proposes ${job.trigger.kind === "webhook" ? "a webhook" : job.trigger.kind === "manual" ? "work started by hand" : "a scheduled job"}: **${job.name}**${change}`,
    `When: ${job.trigger.kind === "webhook" ? "a request to its own URL, shown once it is on" : job.trigger.kind === "manual" ? "when somebody presses Run now" : when}`,
    `Does: ${doesLine(job.agentId, job.payload)}`,
    // Named on the card a person turns on, since that is their yes to it: results sent elsewhere are not asked about again.
    `Results: ${shown.results ? `sent to ${shown.results}, not here` : "here"}`,
    ...(job.delivery.once ? ["Tells once: after the first run that tells you something, it turns itself off."] : []),
    ...(job.delivery.lasts !== undefined ? [`Lasts: ${lastsWords(job.delivery.lasts)} from when it is turned on. Then it turns itself off and says so${job.delivery.once ? ", if it has told nothing by then" : ""}.`] : []),
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

/** What a person is told who says yes to a change of an automation that is not theirs. */
const NOT_THEIRS_TO_CHANGE = "It changes an automation that is someone else's: only they, or an admin, can turn that on.";

/**
 * A person's yes: the job is on, runs as them, and is theirs (`by.owner`, the person as People writes an id). A change takes the shape of the job it replaces — whose history
 * and URL it keeps — and the proposal goes.
 */
export function turnOnProposal(
  store: CronPort,
  id: string,
  by: { actor: string; as: string; owner?: string; /** Whether this person may change that job: its owner, or an admin. */ mayChange?: (job: Job) => boolean },
): { job: Job } | { refused: string } {
  const job = store.get(id);
  if (!job?.proposal) return { refused: "That proposal is no longer waiting." };
  const replaces = job.proposal.replaces;
  if (replaces) {
    // A change rewrites the job it replaces, so the yes is that job's owner's, or an admin's: anyone else who can see
    // the card would change another person's automation with one press.
    const replaced = store.get(replaces);
    if (replaced && by.mayChange && !by.mayChange(replaced)) return { refused: NOT_THEIRS_TO_CHANGE };
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
