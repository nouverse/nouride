/**
 * The inbound path: gateway → router → queue → hook or agent turn → reply.
 *
 * This file is the *wiring*. Every stage is implemented beside it, and the reason they are all in
 * one directory is that the **order** is the thing that is easy to get wrong and hard to see: a
 * group message is observed before it is admitted, admitted before it is routed, routed before it is
 * claimed, and rate-limited only once we know an agent would have answered. Each of those placements
 * fixed a bug, and each is documented where the call happens.
 *
 * What the rest of the daemon asks of the pipeline is in a part per caller, each handed only what it reads; the
 * methods here hand each call to its part:
 *
 *   chat-queue.ts        the gateways': the queue a chat's messages wait in, and what a dropped one leaves behind
 *   slash-commands.ts    a person's `/command`: the hooks, and what each is handed of the pipeline
 *   wake-ups.ts          the daemon's own messages: a job's end, a CLI's own words, a late approval, a resumed turn
 *   turn-control.ts      the control API's, the hooks' and a mission's: stop, steer, status, end a conversation
 *   chat-directory.ts    the dashboard's: what a chat is, the rooms, the chats a job can reach, a line said in one
 *   tool-ports.ts        the tools': `send_file`, `send_message`, `attachment_read`, `delegate`, `ask_agent`
 *   job-turns.ts         the scheduler's turns, and where their output goes
 *
 * And what they are built from:
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
 *   subagent.ts          one helper turn, run as its parent
 *   background-helper.ts one helper as a job of its own, whose end wakes its parent — from the start, or once it runs long
 *   peer-turn.ts         one OTHER agent's turn, run behind the chat
 *   background-ask.ts    that turn moved to a job of its own when it runs long, whose answer wakes the agent that asked
 *   background-move.ts   the one road a helper or an asked agent waited on takes into the background
 *   render-prompt.ts     the diagnostic that shows a prompt without running a turn
 */

import type { KeyedQueue } from "@nouride/queue";
import { createLogger, type MessageEnvelope, type Tool } from "@nouride/shared";
import { HookRegistry, ModelOverrides } from "@/modules/hooks/registry.ts";
import type { CronExecutors } from "@/modules/cron/scheduler.ts";
import type { DaemonRestart } from "@/modules/update/restart.ts";
import type { WorkingJob } from "@/modules/update/self-update.ts";
import { senderIsAdmin } from "@/modules/people/match.ts";

import type { PipelineDeps } from "./deps.ts";
import { Voice } from "./voice.ts";
import { Admission } from "./admission.ts";
import { RoomMemory } from "./room-memory.ts";
import { Batcher } from "./batcher.ts";
import { AttachmentIntake } from "./attachments.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import type { EndingConversation, EndMode } from "./conversation-end.ts";
import { TurnContext } from "./turn-context.ts";
import { ChatTypes } from "./chat-types.ts";
import { SideQuestions } from "./side-question.ts";
import { TurnRunner } from "./turn.ts";
import { InboxDesk } from "./inbox-desk.ts";
import { InboundRouter } from "./inbound.ts";
import { renderPrompt } from "./render-prompt.ts";
import { JobTurns } from "./job-turns.ts";
import { scheduleProviderResume, type ResumableTurn } from "./provider-resume.ts";
import { arrive, type ArrivalParts } from "./arrival.ts";
import { ChatSecrets } from "./chat-secrets.ts";
import { EditLedger } from "./edits.ts";
import { onGatewayEvent } from "./gateway-events.ts";
import { chatQueue } from "./chat-queue.ts";
import { commandMenu, slashCommands } from "./slash-commands.ts";
import { WakeUps } from "./wake-ups.ts";
import { TurnControl } from "./turn-control.ts";
import { ChatDirectory } from "./chat-directory.ts";
import { ToolPorts } from "./tool-ports.ts";

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
  private readonly wakes: WakeUps;
  private readonly control: TurnControl;
  private readonly chats: ChatDirectory;
  private readonly toolPorts: ToolPorts;
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
    this.control = new TurnControl({ deps, turnContext: this.turnContext, voice: this.voice, modelOverrides: this.modelOverrides });
    const end = (conversation: EndingConversation, mode: EndMode) => this.control.endConversation(conversation, mode);
    this.lifecycle = new SessionLifecycle(deps, end);

    this.hooks = slashCommands({
      deps,
      admission: this.admission,
      modelOverrides: this.modelOverrides,
      turnContext: this.turnContext,
      lifecycle: this.lifecycle,
      sideQuestions: this.sideQuestions,
      secrets: this.secrets,
      control: this.control,
      isAdmin: (envelope) => this.isAdmin(envelope),
      restart: () => this.restart,
      deliver: (back) => this.deliver(back),
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
    this.queue = chatQueue({
      deps,
      hooks: this.hooks,
      turnContext: this.turnContext,
      inbound: this.inbound,
      admission: this.admission,
      voice: this.voice,
      inbox: () => this.inbox,
    });

    this.wakes = new WakeUps({
      deps,
      queue: this.queue,
      admission: this.admission,
      chatTypes: this.chatTypes,
      turnContext: this.turnContext,
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
    this.turnContext.resumeLater = (turn) => this.resumeLater(turn);
    this.inbox = new InboxDesk(deps, this.batcher, (envelope) => this.turnContext.holds(envelope));
    this.turnContext.settleMessage = (envelope) => this.inbox.settleWithTurn(envelope);
    // A delegate in the background that has run long, said to the agent it reports to — the road a quiet job's notice takes.
    this.turnContext.nudgeLead = (jobId, text) => {
      const job = deps.jobs?.get(jobId);
      if (job) this.wakes.wakeForQuietJob(job, text);
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

    this.chats = new ChatDirectory({ deps, chatTypes: this.chatTypes, turnContext: this.turnContext });
    this.toolPorts = new ToolPorts({ deps, turnContext: this.turnContext, intake: this.attachments, chatTypes: this.chatTypes, modelOverrides: this.modelOverrides });
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
       * One transaction for everything an arriving message writes before anything awaits: the room's record of
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

  /** What the external agents' CLIs left running in the background: a restart waits for it, as for a job (0.8.6). */
  cliCommands(): WorkingJob[] {
    return this.deps.externalAgents?.working?.() ?? [];
  }

  /** Resolves when the queue is empty. Does not stop accepting work. */
  async idle(): Promise<void> {
    this.batcher.flush();
    // Deferred job wake-ups waiting for a turn to finish must push before the queue can be idle.
    if (this.wakes.pending.size > 0) await Promise.all(this.wakes.pending);
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
    if (this.wakes.pending.size > 0) await Promise.all(this.wakes.pending);
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

  rateLimitEntries(): number { return this.admission.rateLimitEntries(); }
  groupContextRooms(): number { return this.rooms.groupContextRooms(); }
  claimEntries(): number { return this.admission.claimEntries(); }

  /**
   * Whether this sender is an admin by People (`senderIsAdmin`): in a room, who besides the person who asked may answer an
   * approval — by `/approve` (the hooks) or by a press on its prompt (`tools/approval-prompts.ts`).
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

  /** The slash commands a person may type, for a client that wants to offer them — `commandMenu`. */
  commands(): { command: string; description: string }[] {
    return commandMenu(this.hooks);
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

  // The daemon's own messages into a chat's queue — `wake-ups.ts`.
  wakeForJob(...args: Parameters<WakeUps["wakeForJob"]>) { return this.wakes.wakeForJob(...args); }
  wakeForQuietJob(...args: Parameters<WakeUps["wakeForQuietJob"]>) { return this.wakes.wakeForQuietJob(...args); }
  queueTurn(...args: Parameters<WakeUps["queueTurn"]>) { return this.wakes.queueTurn(...args); }
  wakeForOwnWords(...args: Parameters<WakeUps["wakeForOwnWords"]>) { return this.wakes.wakeForOwnWords(...args); }
  wakeForCliStopped(...args: Parameters<WakeUps["wakeForCliStopped"]>) { return this.wakes.wakeForCliStopped(...args); }
  resumeAfterApproval(...args: Parameters<WakeUps["resumeAfterApproval"]>) { return this.wakes.resumeAfterApproval(...args); }
  resumeTurn(...args: Parameters<WakeUps["resumeTurn"]>) { return this.wakes.resumeTurn(...args); }

  /** A turn its provider ended, tried again a few minutes after `failedAt` — now, or before a restart (`provider-resume.ts`). */
  resumeLater(turn: ResumableTurn, failedAt?: number): boolean {
    return scheduleProviderResume(
      turn,
      {
        resume: (taken) => this.wakes.resumeTurn(taken, "provider"),
        movedOn: (taken, since) => this.deps.turns?.startedInChatSince(taken.gatewayId, taken.chatId, since) ?? false,
        stopping: () => this.turnContext.paused,
        ...(this.deps.providerResumeMs === undefined ? {} : { delayMs: this.deps.providerResumeMs }),
      },
      failedAt,
    );
  }

  // The turns at work, from outside them — `turn-control.ts`.
  cancelTurnFor(...args: Parameters<TurnControl["cancelTurnFor"]>) { return this.control.cancelTurnFor(...args); }
  cancelTurn(...args: Parameters<TurnControl["cancelTurn"]>) { return this.control.cancelTurn(...args); }
  cancelTurnsInChat(...args: Parameters<TurnControl["cancelTurnsInChat"]>) { return this.control.cancelTurnsInChat(...args); }
  steerInto(...args: Parameters<TurnControl["steerInto"]>) { return this.control.steerInto(...args); }
  steerReach(...args: Parameters<TurnControl["steerReach"]>) { return this.control.steerReach(...args); }
  onToldRead(...args: Parameters<TurnControl["onToldRead"]>) { return this.control.onToldRead(...args); }
  stopBackgroundFor(...args: Parameters<TurnControl["stopBackgroundFor"]>) { return this.control.stopBackgroundFor(...args); }
  endConversation(...args: Parameters<TurnControl["endConversation"]>) { return this.control.endConversation(...args); }
  runningTurns() { return this.control.runningTurns(); }
  agentStatus(...args: Parameters<TurnControl["agentStatus"]>) { return this.control.agentStatus(...args); }

  // The chats the daemon knows, as the dashboard asks — `chat-directory.ts`.
  chatTypeOf(...args: Parameters<ChatDirectory["chatTypeOf"]>) { return this.chats.chatTypeOf(...args); }
  reachableChats() { return this.chats.reachableChats(); }
  knownRooms() { return this.chats.knownRooms(); }
  renameRoom(...args: Parameters<ChatDirectory["renameRoom"]>) { return this.chats.renameRoom(...args); }
  sayInChat(...args: Parameters<ChatDirectory["sayInChat"]>) { return this.chats.sayInChat(...args); }

  // What the built-in tools are handed — `tool-ports.ts`.
  sendAttachment(...args: Parameters<ToolPorts["sendAttachment"]>) { return this.toolPorts.sendAttachment(...args); }
  messageSender() { return this.toolPorts.messageSender(); }
  chatNotice() { return this.toolPorts.chatNotice(); }
  attachmentReader() { return this.toolPorts.attachmentReader(); }
  subagentRunner() { return this.toolPorts.subagentRunner(); }
  backgroundHelpers() { return this.toolPorts.backgroundHelpers(); }
  waitedHelpers() { return this.toolPorts.waitedHelpers(); }
  peerTurnRunner() { return this.toolPorts.peerTurnRunner(); }
  askRunner() { return this.toolPorts.askRunner(); }
  sessionStatus(...args: Parameters<ToolPorts["sessionStatus"]>) { return this.toolPorts.sessionStatus(...args); }
}
