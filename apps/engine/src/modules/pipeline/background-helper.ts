/**
 * A helper that works in the background (0.7.15): `delegate` with `background: true`.
 *
 * The parent hands it a brief and its turn ends at once, so the person can talk to it meanwhile; the helper is a job of
 * its own (`jobs/helper-jobs.ts`), and when it ends its handoff wakes the parent in the chat that started it, through
 * the road every job's end takes (`job-wakes.ts`). Each helper is a job with a wake of its own, so two running are
 * reported one by one, each as it finishes — no barrier (owner, 2026-10-18: "kalau selesai 1 ya proses 1, lalu menunggu
 * lagi").
 *
 * It is the foreground helper's turn (`subagent.ts`), run on a clock of its own rather than the parent's:
 *
 * - **The parent's whole budget**, rounds and wall clock, not half: it is not an errand inside a turn somebody waits on,
 *   it is a turn of the parent's that nobody does. `job_max_ms`, when the operator sets one, stops it like any job —
 *   and the helper wraps up before it rather than being cut off with nothing to say.
 * - **Its own slot, not one of the chats'.** It holds none under `[queue] max_concurrent_turns`: it exists so the parent
 *   stays free for the person, and one that took a chat's slot would be the thing keeping them waiting. What bounds
 *   helpers is `[delegate] max_background`, per agent.
 * - **Its steps go to its job's log**, as they happen. The turn that started it has ended, so they are not rows of that
 *   turn; the log is what `nouride jobs log` and the dashboard read, and what is left when a restart cuts it off.
 * - **Its approvals ask in the parent's chat**, naming it and its goal — nobody is watching it, and a question with no
 *   name on it reads as the parent asking. Unanswered, the question expires and the helper stops there and says so.
 * - **It makes room for the machine** (0.8.0): while the box is busy (`commons/box-load.ts`) it waits before it starts,
 *   and says so in its log — `HELPER_ROOM_MS` at most. A helper in the foreground is part of a turn somebody is waiting
 *   for, and never waits.
 */

import { childSessionId, createLogger, resolveMaxBackground, resolveToolIterations, resolveTurnDurationMs, toUserMessage, type LoadedAgent, type ToolContext } from "@nouride/shared";
import type { ApprovalGate } from "@/modules/tools/approval.ts";
import type { BackgroundStart, HelperView, SubagentRequest } from "@/modules/tools/builtins/delegate.ts";
import { goalLine, renderBrief, type HelperBrief } from "@/modules/tools/builtins/delegate-brief.ts";
import { buildHandoff } from "@/modules/tools/handoff.ts";
import type { HelperOutcome, RunningHelper } from "@/modules/jobs/helper-jobs.ts";
import type { JobRecord } from "@/modules/jobs/jobs.store.ts";
import { logLine, quotable, sayingWho, stopped } from "./background-turn.ts";
import { helperAgent, helperExecutor, helperRunsOn, helperTurn } from "./subagent.ts";
import { delegateNote, leadNudgeText, nudgeBaseMs, sinceSaid, watchTurn } from "./budget-nudges.ts";
import type { TurnContext } from "./turn-context.ts";
import { beginDelegated, type DelegatedEnd } from "./delegated-turn.ts";
import { RoomWait } from "@/commons/room-wait.ts";

const log = createLogger("pipeline.background-helper");

/**
 * The most a helper waits for room on a busy box before it starts anyway — a design constant, not a measurement. Ten
 * minutes gives a build, a test run or an install room to finish, and no longer: the person who asked is waiting for the
 * helper's answer, only not watching it.
 */
const HELPER_ROOM_MS = 10 * 60_000;

/** Start one, or say why not. Synchronous: the turn that asked ends right after, with what it started. */
export function startBackgroundHelper(ctx: TurnContext, request: SubagentRequest): BackgroundStart {
  const jobs = ctx.deps.jobs;
  const parent = ctx.deps.registry.get(request.ctx.agentId);
  if (!jobs || !parent) return { refused: "unavailable", reason: "This process cannot run background helpers. Leave `background` off to run it in the foreground." };

  // Read now, so a change from the dashboard applies to the next one started.
  const limit = resolveMaxBackground(parent.config.maxBackgroundHelpers, ctx.deps.config.delegate.maxBackground);
  if (limit === 0) return { refused: "off" };
  // Counted against the day's caps like any turn: refused before it starts rather than discovered after it spent.
  const budget = ctx.checkSpend();
  if (budget.action === "refuse") return { refused: "unavailable", reason: budget.message };

  const here = (job: JobRecord): HelperView => helperView(job, request.ctx);
  const outcome = jobs.startHelper({
    agentId: parent.config.id,
    gatewayId: request.ctx.gatewayId,
    chatId: request.ctx.chatId,
    cwd: ctx.workspaceFor(parent.config.id).shared,
    brief: request.brief,
    ...(request.ctx.turnId ? { turnId: request.ctx.turnId } : {}),
    senderId: request.ctx.senderId,
    limit,
    run: (job) => runBackgroundHelper(ctx, parent, request, job),
  });
  if ("started" in outcome) return { started: here(outcome.started), running: jobs.backgroundTurns(parent.config.id).map(here) };
  if (outcome.refused === "duplicate") return { refused: "duplicate", running: here(outcome.running) };
  return { refused: "limit", limit: outcome.limit, running: outcome.running.map(here) };
}

/**
 * A running helper — or an ask in the background, by its job line — as a tool says it, and whether it was started from
 * the conversation asking: `delegate`'s list and refusals, and `ask_agent`'s (`background-ask.ts`).
 */
export function helperView(job: JobRecord, at: Pick<ToolContext, "gatewayId" | "chatId">): HelperView {
  return { id: job.id, goal: job.brief ? goalLine(job.brief) : job.command, startedAt: job.startedAt, here: job.gatewayId === at.gatewayId && job.chatId === at.chatId };
}

/**
 * Its turn, to the end: run as the parent, on the parent's whole budget, and handed back as a handoff.
 *
 * Its own signal — a stop, the deadline, a shutdown — not the parent's, whose turn ended when this started. And the
 * daemon's pause, so a shutdown stops it at a step like any turn: then it is handed back `paused`, and the next boot
 * closes it as interrupted and wakes the parent with what it had done.
 */
async function runBackgroundHelper(ctx: TurnContext, parent: LoadedAgent, request: SubagentRequest, job: RunningHelper): Promise<HelperOutcome> {
  const jobMs = ctx.deps.config.security.jobMaxMs;
  const queuedAt = Date.now();
  if (!(await roomFor(ctx, job, jobMs))) return { report: stopped(parent.config.id, queuedAt, job.signal.reason) };
  const startedAt = Date.now();
  const budget = resolveToolIterations(parent.config.llm.maxToolIterations, ctx.deps.config.llm.limits.maxToolIterations);
  const blank = helperAgent(parent, { budget, background: true });
  const turnMs = resolveTurnDurationMs(parent.config.llm.maxTurnDurationMs, ctx.deps.config.llm.limits.maxTurnDurationMs);
  const deadlineAt = helperDeadline({ queuedAt, startedAt, turnMs, jobMs });
  // Its own clock, as a turn has one (`turn.ts`): the wrap-up comes a reserve before it, and this is what stops a turn
  // that did not wrap up. Stopped too, with the reason given, when its job is.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("deadline"), deadlineAt - startedAt);
  job.signal.addEventListener("abort", () => controller.abort(job.signal.reason), { once: true });
  // Run long, it is told to stop and report if stuck, and the parent hears how long it has run (`budget-nudges.ts`).
  const nudges = watchTurn(nudgeBaseMs(ctx.deps.config.agents.nudgeAfterMinutes), delegateNote, (nudge) => {
    job.log(`· ${sinceSaid(nudge.dueMs)} in: asked to report if stuck`);
    ctx.nudgeLead?.(job.id, leadNudgeText({ who: "Your background helper", task: quotable(request.brief.goal), ms: nudge.dueMs, job: job.id }));
  });

  // A child of the parent's conversation, as a foreground helper's is: its spilled output lands where the parent opens it.
  const sessionId = childSessionId(request.ctx.sessionId, "sub");
  // Its own turn record (0.7.26), beside its log: its steps, the nudges it read and its report, read like a chat turn's.
  const record = beginDelegated(ctx.deps.turns, {
    via: "delegate",
    by: parent.config.id,
    job,
    ...(request.ctx.turnId ? { parent: request.ctx.turnId } : {}),
    sessionId,
    gatewayId: request.ctx.gatewayId,
    chatId: request.ctx.chatId,
    senderId: request.ctx.senderId,
    prompt: renderBrief(request.brief),
  });
  const executor = helperExecutor(ctx, parent, request, {
    onActivity: (kind, text, detail) => {
      const line = logLine(kind, text);
      if (line) job.log(line);
      record?.step(kind, text, detail);
    },
    onRequest: (line) => record?.context(line),
    approvals: askingFor(ctx.deps.approvals, job.id, request.brief.goal),
  });
  /** How it ended, written to its record too — whichever way out it took. */
  const ended = (outcome: HelperOutcome, result?: DelegatedEnd["result"]): HelperOutcome => {
    record?.finish(outcome, { ...(result ? { result } : {}), model: helperRunsOn(ctx, parent, request), stopped: controller.signal.aborted });
    return outcome;
  };
  try {
    const result = await executor.run({
      ...helperTurn(ctx, blank, request, sessionId, { notes: namedFiles(ctx, request), background: true }),
      signal: controller.signal,
      deadlineAt,
      // The turn that started it, for its calls' audit rows and its usage (D2). Not its call ids: its steps are not
      // that turn's rows, which ended when this started.
      ...(request.ctx.turnId ? { turnId: request.ctx.turnId } : {}),
      pause: () => ctx.paused,
      ...(nudges ? { harnessNote: nudges.take } : {}),
    });
    const report = buildHandoff({ agentId: parent.config.id, startedAt, result, aborted: controller.signal.aborted });
    // Stopped at a step for a shutdown: what it did is kept, and it says it was not finished — the next boot reports it.
    if (result.paused) return ended({ report: { ...report, status: "incomplete", reason: "a restart stopped it before it finished" }, paused: true }, result);
    return ended({ report }, result);
  } catch (err) {
    // Stopped in the middle of a call — a stop, its clock, a shutdown: what happened is the stop, not the abort the call
    // threw on its way out, which would read as the helper having failed.
    if (controller.signal.aborted) {
      log.info("a background helper was stopped mid-call", { job: job.id, agent_id: parent.config.id, why: String(controller.signal.reason) });
      return ended({ report: stopped(parent.config.id, startedAt, controller.signal.reason) });
    }
    log.warn("a background helper's turn threw", { job: job.id, agent_id: parent.config.id, error: String(err) });
    return ended({ report: buildHandoff({ agentId: parent.config.id, startedAt, error: toUserMessage(err) }) });
  } finally {
    clearTimeout(timer);
    nudges?.stop();
  }
}

/**
 * When its turn's clock runs out: the turn's whole duration from when it started — a wait for room is not taken from
 * it — and never past `job_max_ms` from when its job did, the deadline the job itself keeps, so it wraps up before that
 * stops it. Pure.
 */
export function helperDeadline(at: { queuedAt: number; startedAt: number; turnMs: number; jobMs: number }): number {
  const own = at.startedAt + at.turnMs;
  return at.jobMs > 0 ? Math.min(own, at.queuedAt + at.jobMs) : own;
}

/**
 * Room on the box before it starts: waits while the machine is busy, its log saying why and when it goes on. True to
 * start; false when it was stopped while it waited — a kill, the deadline, a shutdown.
 */
async function roomFor(ctx: TurnContext, job: RunningHelper, jobMs: number): Promise<boolean> {
  if (!ctx.deps.load) return true;
  const room = new RoomWait(ctx.deps.load, {
    what: `background helper ${job.id}`,
    // Never more than half of `job_max_ms`, so a helper it bounds still has the other half to work in.
    ceilingMs: jobMs > 0 ? Math.min(HELPER_ROOM_MS, jobMs / 2) : HELPER_ROOM_MS,
    ...(ctx.deps.roomCheckMs ? { everyMs: ctx.deps.roomCheckMs } : {}),
    tell: job.log,
  });
  return await room.wait(job.signal);
}

/**
 * The approval gate, saying who asks: a helper nobody is watching, and what it is for. Its question goes to the
 * parent's chat like any of the parent's — answerable there, from the CLI and from the dashboard, and kept across a
 * restart (D8) — with the helper and its goal in the reason, which every surface shows and the row keeps.
 */
function askingFor(gate: ApprovalGate, jobId: string, goal: string): ApprovalGate {
  // The goal is the model's words, in a question a person answers: one line, short, and unable to close its own quotes.
  const who = `a background task (${jobId}: "${quotable(goal)}") wants to run this`;
  return sayingWho(gate, () => who);
}

/**
 * The conversation's files the brief names, with where each is — the daemon adds what the parent cannot be expected to
 * restate. Matched by name, in the files this conversation holds; the helper opens them with `read` as the parent does.
 */
function namedFiles(ctx: TurnContext, request: SubagentRequest): string[] {
  const index = ctx.deps.attachmentIndex;
  // Only the copies under the parent's own directory for this conversation: the one the helper's sandbox opens.
  const root = ctx.deps.attachments?.rootFor({ agentId: request.ctx.agentId, gatewayId: request.ctx.gatewayId, chatId: request.ctx.chatId });
  if (!index || !root) return [];
  return filesNamedIn(request.brief, index.recent(request.ctx, 50), root);
}

/** The note naming them: each file whose name the brief says, kept under `root`, with its path. Nothing when none is. */
export function filesNamedIn(brief: HelperBrief, files: readonly { name: string; localPath?: string }[], root: string): string[] {
  const text = `${brief.goal}\n${brief.context}\n${brief.constraints ?? ""}\n${brief.deliverable}`.toLowerCase();
  const named = files.filter((file) => file.localPath?.startsWith(root) && file.name.length > 2 && text.includes(file.name.toLowerCase()));
  if (named.length === 0) return [];
  return [["FILES FROM THE CONVERSATION", ...named.map((file) => `- ${file.name}: ${file.localPath}`)].join("\n")];
}
