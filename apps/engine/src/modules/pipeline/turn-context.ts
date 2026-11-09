/**
 * The shared ground every turn stands on, whoever started it.
 *
 * Three things run turns — a person's message, a scheduled job, and a subagent — and each of them
 * needs the same handful of answers: which tools this agent has, where its workspace is, what it may
 * read, what today's spend is, and how to stop it. That set used to be private methods on the
 * pipeline, which is why all three had to live in the same file as the queue wiring.
 *
 * The table of turns running now — what is busy, what to stop, what waits — is `ActiveTurns` (`active-turns.ts`), which
 * this extends: its callers ask one object, and the table's state and rules are in a file of their own.
 *
 * Holds the live tool map because it is replaced after construction: `session_status` needs facts
 * from the pipeline while the pipeline needs the tool map, so the map arrives second — see
 * `Pipeline.setTools`.
 */

import { estimateMessagesTokens } from "@nouride/llm";
import { capStoredTurns } from "@/modules/llm/context.ts";
import { TokenScales } from "@/modules/llm/context-scale.ts";
import { closeTurn, type ClosedTurn, type InterruptCause } from "@/modules/turns/close.ts";
import type { TurnJournal } from "@/modules/turns/journal.store.ts";
import { startJobFor } from "@/modules/jobs/jobs.store.ts";
import { goalLine } from "@/modules/tools/builtins/delegate-brief.ts";
import { agentCommandsHaveOwnUsers, ensureDir, readFileBytes } from "@nouride/runtime";
import { createLogger, resolveMaxBackground, type Attachment, type ChatMessage, type LoadedAgent, type MessageEnvelope, type SessionKey, type ToolContext, type Tool } from "@nouride/shared";
import { projectSkillReadRoots, skillsDirFor } from "@nouride/persona";
import { privateWorkspace, scratchpadFor, sharedWorkspace } from "@nouride/persona";
import { hostReadRoots } from "@/modules/toolchain/facts.ts";
import { resolveApprovalLevel, type ApprovalResolution } from "@nouride/policy";
import { CarefulHints } from "@/modules/tools/careful-hint.ts";
import type { ApprovalLevel } from "@nouride/shared";
import { todaysVerdict, type BudgetVerdict } from "@/modules/llm/budget.ts";
import { findPerson } from "@/modules/people/match.ts";
import { roomName as nameOfRoom } from "@/modules/rooms/room-names.store.ts";
import type { Recall } from "@/modules/memory/index.ts";
import { isStored } from "@/modules/attachments/store.ts";
import type { PipelineDeps } from "./deps.ts";
import type { Voice } from "./voice.ts";
import type { ChatTypes } from "./chat-types.ts";
import type { ResumableTurn } from "./provider-resume.ts";
import { TurnLanes } from "./lanes.ts";
import { describePeers } from "@/modules/router/agent-mentions.ts";
import type { HarnessFacts } from "@/modules/llm/prompt/types.ts";
import { ActiveTurns } from "./active-turns.ts";
import { Asleep } from "./asleep.ts";
import { FallbackOutages } from "./fallback-alert.ts";

export { RESTARTING, STOPPED_BY_PERSON, type ActiveTurn } from "./active-turns.ts";

const log = createLogger("pipeline.turn-context");

/**
 * The index an outbound file is stored under.
 *
 * The store's file names carry the index of the attachment *within its message*, and a `send_file` is
 * always one file in one message — so it is always the first. A shared constant rather than a bare `0`
 * because the number means "position in the message", not "the only one".
 */
const OUTBOUND_INDEX = 0;

/** What `send_file` needs to know: the ids, if any, whether it actually arrived, and when it will not, why. */
export interface SendAttachmentResult {
  ids: string[];
  delivered: boolean;
  /** The platform's refusal, in its words — a chat the bot cannot write to will not take the file later either. */
  refused?: string;
}

export class TurnContext extends ActiveTurns {
  /** Replaced via `Pipeline.setTools` once built — see the note there. */
  tools: Map<string, Tool>;
  /** Each turn's lanes, by the turn — gone once nothing it started is running or waiting (`inLane`). */
  private readonly lanes = new Map<string, TurnLanes>();
  /**
   * Every call id each turn has used, by the turn — shared with the helpers and peers it starts, whose steps are rows of
   * its stream: an id is unique within a turn (`executor/call-ids.ts`), and a gateway that sends none gives each of
   * them `call_0` again. Dropped when the turn ends (`forgetCallIds`).
   */
  private readonly callIds = new Map<string, Set<string>>();
  /** A free slot under the ceiling for a turn's helpers and peers, or null at it — set by the pipeline (`lanes.ts`). */
  borrowSlot: () => (() => void) | null = () => () => {};
  /**
   * Set when the daemon starts to shut down: every running turn stops at its next step boundary, and no
   * new one starts. Read by the executor through `TurnRequest.pause`.
   */
  paused = false;
  /** Try a turn its provider ended again, a few minutes on — set by the pipeline, see `provider-resume.ts`. */
  resumeLater?: (turn: ResumableTurn) => boolean;
  /** The message a turn answered, handled in the turn's own settle — `InboxDesk.settleWithTurn`. Set by the pipeline. */
  settleMessage?: (envelope: MessageEnvelope) => void;
  /** Tell the agent a job of its reports to, in that job's chat, how long it has run — set by the pipeline (`JobWakes.quiet`). */
  nudgeLead?: (jobId: string, text: string) => void;
  /** What each conversation's provider counted per estimated token, for its next turn to start from — `context-scale.ts`. */
  readonly tokenScales = new TokenScales();
  /** What an asleep agent is sent meanwhile — `asleep.ts`. Its requeue is the pipeline's. */
  readonly asleep = new Asleep();
  /** Which models are falling back now, so the operator hears of each outage once (`fallback-alert.ts`). */
  readonly outages = new FallbackOutages();
  /** The daemon's hint under `careful`, counted per person per day — `tools/careful-hint.ts`. */
  private readonly carefulHints = new CarefulHints({ timeZone: () => this.deps.config.daemon.timezone });

  constructor(
    deps: PipelineDeps,
    readonly voice: Voice,
    /**
     * Room or one-to-one, per chat.
     *
     * Here because all three things that start turns need it and only one of them is handed an
     * envelope that carries the answer. See `chat-types.ts`.
     */
    readonly chatTypes: ChatTypes,
  ) {
    super(deps);
    this.tools = deps.tools;
  }

  /** The room's name for the runtime block (`roomName`), in a room that has one — none for a one-to-one. */
  roomNameOf(envelope: MessageEnvelope): { roomName?: string } {
    if (envelope.chatType === "dm") return {};
    const roomName = nameOfRoom(this.deps, { gatewayId: envelope.gatewayId, platform: envelope.gateway, chatId: envelope.chatId });
    return roomName ? { roomName } : {};
  }

  /** What a connection says about writing for it (`Gateway.formatting`), as a run's request carries it — nothing when it says nothing. */
  formattingFor(gatewayId: string): { formatting?: string } {
    const formatting = this.deps.gateways.get(gatewayId)?.formatting;
    return formatting ? { formatting } : {};
  }

  /** The call ids turn `turnId` has used — its own run's and its helpers' and peers' alike. */
  callIdsOf(turnId: string): Set<string> {
    const ids = this.callIds.get(turnId) ?? new Set<string>();
    this.callIds.set(turnId, ids);
    return ids;
  }

  /** The turn is over, and so is everything it started. */
  forgetCallIds(turnId: string | undefined): void {
    if (turnId) this.callIds.delete(turnId);
  }

  /** Work a turn started — a helper, a peer — on that turn's lanes (`lanes.ts`). `owner` is the turn: its id, or its session. */
  async inLane<R>(owner: string, work: () => Promise<R>): Promise<R> {
    const pool = this.lanes.get(owner) ?? new TurnLanes(() => this.borrowSlot());
    this.lanes.set(owner, pool);
    try {
      return await pool.run(work);
    } finally {
      if (pool.idle && this.lanes.get(owner) === pool) this.lanes.delete(owner);
    }
  }

  /**
   * Fold a turn that did not finish into its conversation — `modules/turns/close.ts` — then clear its
   * journal and close its record, in one transaction.
   *
   * Every call the turn made keeps its result, a call cut off is said to be, and the assistant has the
   * last word, so the next message has everything the turn did. Without a journal — none configured,
   * or the turn died before the question was composed — what is kept is the question and the note,
   * which is what an interrupted turn always kept.
   */
  closeUnfinished(
    input: {
      key: SessionKey;
      history: ChatMessage[];
      asked: ChatMessage | undefined;
      journal: TurnJournal | undefined;
      cause: InterruptCause;
    },
    finish: (closed: ClosedTurn) => void = () => {},
  ): ClosedTurn {
    const entries = input.journal ? input.journal.entries() : input.asked ? [{ message: input.asked }] : [];
    const closed = closeTurn(entries, input.cause, { complete: input.journal?.complete() ?? true });
    const kept = entries.length > 0 ? capStoredTurns([...input.history, ...closed.messages], this.deps.config.security.maxConversationTurns) : [];
    this.atomically(() => {
      if (kept.length > 0) this.deps.sessions.save(input.key, kept, estimateMessagesTokens(kept));
      if (input.journal) this.deps.journal?.clear(input.journal.turnId);
      finish(closed);
    });
    log.info("closed an unfinished turn", {
      cause: input.cause.kind,
      chat_id: input.key.chatId,
      done: closed.done.length,
      cut_off: closed.cut.length,
      not_started: closed.notStarted.length,
    });
    return closed;
  }

  /**
   * A turn's reply landed — now, or later when a buffered copy is flushed. A reply recorded and never
   * delivered is what the next boot sends (`boot/delivery.ts`), so this is what keeps that from becoming
   * a second copy.
   */
  markDelivered(turnId: string | undefined): void {
    if (!turnId) return;
    try {
      this.deps.delivery?.markDelivered(turnId);
    } catch (err) {
      log.debug("delivery not recorded", { turn: turnId, error: String(err) });
    }
  }

  /** A turn's reply is committed and about to be sent — inside the settle, so a crash before the send leaves it owed. */
  awaitDelivery(turnId: string | undefined): void {
    if (turnId) this.deps.delivery?.awaiting(turnId);
  }

  /** One transaction when the daemon gave us one, the writes in order otherwise. */
  atomically<T>(work: () => T): T {
    return this.deps.atomically ? this.deps.atomically(work) : work();
  }

  /**
   * The agents addressable in this chat, or `null` when nothing has an opinion.
   *
   * One place, because two callers need the same answer and a second copy of this rule is a second
   * chance to get it wrong: the prompt's OTHER AGENTS section decides who an agent is *told* it can
   * tag, and `couldAnswerUnaddressed` decides whether an untagged message may be answered at all.
   * Those two disagreeing produces an agent that tags a name the router will not deliver to.
   *
   * **`null` is not an empty room.** It means this chat has no membership list, which is true of
   * every Discord and Telegram conversation — the platform decides who is in the channel and
   * `voice.ts` records that we cannot know it. Callers keep their existing behaviour on `null`.
   *
   * Filtered through the registry, so a member that has since been disabled or deleted is not
   * offered. A name in the table is a record of a decision; whether it can answer today is the
   * registry's business.
   */
  roomAgents(envelope: MessageEnvelope): string[] | null {
    const store = this.deps.rooms;
    if (!store) return null;
    const members = store.membersOf(envelope.gatewayId, envelope.chatId);
    if (members.length === 0) return null;

    const live = new Set(this.deps.registry.enabled().map((agent) => agent.config.id));
    return members.filter((agentId) => live.has(agentId));
  }

  /**
   * What the prompt's OTHER AGENTS section is told, for a turn and for `/prompt` alike — one builder, since the two
   * assembled it apart and drifted: `/prompt` named every enabled agent in a room built of three. Who can be reached here
   * (only the agents that could actually answer: a room's members where it has some), how to address each, how far a
   * chain may run, how a handover travels — a tag in a room, the bus in a DM — and what each is for, from its pack.
   */
  otherAgentsFor(agentId: string, envelope: MessageEnvelope): HarnessFacts["otherAgents"] {
    if (!this.deps.config.agents.mentionsEnabled) return undefined;
    const everyone = (this.roomAgents(envelope) ?? this.deps.registry.enabled().map((other) => other.config.id)).filter((other) => other !== agentId);
    // In a room, an agent whose own bot cannot read it is not one a tag reaches (`Gateway.sees`): live on Discord, Nouva
    // tagged Nexa in a channel Nexa's bot could not view, and nothing came of it. Said apart, so the agent can say why.
    const absent = envelope.chatType === "dm" ? [] : everyone.filter((other) => this.ownConnectionSees(other, envelope) === false);
    const names = everyone.filter((other) => !absent.includes(other));
    return {
      names,
      ...(absent.length > 0 ? { absent } : {}),
      about: describePeers(names, (id) => this.deps.registry.get(id)),
      mentions: this.voice.agentMentionTokens(envelope.gateway),
      maxHops: this.deps.config.agents.mentionMaxHops,
      channel: envelope.chatType === "dm" ? "bus" : "mention",
      ...(envelope.chatType !== "dm" && this.deps.config.daemon.orchestrator === agentId ? { frontDesk: true } : {}),
    };
  }

  /** Whether an agent's own connection on this platform can read the room — undefined when it has none, or cannot tell. */
  private ownConnectionSees(agentId: string, envelope: MessageEnvelope): boolean | undefined {
    const own = this.deps.config.gateways.find((gateway) => gateway.enabled && gateway.platform === envelope.gateway && gateway.agent === agentId);
    return own ? this.deps.gateways.get(own.id)?.sees?.(envelope.chatId) : undefined;
  }

  /**
   * The agent's own work directory, created on demand.
   *
   * `data/workspace/<agent>/`. Derived, never configured — the whole point. An agent that can do nothing
   * until someone declares a directory does not work out of the box, and the first person to hit that
   * wrote a root pointing at a directory that did not exist and then watched it fail to find a file
   * sitting in plain sight.
   *
   * `[workspace] roots` still exists, and is now what it should have been from the start: opt-in access
   * to directories that **already exist** — a project repo, a shared folder — not a prerequisite for the
   * agent to function.
   *
   * Under `workspace_dir` rather than in the pack because this is mutable output, and the pack is
   * config-as-code that gets committed.
   *
   * ## Two directories, and why the default is the shared one
   *
   * `shared/` is reachable by every agent; `private/<id>/` by one. The default working directory —
   * what the prompt tells the agent a relative path resolves to — is **shared**, because handover is
   * the normal case in a multi-agent install and isolation-by-default silently broke it: with a
   * workspace per agent, `@nox benerin build ini` pointed at a path outside every root Nox had.
   *
   * For a single-agent install the two are indistinguishable in effect, so defaulting to shared costs
   * that case nothing.
   */
  workspaceFor(agentId: string): { shared: string; own: string } {
    const root = this.deps.config.daemon.workspaceDir;
    const shared = sharedWorkspace(root);
    const own = privateWorkspace(root, agentId);
    ensureDir(shared);
    // Created here rather than on first use, for the same reason the job log directory is: the prompt
    // names this path, and an agent told to put throwaway work in a directory that does not exist yet
    // spends its first command finding that out. Where each agent is its own user the helper makes both, as the
    // agent's: a scratchpad the daemon made would be one its commands could not write in.
    if (!agentCommandsHaveOwnUsers()) {
      ensureDir(own);
      ensureDir(scratchpadFor(own));
    }
    return { shared, own };
  }

  /**
   * Put a file in the conversation, and say whether it got there — for `send_file`.
   *
   * The target comes from `ctx` and not from an argument: a tool holding the gateway map could send
   * anywhere, to any conversation, and the whole point of this one is that it can only reach the chat
   * it was called from.
   *
   *
   * `delivered` rather than leaving the caller to read it off `ids.length`. An empty id list means two
   * different things — "the platform refused it" and "this transport has no message ids" — and the
   * second is the normal case for the dashboard. Reading them as one reported `could not be delivered`
   * for two images that were on screen at the time, and the agent passed that on to the operator as a
   * broken gateway. Only the thing holding the gateway can tell the difference, and this is it.
   */
  async sendAttachment(ctx: ToolContext, attachment: Attachment): Promise<SendAttachmentResult> {
    const gateway = this.deps.gateways.get(ctx.gatewayId);
    if (!gateway) {
      log.warn("send_file has no gateway", { gateway_id: ctx.gatewayId });
      return { ids: [], delivered: false };
    }
    let ids: string[];
    try {
      ids = await gateway.send({
        gatewayId: ctx.gatewayId,
        chatId: ctx.chatId,
        // Empty: the caption rides on the attachment, so the adapter decides whether that is a separate
        // message or a caption field. A text here would be a second message nobody asked for.
        text: "",
        attachments: [attachment],
      });
    } catch (err) {
      log.warn("send_file was refused", { gateway_id: ctx.gatewayId, error: String(err) });
      return { ids: [], delivered: false, refused: err instanceof Error ? err.message : String(err) };
    }

    /**
     * Kept a copy, and written onto the turn that sent it.
     *
     * `send_file` hands the bytes over as a buffer and no path — for a local file because the platform
     * wants bytes, for a URL because it was fetched here. So there is nothing on disk to point a
     * reader at unless one is made, and the right place is the same directory this conversation's
     * inbound files live in: the retention sweep already governs it, and `read` already reaches it.
     *
     * Done in this funnel rather than in a gateway because every `send_file` passes through here — and
     * because the local gateway has nowhere to put a file at all. Its `send` keeps only text, so
     * before this an agent that sent a report in the dashboard produced *nothing* visible: the tool
     * reported success and the chat showed neither the file nor a note about it.
     *
     * A side effect worth having: a file sent to Telegram is now readable from the dashboard too.
     */
    void this.keepOutboundCopy(ctx, attachment);

    return {
      ids,
      // A transport with ids proves delivery by producing one. A transport without them has nothing to
      // prove it with, and its `send` throws when it fails — so reaching here is the proof.
      delivered: gateway.addressableMessages === false || ids.length > 0,
    };
  }

  /**
   * Save what the agent just sent, beside what the person sent, and note it on the turn.
   *
   * Failures are swallowed: the file has already been delivered by the time this runs, and losing the
   * dashboard's copy of it must never turn a successful `send_file` into an error.
   */
  private async keepOutboundCopy(ctx: ToolContext, attachment: Attachment): Promise<void> {
    const turns = this.deps.turns;
    const store = this.deps.attachments;
    if (!turns || !store) return;

    const turnId = turns.runningFor(ctx.agentId, ctx.gatewayId, ctx.chatId);
    if (!turnId) return;

    try {
      const outcome = await store.store(
        { agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId },
        attachment,
        // The bytes are already in hand — this "fetch" is the identity. A file with neither buffer nor
        // a readable path is recorded as metadata only, which is still better than silence.
        async (candidate) =>
          candidate.buffer ??
          (candidate.url && !candidate.url.startsWith("http") ? await readFileBytes(candidate.url) : null),
        OUTBOUND_INDEX,
      );

      turns.addAttachment(turnId, {
        name: attachment.filename ?? "file",
        mimeType: attachment.mimeType,
        kind: attachment.type,
        ...(attachment.size === undefined ? {} : { bytes: attachment.size }),
        direction: "out",
        ...(isStored(outcome) ? { path: outcome.localPath } : {}),
      });

      /**
       * And into the conversation's list of files, so the *other* agents in the room can open it.
       *
       * This is the case that started the whole feature: one agent sent a photo, everybody else
       * overheard the sentence and not the attachment, and asked about it they correctly said they
       * only receive text. A turn record is the sender's own account of what it did; the index is
       * what the room can see.
       *
       * The ref is keyed on the stored path rather than a message id, because an outbound file has
       * no message id worth keying on: the local gateway returns none at all, and a platform's id
       * arrives after the send. The path carries the date, the conversation and the position, and
       * one send writes one file.
       */
      if (isStored(outcome)) {
        this.deps.attachmentIndex?.register({
          key: `out:${outcome.localPath}`,
          gateway: ctx.gateway,
          chatId: ctx.chatId,
          gatewayId: ctx.gatewayId,
          name: attachment.filename ?? "file",
          mimeType: attachment.mimeType,
          kind: attachment.type,
          ...(outcome.size === undefined ? {} : { size: outcome.size }),
          localPath: outcome.localPath,
          fromAgent: ctx.agentId,
          at: Date.now(),
        });
      }
    } catch (err) {
      log.debug("outbound file not kept", { agent_id: ctx.agentId, error: String(err) });
    }
  }

  /**
   * Directories a turn may read but never write.
   *
   * Two of them, and the second was a bug found live. A pooled skill is advertised to the agent by
   * path, and `agents/skills/` is not inside the agent's own pack — so `read` refused the exact path
   * the prompt had just named. The agent worked around it with `exec cat`, got the right answer, and
   * nothing looked broken: a sandbox that says no to the file tools and yes to a shell is the shape
   * where a limit exists on paper only.
   *
   * Read-only rather than a workspace root, deliberately. Every skill in the pool belongs to every
   * agent now, so one of them rewriting a file silently changes how the others behave. Authoring
   * goes through `skill_create`, which is approval-gated and audited; `write` on the same path is
   * neither.
   */
  readOnlyRoots(agent: LoadedAgent, sessionId: string): string[] {
    return [
      ...(this.deps.jobs ? [this.deps.jobs.logDirFor(agent.config.id)] : []),
      // The spilled tool output the excerpt points at. Without this the header says "open it with
      // `read`" and the sandbox refuses the path — a pointer the agent can see and cannot follow,
      // which is the failure mode the job-log root was added to fix. This agent's, for this
      // conversation, and nobody else's: see `ToolOutputSpill.rootFor`.
      ...(this.deps.spill ? [this.deps.spill.rootFor({ agentId: agent.config.id, sessionId })] : []),
      // Its work notes, and what was set aside from them: the notes name the archive's path (`notes/tail.ts`).
      ...(this.deps.notes ? [this.deps.notes.folderOf(agent.config.id)] : []),
      skillsDirFor(this.deps.config.daemon.agentsDir),
      // The skills this build ships with, for exactly the reason the line above exists: they are named
      // in the prompt by absolute path, and without this `read` refuses the path it was just handed.
      ...(this.deps.builtinSkillsDir ? [this.deps.builtinSkillsDir] : []),
      // A project's skills, for every root the pack named. Readable and never writable: one agent
      // rewriting a project skill would silently change how everyone working in that repository
      // behaves, and `skill_create` writes into the agent's own pack, which is where a skill an
      // agent authored belongs.
      //
      // This line was written once before and lost — the edit that added it sat in a block that
      // failed an assertion earlier and never wrote. The live test passed anyway because the test
      // project happened to sit *inside* the workspace, which is already a root. A skill root
      // outside one — `~/workspace/my-project`, the case this feature exists for — was advertised
      // in the prompt and then refused by `read`.
      //
      // A skill linked into `.agents/skills/` from elsewhere in the root adds where it really is: `read` checks a path
      // by where it leads, so the link named in the prompt was refused otherwise (`projectSkillReadRoots`).
      ...agent.config.skillRoots.flatMap((root) => projectSkillReadRoots(root)),
      // HOME and the install's program directories, for an agent that could `cat` them anyway — see
      // `hostReadRoots`. Not for one without a shell: for that agent they would be new reach.
      ...(agent.config.tools.enabled.includes("exec") ? hostReadRoots() : []),
    ];
  }

  /**
   * What this agent remembers that may be shown in this chat. Undefined when memory is not wired or
   * nothing is remembered — and then the prompt has no recall section rather than an empty one.
   *
   * Never throws: a memory that cannot be read this turn is a turn without recall, not a turn that
   * fails. Logged, because it would otherwise look like the agent forgetting.
   */
  async recallFor(agentId: string, envelope: MessageEnvelope): Promise<Recall | undefined> {
    const memory = this.deps.memory;
    if (!memory) return undefined;
    try {
      const recall = memory.recall({
        agentId,
        gatewayId: envelope.gatewayId,
        senderId: envelope.senderId,
        chatId: envelope.chatId,
        chatType: envelope.chatType,
      });
      return recall.profiles.length || recall.shared.length || recall.recent.length || recall.knowledge?.length ? recall : undefined;
    } catch (err) {
      log.warn("could not read memory for this turn, answering without recall", { agent_id: agentId, error: String(err) });
      return undefined;
    }
  }

  /**
   * Who this is, from `[[people]]`.
   *
   * Both id spellings and every id a person holds — see `apps/engine/src/modules/people/match.ts`. The
   * matching moved out of here because it stopped being a string comparison: on Discord, which of our
   * connections a message arrives on depends on which bot the person tagged, so a connection-qualified id
   * alone recognised somebody talking to Nero and left the same person a stranger the moment they tagged Nox.
   *
   * The platform's display name is never consulted, because it is a string the sender chooses:
   * `sender_access` already records it as "display only, and *untrusted*", and matching on it here would
   * undo that in the one place it would matter.
   */
  personFor(envelope: MessageEnvelope): { name: string; notes?: string } | undefined {
    return findPerson(this.deps.config.people, envelope);
  }

  /**
   * Today's spend against the cap.
   *
   * One place for chat and job turns alike, so both are held to the same number. The dashboard reads
   * the same `usage.since` it is computed from.
   */
  checkSpend(): BudgetVerdict {
    const verdict = todaysVerdict(this.deps.usage, this.deps.config);
    // Every caller that spends asks here, so the day's steps toward the cap are said from one place.
    this.deps.spendAlerts?.check(verdict);
    return verdict;
  }

  /**
   * How much this (agent, person) pair gets asked, resolved fresh on every call.
   *
   * Fresh because an operator can change it from the dashboard while a turn is running, and a captured
   * value would answer for the moment the turn started. The three layers and the order between them
   * are in `@nouride/policy`'s `approvals.ts`; this only reads them.
   *
   * `person` is who is talking to this agent, and a turn nobody is talking to has none: a peer turn another agent
   * asked for resolves on its own posture and the daemon's. A person's "stop asking me" was said to the agent
   * they talk to; read for a peer, it let that agent's model hand work to one with tools the person never let run
   * unasked — and have it run unasked.
   */
  approvalLevel(agent: LoadedAgent, person?: { gatewayId: string; senderId: string }): ApprovalLevel {
    return this.approvalResolution(agent, person).level;
  }

  private approvalResolution(agent: LoadedAgent, person?: { gatewayId: string; senderId: string }): ApprovalResolution {
    const personal = person ? this.deps.autoApprove?.levelFor(person.gatewayId, person.senderId) : undefined;
    return resolveApprovalLevel({
      ...(agent.config.approvals ? { agent: agent.config.approvals } : {}),
      ...(personal ? { person: personal } : {}),
      daemon: this.deps.config.security.approvals,
    });
  }

  /** One more question put to `person` from `agent`, and the daemon's hint to carry with it, if this is the one. */
  carefulHint(agent: LoadedAgent, person: { gatewayId: string; senderId: string }): string | null {
    return this.carefulHints.next(`${person.gatewayId}\u0000${person.senderId}`, this.approvalResolution(agent, person));
  }

  /**
   * This agent's helpers and asks working in the background for this conversation, oldest first — `turnReminders` says
   * them. An ask's goal is its job line, `ask <agent>: <task>`.
   */
  helpersRunning(agentId: string, at: Pick<MessageEnvelope, "gatewayId" | "chatId">): { id: string; goal: string; startedAt: number }[] {
    return (this.deps.jobs?.backgroundTurns(agentId) ?? [])
      .filter((job) => job.gatewayId === at.gatewayId && job.chatId === at.chatId)
      .map((job) => ({ id: job.id, goal: job.brief ? goalLine(job.brief) : job.command, startedAt: job.startedAt }));
  }

  /**
   * Live state the per-call gate needs.
   *
   * A method rather than a stored object: both callers resolve a toolset per turn, and the answer
   * to "can a human be reached" must be read then, not when the pipeline was built.
   */
  toolsetDeps() {
    return {
      ...(this.deps.mcp ? { mcpTools: this.deps.mcp.toolsFor.bind(this.deps.mcp) } : {}),
      ...(this.deps.personaTool ? { personaTool: this.deps.personaTool } : {}),
      ...(this.deps.skillRootTool ? { skillRootTool: this.deps.skillRootTool } : {}),
      ...(this.deps.jobs
        ? {
            startJob: startJobFor(this.deps.jobs),
          }
        : {}),
      ...(this.deps.grants ? { liveGrants: (agentId: string) => this.deps.grants!.liveKeys(agentId) } : {}),
      ...(this.deps.toolGrants
        ? { liveToolGrants: (agentId: string) => this.deps.toolGrants!.liveKeys(agentId) }
        : {}),
      ...(this.deps.approvals.canAsk ? { canAsk: () => this.deps.approvals.canAsk!() } : {}),
      /**
       * Who this agent could hand work to, read per turn.
       *
       * Never captured: `agent_create` and a pack reload both change the answer inside a running
       * daemon, and this is what decides whether `ask_agent` is offered at all.
       *
       * Empty when `mentions_enabled` is off, so that one switch governs both transports. The setting
       * means "agents do not address each other on this daemon", and leaving the bus running under a
       * different name would make it mean "…except in DMs", which is not what an operator who turned
       * it off asked for.
       */
      peerAgents: (agentId: string) =>
        this.deps.config.agents.mentionsEnabled
          ? this.deps.registry
              .enabled()
              .map((agent) => agent.config.id)
              .filter((id) => id !== agentId)
          : [],
      ...(this.deps.childEnv ? { childEnv: this.deps.childEnv } : {}),
      // The credentials sent in chat — read per call.
      ...(this.deps.heldSecrets ? { heldSecrets: this.deps.heldSecrets } : {}),
      ...(this.deps.ownSecrets ? { ownSecrets: this.deps.ownSecrets } : {}),
      // Read per turn, so a limit set from the dashboard is the next turn's. None where this process runs no jobs.
      ...(this.deps.jobs
        ? { backgroundHelpers: (agentId: string) => resolveMaxBackground(this.deps.registry.get(agentId)?.config.maxBackgroundHelpers, this.deps.config.delegate.maxBackground) }
        : {}),
    };
  }

}
