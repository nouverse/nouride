/**
 * One subagent, run as its parent — in the foreground here; in the background, `background-helper.ts`, from the same
 * parts. One waited on may move there once it outlasts `delegate`'s wait (`startSubagent`).
 *
 * Separate from the ordinary turn because almost nothing is shared: no session, no persona, no
 * history, no slash commands. What it *does* share is the parent's identity — the same agent id, so
 * exec grants, tool grants and the approval gate all recognise it, and the same workspace, so work it
 * produces lands where the parent will look for it.
 */

import { readOnlyToolset } from "@/modules/tools/read-only.ts";
import { changesSharedTools } from "@/modules/toolchain/shared-tools.ts";
import { workNotesCopy } from "@/modules/notes/tail.ts";
import { dirname, join } from "@nouride/runtime";
import { childSessionId, resolveToolIterations, resolveTurnDurationMs, tierModel, toUserMessage, type GateDecision, type LoadedAgent, type Tool, type ToolDefinition } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { wrapUpReserveMs } from "@/modules/llm/executor/deadline.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { resolveToolset, writesWhatPromptsRead, type AgentToolset } from "@/modules/tools/registry.ts";
import { helperRole, MOVED_NOTE, type SubagentRequest, type SubagentResult } from "@/modules/tools/builtins/delegate.ts";
import { renderBrief } from "@/modules/tools/builtins/delegate-brief.ts";
import { buildHandoff } from "@/modules/tools/handoff.ts";
import type { HelperOutcome, RunningHelper } from "@/modules/jobs/helper-jobs.ts";
import type { TurnContext } from "./turn-context.ts";
import { delegateNote, leadNudgeText, nudgeBaseMs, sinceSaid, watchTurn } from "./budget-nudges.ts";
import { helperAsking, logLine, quotable, sayingWho, stopped } from "./background-turn.ts";
import { endedAlready, type MovableTurn } from "./background-move.ts";
import { beginDelegated, type DelegatedEnd, type DelegatedTurn } from "./delegated-turn.ts";
import { meter } from "@/modules/llm/metered.ts";
import { contextInto, stepsInto } from "@/modules/turns/recorder.ts";
import { alertOnFallback } from "@/modules/pipeline/fallback-alert.ts";
import { fallbacksFor } from "@/modules/llm/fallbacks.ts";
import { secondLookFor } from "@/modules/tools/second-look.ts";

/**
 * Run one subagent to completion, as its parent, while the parent's turn waits.
 *
 * The inheritance is the design, and it is expressed by what is *reused* rather than by copying
 * fields: the same agent id (so exec grants, tool grants and the approval gate all recognise it),
 * the same model, provider, workspace and policy. What it does not get is who the parent is — the
 * persona and memory are replaced with a role, and the history starts empty.
 */
export async function runSubagent(ctx: TurnContext, request: SubagentRequest): Promise<SubagentResult> {
  return (await startSubagent(ctx, request).ended).report;
}

/** Where a helper works: waited on, or in the background. Its `exec` reads it at each command, so one that moved runs as it now may. */
export interface HelperMode {
  background: boolean;
}

/**
 * Start one subagent, as its parent, while the parent's turn waits for it. `detachable`: it may move to the background
 * once it outlasts `delegate`'s wait (`background-helper.ts`), and is from then on what a helper started there is:
 *
 * - **Its job's stop, and a clock of its own.** The parent's turn ends without it, so a stop of its job — `/stop`, a
 *   kill, `job_max_ms`, a shutdown — stops it, and its clock is a background helper's (`helperDeadline`). Waited on, it
 *   wraps up a reserve before the parent's, as it always did.
 * - **Its steps are its job's log**, and a turn record of its own; before the move they are the parent turn's rows, and
 *   its job's log begins with them.
 * - **A question it puts to a person names it**, and the parent hears when it has run long.
 * - **It is told it moved**, before its next step (`MOVED_NOTE`): its role said four minutes a command, and its commands
 *   may now take thirty, as a background helper's may.
 *
 * Its round trips stay half the parent's: the number its prompt gave it, which its loop counts from the first round. At
 * the default that is over a hundred, more than work that was a quick question a minute ago will spend.
 */
export function startSubagent(ctx: TurnContext, request: SubagentRequest, options: { detachable?: boolean } = {}): MovableTurn {
  const startedAt = Date.now();
  const parent = ctx.deps.registry.get(request.ctx.agentId);
  if (!parent) return endedAlready(startedAt, buildHandoff({ agentId: request.ctx.agentId, startedAt, error: "the parent agent is no longer loaded" }));

  /**
   * Half of what the parent gets, floored at 3.
   *
   * A subagent is a helper on one narrow job, and the floor is below the global minimum on
   * purpose: it is not an agent somebody talks to, it is a bounded errand, and five would let
   * a cheap helper cost as much as the turn that asked for it. A helper that needs twenty-five round trips has been
   * given a job that wanted breaking up, and the parent is the one that can see that.
   */
  const budget = Math.max(3, Math.floor(resolveToolIterations(parent.config.llm.maxToolIterations, ctx.deps.config.llm.limits.maxToolIterations) / 2));
  const blank = helperAgent(parent, { budget, background: false });
  const mode: HelperMode = { background: false };

  /** The job it runs as once it moved, and its own turn record from then. */
  let job: RunningHelper | undefined;
  let record: DelegatedTurn | undefined;
  /** Its steps while it is waited on, which its job's log begins with if it gets one — until it is known it will not. */
  const before: string[] = [];
  let gathering = options.detachable === true;
  /**
   * Its steps are the parent turn's: written into that turn's stream, marked as a helper's — so the dashboard, `nouride
   * events` and `nouride turns show` account for its calls, where they used to see one opaque `delegate` for minutes.
   * Once it moved, its job's log and its own record: that turn has ended.
   */
  const steps = stepsInto(ctx.deps.turns, request.ctx.turnId, { via: "delegate", by: parent.config.id });
  // And what each of its requests carried, beside them (0.7.26).
  const lines = contextInto(ctx.deps.turns, request.ctx.turnId, { via: "delegate", by: parent.config.id });
  const executor = helperExecutor(ctx, parent, request, {
    // Shown in the parent's conversation, marked as coming from a helper. A tool call the operator
    // did not ask for appearing unattributed is worse than one line of noise.
    onActivity: (kind, text, detail) => {
      const line = logLine(kind, text);
      if (job) {
        if (line) job.log(line);
        record?.step(kind, text, detail);
        return;
      }
      if (gathering && line) before.push(line);
      steps?.(kind, text, detail);
    },
    onRequest: (line) => (job ? record?.context(line) : lines?.(line)),
    approvals: sayingWho(ctx.deps.approvals, () => (job ? helperAsking(job.id, request.brief.goal) : null)),
  });

  const sessionId = childSessionId(request.ctx.sessionId, "sub");
  // Its own stop, which follows the parent turn's — so stopping the turn stops everything it started — until it moves;
  // then its job's.
  const controller = new AbortController();
  const follow = () => controller.abort(request.ctx.signal.reason);
  if (request.ctx.signal.aborted) follow();
  else request.ctx.signal.addEventListener("abort", follow, { once: true });
  /** When it must be done: the parent's clock less the parent's reserve while it is waited on, its own once it moved. */
  const clock = { at: waitedDeadline(ctx, parent, request.ctx.deadlineAt) };
  /** `MOVED_NOTE`, from the move until its next step reads it. */
  let moved: string | null = null;
  /**
   * Run long, it is told to stop and report if stuck (`budget-nudges.ts`). Waited on, the parent waits in a turn of its
   * own, on its own clock and nudges; once it moved, the parent hears how long it has run.
   */
  const nudges = watchTurn(nudgeBaseMs(ctx.deps.config.agents.nudgeAfterMinutes), delegateNote, (nudge) => {
    if (!job) return;
    job.log(`· ${sinceSaid(nudge.dueMs)} in: asked to report if stuck`);
    ctx.nudgeLead?.(job.id, leadNudgeText({ who: "Your background helper", task: quotable(request.brief.goal), ms: nudge.dueMs, job: job.id }));
  });
  const turn: TurnRequest = {
    ...helperTurn(ctx, blank, request, sessionId, { mode }),
    signal: controller.signal,
    // The parent turn's: its calls' audit rows carry it, and their ids are drawn from the turn's own, since their
    // rows are that turn's.
    ...(request.ctx.turnId ? { turnId: request.ctx.turnId, callIds: ctx.callIdsOf(request.ctx.turnId) } : {}),
    // Read at each step and each call (`TurnRequest.deadlineAt`), so a move gives it its own clock.
    get deadlineAt() {
      return clock.at;
    },
    // A shutdown stops one that may move at a step, as it stops any job's turn: one that moved is reported by the next boot.
    ...(options.detachable ? { pause: () => ctx.paused } : {}),
    harnessNote: () => {
      const note = moved ?? nudges?.take() ?? null;
      moved = null;
      return note;
    },
  };

  let settled = false;
  const ended = (async (): Promise<HelperOutcome> => {
    /** How it ended — written to its own record too, once it moved and has one. */
    const close = (outcome: HelperOutcome, result?: DelegatedEnd["result"]): HelperOutcome => {
      record?.finish(outcome, { ...(result ? { result } : {}), model: helperRunsOn(ctx, parent, request), stopped: controller.signal.aborted });
      return outcome;
    };
    try {
      // On the parent's lanes: inside the ceiling, and never stuck waiting on it (`lanes.ts`). One that moves keeps the
      // lane it ran on until it ends, as an asked agent's turn does (`peer-turn.ts`).
      const result = await ctx.inLane(request.ctx.turnId ?? request.ctx.sessionId, () => executor.run(turn));
      // Under the parent's id, because that is who a subagent runs as — the same id its grants, its
      // approvals and its audit rows are keyed on. See `tools/handoff.ts`.
      const report = buildHandoff({ agentId: blank.config.id, startedAt, result, aborted: controller.signal.aborted });
      // Stopped at a step for a shutdown: what it did is kept, and it says it was not finished.
      if (result.paused) return close({ report: { ...report, status: "incomplete", reason: "a restart stopped it before it finished" }, paused: true }, result);
      return close({ report }, result);
    } catch (err) {
      // Stopped in the middle of a call once it is a job — a stop, its clock, a shutdown: what happened is the stop, not
      // the abort the call threw on its way out, which would read as the helper having failed.
      if (job && controller.signal.aborted) return close({ report: stopped(parent.config.id, startedAt, controller.signal.reason) });
      return close({ report: buildHandoff({ agentId: blank.config.id, startedAt, error: toUserMessage(err) }) });
    } finally {
      settled = true;
      nudges?.stop();
      request.ctx.signal.removeEventListener("abort", follow);
    }
  })();

  return {
    startedAt,
    ended,
    done: () => settled,
    // Behind the parent's turn from now on (`background-move.ts`), as if it had been started in the background now.
    detach: (to) => {
      if (settled) return false;
      job = to;
      request.ctx.signal.removeEventListener("abort", follow);
      const stop = () => controller.abort(to.signal.reason);
      if (to.signal.aborted) stop();
      else to.signal.addEventListener("abort", stop, { once: true });
      clock.at = helperDeadline({ queuedAt: startedAt, startedAt, turnMs: turnMsOf(ctx, parent), jobMs: ctx.deps.config.security.jobMaxMs });
      mode.background = true;
      moved = MOVED_NOTE;
      for (const line of before.splice(0)) to.log(line);
      gathering = false;
      // Its own turn from here, read like a chat turn: what it does now is no row of the parent's.
      record = beginDelegated(ctx.deps.turns, {
        via: "delegate",
        by: parent.config.id,
        job: to,
        ...(request.ctx.turnId ? { parent: request.ctx.turnId } : {}),
        sessionId,
        gatewayId: request.ctx.gatewayId,
        chatId: request.ctx.chatId,
        senderId: request.ctx.senderId,
        prompt: renderBrief(request.brief),
      });
      record?.step("note", `moved to the background as ${to.id}${request.ctx.turnId ? ` (its steps before this are turn ${request.ctx.turnId}'s)` : ""}`);
      return true;
    },
    stay: () => {
      gathering = false;
      before.length = 0;
    },
  };
}

/**
 * The parent as one of its helpers: the same agent and config, a role in place of the persona, and its own round-trip
 * budget — on the config, where the loop and the prompt both read it. It was in the daemon's limits, which an agent's
 * own `max_tool_iterations` overrides: a pack that named one gave its helpers the whole of it.
 *
 * The skills' index stays (0.7.15): a helper can follow a skill the parent would, and an index of names and one line
 * each is cheap — the bodies are read from disk when a task needs one, as the parent reads them.
 */
export function helperAgent(parent: LoadedAgent, mode: { budget: number; background: boolean }): LoadedAgent {
  return {
    ...parent,
    persona: { identity: helperRole({ background: mode.background }) },
    config: { ...parent.config, llm: { ...parent.config.llm, maxToolIterations: mode.budget } },
  };
}

/**
 * What a helper may not do, of what its parent may: speak as the parent.
 *
 * `delegate` is removed, which keeps the tree one level deep — recursion would be an unbounded fan-out of provider calls
 * started by a model. `send_file` and `send_message` are removed: a file posted into the chat, or a message into another,
 * is the parent speaking, and what reaches anybody is the parent's call, from the handoff. And it writes no memory, by
 * the same test that holds such a write after outside content (`writesWhatPromptsRead`): the tools that only write are
 * not offered, and a write through one that also reads — a change to a person's notes — is refused at the gate. The
 * parent decides what is kept.
 */
function helperToolset(toolset: AgentToolset, mode: HelperMode): AgentToolset {
  const withheld = (name: string): boolean => WITHHELD.has(name) || toolset.get(name)?.keepsInPrompt === true;
  // Without `delegate` there is nothing to start in the background, and its prompt says nothing of it.
  const { backgroundHelpers: _none, ...rest } = toolset;
  const shown = (definition: ToolDefinition) => (definition.name === "exec" ? inTheForeground(definition, mode) : definition);
  return {
    ...rest,
    definitions: toolset.definitions.filter((definition) => !withheld(definition.name)).map(shown),
    get: (name) => {
      const tool = withheld(name) ? undefined : toolset.get(name);
      return tool && name === "exec" ? foregroundExec(tool, mode) : tool;
    },
    gate: (name, args, toolCtx): GateDecision => {
      const tool = toolset.get(name);
      if (tool && !withheld(name) && writesWhatPromptsRead(tool, args)) {
        return { action: "refuse", reason: "a helper writes no memory. Say in your answer what is worth keeping, and the agent that asked decides" };
      }
      return toolset.gate(name, args, toolCtx);
    },
  };
}

const WITHHELD: ReadonlySet<string> = new Set(["delegate", "send_file", "send_message", "notes"]);

/** `exec`'s options that start a job outliving the call — none of which a helper is given. */
const JOB_OPTIONS: ReadonlySet<string> = new Set(["background", "keep_working", "service", "on_complete"]);

/**
 * How long one command of a helper working in the background may wait, asked for with `timeout_ms`. Its own clock —
 * the turn's whole, or `job_max_ms` — bounds the rest.
 */
const BACKGROUND_COMMAND_MAX_MS = 30 * 60_000;

/**
 * `exec` as a helper has it: every command in the foreground, and its output read by the helper.
 *
 * A job a helper started ended its turn on the spot (`background_started`), so it handed back having read nothing, and
 * the job's own end woke the parent's chat as a command's — about work the parent never ran. Found on 0.7.15's first
 * run on the box: a helper's `sleep 12; echo alpha-done` was moved to a job of its own for its wait, and the helper's
 * whole report was "exec ok · 5ms". A helper is the work nobody waits on; it has no background of its own. So the
 * options that would start a job are not offered, one asked for anyway is refused with what to do instead, and a
 * command that waits stays in the foreground: up to `BACKGROUND_COMMAND_MAX_MS` in the background, where a long build
 * is what a helper is for, and `exec`'s usual 240 seconds in the foreground, inside a turn somebody is waiting on. Read
 * at each command: a helper waited on that moved to the background may wait as one started there.
 */
function foregroundExec(tool: Tool, mode: HelperMode): Tool {
  return {
    ...tool,
    definition: inTheForeground(tool.definition, mode),
    execute: async (args, ctx) => {
      if (args.background === true || args.service === true) {
        return {
          content:
            "A helper runs every command in the foreground and reads what it prints: a job started from here would report to nobody. " +
            (mode.background
              ? `Run it without \`background\` or \`service\`, with \`timeout_ms\` up to ${BACKGROUND_COMMAND_MAX_MS} for a long one.`
              : "Run it without `background` or `service`; anything that needs longer than 240 seconds is for the agent that asked: say so in your answer."),
          isError: true,
        };
      }
      const foreground = { ...args, background: false, service: false };
      return tool.execute(foreground, mode.background ? { ...ctx, commandMaxMs: BACKGROUND_COMMAND_MAX_MS } : ctx);
    },
  };
}

/** `exec`'s definition without the options that start a job, and with the wait a helper in the background may ask for. */
function inTheForeground(definition: ToolDefinition, mode: HelperMode): ToolDefinition {
  const parameters = definition.parameters as { properties?: Record<string, { description?: string }> };
  const properties = Object.fromEntries(Object.entries(parameters.properties ?? {}).filter(([key]) => !JOB_OPTIONS.has(key)));
  if (mode.background && properties.timeout_ms) {
    properties.timeout_ms = {
      ...properties.timeout_ms,
      description: `Milliseconds before the command is killed, up to ${BACKGROUND_COMMAND_MAX_MS}: you work in the background, so a long build or a slow check runs to its end here. Give it when a command may take more than a couple of minutes.`,
    };
  }
  return { ...definition, parameters: { ...definition.parameters, properties } };
}

/**
 * The model a helper runs on: the parent's model of the tier the brief was given (0.8.0) — `default`, the parent's own,
 * when it was given none.
 */
export function helperRunsOn(ctx: TurnContext, parent: LoadedAgent, request: SubagentRequest): string {
  return tierModel(parent.config.llm, ctx.deps.config.llm.defaults, request.tier ?? "default");
}

/** What a helper's executor is built with, whichever way it runs: the parent's, with what the run says. */
export function helperExecutor(
  ctx: TurnContext,
  parent: LoadedAgent,
  request: SubagentRequest,
  run: Pick<ExecutorDeps, "onActivity"> & Partial<Pick<ExecutorDeps, "approvals" | "onRequest">>,
): TurnExecutor {
  /**
   * The parent's level, resolved the way the parent's is. With none the executor read `careful`: a person on
   * `balanced` was asked again for every write a helper made, about work they had already let the turn do. In work nobody
   * watches, the level that turn runs at (0.8.1): a job's run is held below its agent's own, and its helper was not.
   */
  const level = () => request.ctx.unattended?.level ?? ctx.approvalLevel(parent, { gatewayId: request.ctx.gatewayId, senderId: request.ctx.senderId });
  return new TurnExecutor({
    ...(ctx.deps.spill ? { spill: ctx.deps.spill } : {}),
    // A helper runs as its parent, on the parent's model and fallback.
    onFallback: alertOnFallback(ctx.outages, ctx.deps.notifier, parent),
    windowOf: (model) => ctx.deps.providers?.catalog?.windowNow(parent.config.llm.provider, model) ?? null,
    llm: ctx.deps.config.llm,
    approvals: run.approvals ?? ctx.deps.approvals,
    approvalLevel: level,
    // The parent's second look, at that level: a helper of work nobody watches sends as its parent would (0.8.1).
    secondLook: secondLookFor({
      agent: parent.config,
      install: () => ctx.deps.config,
      level,
      provider: () => ctx.deps.providers.get(parent.config.llm.provider),
      onUsage: (usage, model) =>
        meter(ctx.deps.usage, {
          agentId: parent.config.id,
          provider: parent.config.llm.provider,
          purpose: "second_look",
          sessionId: request.ctx.sessionId,
          ...(request.ctx.turnId ? { turnId: request.ctx.turnId } : {}),
        })(usage, model),
    }),
    ...(run.onActivity ? { onActivity: run.onActivity } : {}),
    ...(run.onRequest ? { onRequest: run.onRequest } : {}),
    onGrantUsed: (agentId, grantKey) => {
      if (!grantKey) return;
      ctx.deps.grants?.touch(agentId, grantKey);
      ctx.deps.toolGrants?.touch(grantKey);
    },
    execPolicy: (agentId) => ({
      grantsHeld: ctx.deps.grants?.liveKeys(agentId).size ?? 0,
    }),
    timezone: ctx.deps.config.daemon.timezone,
    ...(ctx.deps.credentialsDir ? { credentialsDir: ctx.deps.credentialsDir } : {}),
    installDir: dirname(dirname(ctx.deps.config.daemon.dataDir)),
    binDir: join(dirname(ctx.deps.config.daemon.dataDir), "bin"),
    changesSharedTools: (agentId: string) => changesSharedTools(ctx.deps.config, ctx.deps.registry.get(agentId)),
    ...(ctx.deps.projectSkills ? { projectSkills: (a: LoadedAgent) => ctx.deps.projectSkills!.forAgent(a) } : {}),
    commands: [],
    // The turn that started it: a helper's calls are part of what that turn cost, in the foreground and behind it.
    onUsage: (usage) =>
      meter(ctx.deps.usage, {
        agentId: usage.agentId,
        provider: parent.config.llm.provider,
        purpose: "helper",
        sessionId: request.ctx.sessionId,
        ...(request.ctx.turnId ? { turnId: request.ctx.turnId } : {}),
      })(usage, usage.model, usage.purpose, usage.provider),
  });
}

/**
 * The turn a helper runs, as either way runs it: its brief as the one message, the parent's chat and directories, no
 * history. The signal, the deadline and the turn's ids are the caller's.
 */
export function helperTurn(
  ctx: TurnContext,
  blank: LoadedAgent,
  request: SubagentRequest,
  sessionId: string,
  extra: { notes?: string[]; mode?: HelperMode } = {},
): Omit<TurnRequest, "signal"> {
  const model = helperRunsOn(ctx, blank, request);
  return {
    agent: blank,
    provider: ctx.deps.providers.get(blank.config.llm.provider),
    ...fallbacksFor(blank, ctx.deps.providers),
    // On the parent's provider, as every helper is: a tier is a model of the parent's, never another endpoint.
    ...(model !== blank.config.llm.model ? { model } : {}),
    // Resolved as a turn that holds no background work: a helper starts no helper, and its `ask_agent` waits for the
    // answer however long it takes (0.7.19) — one in the background that moved an ask behind itself would leave a turn
    // nobody watches waiting on nothing, with the answer bound for a conversation it is not in (`waitingForm`).
    toolset: (request.readOnly ? readOnlyToolset : (toolset: AgentToolset) => toolset)(
      helperToolset(resolveToolset(blank, ctx.tools, ctx.deps.config.security, { ...ctx.toolsetDeps(), backgroundHelpers: () => 0 }), extra.mode ?? { background: false }),
    ),
    history: [],
    // With a read-only copy of the task in the parent's work notes this is part of (`workNotesCopy`).
    userMessage: {
      role: "user",
      content: [
        renderBrief(request.brief),
        ...(extra.notes ?? []),
        workNotesCopy(ctx.deps.notes, { agentId: blank.config.id, gatewayId: request.ctx.gatewayId, chatId: request.ctx.chatId }),
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n"),
      timestamp: Date.now(),
    },
    gateway: request.ctx.gateway,
    ...ctx.formattingFor(request.ctx.gatewayId),
    gatewayId: request.ctx.gatewayId,
    chatId: request.ctx.chatId,
    chatType: "dm",
    // Its own session id, never persisted: a subagent's conversation is scaffolding, and writing
    // it to the sessions table would leave rows nobody can find their way back to.
    sessionId,
    senderId: request.ctx.senderId,
    helper: true,
    // What its parent's turn read from outside, and — in work nobody watches — what that work is for and where it sends
    // (0.8.1): a helper of a job's run had neither, so the second look never weighed what it sent.
    ...(request.ctx.untrustedRead?.length ? { outsideContent: request.ctx.untrustedRead } : {}),
    ...(request.ctx.unattended
      ? {
          unattended: {
            goal: request.ctx.unattended.goal,
            ...(request.ctx.unattended.jobId ? { jobId: request.ctx.unattended.jobId } : {}),
            ...(request.ctx.sendsTo ? { sendsTo: request.ctx.sendsTo } : {}),
            ...(request.ctx.allowed ? { allowed: request.ctx.allowed } : {}),
          },
        }
      : {}),
    // The parent's directories, not the subagent's own. `blank` carries the parent's id, so this
    // resolves to the same pair — which is the point: a subagent is the parent doing one job in
    // parallel, and work it produces has to land where the parent will look for it.
    workspaceDir: ctx.workspaceFor(blank.config.id).shared,
    privateDir: ctx.workspaceFor(blank.config.id).own,
    // The same read-only roots a turn of the parent's gets. A helper had none, so the excerpt of
    // its own large output said "open it with `read`" and `read` refused the path — as it refused
    // the job logs and pooled skills the prompt had just named.
    readOnlyRoots: ctx.readOnlyRoots(blank, sessionId),
    // And the conversation's files, as the parent's turn reaches them: a file the brief names opens (0.7.15).
    ...(ctx.deps.attachments
      ? { attachmentRoot: ctx.deps.attachments.rootFor({ agentId: blank.config.id, gatewayId: request.ctx.gatewayId, chatId: request.ctx.chatId }) }
      : {}),
  };
}

/**
 * The parent's clock, less the reserve the parent needs to answer with what the helper found.
 *
 * With no deadline a helper never wrapped up: it ran until the parent's abort cut it off, and handed back
 * `incomplete` with no summary. With the parent's own, it would wrap up into the very reserve the parent keeps for
 * its last call. One reserve earlier, the helper's summary and the parent's answer both fit.
 */
function waitedDeadline(ctx: TurnContext, parent: LoadedAgent, parentDeadline: number | undefined): number | undefined {
  if (parentDeadline === undefined) return undefined;
  return parentDeadline - wrapUpReserveMs(turnMsOf(ctx, parent));
}

/** How long a turn of the parent's may run: its own `max_turn_duration_ms`, or the daemon's. */
function turnMsOf(ctx: TurnContext, parent: LoadedAgent): number {
  return resolveTurnDurationMs(parent.config.llm.maxTurnDurationMs, ctx.deps.config.llm.limits.maxTurnDurationMs);
}

/**
 * When a helper in the background must be done — started there, or moved there from the foreground: its turn's whole
 * duration from when it started — a wait for room is not taken from it — and never past `job_max_ms` from when its job
 * did, the deadline the job itself keeps, so it wraps up before that stops it. Pure.
 */
export function helperDeadline(at: { queuedAt: number; startedAt: number; turnMs: number; jobMs: number }): number {
  const own = at.startedAt + at.turnMs;
  return at.jobMs > 0 ? Math.min(own, at.queuedAt + at.jobMs) : own;
}
