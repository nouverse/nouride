/**
 * Turns nobody is watching, and where their output goes.
 *
 * The scheduler's half of the pipeline, separate from the ordinary turn path for one reason —
 * delivery. `runTurn` answers into the conversation the message came from, which is right for every
 * message and wrong for a scheduled job: a run's output may go to a different chat, to a webhook, or
 * nowhere, and it has to come back as *text* regardless, because the run history records what the
 * job produced.
 *
 * `cronExecutors()` is the entire surface the scheduler gets. Functions rather than this object, for
 * the same reason `delegate` and `exec`'s job runner take closures: a component that holds the
 * pipeline holds everything the pipeline can do, and this one runs with nobody watching.
 */

import { changesSharedTools } from "@/modules/toolchain/shared-tools.ts";
import { dirname, join } from "@nouride/runtime";
import {
  createLogger,
  LLMError,
  newId,
  toUserMessage,
  type ChatMessage,
  type Job,
  type JobTarget,
  type LoadedAgent,
  type MessageEnvelope,
  type SessionKey,
  resolveTurnDurationMs,
  type ApprovalLevel,
  type HeldAction,
} from "@nouride/shared";
import { scratchpadFor } from "@nouride/persona";
import { brainFor } from "./brain.ts";
import { capStoredTurns } from "@/modules/llm/context.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { buildEnv, ownHomeEnv } from "@/modules/tools/builtins/exec.ts";
import { postWebhook } from "@/modules/cron/webhook.ts";
import { settleNotes } from "@/modules/tools/builtins/plan.ts";
import { notesOf } from "@/modules/notes/tail.ts";
import { UnattendedApprovalGate } from "@/modules/cron/approval.ts";
import { carriesHistory, deliveryTarget } from "@/modules/cron/addressing.ts";
import { type CronExecutors, type JobTurnRequest, type JobTurnResult } from "@/modules/cron/scheduler.ts";
import { jobGoal, unattendedPreamble } from "@/modules/cron/prompts.ts";
import { secondLookFor } from "@/modules/tools/second-look.ts";
import { SYSTEM_SENDER } from "./deps.ts";
import { RESTARTING, STOPPED_BY_PERSON, type TurnContext } from "./turn-context.ts";
import { APPLIANCE_REPLY_FLUSH, TurnRecorder } from "@/modules/turns/recorder.ts";
import { SCHEDULED } from "@/modules/turns/turns.store.ts";
import type { InterruptCause } from "@/modules/turns/close.ts";
import type { Unattended } from "@/modules/llm/executor/types.ts";
import { meter } from "@/modules/llm/metered.ts";
import { summarizerFor } from "@/modules/llm/summarizer.ts";
import { alertOnFallback } from "@/modules/pipeline/fallback-alert.ts";
import { fallbacksFor } from "@/modules/llm/fallbacks.ts";
import { recordSaid } from "@/modules/pipeline/send-message.ts";

const log = createLogger("pipeline.job-turns");

export class JobTurns {
  /**
   * `dispatch` is the queue's `push` and nothing else.
   *
   * Handed in rather than reached for: the announce path enters the pipeline as an ordinary message,
   * and a scheduler-facing object that held the queue could also drain it.
   */
  constructor(
    private readonly ctx: TurnContext,
    private readonly dispatch: (envelope: MessageEnvelope) => boolean,
    /**
     * Capture-and-close a stale conversation, from `SessionLifecycle`.
     *
     * A closure rather than the lifecycle object, for the same reason `dispatch` is `push` and
     * nothing else: this component runs with nobody watching, and the lifecycle can also compact and
     * clear a conversation on demand. One verb is all a scheduled turn needs.
     */
    private readonly rollOver: (agent: LoadedAgent, key: SessionKey) => Promise<void>,
    /** A slot under `max_concurrent_turns`, held for the turn — the queue's, so chat turns and these share one ceiling. */
    private readonly slot: <R>(work: () => Promise<R>) => Promise<R>,
  ) {}

  /**
   * A turn nobody is watching, started by the scheduler.
   *
   * Separate from `runTurn` rather than an envelope pushed through the queue, and the reason is
   * delivery: `runTurn` answers into the conversation the message came from, which is right for
   * every message and wrong for a scheduled job. A cron run's output may go to a different chat, to
   * a webhook, or nowhere — and it has to come back here as *text* regardless, because the run
   * history records what the job produced. So the turn returns its answer and the scheduler decides
   * where it goes.
   *
   * What it keeps from the ordinary path: the real persona, a persisted session, the daily cost
   * cap, usage accounting, a turn record, and cancellation through `/stop`. A scheduled turn is
   * the same agent doing the same work, not a lesser one.
   *
   * ## Approvals, with nobody there
   *
   * Nobody is asked, ever: the gate is `UnattendedApprovalGate`, which refuses at once with a reason the
   * model can report (see where it is set below for why waiting on a prompt was dropped).
   * `[cron] unattended_approval` only decides how much runs before that gate is reached — the approval
   * level of the turn:
   *
   * - `"auto"` (default) — `balanced`: ordinary calls run; what `balanced` still asks (`BALANCED_ASKS`: a config
   *   changed, someone given access, the daemon stopped, a secret replaced, a credential leaving, this machine's
   *   packages changed, and what every level asks) is refused. A job
   *   that stops at a prompt nobody will see has not run.
   * - `"deny"` — `careful`: whatever `careful` would ask about is refused. The job fails honestly
   *   instead of silently doing less than it was asked to.
   */
  async runCronTurn(request: JobTurnRequest): Promise<JobTurnResult> {
    const agent = this.ctx.deps.registry.get(request.job.agentId);
    if (!agent) {
      return { text: "", error: `agent ${request.job.agentId} is not loaded` };
    }
    // Asleep (0.8.0): a schedule coming due or a webhook called is recorded as skipped, not failed — nothing went wrong.
    if (this.ctx.deps.registry.isPaused(agent.config.id)) return { text: "", skipped: `agent asleep: ${agent.config.id}` };
    /**
     * Not into a chat its agent is answering in, and under the same ceiling as every chat turn.
     *
     * It took neither. A `session: "chat"` job due while a person talked to the agent there overwrote that turn's
     * `ActiveTurn`: both wrote one session, and the job's end dropped the person's steers. And N due jobs were N
     * provider turns beside the `max_concurrent_turns` the queue allows. Skipped and recorded, not deferred — the next
     * occurrence comes as usual. Asked again once a slot is held, since a person may have started a turn meanwhile.
     */
    const busy = () => this.ctx.isBusy(agent.config.id, request.session.chatId, request.session.gatewayId);
    const skipped = { text: "", skipped: `agent busy: ${agent.config.id} was in a turn in that chat` };
    if (busy()) return skipped;
    return await this.slot(async () => (busy() ? skipped : await this.run(request, agent)));
  }

  private async run(request: JobTurnRequest, agent: LoadedAgent): Promise<JobTurnResult> {
    const key: SessionKey = {
      agentId: agent.config.id,
      gatewayId: request.session.gatewayId,
      chatId: request.session.chatId,
    };
    // Resolved up here because the rollover below needs its platform, not only the turn.
    const gateway = this.ctx.deps.gateways.get(request.session.gatewayId);

    /**
     * A conversation that has gone stale is captured and closed before this turn joins it.
     *
     * The same rollover a person's message triggers, on the same policy — and it was missing here
     * entirely, which is the half of the context problem that had nothing to do with which chat a job
     * used. An `isolated` job ran against a private history that no clock and no idle timer ever
     * ended: it grew until `max_conversation_turns` capped it, and every run in between paid to send
     * it and then paid a summarizer to compress it.
     *
     * Skipped for `fresh`, which has no history to roll over by definition.
     */
    if (carriesHistory(request.job)) {
      await this.rollOver(agent, key);
    }

    // `"cron"` as the session type, so an operator reading the sessions table can tell a scheduled
    // conversation from one a person had. An isolated job's chat id (`cron:<jobId>`) says the same
    // thing, but a `session: "chat"` job shares the human's chat id and would be indistinguishable.
    const session = this.ctx.deps.sessions.load(key, "cron");

    /**
     * `fresh` sees its own prompt and nothing else.
     *
     * Nothing is read and nothing is written back, so the run costs exactly what the job is: a daily
     * report does not benefit from remembering yesterday's report, it only pays for it. Any row left
     * from when this job ran in another mode is cleared rather than left lying around — a private
     * history that nothing will ever read again is just a copy of old work with no owner.
     */
    const keepsHistory = carriesHistory(request.job);
    if (!keepsHistory && session.messages.length > 0) {
      this.ctx.deps.sessions.clear(key);
      // The last run's spilled output goes with the history that pointed at it.
      this.ctx.deps.spill?.forget({ agentId: key.agentId, sessionId: session.id });
    }

    // Before the provider is called. A scheduled job is exactly the thing that quietly runs past a
    // cost cap overnight, which is why the cap is checked on the same path as a human turn.
    const budget = this.ctx.checkSpend();
    if (budget.action === "refuse") {
      return { text: "", error: budget.message };
    }

    /**
     * A record of its own, like any turn: its start and end and every step are rows of the stream, in the conversation
     * it runs in — so `nouride events`, `nouride turns` and the dashboard see a scheduled run, where it used to reach
     * only the in-memory feed and the job's run history. Marked as the schedule's (`cause`): it is not a person's turn,
     * and a restart does not take it up as one (`restart-resume.ts`) — the job has a next run of its own.
     */
    const record = TurnRecorder.begin(this.ctx.deps.turns, {
      sessionId: session.id,
      agentId: agent.config.id,
      gatewayId: key.gatewayId,
      chatId: key.chatId,
      senderId: SYSTEM_SENDER,
      prompt: request.message.trim() || request.job.name,
      cause: { via: SCHEDULED, job: request.job.id },
    }, this.ctx.deps.appliance?.() ? APPLIANCE_REPLY_FLUSH : undefined);
    let finished = false;
    const close = (patch: Parameters<TurnRecorder["finish"]>[0]): void => {
      if (finished) return;
      finished = true;
      record?.finish(patch);
    };

    const unattendedAuto = this.ctx.deps.config.cron.unattendedApproval === "auto";
    /** What the job's guards held with nobody to ask (0.8.0): on the run, for a person to allow always. */
    const held: HeldAction[] = [];

    const turnKey = `${key.agentId}:${key.chatId}:${key.gatewayId}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      resolveTurnDurationMs(
        agent.config.llm.maxTurnDurationMs,
        this.ctx.deps.config.llm.limits.maxTurnDurationMs,
      ),
    );
    // The scheduler's signal is the shutdown path; the timer is the turn's own ceiling. Both have
    // to reach the executor, and it takes one signal.
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    this.ctx.activeTurns.set(turnKey, {
      controller,
      agentId: key.agentId,
      chatId: key.chatId,
      gatewayId: key.gatewayId,
    });

    const executor = brainFor(this.ctx.deps.externalAgents, agent, {
      maxImageBytes: this.ctx.deps.config.media.maxImageBytes,
      fitImages: this.ctx.fitImages,
      onFallback: alertOnFallback(this.ctx.outages, this.ctx.deps.notifier, agent),
      windowOf: (model) => this.ctx.deps.providers?.catalog?.windowNow(agent.config.llm.provider, model) ?? null,
      ...(this.ctx.deps.spill ? { spill: this.ctx.deps.spill } : {}),
      // The conversation's scale: a job kept in a chat's history runs on that history.
      tokenScales: this.ctx.tokenScales,
      llm: this.ctx.deps.config.llm,
      /**
       * Always the unattended gate, in both modes — and the reasoning changed once this ran live.
       *
       * `approvalLevel` below turns an ordinary `ask` into a run before this gate is ever consulted,
       * so the only thing that reaches it is a **hardline** call: privilege escalation, a recursive
       * delete, a credential path, an infrastructure change. Handing those to the real gate parked
       * the turn for the full `approval_timeout_ms` waiting for an answer that could not arrive —
       * an isolated cron session's chat id is `cron:<jobId>`, which no platform can deliver to, so
       * the prompt went nowhere and five minutes later the turn failed anyway.
       *
       * Observed exactly that: `sh -lc "rm -rf …"` sat in the approval queue for 281 seconds while
       * the run held its slot. Refusing at once costs nothing and the model gets a result it can
       * report. "Nobody is watching" is the definition of this turn, not a state to wait out.
       */
      approvals: new UnattendedApprovalGate((one) => held.push(one)),
      // A cron turn has no person in it, so there is nobody to have set a level and nobody to ask.
      // `unattendedAuto` is the scheduler's own decision about that; see the note above.
      approvalLevel: () => (unattendedAuto ? "balanced" : "careful"),
      // The second look at what it sends out after reading outside content (0.8.0), at the level it runs at.
      secondLook: secondLookFor({
        agent: agent.config,
        install: () => this.ctx.deps.config,
        level: () => (unattendedAuto ? "balanced" : "careful"),
        provider: () => this.ctx.deps.providers.get(agent.config.llm.provider),
        onUsage: (usage, model) =>
          meter(this.ctx.deps.usage, { agentId: agent.config.id, provider: agent.config.llm.provider, purpose: "second_look", sessionId: session.id, ...(record ? { turnId: record.id } : {}) })(usage, model),
      }),
      // Its steps, rows of its own turn in the conversation it runs in — `cron:<job>` for a job with a history of its
      // own: `nouride events`, `nouride turns` and that conversation's page show them. They went to the target chat's
      // in-memory feed until 0.7.11, which only `nouride chat` read, and only for the dashboard's chat.
      onActivity: (kind, text, detail) => record?.step(kind, text, detail),
      onRequest: (line) => record?.context(line),
      ...(record ? { onText: (delta: string) => record.delta(delta) } : {}),
      onGrantUsed: (agentId, grantKey) => {
        if (!grantKey) return;
        this.ctx.deps.grants?.touch(agentId, grantKey);
        this.ctx.deps.toolGrants?.touch(grantKey);
      },
      execPolicy: (agentId) => ({
        grantsHeld: this.ctx.deps.grants?.liveKeys(agentId).size ?? 0,
      }),
      timezone: this.ctx.deps.config.daemon.timezone,
      ...(this.ctx.deps.credentialsDir ? { credentialsDir: this.ctx.deps.credentialsDir } : {}),
      installDir: dirname(dirname(this.ctx.deps.config.daemon.dataDir)),
      binDir: join(dirname(this.ctx.deps.config.daemon.dataDir), "bin"),
      changesSharedTools: (agentId: string) => changesSharedTools(this.ctx.deps.config, this.ctx.deps.registry.get(agentId)),
      ...(this.ctx.deps.projectSkills
        ? { projectSkills: (a: LoadedAgent) => this.ctx.deps.projectSkills!.forAgent(a) }
        : {}),

      // No slash commands: they are answered by the hook registry on the inbound path, and telling
      // an unattended agent about commands it cannot invoke is prompt budget spent on a dead end.
      commands: [],
      onUsage: (usage) =>
        meter(this.ctx.deps.usage, { agentId: usage.agentId, provider: agent.config.llm.provider, purpose: "turn", sessionId: session.id, ...(record ? { turnId: record.id } : {}) })(usage, usage.model, usage.purpose, usage.provider),
      // A job kept in a chat's history compacts it like a turn there: with `[memory]`'s pass model when set.
      summarizer: summarizerFor(this.ctx.deps, { agentId: agent.config.id, profile: agent.config.llm.provider, sessionId: session.id, tiers: agent.config.llm, ...(record ? { turnId: record.id } : {}) }),
    });

    const asked: ChatMessage = { role: "user", content: unattendedPreamble(request.job, request.message), timestamp: Date.now() };
    /**
     * Journaled like a chat turn when the job keeps a conversation: a run cut short by a restart leaves
     * its work in that conversation for the next run, instead of nothing (`modules/turns/journal.store.ts`).
     * A fresh job keeps nothing, so there is nothing to journal.
     */
    const journal = keepsHistory
      ? this.ctx.deps.journal?.open(record?.id ?? newId("turn"), { agentId: key.agentId, gatewayId: key.gatewayId, chatId: key.chatId, kind: "job", startedAt: Date.now() }, asked)
      : undefined;
    const fold = (cause: InterruptCause) => {
      if (journal) this.ctx.closeUnfinished({ key, history: session.messages, asked, journal, cause });
    };

    try {
      const workspace = this.ctx.workspaceFor(agent.config.id);
      const result = await executor.run({
        signal: controller.signal,
        agent,
        provider: this.ctx.deps.providers.get(agent.config.llm.provider),
        ...fallbacksFor(agent, this.ctx.deps.providers),
        // No helpers in the background (0.7.15): a scheduled turn has nobody to stay free for, and an isolated one's chat
        // is `cron:<job>`, which no helper's report could reach. Its `delegate` waits for its helpers.
        toolset: resolveToolset(agent, this.ctx.tools, this.ctx.deps.config.security, { ...this.ctx.toolsetDeps(), backgroundHelpers: () => 0 }),
        history: keepsHistory ? session.messages : [],
        userMessage: asked,
        ...(journal ? { journal } : {}),
        pause: () => this.ctx.paused,
        // The conversation's work notes, as a chat turn reads them (`modules/notes/`).
        ...notesOf(this.ctx.deps.notes, { agentId: agent.config.id, gatewayId: request.session.gatewayId, chatId: request.session.chatId }),
        workspaceDir: workspace.shared,
        privateDir: workspace.own,
        readOnlyRoots: this.ctx.readOnlyRoots(agent, session.id),
        gateway: gateway?.platform ?? "web",
        ...this.ctx.formattingFor(request.session.gatewayId),
        gatewayId: request.session.gatewayId,
        chatId: request.session.chatId,
        // What the chat actually is. A cron turn writes into a real conversation, and the prompt's
        // handover section is built from this — a scheduled job in a channel used to be told it was in
        // a one-to-one chat and that a tag would reach nobody. See `chat-types.ts`.
        chatType: this.ctx.chatTypes.of(request.session.gatewayId, request.session.chatId) ?? "dm",
        sessionId: session.id,
        ...(record ? { turnId: record.id, callIds: this.ctx.callIdsOf(record.id) } : {}),
        senderId: SYSTEM_SENDER,
        systemEvent: true,
        ...(request.model ? { model: request.model } : {}),
        // The payload of the webhook that fired it is outside content from the first step.
        ...(request.outsideContent?.length ? { outsideContent: request.outsideContent } : {}),
        // Nobody is watching it, and it sends only to its job's chat (0.8.0).
        unattended: {
          goal: jobGoal(request.job),
          sendsTo: deliveryTarget(request.job),
          jobId: request.job.id,
          allowed: request.job.allowed?.flatMap((allowance) => allowance.keys) ?? [],
        },
      });

      // Stopped at a step for a shutdown: closed with what it did, and the run says it was interrupted.
      if (result.paused) {
        fold({ kind: "restart" });
        close({ status: "interrupted", error: "the daemon restarted while this turn was running" });
        // Interrupted, not failed: nothing about the job went wrong, and a failure report would say it had.
        return { text: "", interrupted: "interrupted by a daemon restart" };
      }

      // The conversation, the journal and the record move together, as a chat turn's do.
      this.ctx.atomically(() => {
        if (keepsHistory) {
          this.ctx.deps.sessions.save(key, capStoredTurns(result.messages, this.ctx.deps.config.security.maxConversationTurns), result.contextTokens);
          if (journal) this.ctx.deps.journal?.clear(journal.turnId);
        }
        close({
          status: controller.signal.aborted ? "cancelled" : "done",
          reply: result.text,
          model: result.answeredBy ?? request.model ?? agent.config.llm.model,
          toolCalls: result.toolCalls,
          iterations: result.iterations,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
      });
      this.ctx.deps.providerErrors?.set(agent.config.llm.provider, 0);

      await settleNotes(this.ctx.deps.notes, { agentId: agent.config.id, gatewayId: request.session.gatewayId, chatId: request.session.chatId, sessionId: session.id });

      log.info("cron turn complete", {
        agent_id: agent.config.id,
        job: request.job.id,
        iterations: result.iterations,
        tool_calls: result.toolCalls,
      });
      return { text: result.text, ...(held.length > 0 ? { held } : {}) };
    } catch (err) {
      /**
       * Cut off by a shutdown in the middle of a call — a model answering slowly does not reach a step in the 15 s the
       * shutdown gives it, and is aborted (`stopTurns`). Interrupted, as one stopped at a step is: it was not
       * the job that failed, nor the provider, and both were said — "The model is not responding right now".
       */
      if (controller.signal.reason === RESTARTING) {
        fold({ kind: "restart" });
        close({ status: "interrupted", error: "the daemon restarted while this turn was running" });
        log.info("cron turn interrupted by a daemon restart", { agent_id: agent.config.id, job: request.job.id });
        return { text: "", interrupted: "interrupted by a daemon restart" };
      }
      if (err instanceof LLMError) {
        const profile = agent.config.llm.provider;
        this.ctx.deps.providerErrors?.set(profile, (this.ctx.deps.providerErrors.get(profile) ?? 0) + 1);
      }
      log.error("cron turn failed", {
        agent_id: agent.config.id,
        job: request.job.id,
        error: String(err),
      });
      // What the run did is kept in its conversation, however it ended.
      fold(controller.signal.aborted ? { kind: "deadline" } : { kind: "error", message: toUserMessage(err) });
      close({ status: controller.signal.reason === STOPPED_BY_PERSON ? "cancelled" : "failed", error: toUserMessage(err) });
      // Shaped for a human, like any other error that reaches a chat — this one lands in the run
      // history and, on failure, in the job's chat.
      return { text: "", error: toUserMessage(err) };
    } finally {
      clearTimeout(timer);
      // Through `releaseTurn`, never a bare delete: a wake for a job this turn started waits on the key
      // (`waitUntilFree`), and a delete leaves that wait unanswered — the job's result never arrives.
      this.ctx.releaseTurn(turnKey);
      this.ctx.forgetCallIds(record?.id);
      // Every path above closes it; this catches the one somebody adds later and forgets.
      close({ status: "failed", error: "the turn ended without a result" });
    }
  }

  /**
   * Enqueue a cron turn as a regular pipeline message — fire-and-forget.
   *
   * The scheduler calls this instead of `runCronTurn` for jobs with `announce` delivery. The
   * message enters the queue as if a person had sent it, goes through routing, runs a turn, and
   * replies to the target chat. The scheduler does not wait for any of that.
   *
   * The `unattendedPreamble` is already applied by the scheduler, so the text arriving here is
   * the full prompt the agent will see.
   */
  private dispatchCronTurn(job: Job, message: string, outsideContent?: string[]): boolean {
    /**
     * Always the target chat — this path is only for `session: "chat"` jobs.
     *
     * It used to substitute `cron:<jobId>` for an isolated job, which put the *reply* there too: the
     * pipeline answers into the conversation a message came from, and no platform can deliver to that
     * id. The scheduler now keeps every other mode on the synchronous path, where it delivers the
     * text itself. See the `announce` conditions in `scheduler.ts`.
     */
    const target = job.target;
    const gateway = this.ctx.deps.gateways.get(target.gatewayId);
    if (!gateway) {
      log.warn("cron dispatch has no gateway", { job: job.id, gateway_id: target.gatewayId });
      return false;
    }

    // The return value is the point. `push` refuses a message when the queue is full, draining, or
    // deduplicated — and ignoring that made the run record say "dispatched" for a turn that never
    // happened, with a log line beside it saying the same thing. A scheduled job that quietly stops
    // running while reporting success is the worst shape this could take.
    const accepted = this.dispatch({
      id: newId("msg"),
      timestamp: Date.now(),
      gateway: gateway.platform,
      gatewayId: target.gatewayId,
      chatId: target.chatId,
      chatType: this.ctx.chatTypes.of(target.gatewayId, target.chatId) ?? "dm",
      senderId: SYSTEM_SENDER,
      senderName: "Nouride",
      // Named, not left to a fallback. In a room shared by several of our bots nothing answers an
      // unaddressed message, so a scheduled job dispatched into a channel would reach nobody once the
      // chat type stopped claiming to be a DM. The job knows whose it is.
      mentions: [job.agentId],
      text: message,
      ...(outsideContent?.length ? { outsideContent } : {}),
      // What a person allowed this job's runs always (0.8.0): the turn in the chat reads it as a run on its own does.
      raw: { via: "cron dispatch", job: job.id, cronName: job.name, allowed: job.allowed?.flatMap((allowance) => allowance.keys) ?? [] },
    });

    if (!accepted) {
      log.warn("cron dispatch was refused by the queue", { job: job.id, name: job.name });
      return false;
    }

    log.info("cron turn dispatched into pipeline", { job: job.id, name: job.name });
    return true;
  }

  /**
   * What the scheduler is allowed to reach.
   *
   * Functions rather than the pipeline itself, for the same reason `delegate` and `exec`'s job
   * runner take closures: a component that holds the pipeline holds everything the pipeline can
   * do, and this one runs with nobody watching.
   */
  cronExecutors(): CronExecutors {
    return {
      runTurn: (request) => this.runCronTurn(request),
      dispatchTurn: (job: Job, message: string, outsideContent?: string[]) => this.dispatchCronTurn(job, message, outsideContent),
      deliver: (target: JobTarget, text: string, said?: { agentId: string; job: string }) => this.deliverToChat(target, text, said),
      commandSandbox: (job: Job) => {
        if (!this.ctx.deps.registry.get(job.agentId)) return null;
        // Every value, to mask what it prints with; in its environment only the secrets bound to its command.
        const secrets = this.ctx.deps.childEnv?.(job.agentId) ?? {};
        const handed = job.payload.kind === "command" ? (this.ctx.deps.childEnv?.forCommand(job.agentId, job.payload.argv).env ?? {}) : {};
        const workspace = this.ctx.workspaceFor(job.agentId);
        const scratchpad = scratchpadFor(workspace.own);
        return {
          cwd: workspace.shared,
          secrets,
          // The same allowlist `exec` uses, plus the agent's `exec_secrets` exactly as `exec` would hand this command.
          // The daemon's own environment holds every API key and is never inherited (§17.1); a
          // scheduled command gets only what the agent is configured to hand its commands. And the same
          // temporary directory: without it a scheduled command wrote its temp files to /tmp, where a
          // delete is hardline and nothing ever cleaned them up.
          // Its own HOME and installs where it is its own user, over the allowlist's (`commandEnv`).
          env: { ...buildEnv({ TMPDIR: scratchpad, TMP: scratchpad, TEMP: scratchpad, ...handed }), ...ownHomeEnv(workspace.own) },
        };
      },
      // Behind the SSRF guard, to the address it judged, and never redirected — see `cron/webhook.ts`.
      webhook: (url, body) => postWebhook(url, body, { allowPrivate: this.ctx.deps.config.security.web.allowPrivateUrls }),
      alert: async (key, text) => await this.ctx.deps.notifier?.alert(key, text),
      asleep: (agentId) => this.ctx.deps.registry.isPaused(agentId),
    };
  }

  /**
   * Send text into a conversation, for the scheduler: a failed send is a job error, with why. A platform's refusal
   * arrives here as a throw (`UndeliverableError`); buffered and dropped, it was a run recorded as delivered.
   */
  private async deliverToChat(target: JobTarget, text: string, said?: { agentId: string; job: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const gateway = this.ctx.deps.gateways.get(target.gatewayId);
    if (!gateway) {
      log.warn("cron delivery has no gateway", { gateway_id: target.gatewayId });
      return { ok: false, reason: `no gateway ${target.gatewayId}` };
    }
    try {
      await gateway.send({ gatewayId: target.gatewayId, chatId: target.chatId, text });
      // In the agent's conversation there too, so whoever answers it is answered by an agent that knows what it said.
      if (said) {
        recordSaid(this.ctx, {
          agentId: said.agentId,
          gatewayId: target.gatewayId,
          chatId: target.chatId,
          text,
          note: `Your scheduled job "${said.job}" posted the message below in this chat. It is part of this conversation now: anyone here may answer it.`,
        });
      }
      return { ok: true };
    } catch (err) {
      // Warn: the platform said no — the gateway logged why, and the run is recorded failed with it.
      log.warn("cron delivery failed", { gateway_id: target.gatewayId, error: String(err) });
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * A scheduled job's turn put into its own chat (`dispatchCronTurn`, `session: "chat"`): work nobody watches, sending to that
 * chat (0.8.0). Its message is the job's prompt — what the second look weighs an action against.
 */
export function scheduledInChat(envelope: MessageEnvelope): Unattended | undefined {
  const raw = envelope.raw as { via?: unknown; job?: unknown; allowed?: unknown } | null | undefined;
  if (raw?.via !== "cron dispatch") return undefined;
  return {
    goal: envelope.text,
    sendsTo: { gatewayId: envelope.gatewayId, chatId: envelope.chatId },
    ...(typeof raw.job === "string" ? { jobId: raw.job } : {}),
    allowed: Array.isArray(raw.allowed) ? raw.allowed.filter((key): key is string => typeof key === "string") : [],
  };
}

/**
 * The level a turn in a chat is answered at: a scheduled job's is never `trusted`, so it looks (0.8.0). It was resolved
 * as any chat turn's, for `nouride:system`, and an agent or a daemon at `trusted` gave it a run with no second look.
 */
export function chatTurnLevel(envelope: MessageEnvelope, level: ApprovalLevel): ApprovalLevel {
  return level === "trusted" && scheduledInChat(envelope) ? "balanced" : level;
}
