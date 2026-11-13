/**
 * `schedule` — work that runs later, proposed (0.8.0). The agent writes the job whole; a person
 * turns it on from its card (`cron/proposals.ts`). Nothing runs until they do, and the agent has no way to turn one
 * on, widen it, or change one that runs — a change is a new proposal naming the job it replaces.
 *
 * Resolved by the daemon for a chat's turn, like `mission`: any agent may be asked for a reminder or a weekly report,
 * and a pack listing its tools would otherwise never learn it can propose one. It confers nothing: what it proposes
 * runs only once a person has read it and said yes.
 */

import type { Job, JobPayload, JobTrigger, Tool, ToolContext } from "@nouride/shared";
import { CronValidationError } from "@/modules/cron/validate.ts";
import { parseScheduleInput } from "@/modules/cron/parse.ts";
import { stepsFrom } from "@/modules/cron/step-input.ts";
import type { CronPort, JobInput } from "@/modules/cron/cron.store.ts";
import { proposalFor, proposalRefusal } from "@/modules/cron/proposals.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { briefFilesOf } from "@/modules/missions/start.ts";
import { pagePath, type LinkFor } from "@/modules/web/links.ts";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";
import { describeAddress, resolveSendTarget, type SendTargets } from "./send-message.ts";

export interface ScheduleToolOptions {
  store: CronPort;
  /** `[daemon] timezone`: what a time with no zone means. */
  timezone: () => string;
  /** Whether an agent of this id exists, for one proposed for another agent. */
  agentExists: (agentId: string) => boolean;
  /** Post its card in the chat it was asked in. False when it could not be said there. */
  post: (job: Job) => Promise<boolean>;
  /** The chats an agent can reach, as `send_message` knows them: what `to` is resolved against, for the agent that will run the job. */
  chats: (agentId: string) => SendTargets;
  /** The job's card on the Schedule page, where a link goes into this chat (`web/links.ts`, 0.8.11). */
  linkFor?: LinkFor;
  /** A brief file's text, or null where it cannot be read — what a mission's start reads (`boot/missions.ts`). */
  readBrief?: (path: string) => string | null;
  now?: () => number;
}

const DESCRIPTION =
  "Propose work that runs later: on a schedule, when a webhook is called, or when a person starts it. It stays off " +
  "until a person turns it on from the card this posts here. Say so in one line. Use it for anything asked at a time " +
  "or again and again. The cheapest that does the job: `text` is sent as written, `command` runs a shell line, " +
  "`prompt` is one turn of yours, `mission` is long work that is checked. Several in order are `steps`. To watch " +
  'something ("tell me when…"), check it on a schedule with `only_changed`: it speaks when what it found changes and ' +
  "is quiet otherwise. Add `once` when it should tell one time and then stop. Each run's result comes to this chat; " +
  "`to` sends it to another one instead, so no run needs `send_message` for its own result. To change a job, or its " +
  "steps, propose it again with `replaces`.";

/**
 * A run's `prompt`, or its mission's goal and review, as written in English (0.8.8): each run of a proposed job starts
 * fresh, read by the agent's model and a mission's reviewer whatever the person speaks — a brief, as `ask_agent`'s task
 * and a mission's goal are. Judged as working text, a person's words quoted as they are. `text` is the person's, sent
 * as written, and is not judged.
 */
function notInEnglish(args: Record<string, unknown>): string | null {
  const briefs: [string, string][] = [["prompt", "The `prompt`"], ["mission", "The `mission` goal"], ["review", "The `review`"]];
  for (const [key, what] of briefs) {
    // A review goes with a mission and is dropped with anything else: what is dropped is not judged.
    if (key === "review" && typeof args.mission !== "string") continue;
    if (typeof args[key] === "string" && !workTextIsEnglish(args[key] as string)) return writeWorkInEnglish(what);
  }
  return null;
}

type OneKind = Exclude<JobPayload, { kind: "steps" }>;

/** The one thing a job, or one step of several, does: exactly one of the four, as written. */
function doesOf(args: Record<string, unknown>): OneKind | string {
  const given = (["text", "command", "prompt", "mission"] as const).filter((key) => typeof args[key] === "string" && String(args[key]).trim());
  if (given.length !== 1) return "Give exactly one of `text`, `command`, `prompt` or `mission`.";
  const refused = notInEnglish(args);
  if (refused) return refused;
  const value = String(args[given[0]!]).trim();
  switch (given[0]!) {
    case "text":
      return { kind: "systemEvent", text: value };
    case "command":
      // `sh -lc`, as the CLI and the dashboard write a shell line — the card shows it whole.
      return { kind: "command", argv: ["sh", "-lc", value], then: "deliver" };
    case "prompt":
      return { kind: "agentTurn", message: value };
    case "mission": {
      const checks = Array.isArray(args.checks) ? args.checks.map(String).map((check) => check.trim()).filter(Boolean) : [];
      return {
        kind: "mission",
        goal: value,
        ...(checks.length > 0 ? { checks } : {}),
        ...(args.no_review === true ? { review: false } : typeof args.review === "string" && args.review.trim() ? { review: args.review.trim() } : {}),
      };
    }
  }
}

/** A step's exit as the tool takes it, `if_failed` and `if_empty` beside `then`, under the name a job keeps it by. */
const EXITS = [["then", "then"], ["if_failed", "whenFailed"], ["if_empty", "whenEmpty"]] as const;

/**
 * `steps`: each one written as a job of one kind is, so there is little new to learn to write a list. A `prompt` or a
 * `mission` may name another agent, `ask` waits for a person, and each of a step's three exits is `next`, `end` or the
 * number of a later step. Given with `text`, `command`, `prompt` or `mission` beside it, the call is refused: a job is
 * one thing or a list, and guessing which was meant would propose the wrong one.
 */
function payloadOf(args: Record<string, unknown>, agentExists: (agentId: string) => boolean): JobPayload | string {
  if (args.steps === undefined) {
    const one = doesOf(args);
    if (typeof one === "string" || args.only_changed !== true) return one;
    if (one.kind === "systemEvent") return "A `text` is the same words every run, so there is nothing that could change: watch with a `command` or a `prompt` that looks at something.";
    // One thing that speaks only when changed is a list of one: the mark is a step's, and a list's last words are sent.
    const step: Record<string, unknown> = { ...one, onlyChanged: true };
    delete step.then;
    return { kind: "steps", steps: stepsFrom([step]) };
  }
  if (!Array.isArray(args.steps) || args.steps.length === 0) return "`steps` is a list of at least one step.";
  if ((["text", "command", "prompt", "mission"] as const).some((key) => typeof args[key] === "string" && String(args[key]).trim())) {
    return "Give `steps`, or one of `text`, `command`, `prompt` and `mission`: not both.";
  }
  const written: Record<string, unknown>[] = [];
  for (const [index, raw] of args.steps.entries()) {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const asks = typeof step.ask === "string" && step.ask.trim() ? step.ask.trim() : "";
    const does = asks ? null : doesOf(step);
    if (typeof does === "string") return `Step ${index + 1}: ${does.replace("`prompt` or `mission`", "`prompt`, `mission` or `ask`")}`;
    const agent = typeof step.agent === "string" && step.agent.trim() ? step.agent.trim() : "";
    if (agent && !agentExists(agent)) return `Step ${index + 1}: there is no agent called ${agent}.`;
    // A command's own `then` is what a job of one command does with its output: in a list that is the step after it.
    const one: Record<string, unknown> = asks ? { kind: "approval", ask: asks } : { ...does };
    delete one.then;
    written.push({
      ...one,
      ...(agent ? { agentId: agent } : {}),
      ...(typeof step.name === "string" ? { name: step.name } : {}),
      ...(step.only_changed === true ? { onlyChanged: true } : {}),
      ...Object.fromEntries(EXITS.filter(([given]) => step[given] !== undefined).map(([given, kept]) => [kept, step[given]])),
    });
  }
  return { kind: "steps", steps: stepsFrom(written) };
}

/**
 * `when`, as a person would say it to a CLI: `every 15m`, `cron 0 9 * * 1-5`, `at 2026-11-02 09:00`, `webhook`. One
 * field rather than four, because each field rides on every chat request's tool list.
 */
function triggerOf(when: string, tz: string | undefined, now: number, timezone: string): JobTrigger {
  const [word = "", ...rest] = when.trim().split(/\s+/);
  const value = rest.join(" ");
  const zone = tz?.trim() ? { tz: tz.trim() } : {};
  switch (word.toLowerCase()) {
    case "webhook":
      return { kind: "webhook" };
    case "manual":
      return { kind: "manual" };
    case "every":
      return parseScheduleInput({ every: value }, now, timezone);
    case "at":
      return parseScheduleInput({ at: value, ...zone }, now, timezone);
    case "cron":
      return parseScheduleInput({ cron: value, ...zone }, now, timezone);
    default:
      throw new CronValidationError('`when` starts with `every`, `at`, `cron` or is `webhook` or `manual`: "every 15m", "cron 0 9 * * 1-5".');
  }
}

/**
 * Where each run's result goes when that is not the chat it was proposed in, or null for here; a string is why `to`
 * names no chat. Resolved as `send_message` resolves its `to`, against the chats of the agent that will run the job: it
 * is that agent's connection the result goes out on.
 *
 * Without it a job could only report to the chat it was made in. Asked from the dashboard for a digest on a person's
 * WhatsApp every morning, an agent wrote "send it with `send_message`" into the job's prompt instead: each run then
 * looked the chat up again, sent the digest as a message of its own, and reported a second time where it was made.
 *
 * A change that says no `to` keeps where the job it replaces sends: a change of its hour does not move its results.
 */
function resultsGoTo(args: Record<string, unknown>, ctx: ToolContext, targets: SendTargets, replaced: Job | null): { gatewayId: string; chatId: string } | null | string {
  const to = typeof args.to === "string" ? args.to.trim() : "";
  if (!to) return replaced?.delivery.gatewayId && replaced.delivery.chatId ? { gatewayId: replaced.delivery.gatewayId, chatId: replaced.delivery.chatId } : null;
  // No chat is "here" to the resolver, so this one resolves as any other: naming it is the same as leaving `to` out.
  const found = resolveSendTarget(to, targets, { gatewayId: ctx.gatewayId, chatId: "", gateway: ctx.gateway });
  if (!found.ok) return `\`to\` names no chat its results could go to. ${found.reason}`;
  return found.chat.gatewayId === ctx.gatewayId && found.chat.chatId === ctx.chatId ? null : { gatewayId: found.chat.gatewayId, chatId: found.chat.chatId };
}

/** Why this chat cannot take a proposal: its card would go where nobody reads — a mission's conversation, a job's own. */
function notAChat(ctx: ToolContext): string | null {
  if (ctx.gatewayId === MISSION_GATEWAY_ID || ctx.chatId.startsWith("cron:")) return "Propose scheduled work from a chat with a person in it: nobody reads this conversation.";
  return null;
}

export function createScheduleTool(options: ScheduleToolOptions): Tool {
  const now = options.now ?? Date.now;
  return {
    requiresApproval: false,
    definition: {
      name: "schedule",
      description: DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short: on its card and in the list." },
          when: { type: "string", description: '"every 15m", "cron 0 9 * * 1-5", "at 2026-11-02 09:00", "webhook", or "manual".' },
          tz: { type: "string", description: "The zone for `cron` and `at`." },
          text: { type: "string", description: "A reminder, sent as written." },
          command: { type: "string", description: "A shell line; what it prints is sent, and nothing at all when it prints nothing." },
          prompt: { type: "string", description: "What you are woken with, in English, and whole: a run starts with none of this conversation." },
          mission: { type: "string", description: "Long work: each run's goal, as `mission` takes one." },
          checks: { type: "array", items: { type: "string" }, description: "Mission: commands that say a run is done." },
          review: { type: "string", description: "Mission: what the reviewer checks." },
          no_review: { type: "boolean", description: "Mission: no reviewer." },
          steps: {
            type: "array",
            description:
              "Several, in a fixed order, each handed what the one before said; the last one's words are sent. A step is one of `text`, `command`, `prompt`, `mission` (the run waits for it) or `ask` (the run waits for a person's yes). A failed step ends the run as failed and one with nothing to say ends it quietly, unless `if_failed` or `if_empty` say otherwise; `then` is where it goes once done. Each is \"next\", \"end\" or a later step's number.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                text: { type: "string" },
                command: { type: "string" },
                prompt: { type: "string" },
                mission: { type: "string" },
                ask: { type: "string" },
                agent: { type: "string" },
                then: { type: "string" },
                if_failed: { type: "string" },
                if_empty: { type: "string" },
                only_changed: { type: "boolean" },
              },
            },
          },
          only_changed: { type: "boolean", description: "A `command` or `prompt` (or a step): goes on only when what it said differs from the last run." },
          once: { type: "boolean", description: "Turns itself off after the first run that tells somebody." },
          agent: { type: "string", description: "Another agent runs it." },
          to: { type: "string", description: "Where each run's result is sent when not here: as `send_message`'s `to`." },
          replaces: { type: "string", description: "The id of the job this changes." },
        },
        required: ["name", "when"],
      },
    },

    async execute(args, ctx) {
      const elsewhere = notAChat(ctx);
      if (elsewhere) return { content: elsewhere, isError: true };
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) return { content: "Give it a `name`.", isError: true };
      const agentId = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : ctx.agentId;
      if (!options.agentExists(agentId)) return { content: `There is no agent called ${agentId}.`, isError: true };
      const payload = payloadOf(args, options.agentExists);
      if (typeof payload === "string") return { content: payload, isError: true };
      // Each run is started as the person who turned the job on, so a run's start does not read the brief its goal
      // points at, as an agent's own start does: it is read here, while the agent that wrote it is here to fix it.
      const missions = payload.kind === "steps" ? payload.steps.filter((step) => step.kind === "mission") : payload.kind === "mission" ? [payload] : [];
      for (const mission of options.readBrief ? missions : []) {
        for (const path of briefFilesOf(mission.goal)) {
          const text = options.readBrief!(path);
          if (text !== null && !workTextIsEnglish(text)) return { content: writeWorkInEnglish(`The brief file ${path}, which the goal points at,`), isError: true };
        }
      }
      try {
        const trigger = triggerOf(String(args.when ?? ""), typeof args.tz === "string" ? args.tz : undefined, now(), options.timezone());
        // A command a call from outside sets off, with no model between, is an admin's to make from the dashboard.
        if (trigger.kind === "webhook" && (payload.kind === "command" || (payload.kind === "steps" && payload.steps.some((step) => step.kind === "command")))) {
          return { content: "A webhook that runs a command is made by an admin from the dashboard, not proposed.", isError: true };
        }
        const replaces = typeof args.replaces === "string" && args.replaces.trim() ? args.replaces.trim() : undefined;
        const refused = proposalRefusal(options.store, ctx.agentId, { trigger }, replaces);
        if (refused) return { content: refused, isError: true };
        const elsewhere = resultsGoTo(args, ctx, options.chats(agentId), replaces ? options.store.get(replaces) : null);
        if (typeof elsewhere === "string") return { content: elsewhere, isError: true };
        const input: JobInput = {
          agentId,
          name,
          trigger,
          payload,
          target: { gatewayId: ctx.gatewayId, chatId: ctx.chatId },
          ...(args.once === true || elsewhere ? { delivery: { mode: "announce" as const, ...(args.once === true ? { once: true as const } : {}), ...elsewhere } } : {}),
          createdBy: `agent:${ctx.agentId}`,
          proposal: proposalFor(ctx.agentId, { gatewayId: ctx.gatewayId, chatId: ctx.chatId, senderId: ctx.senderId }, now(), replaces),
        };
        const job = options.store.create(input);
        const posted = await options.post(job);
        const page = options.linkFor?.(ctx, { kind: "schedule", job: job.id });
        return {
          content:
            `Proposed as ${job.id}.${elsewhere ? ` Each run's result goes to ${describeAddress(options.chats(agentId), elsewhere)}, not here.` : ""} It stays off until a person turns it on ` +
            (posted ? "from its card here" : "from the Automations page (its card could not be posted here)") +
            `. Say so in one line; do not ask them again.${page ? ` Its page: ${page}` : ""}`,
          isError: false,
          page: pagePath({ kind: "schedule", job: job.id }),
        };
      } catch (err) {
        if (err instanceof CronValidationError || (err as Error)?.name === "CronParseError") return { content: `Not proposed: ${(err as Error).message}`, isError: true };
        throw err;
      }
    },
  };
}
