/**
 * The inbound path: gateway → router → queue → hook or agent turn → reply.
 *
 * This file is the *wiring*. Every stage is implemented beside it, and the reason they are all in
 * one directory is that the **order** is the thing that is easy to get wrong and hard to see: a
 * group message is observed before it is admitted, admitted before it is routed, routed before it is
 * claimed, and rate-limited only once we know an agent would have answered. Each of those placements
 * fixed a bug, and each is documented where the call happens.
 *
 *   deps.ts              what the pipeline is handed, and the shared constants
 *   messages.ts          the strings a person reads when something goes missing
 *   voice.ts             which bot an agent speaks with, and the outbound record
 *   admission.ts         allowlist and pairing, rate limit, one-turn-per-message claim
 *   room-memory.ts       what a room said while nobody was addressed
 *   chat-types.ts        room or one-to-one, for the turns nobody is watching
 *   batcher.ts           four photos, one turn
 *   attachments.ts       fetching and describing what arrived
 *   session-lifecycle.ts rollover, compaction
 *   conversation-end.ts  what ending a conversation clears — /new, /reset, a rollover, a delete
 *   turn-context.ts      what every turn needs, whoever started it
 *   arrival.ts           what an arriving message does first, in order, before anyone is chosen to answer
 *   gateway-events.ts    a gateway connecting, dying or refusing a reply: the menu, and the operator's alerts
 *   inbound.ts           whether this message gets a turn at all, and whose
 *   turn.ts              running one, from executor to reply
 *   job-turns.ts         the scheduler's turns, and where their output goes
 *   subagent.ts          one helper turn, run as its parent
 *   background-helper.ts one helper as a job of its own, whose end wakes its parent
 *   peer-turn.ts         one OTHER agent's turn, run behind the chat
 *   background-ask.ts    that turn moved to a job of its own when it runs long, whose answer wakes the agent that asked
 *   render-prompt.ts     the diagnostic that shows a prompt without running a turn
 */

import { agentStatus, type AgentStatus } from "./agent-status.ts";
import { readFileBytes } from "@nouride/runtime";
import { KeyedQueue } from "@nouride/queue";
import {
  createLogger,
  type ApprovalDecision,
  type ApprovalRequest,
  type Attachment,
  type ChatType,
  type LoadedAgent,
  type MessageEnvelope,
  type Tool,
  type ToolContext,
} from "@nouride/shared";
import { SideQuestions } from "./side-question.ts";
import { HookRegistry, ModelOverrides, parseCommand } from "@/modules/hooks/registry.ts";
import type { StoppedInBackground } from "@/modules/hooks/types.ts";
import {type SessionStatus } from "@/modules/tools/registry.ts";
import type { BackgroundStart, SubagentRequest, SubagentResult } from "@/modules/tools/builtins/delegate.ts";
import type { AskStart, PeerTurnRequest, PeerTurnResult } from "@/modules/tools/builtins/ask-agent.ts";
import type {
  AttachmentReadOptions,
  OpenedAttachment,
} from "@/modules/tools/builtins/attachment.ts";
import type { ChatAttachment } from "@/modules/attachments/chat-attachments.store.ts";
import { isStored } from "@/modules/attachments/store.ts";
import type { CronExecutors } from "@/modules/cron/scheduler.ts";
import type { JobCompletion, JobRecord } from "@/modules/jobs/jobs.store.ts";

import type { PipelineDeps } from "./deps.ts";
import { Voice } from "./voice.ts";
import { Admission } from "./admission.ts";
import { RoomMemory } from "./room-memory.ts";
import { Batcher } from "./batcher.ts";
import { AttachmentIntake } from "./attachments.ts";
import { JobWakes, jobOfCompletionWake } from "./job-wakes.ts";
import { attachmentReadOptions } from "./attachment-reader.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { endConversation, type Ended, type EndingConversation, type EndMode } from "./conversation-end.ts";
import { TurnContext, type ActiveTurn, type SendAttachmentResult } from "./turn-context.ts";
import { ChatTypes } from "./chat-types.ts";
import { TurnRunner } from "./turn.ts";
import { InboxDesk } from "./inbox-desk.ts";
import { InboundRouter } from "./inbound.ts";
import { steerReach } from "./steering.ts";
import { renderPrompt, renderPromptForOperator } from "./render-prompt.ts";
import { JobTurns } from "./job-turns.ts";
import { runSubagent } from "./subagent.ts";
import { startBackgroundHelper } from "./background-helper.ts";
import { runPeerTurn } from "./peer-turn.ts";
import { startAsk } from "./background-ask.ts";
import type { DaemonRestart } from "@/modules/update/restart.ts";
import { senderIsAdmin } from "@/modules/people/match.ts";
import { restartResumeEnvelope, type Cut, type ResumeWhy } from "./restart-resume.ts";
import { cliStoppedEnvelope, ownWordsEnvelope } from "./own-words-wake.ts";
import type { WorkingJob } from "@/modules/update/self-update.ts";
import { scheduleProviderResume } from "./provider-resume.ts";
import { approvalResumeEnvelope } from "./approval-resume.ts";
import { arrive, type ArrivalParts } from "./arrival.ts";
import { ChatSecrets, secretsHookPort } from "./chat-secrets.ts";
import { answerGroupCommand, groupMentionHookPort } from "./room-mention.ts";
import { EditLedger } from "./edits.ts";
import { onGatewayEvent } from "./gateway-events.ts";
import { postMessage, reachableChats, sayInChat, sendTargets, tellChat } from "./send-message.ts";
import { knownRooms, renameRoom, type KnownRoom } from "./known-rooms.ts";
import type { SendMessageOptions } from "@/modules/tools/builtins/send-message.ts";
import { conversationSlots } from "./fair-share.ts";
import type { TurnRecord } from "@/modules/turns/turns.store.ts";

export type { PipelineDeps } from "./deps.ts";

const log = createLogger("pipeline");

export class Pipeline {
  private readonly queue: KeyedQueue<MessageEnvelope>;
  /** Messages written down on arrival, and put back after a restart — `inbox-desk.ts`. */
  readonly inbox: InboxDesk;
  /** The daemon's restart, handed back once built — it waits for this pipeline to go idle. `/daemon-restart` asks it. */
  restart?: DaemonRestart;
  private readonly hooks: HookRegistry;
  /** A chat's `/model` and `/effort`, on its conversation's row (076) so a restart keeps them. */
  private readonly modelOverrides: ModelOverrides;

  private readonly voice: Voice;
  private readonly admission: Admission;
  private readonly rooms: RoomMemory;
  // The room log answers for a room this process has not heard from yet — a dashboard room, or one a platform recorded.
  private readonly chatTypes = new ChatTypes((gatewayId, chatId) => Boolean(this.deps.rooms?.get(gatewayId, chatId) || this.deps.roomMessages?.isRoom(gatewayId, chatId)));
  private readonly batcher: Batcher;
  private readonly attachments: AttachmentIntake;
  private readonly lifecycle: SessionLifecycle;
  private readonly turnContext: TurnContext;
  /** `/btw`: side questions, answered beside the work (0.8.17). */
  private readonly sideQuestions: SideQuestions;
  private readonly turns: TurnRunner;
  private readonly inbound: InboundRouter;
  private readonly jobTurns: JobTurns;
  /** Deferred wake-up pushes waiting for a turn to finish — see `wakeForJob`. */
  private readonly pendingWakes = new Set<Promise<void>>();
  private readonly jobWakes: JobWakes;
  /** What recently edited messages say now — `edits.ts`. */
  private readonly edits = new EditLedger();
  /** The credentials people send, taken out as their messages arrive — `chat-secrets.ts`. */
  private readonly secrets: ChatSecrets | undefined;
  /** What an arriving message passes through, once `attach` has built it — for a message the daemon puts back. */
  private parts: ArrivalParts | undefined;

  constructor(private readonly deps: PipelineDeps) {
    this.modelOverrides = new ModelOverrides(deps.sessions);
    this.secrets = deps.heldSecrets ? new ChatSecrets(deps.heldSecrets) : undefined;
    this.voice = new Voice(deps);
    this.admission = new Admission(deps, (envelope) =>
      this.voice.replyAuthor(envelope, deps.config.gateways.find((gateway) => gateway.id === envelope.gatewayId)?.agent),
    );
    this.rooms = new RoomMemory(deps, this.voice);
    this.attachments = new AttachmentIntake(deps);
    this.turnContext = new TurnContext(deps, this.voice, this.chatTypes);
    this.sideQuestions = new SideQuestions(this.turnContext);
    const end = (conversation: EndingConversation, mode: EndMode) => this.endConversation(conversation, mode);
    this.lifecycle = new SessionLifecycle(deps, end);

    const isAdmin = (envelope: MessageEnvelope) => this.isAdmin(envelope);
    this.hooks = new HookRegistry({
      registry: deps.registry,
      restart: {
        request: (request) => this.restart?.request(request) ?? null,
        mayRestart: (envelope) => this.admission.admitsByName(envelope) && isAdmin(envelope),
      },
      isAdmin,
      sessions: deps.sessions,
      approvals: deps.approvals,
      modelOverrides: this.modelOverrides,
      endConversation: end,
      ...(deps.notes ? { notes: deps.notes } : {}),
      ...(deps.missionCommands ? { missions: deps.missionCommands } : {}),
      ...(deps.scheduleCommands ? { proposals: deps.scheduleCommands } : {}),
      ...(deps.grants ? { grants: deps.grants } : {}),
      daemon: { startedAt: deps.startedAt, version: deps.version },
      // The redacted text — the operator's own files, with everything this repository wrote
      // replaced by a note. See `renderPromptForOperator`.
      renderPrompt: (id, c) => renderPromptForOperator(this.turnContext, this.hooks, this.modelOverrides, id, c.envelope),
      cancelTurn: (agentId, chatId) => this.cancelTurnFor(agentId, chatId),
      stopBackground: (agentId, chatId) => this.stopBackgroundFor(agentId, chatId),
      agentStatus: (agentId) => this.agentStatus(agentId),
      ...(deps.externalAgents?.offeredEfforts ? { cliEfforts: (agentId: string) => deps.externalAgents!.offeredEfforts!(agentId) } : {}),
      ...(deps.agentEffort ? { agentEffort: { mayChange: (envelope: MessageEnvelope) => this.admission.admitsByName(envelope) && isAdmin(envelope), set: deps.agentEffort } } : {}),
      ...(deps.externalAgents?.answering ? { answering: (agent: LoadedAgent, gatewayId: string, chatId: string) => deps.externalAgents!.answering!(agent, gatewayId, chatId) } : {}),
      compactSession: (agentId, hookCtx) => this.lifecycle.compactSession(agentId, hookCtx),
      sideQuestion: (agent, envelope, question) => this.sideQuestions.ask(agent, envelope, question),
      ...(this.deps.autoApprove ? { autoApprove: this.deps.autoApprove } : {}),
      // So `/approvals` can report the fallback when neither the agent nor the person has set one.
      daemonApprovals: deps.config.security.approvals,
      resolveGateway: (id) => this.deps.gateways.get(id),
      listHooks: () => this.hooks.list(),
      ...(deps.usage ? { sessionUsage: (sessionId: string, since: number, onlyCli?: boolean) => deps.usage!.forSession(sessionId, since, onlyCli) } : {}),
      ...(deps.reflection ? { drafts: deps.reflection } : {}),
      ...(deps.roomMention
        ? { groupMention: groupMentionHookPort({ config: deps.config, store: deps.roomMention, mayChange: (envelope) => this.admission.admitsByName(envelope) && isAdmin(envelope), claim: (envelope, key) => this.admission.claim(envelope, key) }) }
        : {}),
      ...(this.secrets
        ? { secrets: secretsHookPort({ secrets: this.secrets, keeping: deps.secretKeeping, registry: deps.registry, mayManage: (envelope) => this.admission.admitsByName(envelope) && isAdmin(envelope), deliver: (back) => this.deliver(back) }) }
        : {}),
    });

    this.turns = new TurnRunner(
      this.turnContext,
      this.rooms,
      this.attachments,
      this.hooks,
      this.modelOverrides,
    );
    this.inbound = new InboundRouter(
      this.turnContext,
      this.admission,
      this.lifecycle,
      this.hooks,
      this.turns,
    );

    const groupCommand = {
      hooks: this.hooks,
      registry: deps.registry,
      config: deps.config,
      reply: (to: MessageEnvelope, text: string, fromAgent: string) => this.voice.reply(to, text, fromAgent),
      connected: (gatewayId: string) => deps.gateways.get(gatewayId)?.status === "connected",
    };
    this.queue = new KeyedQueue<MessageEnvelope>({
      // Sequential per (agent-bearing chat), parallel across chats. The key deliberately
      // excludes the agent: two agents in one chat still take turns, because they are
      // talking to the same person.
      key: (envelope) => `${envelope.gatewayId}:${envelope.chatId}`,
      // Not a message a turn handed back unread: in a room it came through here a moment ago (`TurnContext.returned`).
      dedupId: (envelope) => (this.turnContext.returned.has(envelope) ? null : `${envelope.gatewayId}:${envelope.chatId}:${envelope.id}`),
      // Slash commands answer immediately, outside the ordering.
      //
      // They were parsed inside this queue's handler, which made `/approve` useless for the one thing
      // it exists for: the turn waiting on that approval holds this conversation's key, so the answer
      // queued behind the question and neither could move until the approval timed out five minutes
      // later. Seen live on Telegram — three `/approve` messages, no reply to any of them.
      //
      // Deliberately narrow: only text that *already* starts with `/` and names a hook we have. A
      // group message like "nouva: /approve" still queues, because deciding otherwise needs the routed
      // agent and getting it wrong would run two turns at once in one chat — which loses messages.
      // Everything here is cheap and touches no session, so running it beside a turn is safe.
      urgent: (envelope) => {
        const command = parseCommand(envelope.text.trim());
        return command !== null && this.hooks.has(command.command);
      },
      /**
       * One turn at a time in a one-to-one chat; several in a room.
       *
       * The key is the *chat*, and for a DM that is the right unit: two turns at once means one agent
       * answering two things simultaneously, interleaving writes to one session.
       *
       * A room's conversations are per agent — each member has its own session — so serialising the
       * chat makes every member wait for whichever one was asked first. Asked to compare two models,
       * Nouva ran for a minute and a message to Nero sat behind it doing nothing, in a room whose
       * whole point is that the other agents are free.
       *
       * The global ceiling (`maxConcurrentTurns`) still bounds the spend, which is what it is for —
       * the per-key cap looks like it is doing that job and is not. A room's share of it is its agents, at
       * most half the ceiling, so one room cannot take every slot (`fair-share.ts`, P12).
       */
      maxConcurrentPerKey: (envelope) => conversationSlots(envelope, deps),
      maxConcurrentTotal: deps.config.queue.maxConcurrentTurns,
      maxQueueDepth: deps.config.queue.maxQueueDepth,
      queueTimeoutMs: deps.config.queue.queueTimeoutMs,
      /**
       * The inbox follows the message through: taken by a turn, then handled — however it was handled. A
       * message whose turn the daemon could not finish is closed with its work kept and its person told,
       * which is handled too: it must not be answered again from the inbox after a restart.
       */
      handler: (envelope) => {
        // Taken from the queue: a finished job's result is now in front of its agent (`069_baseline.sql`).
        const woken = jobOfCompletionWake(envelope);
        if (woken) this.deps.jobWakes?.markWoken(woken, Date.now());
        // A command about the group (`/mention`) before routing: untagged in a shared room, routing would answer nobody.
        return this.inbox.track(envelope, async () => {
          if (!(await answerGroupCommand(groupCommand, envelope))) await this.inbound.handle(envelope);
        });
      },
      onDropped: (envelope, reason) => {
        // A shutdown keeps what was waiting: it stays in the inbox and is answered after the restart.
        if (this.inbox.dropped(envelope, reason)) return;
        log.warn("message dropped", {
          chat_id: envelope.chatId,
          gateway: envelope.gatewayId,
          reason,
        });
        const notice = this.admission.noticeDropped(envelope, reason);
        if (notice) {
          void this.voice.reply(envelope, notice).catch((err: unknown) =>
            log.error("drop notice failed", { chat_id: envelope.chatId, error: String(err) }),
          );
        }
        /**
         * Recorded whether or not a notice was sent, and that difference is the point.
         *
         * `noticeDropped` throttles to one notice per chat per minute, because a full queue drops
         * many messages at once and an apology per message would itself be the flood. Every drop
         * still happened, though, and "my message never got an answer" is the question this table
         * can now answer — the throttled ones are exactly the ones nothing told anybody about.
         *
         * `ui`: the message was never routed, so no agent was ever told about it, and putting it in
         * an agent's context would describe a conversation it did not have.
         */
        this.deps.chatEvents?.record({
          gatewayId: envelope.gatewayId,
          chatId: envelope.chatId,
          audience: "ui",
          kind: "dropped",
          text: notice ?? dropSentence(reason),
          ...(envelope.senderId ? { actor: envelope.senderId } : {}),
          details: { reason, messageId: envelope.id, throttled: !notice },
        });
      },
    });

    this.jobWakes = new JobWakes({
      deps,
      queue: this.queue,
      admission: this.admission,
      chatTypes: this.chatTypes,
      turnContext: this.turnContext,
      pending: this.pendingWakes,
    });
    this.batcher = new Batcher((envelope) => void this.queue.push(envelope));
    this.turnContext.requeue = (envelope) => void this.queue.push(envelope);
    // What an asleep agent was sent waits for it to wake, then goes back in, in order (0.8.0).
    this.turnContext.asleep.requeue = (envelope) => void this.queue.push(envelope);
    deps.registry.onWoke?.((agentId) => {
      const released = this.turnContext.asleep.release(agentId);
      if (released > 0) log.info("an agent woke: what was kept for it goes on", { agent_id: agentId, messages: released });
    });
    this.turnContext.borrowSlot = () => this.queue.borrow();
    this.turnContext.resumeLater = (turn) =>
      scheduleProviderResume(turn, {
        resume: (taken) => this.resumeTurn(taken, "provider"),
        movedOn: (taken, since) => this.deps.turns?.startedInChatSince(taken.gatewayId, taken.chatId, since) ?? false,
        stopping: () => this.turnContext.paused,
        ...(deps.providerResumeMs === undefined ? {} : { delayMs: deps.providerResumeMs }),
      });
    this.inbox = new InboxDesk(deps, this.batcher, (envelope) => this.turnContext.holds(envelope));
    this.turnContext.settleMessage = (envelope) => this.inbox.settleWithTurn(envelope);
    // A delegate in the background that has run long, said to the agent it reports to — the road a quiet job's notice takes.
    this.turnContext.nudgeLead = (jobId, text) => {
      const job = deps.jobs?.get(jobId);
      if (job) this.jobWakes.quiet(job, text);
    };
    this.jobTurns = new JobTurns(
      this.turnContext,
      (envelope) => this.queue.push(envelope),
      (agent, key) => this.lifecycle.rollOverIfStale(agent, key),
      (work) => this.queue.runOutside(work),
    );

    // An agent's reply that @mentions another agent sharing the same bot will never be delivered by
    // the platform (the bot filters its own echo). Re-inject it through the queue so the inbound
    // pipeline can route it to the mentioned agent.
    this.voice.onInternalHandover((envelope) => {
      // Room memory first, then the router — the same order `attach` uses for a platform message, and
      // for the same reason: what was said is worth recording whether or not anybody answers it.
      this.rooms.observe(envelope);
      void this.queue.push(envelope);
    });
    /**
     * A record, not a message. Deliberately not `queue.push`.
     *
     * This fires for every reply an agent makes on a gateway that does not echo — including the closing
     * lines that tag nobody, which is most of them. Routing it would make every reply a new inbound
     * message and turn the convention that ends an exchange into the thing that continues it.
     */
    this.voice.onOwnMessage((envelope) => {
      this.rooms.observe(envelope);
    });
  }

  /**
   * Install the tool registry.
   *
   * A two-step construction, because `session_status` needs live session facts from the
   * pipeline while the pipeline needs the tool map. Passing a closure into the tool factory
   * and the finished map back in here breaks the cycle without a lazy getter that could be
   * read before it is set.
   */
  setTools(tools: Map<string, Tool>): void {
    this.turnContext.tools = tools;
  }

  /** Subscribe to every gateway. Called once, after the gateways are built. */
  attach(): void {
    const parts: ArrivalParts = (this.parts = {
      deps: this.deps,
      rooms: this.rooms,
      chatTypes: this.chatTypes,
      admission: this.admission,
      inbox: this.inbox,
      hooks: this.hooks,
      turnContext: this.turnContext,
      batcher: this.batcher,
      // A message not yet taken by a turn, for its edit: held in a burst first, the queue after.
      waiting: (match) => this.batcher.find(match) ?? this.queue.find(match),
      edits: this.edits,
      ...(this.secrets ? { secrets: this.secrets } : {}),
    });
    for (const gateway of this.deps.gateways.values()) {
      /**
       * One transaction for everything an arriving message writes before anything awaits (E7): the room's record of
       * it, its files, the inbox's row, and — when the queue takes it at once, as it does a quiet chat — its `placed`
       * and the turn's opening row. They were a commit each. Nothing here spans an await (`EventStore.batch` refuses).
       */
      gateway.onMessage((envelope) => this.turnContext.atomically(() => arrive(parts, gateway, envelope)));

      gateway.onEvent((event) => onGatewayEvent(gateway, event, () => this.commands(), this.deps.notifier));
    }
  }

  /** A message the daemon puts back — `/secret undo` — arriving as one from its platform would. */
  private deliver(envelope: MessageEnvelope): void {
    const gateway = this.deps.gateways.get(envelope.gatewayId);
    const parts = this.parts;
    if (gateway && parts) this.turnContext.atomically(() => arrive(parts, gateway, envelope));
  }

  /**
   * A finished background job re-enters the pipeline as a message.
   *
   * Through the queue, not as a direct turn: the conversation may be busy, and a wake-up that jumped
   * the queue would interleave with a turn already running on the same history. It also means the
   * per-chat ordering, rate limit and dedup all apply without a second code path.
   *
   * The sender is the daemon, not a person, so it bypasses `admit` — the job was started by an
   * already-authorized turn, and making the runtime pair with itself would be nonsense.
   */
  wakeForJob(raw: JobCompletion): void {
    this.jobWakes.completion(raw);
  }

  /** A turn of a conversation that is not a chat's — a mission's (`modules/missions/`), into the same queue. */
  queueTurn(envelope: MessageEnvelope): boolean {
    return this.queue.push(envelope);
  }

  /** An external agent's CLI said something by itself, between turns: a turn in its chat reads it (`own-words-wake.ts`). */
  wakeForOwnWords(chat: { agentId: string; gatewayId: string; chatId: string }, made = ownWordsEnvelope): void {
    const gateway = this.deps.gateways.get(chat.gatewayId);
    if (!gateway) return;
    const push = () => void this.queue.push(made(chat, gateway.platform, this.chatTypes.of(chat.gatewayId, chat.chatId) ?? "dm"));
    const wake = this.turnContext.waitUntilFree(chat.agentId, chat.chatId, chat.gatewayId).then(push);
    this.pendingWakes.add(wake);
    void wake.then(() => this.pendingWakes.delete(wake));
  }

  /** A command an external agent's CLI had left running, which the last process was stopped with: its chat is told. */
  wakeForCliStopped(chat: { agentId: string; gatewayId: string; chatId: string }): void {
    this.wakeForOwnWords(chat, cliStoppedEnvelope);
  }

  /** A running job that has gone quiet — see `JobWatchdog` and `JobWakes.quiet`. */
  wakeForQuietJob(job: JobRecord, text: string): void {
    this.jobWakes.quiet(job, text);
  }

  /** What the external agents' CLIs left running in the background: a restart waits for it, as for a job (0.8.6). */
  cliCommands(): WorkingJob[] {
    return this.deps.externalAgents?.working?.() ?? [];
  }

  /** Resolves when the queue is empty. Does not stop accepting work. */
  async idle(): Promise<void> {
    this.batcher.flush();
    // Deferred job wake-ups waiting for a turn to finish must push before the queue can be idle.
    if (this.pendingWakes.size > 0) await Promise.all(this.pendingWakes);
    await this.queue.idle();
  }

  /**
   * Stop accepting messages, then wait for in-flight turns — the shutdown path (§14.1 SPEC).
   *
   * One-way on purpose, and distinct from `idle()`: a "drain" that resumed afterwards would
   * make the shutdown sequence's guarantee meaningless, since a gateway still delivering
   * during teardown could enqueue work after the wait returned.
   */
  async drain(): Promise<void> {
    this.batcher.flush();
    if (this.pendingWakes.size > 0) await Promise.all(this.pendingWakes);
    await this.queue.drain();
    await this.deps.externalAgents?.stopAll?.();
  }

  /**
   * The first step of a shutdown: every running turn stops at its next step boundary — no new model call,
   * no new tool — and closes itself with what it had done (`TurnContext.paused`). Nothing new starts:
   * what is waiting stays `queued` in the inbox and is answered after the restart.
   *
   * The queue is held before the batcher is flushed, so a burst of media still held there is kept too
   * rather than starting a turn the shutdown would only cut off.
   */
  pause(): void {
    this.turnContext.paused = true;
    const held = this.queue.hold();
    this.batcher.flush();
    if (held.length > 0) log.info("kept waiting messages for after the restart", { messages: held.length });
  }

  stats() {
    return this.queue.stats();
  }



  /**
   * Cancel whatever this agent is doing in this chat.
   *
   * `/stop` calls it. Without this the command only refused *new* messages, so an agent stuck in a
   * tool loop could not be stopped at all short of restarting the daemon — the reply the operator
   * was waiting on stayed pending and the chat's queue stayed blocked behind it.
   */
  cancelTurnFor(agentId: string, chatId: string): boolean {
    return this.turnContext.cancelTurnsForAgent(agentId, chatId) > 0;
  }

  /** Words put in front of an agent's turn at work in a chat — a mission's `tell` (0.8.10, `ActiveTurns.steerInto`). */
  steerInto(agentId: string, chatId: string, gatewayId: string, envelope: MessageEnvelope): "taken" | "full" | "ending" | "none" {
    return this.turnContext.steerInto(agentId, chatId, gatewayId, envelope);
  }

  /**
   * How words taken into this agent's turn reach it: at its model's next step; into its coding CLI's running prompt; or,
   * where its CLI takes nothing mid-prompt, once that prompt ends.
   */
  steerReach(agentId: string): "next_step" | "into_cli" | "after_prompt" {
    return steerReach(this.deps, agentId);
  }

  /** Where a mission's `tell` its turn was handed is marked read (`ActiveTurns.toldRead`). */
  onToldRead(read: (missionId: string, tellIds: string[]) => void): void {
    this.turnContext.toldRead = read;
  }

  cancelTurn(turnKey: string): boolean {
    return this.turnContext.cancelTurn(turnKey);
  }

  /**
   * Stop what this agent has working in the background for this conversation — its helpers, and the agents it asked
   * whose answers had not come back (0.7.19) — `/stop`'s other half. Each still reports, as stopped.
   */
  stopBackgroundFor(agentId: string, chatId: string): StoppedInBackground {
    const jobs = this.deps.jobs;
    const stopped = (jobs?.backgroundTurns(agentId) ?? []).filter((job) => job.chatId === chatId && jobs!.kill(job.id, "/stop"));
    return { helpers: stopped.filter((job) => job.kind === "helper").length, asked: stopped.flatMap((job) => (job.ask ? [job.ask.agent] : [])) };
  }

  /**
   * End one conversation: `/new`, `/reset`, a rollover, or a delete from the dashboard. What each one clears is
   * `ENDS` in `conversation-end.ts`; this is only where its collaborators are — the stores, and this pipeline's own
   * authorship record, model overrides and running turns.
   */
  endConversation(conversation: EndingConversation, mode: EndMode): Promise<Ended> {
    return endConversation(
      {
        sessions: this.deps.sessions,
        ...(this.deps.turns ? { turns: this.deps.turns } : {}),
        ...(this.deps.chatEvents ? { chatEvents: this.deps.chatEvents } : {}),
        ...(this.deps.spill ? { spill: this.deps.spill } : {}),
        ...(this.deps.notes ? { notes: this.deps.notes } : {}),
        approvals: this.deps.approvals,
        ...(this.deps.memory ? { memory: this.deps.memory } : {}),
        authorship: this.voice.outbound,
        modelOverrides: this.modelOverrides,
        stopTurns: (agentId, chatId) => this.turnContext.cancelTurnsForAgent(agentId, chatId),
        forgetCliSession: (agentId, gatewayId, chatId) => this.deps.externalAgents?.forgetSession?.(agentId, gatewayId, chatId),
        // The connection's own word for its platform; a gateway id is `<platform>:<name>` for one no longer connected.
        platformOf: (gatewayId) => this.deps.gateways.get(gatewayId)?.platform ?? gatewayId.split(":")[0] ?? gatewayId,
      },
      conversation,
      mode,
    );
  }

  /** Every turn running right now, with its address. Read by the shutdown notice. */
  runningTurns(): ActiveTurn[] { return this.turnContext.running(); }

  /** What this agent is doing now — `agent-status.ts`. */
  agentStatus(agentId: string): AgentStatus {
    const agent = this.deps.registry.get(agentId);
    const provider = agent ? this.deps.providers.available().find((profile) => profile.name === agent.config.llm.provider) : undefined;
    return agentStatus({
      state: this.deps.registry.status(agentId),
      enabled: agent?.config.enabled ?? false,
      turns: this.turnContext.running().filter((turn) => turn.agentId === agentId),
      // A command its coding CLI left running is work too: Nix's `sleep 30` showed it idle on the sofa (2026-11-03).
      jobs: (this.deps.jobs?.running(agentId).length ?? 0) + (this.deps.externalAgents?.working?.().filter((cli) => cli.id === `cli:${agentId}`).length ?? 0),
      missions: this.deps.missionCommands?.forStatus(agentId) ?? { atWork: 0, waiting: 0 },
      waiting: this.deps.approvals.pending(agentId).length,
      // An external agent answers on its CLI's sign-in, not its model profile's credential.
      credential: provider && !agent?.config.external ? provider.hasCredential : null,
      cli: agent?.config.external ? (this.deps.externalAgents?.unavailable?.(agentId) ?? null) : null,
    });
  }
  cancelTurnsInChat(gatewayId: string, chatId: string): number { return this.turnContext.cancelTurnsInChat(gatewayId, chatId); }
  rateLimitEntries(): number { return this.admission.rateLimitEntries(); }
  groupContextRooms(): number { return this.rooms.groupContextRooms(); }
  claimEntries(): number { return this.admission.claimEntries(); }

  /** A chat's type as its messages said it, or undefined before one did — whether a mission's link goes there (0.8.11). */
  chatTypeOf(gatewayId: string, chatId: string): string | undefined {
    return this.chatTypes.of(gatewayId, chatId);
  }

  /**
   * Whether this sender is an admin by People (`senderIsAdmin`): in a room, who besides the person who asked may answer an
   * approval — by `/approve` (the hooks) or by a press on its prompt (`tools/approval-prompts.ts`, G11).
   */
  isAdmin(who: { gatewayId: string; senderId: string }): boolean {
    return senderIsAdmin(this.deps.config.people, who, (id) => this.deps.users?.byId(id)?.role);
  }

  /**
   * The connection id an agent should speak through, given where a message arrived.
   *
   * Public because an agent's identity has to hold on *everything* it says — the answer, the live
   * progress line and the approval prompt each go out through their own path.
   */
  voiceGatewayId(agentId: string, inboundGatewayId: string): string {
    return this.voice.voiceGatewayId(agentId, inboundGatewayId);
  }

  /** Whether a paused agent answers this message: a command that works while paused (`HookRegistry.answersWhilePaused`). */
  answersWhilePaused(text: string): boolean {
    return this.hooks.answersWhilePaused(text);
  }

  /**
   * The slash commands a person may type, for a client that wants to offer them.
   *
   * The same list Telegram's menu is built from, from the same registry — because a command list
   * typed out a second time is a command list that goes stale, which is exactly how `/auto` went on
   * being advertised for a release after it became `/approvals`. Hidden commands stay hidden: they
   * answer, they are not taught.
   */
  commands(): { command: string; description: string }[] {
    return this.hooks
      .list()
      .filter((hook) => !hook.hidden)
      .map((hook) => ({ command: hook.command, description: hook.description }));
  }

  /**
   * The built prompt for this chat, whole.
   *
   * Returns the `BuiltPrompt` rather than a string so the caller chooses what it may show:
   * `/prompt` takes `operatorText`, which is the operator's own files with everything this
   * repository wrote replaced by a note. Nothing else calls this.
   *
   * Kept whole here — rather than redacting at this layer — because the assembly is what the tests
   * check. `render-prompt.ts` builds its harness facts by hand, separately from `turn.ts`, and has
   * twice got them wrong; the display no longer shows them, so the test is the only thing left that
   * would notice.
   */
  renderPrompt(agentId: string, envelope: MessageEnvelope): ReturnType<typeof renderPrompt> {
    return renderPrompt(this.turnContext, this.hooks, this.modelOverrides, agentId, envelope);
  }

  /** What the scheduler is allowed to reach — closures, never this object. */
  cronExecutors(): CronExecutors {
    return this.jobTurns.cronExecutors();
  }

  /**
   * Put a file on the wire, for `send_file`.
   *
   * A closure rather than the gateway map, for the same reason `startJob` and the cron executors are
   * closures: a tool holding the gateway map could send anywhere, to any conversation.
   */
  async sendAttachment(ctx: ToolContext, attachment: Attachment): Promise<SendAttachmentResult> {
    return await this.turnContext.sendAttachment(ctx, attachment);
  }

  /**
   * `send_message`'s two closures, each scoped inside to the agent the call is from: the chats it can reach, and the
   * send — never the gateway map, for the reason `sendAttachment` is a closure.
   */
  messageSender(): SendMessageOptions {
    return {
      targets: (ctx) => sendTargets(this.deps, ctx.agentId, this.chatTypes),
      post: (ctx, chat, text) => postMessage(this.turnContext, ctx, chat, text),
    };
  }

  /** A line from the daemon into the chat a tool call came from (`send-message.ts`). */
  chatNotice(): (ctx: ToolContext, text: string) => Promise<boolean> {
    return (ctx, text) => tellChat(this.turnContext, ctx, text);
  }

  /** A line said in a chat for an agent outside any turn, and kept in its conversation there (`send-message.ts`, 0.8.23). */
  sayInChat(chat: { agentId: string; gatewayId: string; chatId: string; chatType: ChatType }, text: string, note: string): Promise<boolean> {
    return sayInChat(this.turnContext, chat, text, note);
  }

  /** The chats a job's results can go to, and what each is — `GET /chats` (0.8.0). */
  reachableChats(): ReturnType<typeof reachableChats> {
    return reachableChats(this.deps, this.chatTypes);
  }

  /** The rooms the daemon knows, for the Groups page, and a rename there (0.7.24) — `known-rooms.ts`. */
  knownRooms(): KnownRoom[] {
    const rooms = knownRooms(this.deps, this.chatTypes);
    // A room nobody has written in since 0.7.24 has no name yet: listing it asks its platform, in the background, so the
    // page has the names the next time it is opened (`refresh` is throttled and never throws).
    for (const room of rooms) {
      const gateway = room.name ? undefined : this.deps.gateways.get(room.gatewayId);
      if (gateway) void this.deps.roomNames?.refresh(gateway, room.chatId);
    }
    return rooms;
  }

  renameRoom(gatewayId: string, chatId: string, title: string): ReturnType<typeof renameRoom> {
    return renameRoom(this.deps, gatewayId, chatId, title);
  }

  /**
   * Exposed so the tool registry can build `attachment_read` without reaching into the pipeline.
   *
   * Four closures rather than the index and the store, per the rule `boot/tools.ts` is built on: a
   * tool holding the index could list any conversation's files, and one holding the attachment store
   * could open any of them. Each of these is scoped to the conversation the calling turn is in,
   * inside the closure, where the tool cannot widen it.
   *
   * `undefined` when this daemon has no attachment index — then the tool is not offered at all,
   * rather than offered and answering "nothing is configured", which teaches a model to stop asking.
   */
  attachmentReader(): AttachmentReadOptions | undefined {
    const index = this.deps.attachmentIndex;
    if (!index) return undefined;

    return attachmentReadOptions({
      deps: this.deps,
      index,
      intake: this.attachments,
      open: (ctx, file) => this.openAttachment(ctx, file),
      status: (ctx) => this.sessionStatus(ctx),
    });
  }

  /**
   * The bytes of one indexed file: the durable copy, or a fetch that becomes one.
   *
   * The path in the index is a hint and is verified, never trusted — a row can outlive the file it
   * points at, because the attachment retention window and the index's are different numbers. So a
   * missing file is not a failure here; it is a reason to go back to the platform.
   *
   * The fetch is attempted on the connection that *saw* the file first, because a handle is not
   * always portable: a Telegram `file_id` is scoped to the bot it was issued to, and another bot on
   * the same chat cannot resolve it. The caller's own connection is the fallback, which is what makes
   * this work on Discord, where the handle is a URL anybody may fetch.
   */
  private async openAttachment(ctx: ToolContext, file: ChatAttachment): Promise<OpenedAttachment> {
    if (file.localPath) {
      const bytes = await readFileBytes(file.localPath).catch(() => null);
      if (bytes) return { bytes, path: file.localPath };
    }

    const store = this.deps.attachments;
    if (!store || !file.handle) {
      return { error: "there is no local copy and no way to fetch it again" };
    }

    const gateway =
      this.deps.gateways.get(file.gatewayId) ?? this.deps.gateways.get(ctx.gatewayId);
    const fetcher = gateway?.fetchAttachment?.bind(gateway);
    if (!fetcher) return { error: "the connection it arrived on cannot retrieve files" };

    /**
     * Stored under the *reading* agent, in this conversation's directory.
     *
     * Not a shared pool: the copy belongs to the agent that asked for it, in the same per-agent,
     * per-chat directory everything else it receives lands in — so its own file tools can reach it
     * and the ordinary retention sweep clears it. The index is what makes the file *findable* across
     * the room; where the bytes sit is still one agent's business.
     */
    const outcome = await store.store(
      { agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId },
      file.handle,
      fetcher,
      0,
    );
    if (!isStored(outcome)) return { error: outcome.unavailable };

    const bytes = await readFileBytes(outcome.localPath).catch(() => null);
    if (!bytes) return { error: "it was downloaded but could not be read back" };

    // So the next reader — this agent or another in the room — finds it on disk.
    this.deps.attachmentIndex?.markStored(file.ref, outcome.localPath);
    return { bytes, path: outcome.localPath };
  }

  /** Exposed so the tool registry can build `delegate` without reaching into the pipeline. */
  subagentRunner(): (request: SubagentRequest) => Promise<SubagentResult> {
    return (request) => runSubagent(this.turnContext, request);
  }

  /** `delegate`'s background half: a helper started as a job, whose end wakes its agent (`background-helper.ts`). */
  backgroundHelpers(): (request: SubagentRequest) => BackgroundStart {
    return (request) => startBackgroundHelper(this.turnContext, request);
  }

  /**
   * Exposed so the tool registry can build `ask_agent` without reaching into the pipeline.
   *
   * The counterpart of `subagentRunner`, and the difference is who runs: a subagent is the caller
   * with its persona stripped, this is another agent entirely. See `peer-turn.ts`.
   */
  peerTurnRunner(): (request: PeerTurnRequest) => Promise<PeerTurnResult> {
    return (request) => runPeerTurn(this.turnContext, request);
  }

  /** `ask_agent`'s other half (0.7.19): an ask waited on that moves to the background when it runs long — `background-ask.ts`. */
  askRunner(): (request: PeerTurnRequest, background: boolean) => AskStart {
    return (request, background) => startAsk(this.turnContext, request, background);
  }

  /**
   * Put an agent back on a job after a human answered late.
   *
   * The turn that asked stopped waiting on purpose — it holds back a slice of its deadline so the
   * model can report and carry on instead of dying mid-call — but the question stayed open. When it
   * is finally answered there is no promise left to release, so the answer only means something if
   * somebody starts a new turn with it.
   *
   * Sent as a system event into the same conversation. That matters twice: an empty reply from a
   * system event sends nothing, so an agent with nothing to add stays quiet; and the queue keeps it
   * behind whatever that conversation is already doing rather than running two turns at once.
   *
   * The command is restated rather than replayed. Nothing here can resume a tool call from a turn
   * that has ended — the arguments, the working directory and the model's own plan are gone — so the
   * honest move is to hand the agent back the facts and let it decide.
   */
  resumeAfterApproval(request: ApprovalRequest, decision: ApprovalDecision, by: string): boolean {
    const gateway = this.deps.gateways.get(request.gateway);
    if (!gateway) {
      log.warn("cannot resume after a late approval: the gateway is gone", { approval: request.id, gateway_id: request.gateway });
      return false;
    }
    const chatType = this.chatTypes.of(request.gateway, request.chatId) ?? "dm";
    if (!this.queue.push(approvalResumeEnvelope(request, decision, by, gateway.platform, chatType))) {
      log.warn("a late approval could not be handed back to the agent", { approval: request.id });
      return false;
    }
    log.info("resuming after a late approval", { approval: request.id, decision, actor: by });
    return true;
  }

  /**
   * A turn a restart or its provider cut off, taken up again — `restart-resume.ts`, `provider-resume.ts`. `waiting`: the
   * approvals it was cut off waiting on, which the restart kept (D8).
   */
  resumeTurn(turn: Pick<TurnRecord, "id" | "agentId" | "gatewayId" | "chatId" | "prompt">, why: ResumeWhy = "restart", waiting: readonly ApprovalRequest[] = [], cut?: Cut): boolean {
    const gateway = this.deps.gateways.get(turn.gatewayId);
    if (!gateway) return false;
    return this.queue.push(restartResumeEnvelope(turn, gateway.platform, this.chatTypes.of(turn.gatewayId, turn.chatId) ?? "dm", why, waiting, cut));
  }

  /** Live facts for the `session_status` tool. */
  sessionStatus(ctx: { agentId: string; chatId: string; gatewayId: string }): SessionStatus {
    const agent = this.deps.registry.get(ctx.agentId);
    const session = this.deps.sessions.load({
      agentId: ctx.agentId,
      chatId: ctx.chatId,
      gatewayId: ctx.gatewayId,
    });

    return {
      agent: agent?.config.displayName ?? ctx.agentId,
      model: this.modelOverrides.get(session.id) ?? agent?.config.llm.model ?? "unknown",
      provider: agent?.config.llm.provider ?? "unknown",
      gateway: ctx.gatewayId,
      chatId: ctx.chatId,
      turns: session.messages.filter((m) => m.role === "user").length,
      contextTokens: session.contextTokenCount,
      toolNames: agent?.config.tools.enabled ?? [],
      startedAt: session.startedAt,
    };
  }
}

/**
 * What to record for a drop the chat was never told about.
 *
 * `noticeDropped` returns nothing once it has apologised for this chat in the last minute, and the
 * drops it stays quiet about are the ones most worth a row: a burst is when messages go missing
 * fastest and when the chat is told least. Written from the reason rather than reusing the chat
 * wording, which is addressed to the sender and reads oddly as a record.
 */
function dropSentence(reason: string): string {
  switch (reason) {
    case "queue_full":
      return "A message was dropped: this conversation had too many waiting to be answered.";
    case "timeout":
      return "A message was dropped: it waited in the queue longer than the timeout allows.";
    case "duplicate":
      return "A duplicate copy of a message was ignored.";
    case "shutdown":
      return "A message was dropped: the daemon was shutting down.";
    default:
      return `A message was dropped (${reason}).`;
  }
}
