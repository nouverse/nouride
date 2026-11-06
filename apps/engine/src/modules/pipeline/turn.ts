/**
 * One turn: build the executor, run the tool loop, persist what came of it, and say something back.
 *
 * Starts only once `inbound.ts` has decided this message gets a turn and which agent takes it. What
 * is left here is genuinely one job, and it is long because a turn touches a lot: the daily cost cap,
 * the in-chat progress line, the typing indicator, grant bookkeeping, usage accounting, the
 * attachments, the group-context replay, the stored-history cap, and four different ways a turn can
 * end with nothing to say.
 */

import { turnClock } from "./turn-clock.ts";
import { changesSharedTools } from "@/modules/toolchain/shared-tools.ts";
import { dirname, join } from "@nouride/runtime";
import {
  createLogger,
  LLMError,
  newId,
  toUserMessage,
  type LoadedAgent,
  type MessageEnvelope,
  type SessionKey,
  resolveTurnDurationMs,
  type ChatMessage,
} from "@nouride/shared";
import { brainFor } from "./brain.ts";
import type { ContextLine } from "@/modules/llm/executor/context-line.ts";
import type { Unattended } from "@/modules/llm/executor/types.ts";
import { capStoredTurns } from "@/modules/llm/context.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { settleNotes } from "@/modules/tools/builtins/plan.ts";
import { notesOf } from "@/modules/notes/tail.ts";
import { HookRegistry, ModelOverrides } from "@/modules/hooks/registry.ts";
import { ChatProgress } from "@/modules/pipeline/chat-progress.ts";
import { APPLIANCE_REPLY_FLUSH, TurnRecorder } from "@/modules/turns/recorder.ts";
import type { TurnJournal } from "@/modules/turns/journal.store.ts";
import { isSystemEvent } from "./deps.ts";
import { editCause, editedQuestionNote, isEdit, quotedId } from "./edit-rules.ts";
import { arrivingQuestion, composeContent, composeQuestion, effortRefusedNote, emptyTurnMessage, outsideOf, secretsNote, threadOpenerNote, turnReminders } from "./messages.ts";
import { missionQuestions } from "./mission-questions.ts";
import { speakerName } from "@/modules/people/match.ts";
import type { AttachmentIntake } from "./attachments.ts";
import type { RoomMemory } from "./room-memory.ts";
import { STOPPED_BY_PERSON, TurnContext } from "./turn-context.ts";
import { causeOf, endEarly } from "./turn-endings.ts";
import { compactAfterReply } from "./session-lifecycle.ts";
import { wakeCause } from "./job-wakes.ts";
import { OWN_WORDS } from "./own-words-wake.ts";
import { meter } from "@/modules/llm/metered.ts";
import { summarizerFor } from "@/modules/llm/summarizer.ts";
import { alertOnFallback } from "@/modules/pipeline/fallback-alert.ts";
import { fallbacksFor } from "@/modules/llm/fallbacks.ts";
import { cronJobOfChat } from "@/modules/cron/session.ts";
import { Preamble } from "./preamble.ts";
import { nudgeBaseMs, replyNote, watchTurn } from "./budget-nudges.ts";
import { outcomeOf, type TurnOutcome, type TurnShape } from "./turn-shape.ts";
import { secondLookFor } from "@/modules/tools/second-look.ts";
import { chatTurnLevel, scheduledInChat } from "./job-turns.ts";

const log = createLogger("pipeline.turn");

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
    // One spelling, shared with `TurnContext.isBusy` — two copies of a turn's identity is two answers
    // to "is this agent working", and the guard would pass while the map said otherwise.
    const turnKey = TurnContext.turnKey(key.agentId, key.chatId, key.gatewayId);
    const controller = new AbortController();
    // A stated cap, not one derived from iterations × tool timeout — that arithmetic came to 12.5
    // minutes by default, which is long enough that the chat looks broken rather than busy.
    // The agent's own clock when it names one, the daemon's otherwise — resolved once so the
    // deadline and the timer that enforces it cannot disagree.
    const turnMs = resolveTurnDurationMs(
      agent.config.llm.maxTurnDurationMs,
      this.ctx.deps.config.llm.limits.maxTurnDurationMs,
    );
    const deadlineAt = Date.now() + turnMs;
    // A coding CLI's mission turn is stopped after the turn's time without a step, not after the turn's time (0.8.7).
    const clock = turnClock(turnMs, () => controller.abort(), shape !== undefined && agent.config.external !== undefined);
    this.ctx.activeTurns.set(turnKey, {
      controller, agentId: key.agentId, chatId: key.chatId, gatewayId: key.gatewayId,
      steers: [], steered: 0, startedAt: Date.now(), trigger: envelope,
    });

    const session = this.ctx.deps.sessions.load(key);
    // What the turn starts from: the conversation so far — or, for a mission's turn, nothing but its page (MISSIONS §4).
    const history = shape ? [] : session.messages;
    // Who the turn is for: the sender — or the person who started the mission, whose level and People entry apply.
    const person = shape?.person ?? { gatewayId: envelope.gatewayId, senderId: envelope.senderId };
    const asPerson: MessageEnvelope = shape ? { ...envelope, gatewayId: person.gatewayId, senderId: person.senderId } : envelope;
    /** Told once, however the turn ends — the mission decides its next step from it. */
    let told = false;
    const tell = (outcome: TurnOutcome) => {
      if (told || !shape) return;
      told = true;
      try {
        shape.ended(outcome);
      } catch (err) {
        log.error("a shaped turn's end could not be taken in", { agent_id: agent.config.id, chat_id: envelope.chatId, error: String(err) });
      }
    };
    /**
     * The message this turn is answering, once it has been composed.
     *
     * Declared out here because the only thing that can save it is the failure path, and the failure
     * path is a `catch` around everything that builds it. Undefined means the turn died before there
     * was a question to keep — nothing composed, nothing to lose.
     */
    let asked: ChatMessage | undefined;
    /** Opened with the question, for the same reason `asked` is declared out here. */
    let journal: TurnJournal | undefined;
    const gateway = this.ctx.deps.gateways.get(envelope.gatewayId);

    /**
     * The durable record of this turn — see `modules/turns/turns.store.ts`.
     *
     * Opened before the cost cap is checked, so a refused turn is a row that says why rather than a
     * message that appears in one chat window and exists nowhere else. Everything after this point
     * reports into it: the steps, the answer as it is written, and how it ended.
     */
    // Or the edit it answers (G11): a message corrected while it waited, or an edit of one already answered.
    const cause = wakeCause(envelope) ?? editCause(envelope);
    const record = TurnRecorder.begin(this.ctx.deps.turns, {
      sessionId: session.id,
      agentId: agent.config.id,
      gatewayId: envelope.gatewayId,
      chatId: envelope.chatId,
      messageId: envelope.id,
      senderId: envelope.senderId,
      // What the person actually wrote. The overheard-context block and the attachment notice are the
      // harness talking, and a transcript that shows them as the question is a transcript of a
      // conversation nobody had.
      prompt: text.trim() || "(attachment)",
      // What the daemon pushed this for, when nobody typed it — the transcript's heading for it.
      ...(cause ? { cause } : {}),
      // Metadata only, and taken from the envelope rather than from what the store managed to save:
      // a file that failed to download was still *sent*, and a transcript that hides it explains
      // nothing about the answer that follows.
      ...(envelope.attachments?.length
        ? {
            attachments: envelope.attachments.map((attachment) => ({
              name: attachment.filename ?? "file",
              mimeType: attachment.mimeType,
              kind: attachment.type,
              ...(attachment.size === undefined ? {} : { bytes: attachment.size }),
              direction: "in" as const,
              // The upload path, replaced below with the durable copy once the intake has run. Kept
              // here so a turn that dies before the intake still says what arrived with it.
              ...(attachment.url ? { path: attachment.url } : {}),
            })),
          }
        : {}),
    }, this.ctx.deps.appliance?.() ? APPLIANCE_REPLY_FLUSH : undefined);
    let finished = false;
    const close = (patch: Parameters<TurnRecorder["finish"]>[0]) => {
      if (finished) return;
      finished = true;
      record?.finish(patch);
    };

    // Checked before the provider is called rather than after: refusing a turn costs nothing, and
    // discovering the cap once the money is spent is not enforcement.
    const budget = this.ctx.checkSpend();
    if (budget.action === "refuse") {
      log.warn("daily cost cap reached, refusing the turn", { agent_id: agent.config.id });
      void this.ctx.deps.notifier?.alert("cost_cap", budget.message);
      await this.ctx.voice.reply(envelope, budget.message);
      close({ status: "failed", reply: budget.message, error: "daily cost cap reached" });
      tell({ toolCalls: 0, worked: 0, tokens: 0, failed: true, error: budget.message, interrupted: false, readOutside: false });
      this.ctx.releaseTurn(turnKey);
      clock.stop();
      return;
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
    if (envelope.announce) {
      await this.ctx.deps.notifier?.toChat(
        { gatewayId: envelope.gatewayId, chatId: envelope.chatId },
        envelope.announce,
      );
    }

    // Live progress in the conversation itself, for gateways that can edit a message.
    //
    // Only `tool` and `waiting` reach it. `thinking` and `reasoning` fire many times per turn and say
    // nothing a person waiting can act on; a status line that changes every second is harder to read
    // than one that changes when something happens. `tool_done` is skipped too — it is immediately
    // replaced by the next `tool`, and on the last step the summary says it better.
    let turnFailed = false;
    // The bubble carries the agent's name and avatar, so it belongs on the agent's own connection —
    // the same rule the answer follows. Posting it on the inbound one put Nexa's "2 steps · waiting
    // for you" under Nouva.
    const voiceGateway =
      this.ctx.deps.gateways.get(this.ctx.voice.voiceGatewayId(agent.config.id, envelope.gatewayId)) ?? gateway;
    const progress =
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
        : undefined;

    /**
     * The opening line before long work, said at once on every platform (`preamble.ts`) — under the same switch as the
     * progress line, since both are "say what you are doing in the chat". A person is waiting only on a message they
     * sent: a system event (a finished job, a scheduled run) gets its answer and nothing before it. Sent like the
     * answer — the agent's own connection, quoting the trigger in a group. The bubble so far is closed above the words,
     * and the steps after them start one below: left open, it was edited above them, where nobody was looking (0.8.5).
     */
    const preamble =
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
    const nudges = preamble ? watchTurn(nudgeBaseMs(this.ctx.deps.config.agents.nudgeAfterMinutes), (ms) => replyNote(ms, canHandOver)) : undefined;

    // The turn's own calls — and the compaction its executor runs first, which says so (`purpose`).
    const charge = meter(this.ctx.deps.usage, {
      agentId: agent.config.id,
      provider: agent.config.llm.provider,
      purpose: "turn",
      sessionId: session.id,
      ...(record ? { turnId: record.id } : {}),
    });
    // Who writes a compaction summary, before the answer and after it alike — `[memory]`'s pass model when set (M12).
    const summarize = summarizerFor(this.ctx.deps, { agentId: agent.config.id, profile: agent.config.llm.provider, sessionId: session.id, tiers: agent.config.llm, ...(record ? { turnId: record.id } : {}) });
    // What a compaction before the answer left, kept if the turn ends early: the summary is paid for either way.
    let upkept: ChatMessage[] | undefined;
    // Three layers, resolved fresh per call: the agent's own posture, then this person's — keyed by the person and not
    // the conversation, because pairing establishes that *they* are trusted and scoping it to a chat meant re-saying it
    // after every `/new` — then the daemon default. A scheduled job's turn here is never `trusted` (`chatTurnLevel`).
    const level = () => chatTurnLevel(envelope, this.ctx.approvalLevel(agent, person));
    const executor = brainFor(this.ctx.deps.externalAgents, agent, {
      summarizer: summarize,
      maxImageBytes: this.ctx.deps.config.media.maxImageBytes,
      // A route that refused audio is not sent any for a week. Read at call time, so a `/model`
      // switched mid-conversation is the one recorded.
      onAudioRefused: () => this.attachments.hearing.recordRejection(agent.config.llm.provider, this.modelOverrides.get(session.id) ?? agent.config.llm.model),
      onFallback: alertOnFallback(this.ctx.outages, this.ctx.deps.notifier, agent),
      windowOf: (model) => this.ctx.deps.providers?.catalog?.windowNow(agent.config.llm.provider, model) ?? null,
      ...(this.ctx.deps.spill ? { spill: this.ctx.deps.spill } : {}),
      tokenScales: this.ctx.tokenScales,
      llm: this.ctx.deps.config.llm,
      approvals: this.ctx.deps.approvals,
      approvalLevel: level,
      // The second look at what work nobody watches sends out (0.8.0), charged with this turn's calls.
      secondLook: secondLookFor({
        agent: agent.config,
        install: () => this.ctx.deps.config,
        level,
        provider: () => this.ctx.deps.providers.get(agent.config.llm.provider),
        onUsage: (usage, model) => charge(usage, model, "second_look"),
      }),
      carefulHint: () => this.ctx.carefulHint(agent, person),
      onBatch: (lines) => progress?.batch(lines),
      group: (write) => this.ctx.atomically(write),
      onActivity: (kind, text, detail) => {
        clock.stillWorking();
        // Two sinks, one callback: the record — the stream every reader follows, `thinking` said to them and kept
        // nowhere — and the bubble in the chat itself.
        record?.step(kind, text, detail);
        progress?.show(kind, text, detail);
        if (kind === "waiting") {
          /**
           * Sealed, and **returned** so the executor waits for it.
           *
           * Two things go wrong without this. The bubble keeps being edited after the approval prompt
           * lands below it, so the numbers climb somewhere the reader has already scrolled past — and
           * after approving, the turn looks like it stopped dead. And because progress is throttled,
           * a tool that needs approval fires `tool` and `waiting` milliseconds apart: the bubble had
           * not been posted yet, so it appeared *below* the prompt instead of above it.
           *
           * Sealing flushes immediately and awaiting it fixes the order.
           */
          return progress?.seal("waiting for you");
        }
      },
      onGrantUsed: (agentId, grantKey) => {
        if (!grantKey) return;
        // Both stores, because the gate hands back a key without saying which kind it is — and both
        // `touch` calls are no-ops for a key they do not hold. Asking the gate to label it would put
        // knowledge of the two tables somewhere that does not need it.
        this.ctx.deps.grants?.touch(agentId, grantKey);
        this.ctx.deps.toolGrants?.touch(grantKey);
      },
      // The answer as it is written. Only the record reads its words — a chat platform gets the finished
      // message, for the reasons in `§6.5` and on `ExecutorDeps.onText`; the bubble only that it is being written.
      onText: (delta: string) => {
        record?.delta(delta);
        progress?.wrote();
      },
      ...(record ? { onRequest: (line: ContextLine) => record.context(line) } : {}),
      ...(preamble ? { onPreamble: (words: string, said?: { own?: boolean }) => preamble.offer(words, said) } : {}),
      execPolicy: (agentId) => ({
        grantsHeld: this.ctx.deps.grants?.liveKeys(agentId).size ?? 0,
      }),
      timezone: this.ctx.deps.config.daemon.timezone,
      ...(this.ctx.deps.credentialsDir ? { credentialsDir: this.ctx.deps.credentialsDir } : {}),
      // The install root, derived the same way the diagnostic `renderPrompt` does it: grandparent of
      // the data directory. Wired here since 2026-08-23 — before this, the executor never passed it,
      // so the "MY OWN CLI" harness section was silently absent on every real turn.
      installDir: dirname(dirname(this.ctx.deps.config.daemon.dataDir)),
      binDir: join(dirname(this.ctx.deps.config.daemon.dataDir), "bin"),
      changesSharedTools: (agentId: string) => changesSharedTools(this.ctx.deps.config, this.ctx.deps.registry.get(agentId)),
      ...(this.ctx.deps.projectSkills
        ? { projectSkills: (a: LoadedAgent) => this.ctx.deps.projectSkills!.forAgent(a) }
        : {}),

      commands: this.hooks.list().filter((hook) => !hook.hidden).map((hook) => hook.command),
      // Refreshed from inside the turn, so the indicator stays alive across tool calls instead
      // of expiring after the first one. Omitted entirely when the config turns it off —
      // passing a no-op would still start the 5s refresh timer.
      ...(this.ctx.deps.config.llm.streaming.typingIndicator
        ? {
            // The agent's own connection, like everything else it emits. On the inbound one the chat
            // showed "Nouva is typing…" while Nexa was the one working — the fourth place this rule
            // had to be applied, and the one a person notices first.
            onTyping: () => void voiceGateway?.setTyping(envelope.chatId),
            ...(this.ctx.deps.typingRefreshMs ? { typingRefreshMs: this.ctx.deps.typingRefreshMs } : {}),
          }
        : {}),
      onUsage: (usage) => {
        log.debug("llm usage", {
          agent_id: usage.agentId,
          model: usage.model,
          input: usage.inputTokens,
          output: usage.outputTokens,
          estimated: usage.estimated ?? false,
        });
        charge(usage, usage.model, usage.purpose, usage.provider);
      },
      onCompacted: (history) => void (upkept = history),
    });

    try {
      const provider = this.ctx.deps.providers.get(agent.config.llm.provider);
      // `mission` as this turn holds it: `start` in a chat, the mission's own actions in a mission's turn (0.8.0).
      const missionTool = shape ? this.ctx.deps.missionTools?.inside : this.ctx.deps.missionTools?.chat;
      // `schedule` in a chat's turn only: a mission's conversation is read by nobody, and its card would go nowhere.
      const scheduleTool = shape ? undefined : this.ctx.deps.scheduleTool;
      const workTool = this.ctx.deps.missionTools?.work;
      const toolset = resolveToolset(agent, this.ctx.tools, this.ctx.deps.config.security, { ...this.ctx.toolsetDeps(), ...(missionTool ? { missionTool } : {}), ...(workTool ? { workTool } : {}), ...(scheduleTool ? { scheduleTool } : {}), ...(shape?.helperWorktrees ? { helperWorktrees: true } : {}) });
      const override = this.modelOverrides.get(session.id);

      /**
       * The turn's journal — `modules/turns/journal.store.ts` — opened before anything slow (P6).
       *
       * With the words alone, because the files that came with them download first, up to thirty seconds a file. A
       * crash in that window used to leave a record and no journal: at the next boot the person was told the turn
       * was gone, and it was taken up again in the same breath. Opened here, it is closed like any turn a crash cut
       * off, and the composed question takes this one's place once it exists. From here nothing the turn does is lost
       * to a crash: the executor commits every message as it happens, and however the turn ends, what it did is
       * folded into the conversation.
       */
      const head = { agentId: agent.config.id, gatewayId: envelope.gatewayId, chatId: envelope.chatId, kind: "chat" as const, startedAt: Date.now() };
      journal = this.ctx.deps.journal?.open(record?.id ?? newId("turn"), head, { role: "user", content: arrivingQuestion(text, envelope.attachments), timestamp: envelope.timestamp });

      // Show typing indicator immediately while downloading attachments and analyzing images
      if (this.ctx.deps.config.llm.streaming.typingIndicator) void voiceGateway?.setTyping(envelope.chatId);

      // Downloaded before the turn starts, so the agent can open the file within the same reply
      // rather than telling the user to send it again. A failure here is a note in the prompt, never
      // an aborted turn: a message whose image did not download still has its text.
      // The model this turn will actually run on — a `/model` override hears or not on its own terms.
      const target = { agentId: agent.config.id, profile: agent.config.llm.provider, model: override ?? agent.config.llm.model };
      const intake = await this.attachments.store(agent.config.id, envelope, target);
      /**
       * Plus the pictures that reached this conversation without being attached to this message.
       *
       * Two ways that happens and both were losing them. A reply brings the quoted *text* and nothing
       * else, so the image somebody was pointing at never arrived. And a picture posted while nobody
       * was talking to this agent was replayed as a line of chatter with its file left behind — the
       * shape of "here is a screenshot" followed by "@agent look at this" in the next message.
       *
       * Both are the same fix and both are bounded: the quoted message, and the window
       * `overheardBefore` already replays. Empty for an ordinary turn.
       */
      const carried = await this.attachments.pictures(agent.config.id, envelope, [
        ...(await this.attachments.quotedFiles(envelope)),
        ...this.rooms.filesBefore(envelope, history, session.startedAt),
      ]);
      const attachmentNotice = carried.length > 0
        ? `${intake.notice}\n[${carried.length} image(s) from earlier in this conversation are in` +
          ` your context as pictures: the message you are replying to, or what was posted here` +
          ` while nobody was talking to you. Read what you need from them.]`.trim()
        : intake.notice;
      /**
       * The record points at the durable copies, not the browser upload.
       *
       * `TurnRecorder.begin` wrote the upload paths, which live in `data/uploads` for a day. These are
       * the files in the agent's own attachment directory, which is what the retention sweep governs
       * and what the dashboard can still serve a week later.
       */
      if (intake.stored.length > 0) {
        record?.attachments(
          intake.stored.map((stored) => ({
            name: stored.filename ?? "file",
            mimeType: stored.mimeType,
            kind: stored.type,
            ...(stored.size === undefined ? {} : { bytes: stored.size }),
            direction: "in" as const,
            path: stored.localPath,
          })),
        );
      }

      /**
       * What the room said since this agent was last spoken to.
       *
       * Composed into the user message and *stored with it*, which is what keeps this from repeating
       * itself: the block is replayed once, becomes part of the conversation like anything else, and
       * the next turn's window starts after the message that carried it. So the history grows by the
       * chatter that actually happened and never by the same line twice.
       */
      const overheard = this.rooms.overheardBefore(agent, envelope, history, session.startedAt);
      // The same window, read from the events table. Stored with the message for the same reason, so
      // an event reaches this agent once and then belongs to its conversation.
      const events = this.rooms.eventsBefore(agent, envelope, history, session.startedAt);
      const question = composeQuestion({
        text,
        overheard,
        events,
        hasAttachments: Boolean(attachmentNotice),
        ...(envelope.chatType === "dm" ? {} : { speaker: speakerName(this.ctx.deps.config.people, envelope) }),
        // A thread's first question carries what the thread was started from; after that it is in the history (0.7.24).
        ...(envelope.threadOpener && history.length === 0
          ? { opener: threadOpenerNote({ name: speakerName(this.ctx.deps.config.people, { gatewayId: envelope.gatewayId, ...envelope.threadOpener }), ...envelope.threadOpener }) }
          : {}),
        // An edit of a message already answered is asked as one, so the agent can say what changes (`edit-rules.ts`).
        ...(isEdit(envelope) ? { edit: editedQuestionNote(envelope) } : {}),
        // What its handles stand for, in the model's copy only: the turn's record keeps what the person wrote. A coding
        // CLI's own shell never has a handle (0.8.11), and is told so.
        ...(envelope.secrets?.length ? { secrets: secretsNote(envelope.secrets, { ownShell: agent.config.external !== undefined }) } : {}),
      });

      const workspace = this.ctx.workspaceFor(agent.config.id);

      /**
       * Assigned here and declared above, so the failure path can still save it.
       *
       * A turn that throws never reaches `sessions.save`, and that is where the question went: stop an
       * agent mid-answer and the message you had just sent was gone from the conversation with it, so
       * `/start` resumed an agent that had never heard it. Reported as "kalo stop beneran hilang
       * konteks di atasnya ya?", and it was — for every failed turn, not only a stopped one.
       */
      asked = {
        role: "user",
        /**
         * Parts when a picture came with the message, a plain string otherwise.
         *
         * Text first and images after, which is the order that reads correctly to every provider
         * this talks to: the question, then the thing it is about. The refs are pointers — the
         * executor turns them into bytes for the request and the transcript keeps the pointers,
         * so the session row stays a few hundred bytes rather than a megabyte per screenshot.
         */
        content: composeContent(
          attachmentNotice ? `${question}\n\n${attachmentNotice}`.trim() : question,
          // The message's own first: `resolveImages` reads newest-first within a budget, and what
          // somebody just sent beats what they are pointing back at.
          [...intake.media, ...carried.filter((part) => !intake.media.some((own) => own.ref === part.ref))],
        ),
        timestamp: envelope.timestamp,
      };

      journal?.question(asked);

      const recall = await this.ctx.recallFor(agent.config.id, asPerson);
      const result = await executor.run({
        signal: controller.signal,
        agent,
        provider,
        ...fallbacksFor(agent, this.ctx.deps.providers),
        toolset,
        history,
        // Already stripped of the address prefix by the caller: left in, the model sees its own
        // name as the first token of every message and starts echoing the pattern back.
        //
        // Attachments are *described*, never silently dropped. Before this, a photo with a caption
        // sent the caption alone and the model answered confidently about a screenshot it had never
        // seen — worse than an error, because nothing in the reply shows it happened.
        userMessage: asked,
        reminders: [
          ...turnReminders(text, toolset.definitions, { running: this.ctx.helpersRunning(agent.config.id, envelope), now: Date.now() }),
          // What its own missions in this chat wait for the person to answer (`mission-questions.ts`).
          ...missionQuestions(this.ctx.deps.missionCommands?.forChat(envelope.gatewayId, envelope.chatId) ?? [], agent.config.id, toolset.definitions),
        ],
        workspaceDir: workspace.shared,
        privateDir: workspace.own,
        ...(this.modelOverrides.effortOf(session.id) ? { effort: this.modelOverrides.effortOf(session.id)! } : {}),
        // Set only on a synthesized wake-up. Forwarded rather than re-derived: the executor has no
        // business knowing what a background job is, and the envelope already knows.
        ...(envelope.owedReport ? { owedReport: envelope.owedReport } : {}),
        // Only the agents that could actually be reached from here. Naming one that is disabled, or
        // that no gateway would deliver to, teaches the model to address somebody who never answers.
        //
        // And *how* they are reached, which is not the same question in every chat. In a room every
        // bot present sees what is said, so a tag is delivered and the exchange is visible to the
        // people in it. A DM is one person and one bot: nothing written there reaches another agent,
        // whether or not it has a connection of its own, so the handover goes over the bus instead
        // and the agent the person is talking to stays the only voice in the conversation.
        /**
         * Narrowed to the room's members where the room has any.
         *
         * `registry.enabled()` is every live agent on the daemon, which is the right answer for a
         * platform chat — the operator decides who is in a Discord channel and we cannot see it — and
         * the wrong one for a room somebody built out of three agents. There it told Nero it could
         * tag Nexa and Nestor, who are not in the conversation: the tag goes out, the router delivers
         * it to nobody, and it reads as a routing bug rather than as a prompt that named the wrong
         * people. `roomAgents` returns null when nothing knows, and this falls back to the old list.
         */
        ...(() => {
          const otherAgents = this.ctx.otherAgentsFor(agent.config.id, envelope);
          return otherAgents ? { otherAgents } : {};
        })(),
        // `exec` hands back `Live log: <dataDir>/jobs/<id>.log` when it starts something in the
        // background, and `read` used to refuse that path — the tool named a file its own sandbox
        // would not open. Read-only, because the job is still writing to it.
        readOnlyRoots: this.ctx.readOnlyRoots(agent, session.id),
        // Scoped to THIS conversation, not the agent's whole attachment tree: a file posted in a
        // Discord channel must not be readable from a Telegram DM.
        ...(this.ctx.deps.attachments
          ? {
              attachmentRoot: this.ctx.deps.attachments.rootFor({
                agentId: agent.config.id,
                gatewayId: envelope.gatewayId,
                chatId: envelope.chatId,
              }),
            }
          : {}),
        gateway: envelope.gateway,
        ...this.ctx.formattingFor(envelope.gatewayId),
        gatewayId: envelope.gatewayId,
        chatId: envelope.chatId,
        // The signal says the turn will end; this says when. Anything deciding how long to block —
        // the approval gate, today — needs the second to leave room for the model to react.
        deadlineAt,
        chatType: envelope.chatType,
        ...this.ctx.roomNameOf(envelope),
        sessionId: session.id,
        // With the call ids its helpers and peers draw from too: their steps are rows of this turn (`stepsInto`).
        ...(record ? { turnId: record.id, callIds: this.ctx.callIdsOf(record.id) } : {}),
        senderId: person.senderId,
        // A mission's call that needs a person is parked, not waited on (MISSIONS §7).
        ...(shape ? { parkApprovalsMs: shape.parkApprovalsMs, workdir: shape.workdir, ...(shape.parked > 0 ? { parkedCalls: shape.parked } : {}) } : {}),
        // Work nobody watches (0.8.0): a mission's turn, or a scheduled job's turn put into its own chat.
        ...((): { unattended?: Unattended } => {
          const unattended = shape?.unattended ?? scheduledInChat(envelope);
          return unattended ? { unattended } : {};
        })(),
        // A schedule's, a job's or a resume's turn says so, rather than reading as a stranger's (#13).
        ...(isSystemEvent(envelope) ? { systemEvent: true } : {}),
        ...(cause?.via === OWN_WORDS ? { ownWords: true } : {}),
        /**
         * An *unverified* display name stays group-only: in a DM there is nobody else in the room, so
         * a name the sender chose for themselves adds nothing but a chance to be misread as
         * identification.
         *
         * A verified one is the opposite. It means this daemon authenticated the account the message
         * came from — the dashboard — and withholding it left the agent knowing nothing about who it
         * was talking to in the one surface where the operator actually sits.
         */
        ...(envelope.chatType !== "dm" || envelope.senderVerified
          ? { senderName: envelope.senderName }
          : {}),
        ...(envelope.senderVerified ? { senderVerified: true } : {}),
        // The *matched* person goes everywhere, DMs included. That is the whole point — a household
        // talks to its agent in DMs, and this is the surface that told the agent nothing.
        ...(() => {
          const known = this.ctx.personFor(asPerson);
          return known ? { person: known } : {};
        })(),
        ...(recall ? { recall } : {}),
        // Told even when nobody matched, because that is when it changes what the model should do.
        ...(this.ctx.deps.config.people.length > 0 ? { peopleConfigured: true } : {}),
        ...(override ? { model: override } : {}),
        ...(journal ? { journal } : {}),
        // A forwarded message, a webhook's payload — or what a mission read in an earlier turn: read as outside content
        // from the first step (S13).
        ...outsideOf({ ...envelope, outsideContent: [...(envelope.outsideContent ?? []), ...(shape?.outsideContent ?? [])] }),
        // A shutdown ends a turn between steps rather than in the middle of one; a person's new message is read there.
        // A shutdown, or the agent put to sleep (0.8.0): either stops the turn at its next step, never mid-call.
        pause: () => this.ctx.paused || this.ctx.deps.registry.isPaused(agent.config.id), steer: () => this.ctx.takeSteers(turnKey),
        steerListen: (poke) => {
          const turn = this.ctx.activeTurns.get(turnKey);
          if (!turn) return () => {};
          turn.onSteer = poke;
          return () => {
            if (turn.onSteer === poke) turn.onSteer = undefined;
          };
        },
        steerReplying: () => this.ctx.activeTurns.get(turnKey)?.replying === true,
        ...(nudges ? { harnessNote: nudges.take } : {}),
        // The conversation's work notes, read at every request and sent after everything else (`modules/notes/`).
        ...notesOf(this.ctx.deps.notes, { agentId: agent.config.id, gatewayId: envelope.gatewayId, chatId: envelope.chatId }),
      });
      // No step left to read a message sent from here on — `ActiveTurn.answered`.
      this.ctx.answered(turnKey);

      /**
       * Stopped at a step boundary because the daemon is shutting down.
       *
       * Closed like any turn cut short — its journal folded into the conversation, the person told
       * what finished — while the gateways are still up to carry the message.
       */
      if (result.paused) {
        turnFailed = true;
        const asleep = !this.ctx.paused;
        const error = asleep ? "the agent was put to sleep while this turn was running" : "the daemon restarted while this turn was running";
        await endEarly(this.ctx, { key, history: upkept ?? history, asked, journal, cause: asleep ? { kind: "stopped" } : { kind: "restart" }, envelope, agentId: agent.config.id, turnId: record?.id, prompt: text, error, close, progress });
        tell(outcomeOf(result, true));
        return;
      }

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
        close({
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

      // Marks the reply as landed — now, or when a buffered copy is flushed (`TurnContext.markDelivered`).
      const delivered = (): void => this.ctx.markDelivered(record?.id);

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
       * **Not covered by a test, unlike its twin in the `catch` below.** Aborting a turn rejects the
       * provider call it is parked in, so every attempt to land here from the harness — mid-provider,
       * mid-tool, between iterations — ended in the error branch instead. The path is real: the
       * executor breaks at the top of its loop when the signal is already aborted, which is a turn
       * stopped while a tool was running and the provider was not. It is simply not one this suite
       * has managed to reach, and a guard that is only in one of the two places is a bug waiting for
       * the other.
       */
      if (stoppedByPerson) {
        // `failed` rather than `ok`: the bubble is the only thing left in the chat saying what
        // happened to this turn, and a tick beside work somebody stopped reads as work that finished.
        await progress?.finish("failed");
        tell(outcomeOf(result, true));
        return;
      }

      if (said.trim()) {
        // Summary-style platforms post their one line here, so it precedes the answer. No-op elsewhere.
        await progress?.beforeAnswer(turnFailed ? "failed" : "ok");
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
          await progress?.beforeAnswer(turnFailed ? "failed" : "ok");
          if (await this.ctx.voice.reply(envelope, notice!, agent.config.id, { onDelivered: delivered })) delivered();
        }
      }

      // A finished plan goes; one with steps left stays with its task in the work notes (`settleNotes`). A mission's stays
      // whole: its checklist is the mission's record until it ends.
      await settleNotes(this.ctx.deps.notes, { agentId: agent.config.id, gatewayId: envelope.gatewayId, chatId: envelope.chatId, sessionId: session.id }, { keepFinished: shape !== undefined });
      tell(outcomeOf(result, false));

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
       * In the `try`, so it never sees a turn that threw. A turn that died halfway has nothing to
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
          stored,
          plan: result.compaction,
          // Charged to this turn, as a compaction: the reply has gone, and the summary is still what it cost. The
          // provider the summary before the answer had, for the model it chose (`plan.summaryModel`).
          provider: summarize(override ?? agent.config.llm.model).provider,
          signal: controller.signal,
          say: (text, detail) => record?.step("compact", text, detail),
        });
      }
    } catch (err) {
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
      turnFailed = true;
      // Sanitized for the chat, detailed in the log (§17.2 item 5).
      const message = toUserMessage(err);
      // What the turn did is kept however it ended, and the person is told what they need — `turn-endings.ts`.
      const cause = causeOf(controller.signal, message);
      await endEarly(this.ctx, { key, history: upkept ?? history, asked, journal, cause, envelope, agentId: agent.config.id, turnId: record?.id, prompt: text, message, error: String(err), close, progress, retryable: err instanceof LLMError && err.retryable });
      tell({ toolCalls: 0, worked: 0, tokens: 0, failed: true, error: message, interrupted: controller.signal.reason === STOPPED_BY_PERSON || this.ctx.paused, readOutside: false });
    } finally {
      clock.stop();
      nudges?.stop();
      this.ctx.releaseTurn(turnKey);
      this.ctx.forgetCallIds(record?.id);
      // A row left `running` is a client polling forever. Every path above closes it; this is the one
      // that catches the path somebody adds later and forgets.
      close({ status: "failed", error: "the turn ended without a result" });
      tell({ toolCalls: 0, worked: 0, tokens: 0, failed: true, error: "the turn ended without a result", interrupted: false, readOutside: false });
      // Not awaited: the answer has already gone out by here, and a turn that waited on a chat
      // platform to acknowledge its own status line would hold this conversation's queue for it.
      // `finish` swallows its own failures.
      void progress?.finish(turnFailed ? "failed" : "ok");
    }
  }
}
