/**
 * `schedule` — work that runs later, proposed (0.8.0, SMART_AUTOMATION §2). The agent writes the job whole; a person
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
import type { CronPort, JobInput } from "@/modules/cron/cron.store.ts";
import { proposalFor, proposalRefusal } from "@/modules/cron/proposals.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { briefFilesOf } from "@/modules/missions/start.ts";
import type { LinkFor } from "@/modules/web/links.ts";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";

export interface ScheduleToolOptions {
  store: CronPort;
  /** `[daemon] timezone`: what a time with no zone means. */
  timezone: () => string;
  /** Whether an agent of this id exists, for one proposed for another agent. */
  agentExists: (agentId: string) => boolean;
  /** Post its card in the chat it was asked in. False when it could not be said there. */
  post: (job: Job) => Promise<boolean>;
  /** The job's card on the Schedule page, where a link goes into this chat (`web/links.ts`, 0.8.11). */
  linkFor?: LinkFor;
  /** A brief file's text, or null where it cannot be read — what a mission's start reads (`boot/missions.ts`). */
  readBrief?: (path: string) => string | null;
  now?: () => number;
}

const DESCRIPTION =
  "Propose work that runs later: on a schedule, or when a webhook is called. It stays off until a person turns it on " +
  "from the card this posts here. Say so in one line. Use it for anything asked at a time or again and again. The " +
  "cheapest that does the job: `text` is sent as written, `command` runs a shell line, `prompt` is one turn of yours, " +
  "`mission` is long work that is checked. To change a job, propose it again with `replaces`.";

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

function payloadOf(args: Record<string, unknown>): JobPayload | string {
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
    case "every":
      return parseScheduleInput({ every: value }, now, timezone);
    case "at":
      return parseScheduleInput({ at: value, ...zone }, now, timezone);
    case "cron":
      return parseScheduleInput({ cron: value, ...zone }, now, timezone);
    default:
      throw new CronValidationError('`when` starts with `every`, `at`, `cron` or is `webhook`: "every 15m", "cron 0 9 * * 1-5".');
  }
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
          when: { type: "string", description: '"every 15m", "cron 0 9 * * 1-5", "at 2026-11-02 09:00", or "webhook".' },
          tz: { type: "string", description: "The zone for `cron` and `at`." },
          text: { type: "string", description: "A reminder, sent as written." },
          command: { type: "string", description: "A shell line; what it prints is sent, and nothing at all when it prints nothing." },
          prompt: { type: "string", description: "What you are woken with, in English, and whole: a run starts with none of this conversation." },
          mission: { type: "string", description: "Long work: each run's goal, as `mission` takes one." },
          checks: { type: "array", items: { type: "string" }, description: "Mission: commands that say a run is done." },
          review: { type: "string", description: "Mission: what the reviewer checks." },
          no_review: { type: "boolean", description: "Mission: no reviewer." },
          agent: { type: "string", description: "Another agent runs it." },
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
      const payload = payloadOf(args);
      if (typeof payload === "string") return { content: payload, isError: true };
      // Each run is started as the person who turned the job on, so a run's start does not read the brief its goal
      // points at, as an agent's own start does (D6): it is read here, while the agent that wrote it is here to fix it.
      if (payload.kind === "mission" && options.readBrief) {
        for (const path of briefFilesOf(payload.goal)) {
          const text = options.readBrief(path);
          if (text !== null && !workTextIsEnglish(text)) return { content: writeWorkInEnglish(`The brief file ${path}, which the goal points at,`), isError: true };
        }
      }
      try {
        const trigger = triggerOf(String(args.when ?? ""), typeof args.tz === "string" ? args.tz : undefined, now(), options.timezone());
        // A command a call from outside sets off, with no model between, is an admin's to make from the dashboard.
        if (trigger.kind === "webhook" && payload.kind === "command") {
          return { content: "A webhook that runs a command is made by an admin from the dashboard, not proposed.", isError: true };
        }
        const replaces = typeof args.replaces === "string" && args.replaces.trim() ? args.replaces.trim() : undefined;
        const refused = proposalRefusal(options.store, ctx.agentId, { trigger }, replaces);
        if (refused) return { content: refused, isError: true };
        const input: JobInput = {
          agentId,
          name,
          trigger,
          payload,
          target: { gatewayId: ctx.gatewayId, chatId: ctx.chatId },
          createdBy: `agent:${ctx.agentId}`,
          proposal: proposalFor(ctx.agentId, { gatewayId: ctx.gatewayId, chatId: ctx.chatId, senderId: ctx.senderId }, now(), replaces),
        };
        const job = options.store.create(input);
        const posted = await options.post(job);
        const page = options.linkFor?.(ctx, { kind: "schedule", job: job.id });
        return {
          content:
            `Proposed as ${job.id}. It stays off until a person turns it on ` +
            (posted ? "from its card here" : "from the Schedule page (its card could not be posted here)") +
            `. Say so in one line; do not ask them again.${page ? ` Its card on the Schedule page: ${page}` : ""}`,
          isError: false,
        };
      } catch (err) {
        if (err instanceof CronValidationError || (err as Error)?.name === "CronParseError") return { content: `Not proposed: ${(err as Error).message}`, isError: true };
        throw err;
      }
    },
  };
}
