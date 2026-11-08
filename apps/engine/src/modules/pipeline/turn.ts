/**
 * One turn: build the executor, run the tool loop, persist what came of it, and say something back.
 *
 * Starts only once `inbound.ts` has decided this message gets a turn and which agent takes it. What
 * is left here is genuinely one job, and it is long because a turn touches a lot: the daily cost cap,
 * the in-chat progress line, the typing indicator, grant bookkeeping, usage accounting, the
 * attachments, the group-context replay, the stored-history cap, and four different ways a turn can
 * end with nothing to say.
 *
 * `runTurn` is the order of its phases, each a function over the turn's one state:
 *
 *   turn-state.ts    the state, and the opening that makes it: the turn's identity, clock and record
 *   turn-brain.ts    the executor, with every sink the turn has
 *   turn-request.ts  the tools it holds, the question it composes, and the request that carries both
 *   turn.ts          the cost cap, the chat's surfaces, the settle, the reply, and every way a turn ends
 */

import { capStoredTurns } from "@/modules/llm/context.ts";
import { createLogger, LLMError, toUserMessage, type LoadedAgent, type MessageEnvelope, type SessionKey, type ChatMessage } from "@nouride/shared";
import type { TurnResult } from "@/modules/llm/executor/types.ts";
import { settleNotes } from "@/modules/tools/builtins/plan.ts";
import { HookRegistry, ModelOverrides } from "@/modules/hooks/registry.ts";
import { ChatProgress } from "@/modules/pipeline/chat-progress.ts";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import { isSystemEvent } from "./deps.ts";
import { quotedId } from "./edit-rules.ts";
import { effortRefusedNote, emptyTurnMessage } from "./messages.ts";
import type { AttachmentIntake } from "./attachments.ts";
import type { RoomMemory } from "./room-memory.ts";
import { STOPPED_BY_PERSON, TurnContext } from "./turn-context.ts";
import { causeOf, endEarly } from "./turn-endings.ts";
import { compactAfterReply } from "./session-lifecycle.ts";
import { Preamble } from "./preamble.ts";
import { nudgeBaseMs, replyNote, watchTurn } from "./budget-nudges.ts";
import { outcomeOf, type TurnShape } from "./turn-shape.ts";
import { beginTurn, close, tell, type TurnState } from "./turn-state.ts";
import { turnBrain } from "./turn-brain.ts";
import { compose, equip, turnRequest } from "./turn-request.ts";

const log = createLogger("pipeline.turn");

/** The answer as the turn settled it: what it stored, what it says, and whether a person stopped it. */
interface Settled {
  stored: ChatMessage[];
  said: string;
  /** What the chat is told when the turn said nothing. */
  notice: string | null;
  /** The answer with this chat's refused `/effort` said under it, once. */
  withRefusal: (text: string) => string;
  stoppedByPerson: boolean;
}

export class TurnRunner {
  constructor(
    private readonly ctx: TurnContext,
    private readonly rooms: RoomMemory,
    private readonly attachments: AttachmentIntake,
    private readonly hooks: HookRegistry,
    private readonly modelOverrides: ModelOverrides,
  ) {}

  async runTurn(
    agent: LoadedAgent,
    envelope: MessageEnvelope,
    key: SessionKey,
    text: string,
    /** A turn that is not a chat's — a mission's (`turn-shape.ts`): its page, its person, its parked approvals. */
    shape?: TurnShape,
  ): Promise<void> {
    const turn = beginTurn(this.ctx, { agent, envelope, key, text, shape });
    if (await this.refusedOverBudget(turn)) return;
    await this.announce(turn);
    this.openSurfaces(turn);
    const brain = turnBrain(this.ctx, turn, { hearing: this.attachments.hearing, modelOverrides: this.modelOverrides, hooks: this.hooks });

    try {
      const kit = equip(this.ctx, turn, this.modelOverrides);
      const { asked, workspace } = await compose(this.ctx, turn, { rooms: this.rooms, attachments: this.attachments }, kit.override);
      const recall = await this.ctx.recallFor(agent.config.id, turn.asPerson);
      const result = await brain.executor.run(turnRequest(this.ctx, turn, { kit, asked, workspace, recall, modelOverrides: this.modelOverrides }));
      // No step left to read a message sent from here on — `ActiveTurn.answered`.
      this.ctx.answered(turn.turnKey);

      if (result.paused) return await this.endPaused(turn, result);
      const answer = this.settle(turn, result, kit.override);
      if (answer.stoppedByPerson) return await this.endStopped(turn, result);
      await this.reply(turn, result, answer);
      await this.afterReply(turn, result, { stored: answer.stored, summarize: brain.summarize, override: kit.override });
    } catch (err) {
      await this.fail(turn, err);
    } finally {
      this.release(turn);
    }
  }

  /**
   * The daily cost cap, checked before the provider is called rather than after: refusing a turn costs nothing, and
   * discovering the cap once the money is spent is not enforcement. True when the turn was refused, and let go.
   */
  private async refusedOverBudget(turn: TurnState): Promise<boolean> {
    const budget = this.ctx.checkSpend();
    if (budget.action !== "refuse") return false;
    log.warn("daily cost cap reached, refusing the turn", { agent_id: turn.agent.config.id });
    void this.ctx.deps.notifier?.alert("cost_cap", budget.message);
    await this.ctx.voice.reply(turn.envelope, budget.message);
    close(turn, { status: "failed", reply: budget.message, error: "daily cost cap reached" });
    tell(turn, { toolCalls: 0, worked: 0, tokens: 0, failed: true, error: budget.message, interrupted: false, readOutside: false });
    this.ctx.releaseTurn(turn.turnKey);
    turn.clock.stop();
    return true;
  }

  /**
   * A fact the daemon states itself, posted before the turn does anything.
   *
   * Awaited, and first: this has to be above the agent's own reply and above the progress bubble,
   * because it is what the reply is *about*. See `MessageEnvelope.announce` — it used to be sent the
   * moment the job finished, which put it 80 seconds and one unrelated answer away from its own
   * explanation.
   *
   * Failure here is swallowed by `toChat`, and deliberately does not stop the turn: an undelivered
   * notice is a worse outcome than a notice plus a reply, but it is a far better one than neither.
   */
  private async announce(turn: TurnState): Promise<void> {
    const { envelope } = turn;
    if (envelope.announce) {
      await this.ctx.deps.notifier?.toChat(
        { gatewayId: envelope.gatewayId, chatId: envelope.chatId },
        envelope.announce,
      );
    }
  }

  /** What the chat sees of the turn while it works: the progress line, the opening line, the long reply's nudges. */
  private openSurfaces(turn: TurnState): void {
    const { agent, envelope, shape } = turn;
    // Live progress in the conversation itself, for gateways that can edit a message.
    //
    // Only `tool` and `waiting` reach it. `thinking` and `reasoning` fire many times per turn and say
    // nothing a person waiting can act on; a status line that changes every second is harder to read
    // than one that changes when something happens. `tool_done` is skipped too — it is immediately
    // replaced by the next `tool`, and on the last step the summary says it better.
    //
    // The bubble carries the agent's name and avatar, so it belongs on the agent's own connection —
    // the same rule the answer follows. Posting it on the inbound one put Nexa's "2 steps · waiting
    // for you" under Nouva.
    const voiceGateway =
      this.ctx.deps.gateways.get(this.ctx.voice.voiceGatewayId(agent.config.id, envelope.gatewayId)) ?? turn.gateway;
    turn.voiceGateway = voiceGateway;
    const progress = (turn.progress =
      this.ctx.deps.config.llm.streaming.progressInChat &&
      voiceGateway &&
      ChatProgress.supported(voiceGateway)
        ? new ChatProgress({
            gateway: voiceGateway,
            chatId: envelope.chatId,
            agentLabel: agent.config.id,
            // Same rule as the reply: a system event's id names no real message, so there is nothing
            // to quote and asking the platform to quote it fails the send. See `Voice.reply`.
            ...(envelope.chatType === "dm" || isSystemEvent(envelope) ? {} : { replyTo: quotedId(envelope) }),
            ...(this.ctx.deps.progressIntervalMs ? { minIntervalMs: this.ctx.deps.progressIntervalMs } : {}),
            ...(this.ctx.deps.progressQuietMs ? { quietTickMs: this.ctx.deps.progressQuietMs } : {}),
            onPosted: (messageId) => this.ctx.voice.outbound.record({ platform: envelope.gateway, chatId: envelope.chatId, messageId, agentId: agent.config.id }),
          })
        : undefined);

    /**
     * The opening line before long work, said at once on every platform (`preamble.ts`) — under the same switch as the
     * progress line, since both are "say what you are doing in the chat". A person is waiting only on a message they
     * sent: a system event (a finished job, a scheduled run) gets its answer and nothing before it. Sent like the
     * answer — the agent's own connection, quoting the trigger in a group. The bubble so far is closed above the words,
     * and the steps after them start one below: left open, it was edited above them, where nobody was looking (0.8.5).
     */
    turn.preamble =
      this.ctx.deps.config.llm.streaming.progressInChat && !isSystemEvent(envelope) && cronJobOfChat(envelope.chatId) === null
        ? new Preamble(async (words) => {
            await progress?.seal();
            return this.ctx.voice.reply(envelope, words, agent.config.id);
          }, {
            ...(this.ctx.deps.preambleGapMs === undefined ? {} : { gapMs: this.ctx.deps.preambleGapMs }),
            callsAnotherAgent: (text) =>
              this.ctx.deps.registry.all().some((other) => other.config.id !== agent.config.id && new RegExp(`@${other.config.id}\\b`, "i").test(text)),
          })
        : undefined;
    // A person is waiting on the same turns the opening line is for: past `[agents] nudge_after_minutes`, and at each
    // doubling, the turn is asked for a one-line status, and to stop if stuck (`budget-nudges.ts`).
    // Where the agent can hand the rest to a mission, the note says so (0.8.0).
    const canHandOver = !shape && this.ctx.deps.missionTools !== undefined && agent.config.tools.enabled.length > 0;
    turn.nudges = turn.preamble ? watchTurn(nudgeBaseMs(this.ctx.deps.config.agents.nudgeAfterMinutes), (ms) => replyNote(ms, canHandOver)) : undefined;
  }

  /**
   * Stopped at a step boundary because the daemon is shutting down.
   *
   * Closed like any turn cut short — its journal folded into the conversation, the person told
   * what finished — while the gateways are still up to carry the message.
   */
  private async endPaused(turn: TurnState, result: TurnResult): Promise<void> {
    turn.failed = true;
    const asleep = !this.ctx.paused;
    const error = asleep ? "the agent was put to sleep while this turn was running" : "the daemon restarted while this turn was running";
    await endEarly(this.ctx, { key: turn.key, history: turn.upkept ?? turn.history, asked: turn.asked, journal: turn.journal, cause: asleep ? { kind: "stopped" } : { kind: "restart" }, envelope: turn.envelope, agentId: turn.agent.config.id, turnId: turn.record?.id, prompt: turn.text, error, close: (patch) => close(turn, patch), progress: turn.progress });
    tell(turn, outcomeOf(result, true));
  }

  /** What the turn says, decided before anything is written, and the conversation, journal and record settled with it. */
  private settle(turn: TurnState, result: TurnResult, override: string | undefined): Settled {
    const { agent, envelope, controller, session, key, journal, record, preamble } = turn;
    // Persisted before sending: if the send fails, the agent still remembers what it said,
    // which is far less confusing than a reply the user saw but the agent has no record of.
    //
    // Capped here, not in the executor: the executor trims what it *sends* (context window),
    // while this bounds what is *stored*. Without it the session JSON grows for the lifetime
    // of the chat and every turn re-truncates a longer array — `max_conversation_turns` was
    // parsed and documented but enforced nowhere.
    const stored = capStoredTurns(result.messages, this.ctx.deps.config.security.maxConversationTurns);
    if (stored.length < result.messages.length) {
      log.info("stored history trimmed to the conversation cap", {
        agent_id: agent.config.id,
        chat_id: envelope.chatId,
        dropped: result.messages.length - stored.length,
      });
    }
    const finishRecord = (reply: string) =>
      close(turn, {
        status: controller.signal.aborted ? "cancelled" : "done",
        reply,
        model: result.answeredBy ?? override ?? agent.config.llm.model,
        toolCalls: result.toolCalls,
        // What the turn actually cost: every one of these re-sent the whole conversation.
        iterations: result.iterations,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });

    const stoppedByPerson = controller.signal.reason === STOPPED_BY_PERSON;
    /**
     * What the turn says, as the chat gets it. A system event's answer with no word in it — `.`, `…` —
     * is the silence it was allowed: told it may reply with nothing when a job's outcome was already
     * reported, a model that cannot send an empty message sends a full stop. One Telegram chat got
     * nine bubbles holding a dot in an evening. Decided here, so the record owes nothing for it either.
     */
    const said = isSystemEvent(envelope) && !/[\p{L}\p{N}]/u.test(result.text) ? "" : result.text;
    const notice = said.trim()
      ? null
      : emptyTurnMessage(result.stopReason, result.toolCalls, controller.signal.aborted, result.approvalsRefused);
    /**
     * This chat's `/effort` level, refused by its model (0.8.17): said under the answer that met it, once, and kept out of
     * the conversation, which holds the model's own words. Not under an answer nobody is sent, stopped or already said
     * as the opening line: the next answer carries it.
     */
    const refusal = !stoppedByPerson && said.trim() && !preamble?.alreadySaid(said) && result.effortRefused && this.modelOverrides.refused(session.id, result.effortRefused) ? result.effortRefused : null;
    const withRefusal = (text: string) => (refusal ? `${text}\n\n${effortRefusedNote(refusal)}` : text);
    /**
     * What the record says the person was told — decided before anything is written. All of it, where some went out
     * before the answer (`TurnResult.told`): kept to the answer alone, a CLI's words before a step were missing from
     * the dashboard, and never reached a person chatting there (0.8.7).
     */
    const recorded = stoppedByPerson || said.trim() ? withRefusal(result.told ?? said) : isSystemEvent(envelope) ? "" : notice!;

    /**
     * The settle: the conversation, the journal and the record move together.
     *
     * A crash between writing the conversation and clearing the journal would fold this turn in twice
     * at the next boot; one between the conversation and the record would report as interrupted a turn
     * that finished. One transaction leaves no such moment. The reply goes out after it — persisted
     * before sending, so an agent always remembers what it said.
     */
    this.ctx.atomically(() => {
      this.ctx.deps.sessions.save(key, stored, result.contextTokens);
      if (journal) this.ctx.deps.journal?.clear(journal.turnId);
      finishRecord(recorded);
      // Owed until it lands — except after `/stop`, which sends nothing (below), and a reply that went out in part
      // already: sent again after a restart, the record's whole reply would say its head twice (`boot/delivery.ts`).
      if (!stoppedByPerson && result.told === undefined) this.ctx.awaitDelivery(record?.id);
      // And the message it answered is handled, in the same commit rather than one of its own after (E7).
      this.ctx.settleMessage?.(envelope);
    });

    // Reset consecutive failure count on success.
    this.ctx.deps.providerErrors?.set(agent.config.llm.provider, 0);
    return { stored, said, notice, withRefusal, stoppedByPerson };
  }

  /**
   * Somebody said stop, so stop — including the sentence it was in the middle of.
   *
   * The abort already ends the work. It did not end the *answer*: whatever the model had produced
   * up to that point was still delivered, so `/stop` was followed by one more message from the
   * agent. The person had just been told "Paused, and cancelled what I was doing", and then it
   * said one more thing anyway.
   *
   * Only for a stop a person asked for. A turn that ran out of clock still reports what it
   * managed — going quiet there is the failure the fallback below exists for, and the two are
   * told apart by the reason on the signal rather than by guessing from the text.
   *
   * Still recorded: the transcript keeps what the turn produced, because "what was it doing when
   * I stopped it" is exactly the question asked afterwards. What it does not do is say it out loud.
   *
   * **Not covered by a test, unlike its twin in `fail`.** Aborting a turn rejects the
   * provider call it is parked in, so every attempt to land here from the harness — mid-provider,
   * mid-tool, between iterations — ended in the error branch instead. The path is real: the
   * executor breaks at the top of its loop when the signal is already aborted, which is a turn
   * stopped while a tool was running and the provider was not. It is simply not one this suite
   * has managed to reach, and a guard that is only in one of the two places is a bug waiting for
   * the other.
   */
  private async endStopped(turn: TurnState, result: TurnResult): Promise<void> {
    // `failed` rather than `ok`: the bubble is the only thing left in the chat saying what
    // happened to this turn, and a tick beside work somebody stopped reads as work that finished.
    await turn.progress?.finish("failed");
    tell(turn, outcomeOf(result, true));
  }

  /** The answer into the chat — or, when the turn said nothing a person can use, the notice that says so. */
  private async reply(turn: TurnState, result: TurnResult, answer: Settled): Promise<void> {
    const { agent, envelope, controller, progress, preamble, record } = turn;
    const { said, notice, withRefusal } = answer;
    // Marks the reply as landed — now, or when a buffered copy is flushed (`TurnContext.markDelivered`).
    const delivered = (): void => this.ctx.markDelivered(record?.id);

    if (said.trim()) {
      // Summary-style platforms post their one line here, so it precedes the answer. No-op elsewhere.
      await progress?.beforeAnswer(turn.failed ? "failed" : "ok");
      // Already in the chat, word for word, as the opening line — a turn cut off by its clock ends on those words.
      if (preamble?.alreadySaid(said)) delivered();
      else if (await this.ctx.voice.reply(envelope, withRefusal(said), agent.config.id, { onDelivered: delivered })) delivered();
    } else {
      // Silence was the old behaviour: a warning in a log nobody is tailing, and nothing at all in
      // the chat. Found live — an approval expired, the model gave up with no text, and the sender
      // got no reply and no error. Indistinguishable from a crash, and it is the one impression
      // this daemon spent a whole session learning not to give.
      const quiet = { agent_id: agent.config.id, stop_reason: result.stopReason, tool_calls: result.toolCalls, aborted: controller.signal.aborted, approvals_refused: result.approvalsRefused };
      // A system event may be answered with nothing — "." asks for it (`commons/silence.ts`): that is info, not a
      // warning. Every quiet wake-up counted in a deploy's warn lines on the live box (0.8.12).
      if (isSystemEvent(envelope)) log.info("a system event's turn said nothing, as it may", quiet);
      else log.warn("turn produced no text", quiet);
      // Silence is a valid answer to a system event, and only to one.
      //
      // For a person, saying nothing is the failure this fallback exists for — an approval expired,
      // the model gave up, and the sender got no reply and no error. For a background job reporting
      // in, nobody is waiting: "I did not manage to produce an answer" is a reply to a question that
      // was never asked, and it is noise in a chat the agent has already updated.
      // Recorded either way (above), including for a system event that stays silent in the chat: "the
      // job finished and the agent had nothing to add" is exactly the kind of thing an operator later
      // wants to be able to look up.
      if (!isSystemEvent(envelope)) {
        await progress?.beforeAnswer(turn.failed ? "failed" : "ok");
        if (await this.ctx.voice.reply(envelope, notice!, agent.config.id, { onDelivered: delivered })) delivered();
      }
    }
  }

  /** Once the answer is out: the work notes settled, the mission told, the turn logged, reflected on and compacted. */
  private async afterReply(
    turn: TurnState,
    result: TurnResult,
    done: { stored: ChatMessage[]; summarize: ReturnType<typeof turnBrain>["summarize"]; override: string | undefined },
  ): Promise<void> {
    const { agent, envelope, session, shape, record, controller, key, text } = turn;
    // A finished plan goes; one with steps left stays with its task in the work notes (`settleNotes`). A mission's stays
    // whole: its checklist is the mission's record until it ends.
    await settleNotes(this.ctx.deps.notes, { agentId: agent.config.id, gatewayId: envelope.gatewayId, chatId: envelope.chatId, sessionId: session.id }, { keepFinished: shape !== undefined });
    tell(turn, outcomeOf(result, false));

    log.info("turn complete", {
      agent_id: agent.config.id, turn_id: record?.id,
      chat_id: envelope.chatId,
      iterations: result.iterations,
      tool_calls: result.toolCalls,
      input_tokens: result.usage.inputTokens,
      output_tokens: result.usage.outputTokens,
      token_scale: result.tokenScale,
    });

    /**
     * The reflection loop gets the finished turn — and only a finished one.
     *
     * Last, after the reply has gone out and the session is saved, and deliberately not awaited:
     * whatever it decides to do takes a provider call, and nothing about this conversation should
     * wait on a background question about a turn that is already over. It swallows its own
     * failures for the same reason (`ReflectionEngine.observe`).
     *
     * Only on this path, so it never sees a turn that threw. A turn that died halfway has nothing to
     * teach except that it did not work, and writing down a half-finished procedure is precisely
     * how a shared skill pool poisons itself.
     */
    // Not a mission's turn: its work is remembered once, from its report, when it ends (MISSIONS §11).
    if (!shape) void this.ctx.deps.reflection?.observe({
      agentId: agent.config.id,
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
      sessionId: session.id,
      // What the pass costs is charged to the turn it looked at (`purpose: "reflection"`).
      ...(record ? { turnId: record.id } : {}),
      // The text as the person typed it, not the composed question: the overheard-context block
      // and the attachment notice are the harness talking, and an explicit "catet jadi skill ya"
      // has to be matched against what they actually said.
      userText: text,
      messages: result.turnMessages,
      // The whole conversation as it now stands, so the loop can see a chain of corrections that
      // no single turn contains. `capStoredTurns` has not been applied to it yet — this is what
      // the model actually worked from, plus the turn it just produced.
      chain: result.messages,
      steps: result.toolSteps,
      iterations: result.iterations,
    });

    // Compacted now, while nobody is waiting — the reply has already gone out. See `compactAfterReply`. A mission's turn
    // keeps only itself, so it has nothing to compact.
    if (!controller.signal.aborted && !shape) {
      await compactAfterReply(this.ctx.deps, {
        key,
        sessionId: session.id,
        stored: done.stored,
        plan: result.compaction,
        // Charged to this turn, as a compaction: the reply has gone, and the summary is still what it cost. The
        // provider the summary before the answer had, for the model it chose (`plan.summaryModel`).
        provider: done.summarize(done.override ?? agent.config.llm.model).provider,
        signal: controller.signal,
        say: (text, detail) => record?.step("compact", text, detail),
      });
    }
  }

  /** A turn that threw: what it did kept, the person told what they need, and the provider blamed only when it failed. */
  private async fail(turn: TurnState, err: unknown): Promise<void> {
    const { agent, envelope, controller } = turn;
    // Only LLM errors count against provider health.
    //
    // Counting every failure meant a bad agent config, a throwing tool or a missing profile all
    // reported the *provider* as failing — health blaming a component that is fine is worse than
    // health saying nothing, because it sends you to the wrong place first.
    //
    // Nor does a turn that was stopped — by a person, a pause or its own clock: the call ends because we ended it.
    // Twelve stopped missions once counted twelve failures against a provider that was answering, at error level.
    const stopped = controller.signal.aborted;
    if (err instanceof LLMError && !stopped) {
      const profile = agent.config.llm.provider;
      this.ctx.deps.providerErrors?.set(profile, (this.ctx.deps.providerErrors.get(profile) ?? 0) + 1);
    }

    const failure = err instanceof LLMError && !stopped ? err.failure : undefined;
    const said = { agent_id: agent.config.id, chat_id: envelope.chatId, error: String(err), ...(failure ? { failure_class: failure.class, action: failure.action } : {}) };
    if (stopped) log.info("turn stopped", said);
    else log.error("turn failed", said);

    // Only the classes the operator can act on. A rate limit is not their problem; an expired key,
    // an empty balance or a model id that does not exist are — and finding out hours later from
    // someone saying "the bot is broken" is what this prevents.
    if (failure?.alertOperator) {
      void this.ctx.deps.notifier?.alert(
        `provider_${failure.class}:${agent.config.llm.provider}`,
        `${agent.config.id} cannot reach ${agent.config.llm.provider}: ${failure.class}. ${failure.operatorHint}`,
      );
    }
    turn.failed = true;
    // Sanitized for the chat, detailed in the log (§17.2 item 5).
    const message = toUserMessage(err);
    // What the turn did is kept however it ended, and the person is told what they need — `turn-endings.ts`.
    const cause = causeOf(controller.signal, message);
    await endEarly(this.ctx, { key: turn.key, history: turn.upkept ?? turn.history, asked: turn.asked, journal: turn.journal, cause, envelope, agentId: agent.config.id, turnId: turn.record?.id, prompt: turn.text, message, error: String(err), close: (patch) => close(turn, patch), progress: turn.progress, retryable: err instanceof LLMError && err.retryable });
    tell(turn, { toolCalls: 0, worked: 0, tokens: 0, failed: true, error: message, interrupted: controller.signal.reason === STOPPED_BY_PERSON || this.ctx.paused, readOutside: false });
  }

  /** However the turn ended: its clock and nudges stopped, its place let go, and nothing left open. */
  private release(turn: TurnState): void {
    turn.clock.stop();
    turn.nudges?.stop();
    this.ctx.releaseTurn(turn.turnKey);
    this.ctx.forgetCallIds(turn.record?.id);
    // A row left `running` is a client polling forever. Every path above closes it; this is the one
    // that catches the path somebody adds later and forgets.
    close(turn, { status: "failed", error: "the turn ended without a result" });
    tell(turn, { toolCalls: 0, worked: 0, tokens: 0, failed: true, error: "the turn ended without a result", interrupted: false, readOutside: false });
    // Not awaited: the answer has already gone out by here, and a turn that waited on a chat
    // platform to acknowledge its own status line would hold this conversation's queue for it.
    // `finish` swallows its own failures.
    void turn.progress?.finish(turn.failed ? "failed" : "ok");
  }
}
