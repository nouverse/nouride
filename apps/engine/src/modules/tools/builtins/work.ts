/**
 * `work` — what an agent can see and do about its own work (0.8.7): its missions, its background jobs and its
 * approvals. Answered by the daemon from its own tables, scoped to the calling agent: a mission it works or started, a
 * job whose row is its own (its `ask_agent` asks included), an approval it raised. Nothing here reads a config file,
 * and nothing reaches another agent's items — an id that is not the caller's reads as one that does not exist.
 *
 * Before it, an agent that wanted to know how its mission stood read `config.toml` for the control token and called the
 * API with it, or asked a person to look.
 */

import { type ApprovalRequest, clip, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import type { JobRecord, JobsPort } from "@/modules/jobs/jobs.store.ts";
import type { Missions } from "@/modules/missions/missions.ts";
import type { KeptPlan } from "@/modules/notes/store.ts";
import { doneWhen, shortId } from "@/modules/missions/page.ts";
import { isFinal, type Mission } from "@/modules/missions/types.ts";
import { describeApprovalParams } from "@/modules/pipeline/messages.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import type { SqliteApprovalGate } from "@/modules/tools/approvals.store.ts";
import type { LinkFor } from "@/modules/web/links.ts";
import type { AuditPort } from "@/commons/audit.store.ts";
import { isDraft } from "@/modules/missions/drafts.ts";
import { pressRefusal } from "@/modules/missions/actions.ts";

export interface WorkToolDeps {
  missions: Pick<Missions, "ownedBy" | "find" | "stop" | "answer" | "acceptOutside" | "tell" | "now" | "limitsLine" | "accept">;
  /** Who is speaking in the chat a turn answers: their name in People, if it has them, and whether they are an admin (`tell`, 0.8.10). */
  speaker?: (who: { gatewayId: string; senderId: string }) => { name?: string; admin: boolean };
  /** A mission's checklist, as its turns keep it — where it stands, step by step. */
  plan?: (mission: Mission) => KeptPlan | undefined;
  jobs: Pick<JobsPort, "list" | "get" | "tail" | "kill">;
  approvals: Pick<SqliteApprovalGate, "pending" | "settled" | "get">;
  /** A dashboard link for this chat (`web/links.ts`, 0.8.11): a mission's page, where an approval is answered. */
  linkFor?: LinkFor;
  /** Where a draft started on a person's word passed on is recorded, with the words (0.8.11). */
  audit?: Pick<AuditPort, "record">;
}

const ACTIONS = ["missions", "mission", "start", "stop", "answer", "accept_outside", "tell", "jobs", "job", "kill", "approvals", "approval"] as const;
type Action = (typeof ACTIONS)[number];

const LISTED = 20;
const LOG_BYTES = 4_000;

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function refused(content: string): ToolResult {
  return { content, isError: true };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m ago` : `${minutes}m ago`;
}

/** The caller's own: the mission it works, or one it started for someone. */
function ownsMission(mission: Mission, agentId: string): boolean {
  return mission.agentId === agentId || mission.byAgent === agentId;
}

function missionState(mission: Mission): string {
  return mission.status === "waiting" ? `waiting for a person (${mission.waitKind ?? "?"})` : mission.status;
}

function missionLine(mission: Mission): string {
  const by = mission.agentId === mission.byAgent || mission.byAgent === null ? "" : ` · started by ${mission.byAgent}`;
  return `${shortId(mission.id)} · ${mission.agentId}${by} · ${missionState(mission)} · ${clip(mission.goal, 100)}`;
}

const STEP_MARK = { done: "✓", active: "●", skipped: "–", pending: "○" } as const;

/**
 * Its checklist, a line a step with what the step left. The chat agent was asked "how far is it?" on the live box and
 * could only say the checklist was in a folder its user cannot read.
 */
function checklist(plan: KeptPlan | undefined): string[] {
  if (!plan || plan.steps.length === 0) return ["Checklist: none written yet."];
  const done = plan.steps.filter((step) => step.state === "done" || step.state === "skipped").length;
  return [`Checklist: ${done} of ${plan.steps.length} steps done`, ...plan.steps.map((step, index) => `${STEP_MARK[step.state]} ${index + 1}. ${step.text}${step.note ? `: ${clip(step.note, 200)}` : ""}`)];
}

function missionDetail(mission: Mission, limits: string, plan: KeptPlan | undefined, page: string | null): string {
  const lines = [
    `${mission.id} · ${mission.agentId} · ${missionState(mission)}`,
    ...(page ? [`Page: ${page}`] : []),
    `Goal: ${mission.goal}`,
    `Done when: ${doneWhen(mission)}.`,
    limits,
    `Folder: ${mission.workdir}`,
    ...checklist(plan),
  ];
  if (mission.parentId) lines.push(`Part of: ${shortId(mission.parentId)}`);
  if (mission.reason) lines.push(`${mission.status === "waiting" ? "Waiting for" : "Why"}: ${mission.reason}`);
  const asked = mission.answers.at(-1);
  if (asked) lines.push(`Last question: "${asked.question}" → ${asked.answer ? `"${asked.answer}"` : "no answer yet"}`);
  if (mission.lastCheck) lines.push(`Last check failed:\n${mission.lastCheck}`);
  if (mission.report) lines.push(`Report: ${mission.report}`);
  return lines.join("\n");
}

function jobLine(job: JobRecord, now: number): string {
  const what = job.kind === "ask" && job.ask ? `ask ${job.ask.agent}: ${clip(job.ask.task, 100)}` : job.kind === "helper" && job.brief ? `helper: ${clip(job.brief.goal, 100)}` : clip(job.command, 100);
  return `${job.id} · ${job.kind} · ${job.status} · ${ago(job.startedAt, now)} · ${what}`;
}

/** The brief a job was given, whole — what a helper or an asked agent was told, to hold its report against. */
function jobBrief(job: JobRecord): string {
  if (job.kind === "ask" && job.ask) return `Asked ${job.ask.agent}:\n${job.ask.task}`;
  if (job.kind === "helper" && job.brief) {
    const { goal, context, constraints, deliverable } = job.brief;
    return [`Goal: ${goal}`, `Context: ${context}`, ...(constraints ? [`Constraints: ${constraints}`] : []), `Deliverable: ${deliverable}`].join("\n");
  }
  return `Command: ${job.command}\nIn: ${job.cwd}`;
}

function approvalLine(request: ApprovalRequest, now: number): string {
  const what = describeApprovalParams(request);
  const how = request.status === "pending" ? `pending, ${ago(request.requestedAt, now)}` : `${request.decision ?? request.status}${request.resolvedBy ? ` by ${request.resolvedBy}` : ""}, ${ago(request.resolvedAt ?? request.requestedAt, now)}`;
  return `${request.id} · ${request.tool}${what ? ` ${clip(what, 160)}` : ""} · ${how}`;
}

function approvalDetail(request: ApprovalRequest, now: number, answerAt: string | null): string {
  return [
    approvalLine(request, now),
    ...(answerAt ? [`Answer it: ${answerAt}`] : []),
    `Asked in: ${request.gateway} ${request.chatId}`,
    ...(request.reason ? [`Why it asked: ${request.reason}`] : []),
    `Parameters: ${JSON.stringify(request.params)}`,
  ].join("\n");
}

export function createWorkTool(deps: WorkToolDeps): Tool {
  const now = () => deps.missions.now();

  /** The caller's mission by id, or the refusal that says there is none — another agent's reads the same. */
  const ownMission = (id: string, ctx: ToolContext): Mission | ToolResult => {
    const mission = id ? deps.missions.find(id) : null;
    return mission && ownsMission(mission, ctx.agentId) ? mission : refused(id ? `No mission ${id} of yours.` : "Name the mission: `id`.");
  };

  const ownJob = (id: string, ctx: ToolContext): JobRecord | ToolResult => {
    const job = id ? deps.jobs.get(id) : null;
    return job && job.agentId === ctx.agentId ? job : refused(id ? `No job ${id} of yours.` : "Name the job: `id`.");
  };

  const act = async (action: Action, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const id = text(args.id);
    const by = `agent ${ctx.agentId}`;
    switch (action) {
      case "missions": {
        const mine = deps.missions.ownedBy(ctx.agentId, LISTED);
        if (mine.length === 0) return ok("You have no missions.");
        const open = mine.filter((mission) => !isFinal(mission.status));
        const ended = mine.filter((mission) => isFinal(mission.status));
        return ok([...open.map(missionLine), ...(ended.length ? ["Ended:", ...ended.map(missionLine)] : [])].join("\n"));
      }
      case "mission": {
        const mission = ownMission(id, ctx);
        return "id" in mission ? ok(missionDetail(mission, deps.missions.limitsLine(mission), deps.plan?.(mission), deps.linkFor?.(ctx, { kind: "mission", id: mission.id }) ?? null)) : mission;
      }
      case "stop": {
        const mission = ownMission(id, ctx);
        if (!("id" in mission)) return mission;
        const acted = deps.missions.stop(mission.id, by);
        return "refused" in acted ? refused(acted.refused) : ok(`Mission ${shortId(mission.id)} stopped.`);
      }
      case "answer": {
        const mission = ownMission(id, ctx);
        if (!("id" in mission)) return mission;
        const acted = deps.missions.answer(mission.id, text(args.text), by);
        return "refused" in acted ? refused(acted.refused) : ok(`Answered; mission ${shortId(mission.id)} goes on.`);
      }
      case "accept_outside": {
        const mission = ownMission(id, ctx);
        if (!("id" in mission)) return mission;
        const acted = deps.missions.acceptOutside(mission.id, text(args.text), by);
        return "refused" in acted ? refused(acted.refused) : ok(`Mission ${shortId(mission.id)} closed as done outside its checks.`);
      }
      case "start": {
        // A draft started on the person's "go" (0.8.11): their words, passed on in the turn their
        // own message started, under `tell`'s guards — never the agent's own decision, which is what a draft waits out.
        if (ctx.gatewayId === MISSION_GATEWAY_ID || ctx.askedBy || ctx.unattended || ctx.senderId === SYSTEM_SENDER) {
          return refused("A draft starts on a person's word, passed on in the turn their own message started, not from a mission's turn, another agent's ask or a scheduled run.");
        }
        const mission = ownMission(id, ctx);
        if (!("id" in mission)) return mission;
        if (!isDraft(mission)) return refused(`Mission ${shortId(mission.id)} is not a draft waiting to start: it is ${missionState(mission)}.`);
        const words = text(args.text);
        if (!words) return refused("`start` needs `text`: the person's own words that said to start it, as they wrote them.");
        const known = deps.speaker?.({ gatewayId: ctx.gatewayId, senderId: ctx.senderId });
        if (!known) return refused("Who is speaking cannot be told here. The person can tap Start it, or use /mission accept where the draft is.");
        const speaker = { ...known, name: known.name ?? ctx.senderName?.trim() ?? ctx.senderId };
        // Who may start it is who may tap its Start it: its own chat, and in a room the person who drafted it or an admin.
        const refusal = pressRefusal(mission, { gatewayId: ctx.gatewayId, chatId: ctx.chatId, chatType: ctx.chatType, senderId: ctx.senderId }, () => speaker.admin);
        if (refusal) return refused(refusal);
        const acted = deps.missions.accept(mission.id, speaker.name, { gatewayId: ctx.gatewayId, senderId: ctx.senderId });
        if ("refused" in acted) return refused(acted.refused);
        deps.audit?.record({ action: "mission_started", actor: speaker.name, agentId: mission.agentId, details: { mission: mission.id, via: `agent ${ctx.agentId}`, said: words } });
        return ok(`Mission ${shortId(mission.id)} started on ${speaker.name}'s word: "${words}". It runs on its own and reports to this chat; do not do the work here as well.`);
      }
      case "tell": {
        // A person's words passed on, never the agent's own (0.8.10): not from a mission's own
        // turn — whose context carries its starter's id, so it could tell itself as them — not an agent asking another,
        // not a schedule's, a job's or anybody's turn nobody watches.
        if (ctx.gatewayId === MISSION_GATEWAY_ID || ctx.askedBy || ctx.unattended || ctx.senderId === SYSTEM_SENDER) {
          return refused("Only a person's words are told to a mission, passed on in the turn their own message started, not from a mission's turn, another agent's ask or a scheduled run.");
        }
        const mission = ownMission(id, ctx);
        if (!("id" in mission)) return mission;
        const known = deps.speaker?.({ gatewayId: ctx.gatewayId, senderId: ctx.senderId });
        if (!known) return refused("Who is speaking cannot be told here. The person can use /mission tell where the mission reports.");
        // As People names them, else as the chat does — `/mission tell` writes the chat's name — and the id last.
        const speaker = { ...known, name: known.name ?? ctx.senderName?.trim() ?? ctx.senderId };
        // The rule `/mission` holds every verb to: the person who started it, or an admin.
        if (mission.startedBy !== ctx.senderId && !speaker.admin) {
          return refused(`Only the person who started mission ${shortId(mission.id)}, or an admin, can tell it something, and ${speaker.name} is neither.`);
        }
        const told = deps.missions.tell(mission.id, text(args.text), speaker.name, ctx.agentId);
        return "refused" in told ? refused(told.refused) : ok(`${told.said} Recorded as ${speaker.name}'s words, passed on by you.`);
      }
      case "jobs": {
        const mine = deps.jobs.list({ agentId: ctx.agentId, limit: LISTED });
        return ok(mine.length === 0 ? "You have no background jobs." : mine.map((job) => jobLine(job, now())).join("\n"));
      }
      case "job": {
        const job = ownJob(id, ctx);
        if (!("id" in job)) return job;
        const log = await deps.jobs.tail(job.id, LOG_BYTES);
        const report = job.report ? `\nReport (${job.report.status}): ${job.report.summary}` : "";
        return ok(`${jobLine(job, now())}\n${jobBrief(job)}${report}\n--- log ---\n${log || "(empty)"}`);
      }
      case "kill": {
        const job = ownJob(id, ctx);
        if (!("id" in job)) return job;
        return deps.jobs.kill(job.id, by) ? ok(`Job ${job.id} stopped.`) : refused(`Job ${job.id} is not running (${job.status}).`);
      }
      case "approvals": {
        const pending = deps.approvals.pending(ctx.agentId);
        const settled = deps.approvals.settled({ agentId: ctx.agentId, limit: LISTED });
        const lines = [
          pending.length > 0 ? "Pending:" : "Pending: none.",
          ...pending.map((request) => approvalLine(request, now())),
          settled.length > 0 ? "Answered:" : "Answered: none kept.",
          ...settled.map((request) => approvalLine(request, now())),
        ];
        return ok(lines.join("\n"));
      }
      case "approval": {
        const request = id ? deps.approvals.get(id) : null;
        if (!request || request.agentId !== ctx.agentId) return refused(id ? `No approval ${id} of yours.` : "Name the approval: `id`.");
        // A call a mission parked is answered on its page; any other, on Overview.
        const askedOn: string = request.gateway;
        const answerAt = deps.linkFor?.(ctx, askedOn === MISSION_GATEWAY_ID ? { kind: "mission", id: request.chatId } : { kind: "overview" }) ?? null;
        return ok(approvalDetail(request, now(), answerAt));
      }
    }
  };

  return {
    requiresApproval: false,
    definition: {
      name: "work",
      description:
        "Your own work, as the daemon knows it, and only yours: missions you work or started, your background jobs (`ask_agent` asks " +
        'included), approvals you raised. "missions" lists them; "mission" shows one; "stop" ends one; "answer" answers its ' +
        'question (`text`); "start" starts a draft of yours when the person you are talking to says to (their own words in ' +
        '`text`); "accept_outside" closes one as done outside its checks, with a `text` note, when the work landed ' +
        'another way. "tell" passes on, word for word, what the person you are talking to wants a running mission of yours to ' +
        'know (`text`): only their words, from their own message; it reaches the mission\'s turn before its next step and ' +
        'never changes its goal. "jobs" lists jobs; "job" shows one with its brief and log; "kill" stops one. "approvals" lists pending and ' +
        'answered; "approval" shows one. Use this rather than reading config files or calling the API.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          id: { type: "string", description: "The mission, job or approval id (a mission's short id works)." },
          text: { type: "string", description: "answer: the answer. accept_outside: the note saying where it was done. tell, start: the person's words." },
        },
        required: ["action"],
      },
    },
    async execute(args, ctx) {
      const action = ACTIONS.find((one) => one === args.action);
      if (!action) return refused(`\`action\` is one of ${ACTIONS.join(", ")}.`);
      return await act(action, args, ctx);
    },
  };
}
