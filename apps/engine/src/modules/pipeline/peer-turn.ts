/**
 * One other agent's turn, run behind the chat.
 *
 * The transport under `ask_agent`. Nouva is talking to somebody in a DM, needs Nox, and there is no
 * message she can write that Nox will ever see — each bot has its own private conversation. So Nox
 * runs here instead: a real turn, with Nox's persona, skills, memory, tools and permissions, whose
 * answer goes back to Nouva as a tool result rather than into the conversation.
 *
 * ## What is shared with the caller, and what is not
 *
 * Shared: the chat. Nox runs *pointed at* this conversation — same gateway instance, same chat id —
 * because everything a turn does that touches a person has to arrive where the person is. An approval
 * Nox needs is asked for here, in Nox's name. A file Nox sends arrives here. And the progress line is
 * posted here, labelled `[nox]`, so a minute of silence is legible as somebody working rather than as
 * the agent having died.
 *
 * Not shared: the voice. Nox never replies. The only message this conversation gets from Nox is the
 * progress bubble; the answer goes to Nouva, and Nouva reports it in her own words. That is the whole
 * point of the split — see the header of `tools/builtins/ask-agent.ts` for what it replaced.
 *
 * Not shared either: identity. Nox runs as Nox, so the grants, the approval gate and the audit log all
 * record the agent that actually did the work.
 *
 * ## No session
 *
 * The history starts empty and is never persisted, the way a subagent's is not. A DM is Nouva's
 * conversation: a second, invisible session belonging to Nox and keyed to the same chat would be
 * resurrected on the next ask, carrying half a conversation Nox was never really part of. What Nox
 * keeps across asks is what Nox chooses to keep — `MEMORY.md`, which loads with the persona.
 *
 * ## Waited on, then behind the turn (0.7.19)
 *
 * A turn started `detachable` may stop being the asking turn's: `background-ask.ts` moves it to a job of the asking
 * agent's when it outlasts its wait. Until then it is what it always was. From then on it is the job's — its stop, its
 * log, a question it puts to a person saying whose work it is — and nothing of the asking turn, which ends without it.
 * Still pointed at the chat, still held there as at work, still Nox.
 */

import { changesSharedTools } from "@/modules/toolchain/shared-tools.ts";
import { workNotesCopy } from "@/modules/notes/tail.ts";
import { dirname, join } from "@nouride/runtime";
import { childSessionId, createLogger, resolveTurnDurationMs, tierModel, toUserMessage, type ChatType, type Tool } from "@nouride/shared";
import { brainFor } from "./brain.ts";
import { resolveToolset } from "@/modules/tools/registry.ts";
import type { PeerTurnRequest, PeerTurnResult } from "@/modules/tools/builtins/ask-agent.ts";
import { buildHandoff } from "@/modules/tools/handoff.ts";
import type { HelperOutcome, RunningHelper } from "@/modules/jobs/helper-jobs.ts";
import { logLine, quotable, sayingWho, stopped } from "./background-turn.ts";
import { delegateNote, leadNudgeText, nudgeBaseMs, sinceSaid, watchTurn } from "./budget-nudges.ts";
import { ChatProgress } from "./chat-progress.ts";
import type { TurnContext } from "./turn-context.ts";
import { beginDelegated, type DelegatedEnd, type DelegatedTurn } from "./delegated-turn.ts";
import { meter } from "@/modules/llm/metered.ts";
import { contextInto, stepsInto } from "@/modules/turns/recorder.ts";
import { alertOnFallback } from "@/modules/pipeline/fallback-alert.ts";
import { fallbacksFor } from "@/modules/llm/fallbacks.ts";

const log = createLogger("pipeline.peer-turn");

/**
 * Whether one agent asking another is worth telling the room about.
 *
 * The agents this is for are the ones *not* involved. Without it a third agent in the same room sees
 * `joined`, `left` and `topic` but never learns that two of its peers are already working on
 * something — so it answers as though nothing were in progress, or starts the same work again. Every
 * other thing that happens to a room was recorded; this was the one that mattered most and was not.
 *
 * Two conditions, and each removes noise rather than capability. Not a one-to-one chat, because in a
 * DM the only agent who would read the line is the one that caused it, and a prompt telling an agent
 * what it just did is pure cost. And more than one agent in the room — which is the condition that
 * actually decides, since `chatType` only says the platform allows more than two people, not that
 * another agent is there.
 *
 * Only `ask_agent` reaches here. `delegate` spawns anonymous subagents that are not room members,
 * and "nouva delegated 3 tasks" tells the room nothing it can act on.
 */
export function announceDelegation(chatType: ChatType, agentsInRoom: number): boolean {
  return chatType !== "dm" && agentsInRoom > 1;
}

/**
 * A tool as an asked agent calls it: told who asked (`ToolContext.askedBy`), so `exec` keeps its commands in the
 * foreground and says where a job it was asked to start reports — to the agent that asked, never to this one.
 */
function askedBy(tool: Tool | undefined, asker: string): Tool | undefined {
  return tool ? { ...tool, execute: (args, ctx) => tool.execute(args, { ...ctx, askedBy: asker }) } : undefined;
}

/** One peer turn under way: how it ends, and how it leaves the asking turn for the background (`background-ask.ts`). */
export interface PeerTurn {
  /** When it was asked — what its job, once it has one, says it started at. */
  startedAt: number;
  /** How it ended: its handoff, and whether a shutdown stopped it at a step — then the next boot reports it. */
  ended: Promise<HelperOutcome>;
  /** Over already: its answer is in hand, or it was refused before it began. */
  done(): boolean;
  /**
   * Behind the asking turn from now on: stopped by its job — not by the asking turn, which ends without it — its steps
   * the job's log, a question it puts to a person saying whose work it is, its bubble in the chat sealed. False when it
   * has already ended.
   */
  detach(job: RunningHelper): boolean;
  /** Waited on to the end after all — it could not move: what it does stays the asking turn's, and no log is gathered for it. */
  stay(): void;
}

/** Run one peer turn to completion, as the peer, while the asking turn waits for it. */
export async function runPeerTurn(ctx: TurnContext, request: PeerTurnRequest): Promise<PeerTurnResult> {
  return (await startPeerTurn(ctx, request).ended).report;
}

/**
 * Start one peer turn, as the peer. `detachable`: it may move to the background (`background-ask.ts`) — so, like any
 * job's turn, a shutdown stops it at a step, and `[security] job_max_ms` is its clock where it is the shorter one.
 */
export function startPeerTurn(ctx: TurnContext, request: PeerTurnRequest, options: { detachable?: boolean } = {}): PeerTurn {
  const startedAt = Date.now();
  /** A refusal that never reached a model: no metrics to report, and a reason that is the whole answer. */
  const refuse = (reason: string): PeerTurn => over(startedAt, buildHandoff({ agentId: request.to, startedAt, error: reason }));

  const peer = ctx.deps.registry.get(request.to);
  // Checked again here even though the tool resolved the name against the live list: agents reload
  // while a turn runs, and the gap between the two is a real window.
  if (!peer) return refuse(`there is no agent called "${request.to}"`);
  if (!peer.config.enabled) return refuse(`${peer.config.id} is disabled`);
  // A paused agent stops answering and keeps everything else (§9.4 SPEC). Being asked by another agent
  // is still answering, so it declines here rather than quietly running while the operator believes it
  // is stopped.
  if (ctx.deps.registry.isPaused(peer.config.id)) return refuse(`${peer.config.id} is asleep and takes no work until a person wakes it`);
  // At work here already — its own turn, or another ask: two turns of one agent in one chat write over each other.
  if (ctx.isBusy(peer.config.id, request.ctx.chatId, request.ctx.gatewayId)) return refuse(busy(ctx, request, peer.config.id));

  const workspace = ctx.workspaceFor(peer.config.id);
  const sessionId = childSessionId(request.ctx.sessionId, "peer");
  // The peer's own model of the tier it was asked on (0.8.0), on its own provider — `default`, its model, when none.
  const model = tierModel(peer.config.llm, ctx.deps.config.llm.defaults, request.tier ?? "default");

  /**
   * The peer's own bubble in the caller's chat.
   *
   * On the *caller's* connection, deliberately. The peer may have a bot of its own, and posting there
   * would put the progress in a conversation nobody has open — the person is watching this one. The
   * `[nox]` label is what makes the line honest about whose work it is reporting.
   *
   * No `replyTo`: the tool context carries no triggering message id, and in a DM there is nothing to
   * quote anyway.
   */
  const gateway = ctx.deps.gateways.get(request.ctx.gatewayId);
  const progress =
    ctx.deps.config.llm.streaming.progressInChat && gateway && ChatProgress.supported(gateway)
      ? new ChatProgress({
          gateway,
          chatId: request.ctx.chatId,
          agentLabel: peer.config.id,
          /**
           * Even when the peer called no tools.
           *
           * A peer never speaks for itself — its answer goes back to the agent that asked, which
           * folds it into a reply of its own. So this line is the only sign it ran, and an ordinary
           * turn's rule (say nothing when nothing was done) makes a peer that answered from its
           * prompt look like a peer that was never asked. Two asked in parallel, one using a tool,
           * read as one.
           */
          announceEmpty: true,
          ...(ctx.deps.progressIntervalMs ? { minIntervalMs: ctx.deps.progressIntervalMs } : {}),
        })
      : undefined;

  if (announceDelegation(request.ctx.chatType, ctx.deps.rooms?.get(request.ctx.gatewayId, request.ctx.chatId)?.members.length ?? 0)) {
    ctx.deps.chatEvents?.record({
      gatewayId: request.ctx.gatewayId,
      chatId: request.ctx.chatId,
      audience: "agents",
      kind: "delegated",
      // Composed here, from two agent ids. The guard in `record` refuses an agent-authored event
      // addressed to agents, and it is right to — it exists so a model cannot write into another
      // model's prompt. Nothing of the task text goes in, for the same reason.
      origin: "daemon",
      text: `${request.from} asked ${peer.config.id} to take something on.`,
      agentId: peer.config.id,
      actor: request.from,
    });
  }

  // No helpers in the background (0.7.15): a peer answers the agent that asked, and a helper's report would wake the
  // peer into the caller's conversation as itself. Its `delegate` waits for its helpers, inside this answer.
  const toolset = resolveToolset(peer, ctx.tools, ctx.deps.config.security, { ...ctx.toolsetDeps(), backgroundHelpers: () => 0 });
  // One level, the same rule `delegate` follows and for the same reason: an agent that can ask an
  // agent that can ask back is a chain of paid provider calls with no ceiling, started by a model.
  // A peer that needs somebody else says so in its answer, and the caller decides. It holds for a peer
  // working in the background too (0.7.19): it has no `ask_agent` at all, so it can neither wait on
  // another agent nor move one behind itself — no ping-pong of agents asking each other in the background.
  // Nor `notes`: the conversation's notes are the asker's, and it is handed a copy of the task (`workNotesCopy`).
  const notForPeers = (name: string) => name === "ask_agent" || name === "notes";
  const withoutAskAgent: typeof toolset = {
    ...toolset,
    definitions: toolset.definitions.filter((d) => !notForPeers(d.name)),
    get: (name) => (notForPeers(name) ? undefined : askedBy(toolset.get(name), request.from)),
  };

  // Its own stop, which follows the asking turn's — `/stop`, its clock, a shutdown stop what it started — until it moves
  // to the background; then its job's (`detach`).
  const controller = new AbortController();
  const follow = () => controller.abort(request.ctx.signal.reason);
  if (request.ctx.signal.aborted) follow();
  else request.ctx.signal.addEventListener("abort", follow, { once: true });
  /** The job it runs as, once it is behind the asking turn. */
  let job: RunningHelper | undefined;
  /** Its own turn record, from the moment it moves (0.7.26): its steps until then are the asking turn's rows. */
  let record: DelegatedTurn | undefined;
  /** Its steps while it is waited on, which its job's log begins with if it gets one — until it is known it will not. */
  const before: string[] = [];
  let gathering = options.detachable === true;

  /**
   * Its steps are the asking turn's: rows of that turn's stream, in the caller's conversation — the one it runs pointed
   * at, so nobody who could not see the caller's turn sees the peer's — and marked as the peer's (`via`, `by`). Once it is
   * in the background they are its job's log instead: that turn has ended.
   */
  const steps = stepsInto(ctx.deps.turns, request.ctx.turnId, { via: "ask_agent", by: peer.config.id });
  /** What each of its requests carried (0.7.26): the asking turn's lines while it waits, its own turn's once it moved. */
  const lines = contextInto(ctx.deps.turns, request.ctx.turnId, { via: "ask_agent", by: peer.config.id });
  const executor = brainFor(ctx.deps.externalAgents, peer, {
    ...(ctx.deps.spill ? { spill: ctx.deps.spill } : {}),
    onFallback: alertOnFallback(ctx.outages, ctx.deps.notifier, peer),
    windowOf: (model) => ctx.deps.providers?.catalog?.windowNow(peer.config.llm.provider, model) ?? null,
    llm: ctx.deps.config.llm,
    // In the background it says whose work a question is for: the asking turn is over, and a question from an agent
    // the person is not talking to, with nothing to say what it is for, reads as coming from nowhere.
    approvals: sayingWho(ctx.deps.approvals, () =>
      job ? `${peer.config.id}, working in the background on what ${request.from} asked (${job.id}: "${quotable(request.task)}"), wants to run this` : null,
    ),
    // The *peer's* posture and the daemon's, and no person's. Nobody is talking to the peer: its task was
    // written by another agent's model, and a person's "stop asking me" was said to the agent they talk to. Read here,
    // it let that model hand work to an agent with tools the person never let run unasked — a page the caller read
    // could ask for it — and have it run unasked. The person is still the one asked, in their own chat.
    approvalLevel: () => ctx.approvalLevel(peer),
    onBatch: (lines) => {
      if (!job) progress?.batch(lines);
    },
    onActivity: (kind, text, detail) => {
      const line = logLine(kind, text);
      if (job) {
        if (line) job.log(line);
        record?.step(kind, text, detail);
        return;
      }
      if (gathering && line) before.push(line);
      steps?.(kind, text, detail);
      progress?.show(kind, text, detail);
      // Sealed and awaited, exactly as an ordinary turn does it: the approval prompt is about to be
      // posted below this bubble, and a bubble still being edited after that keeps the numbers moving
      // somewhere the reader has already scrolled past.
      if (kind === "waiting") return progress?.seal("waiting for you");
    },
    onRequest: (line) => (job ? record?.context(line) : lines?.(line)),
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
    ...(ctx.deps.projectSkills
      ? { projectSkills: (a: typeof peer) => ctx.deps.projectSkills!.forAgent(a) }
      : {}),
    // Nobody can type a slash command at this turn — it is not reading the chat — so advertising them
    // would offer an escape hatch that leads nowhere.
    commands: [],
    // The asking turn's: a peer's answer is part of what that turn cost, waited on or behind it.
    onUsage: (usage) =>
      meter(ctx.deps.usage, {
        agentId: usage.agentId,
        provider: peer.config.llm.provider,
        purpose: "peer",
        sessionId,
        ...(request.ctx.turnId ? { turnId: request.ctx.turnId } : {}),
      })(usage, usage.model, usage.purpose, usage.provider),
  });

  // The *peer's* clock, not the caller's: this turn is the peer's work, run under its own id, its own grants and its own
  // limits — and one that may become a job wraps up before `job_max_ms` would stop it, as a helper in the background does.
  const turnMs = resolveTurnDurationMs(peer.config.llm.maxTurnDurationMs, ctx.deps.config.llm.limits.maxTurnDurationMs);
  const jobMs = options.detachable ? ctx.deps.config.security.jobMaxMs : 0;

  // Held from here, and let go once it ends. Free since the check above: nothing between them waits. In the background
  // too: it is still at work in this chat, so a person addressing it there is told so and a second ask is refused.
  const release = ctx.holdPeer(peer.config.id, request.ctx.chatId, request.ctx.gatewayId) ?? (() => {});
  /**
   * Run long, it is told to stop and report if stuck (`budget-nudges.ts`); once it is in the background the agent that
   * asked hears how long it has run. Waited on, that agent is in a turn of its own, on its own clock and nudges.
   */
  const nudges = watchTurn(nudgeBaseMs(ctx.deps.config.agents.nudgeAfterMinutes), delegateNote, (nudge) => {
    if (!job) return;
    job.log(`· ${sinceSaid(nudge.dueMs)} in: asked to report if stuck`);
    ctx.nudgeLead?.(job.id, leadNudgeText({ who: peer.config.id, task: quotable(request.task), ms: nudge.dueMs, job: job.id }));
  });
  let settled = false;
  const ended = (async (): Promise<HelperOutcome> => {
    let failed = false;
    /** How it ended — written to its own record too, when it moved and has one. */
    const close = (outcome: HelperOutcome, result?: DelegatedEnd["result"]): HelperOutcome => {
      record?.finish(outcome, { ...(result ? { result } : {}), model, stopped: controller.signal.aborted });
      return outcome;
    };
    try {
      // On the caller's lanes: it waits on this, so its slot is this one's first (`lanes.ts`). One that moves to the
      // background keeps the lane it ran on until it ends — the asking turn's own, which the queue stops counting once
      // that turn is over, or one it borrowed from the ceiling, given back when it ends.
      const result = await ctx.inLane(request.ctx.turnId ?? request.ctx.sessionId, () => executor.run({
        signal: controller.signal,
        agent: peer,
        provider: ctx.deps.providers.get(peer.config.llm.provider),
        ...fallbacksFor(peer, ctx.deps.providers),
        ...(model !== peer.config.llm.model ? { model } : {}),
        toolset: withoutAskAgent,
        history: [],
        // With a read-only copy of the task in the asker's work notes this is part of (`workNotesCopy`).
        userMessage: {
          role: "user",
          content: [briefing(request), workNotesCopy(ctx.deps.notes, { agentId: request.ctx.agentId, gatewayId: request.ctx.gatewayId, chatId: request.ctx.chatId })]
            .filter((part): part is string => Boolean(part))
            .join("\n\n"),
          timestamp: Date.now(),
        },
        workspaceDir: workspace.shared,
        privateDir: workspace.own,
        readOnlyRoots: ctx.readOnlyRoots(peer, sessionId),
        gateway: request.ctx.gateway,
        ...ctx.formattingFor(request.ctx.gatewayId),
        gatewayId: request.ctx.gatewayId,
        chatId: request.ctx.chatId,
        chatType: request.ctx.chatType,
        deadlineAt: startedAt + (jobMs > 0 ? Math.min(turnMs, jobMs) : turnMs),
        sessionId,
        asked: true,
        // The asking turn's: the peer's calls are audited under it, and their ids drawn from its own (`stepsInto`).
        ...(request.ctx.turnId ? { turnId: request.ctx.turnId, callIds: ctx.callIdsOf(request.ctx.turnId) } : {}),
        senderId: request.ctx.senderId,
        // A shutdown stops it at a step, as it stops any turn: one in the background is then reported by the next boot.
        ...(options.detachable ? { pause: () => ctx.paused } : {}),
        ...(nudges ? { harnessNote: nudges.take } : {}),
      }));

      /**
       * The envelope, built from what the turn actually did rather than from what it says it did.
       *
       * `aborted` is read off its own signal: a peer stopped by `/stop`, by the caller's deadline or by its job still
       * returns whatever text it had managed to produce, and that text reads like a finished report. See
       * `tools/handoff.ts`.
       */
      const handoff = buildHandoff({ agentId: peer.config.id, startedAt, result, aborted: controller.signal.aborted });

      log.info("peer turn complete", {
        from: request.from,
        agent_id: peer.config.id,
        chat_id: request.ctx.chatId,
        status: handoff.status,
        tool_calls: result.toolCalls,
        iterations: result.iterations,
        files: handoff.files.length,
        ...(job ? { job: job.id } : {}),
      });
      if (result.paused) return close({ report: { ...handoff, status: "incomplete", reason: "a restart stopped it before it finished" }, paused: true }, result);
      return close({ report: handoff }, result);
    } catch (err) {
      failed = true;
      // Stopped in the middle of a call once it is a job — a stop, its clock, a shutdown: what happened is the stop, not
      // the abort the call threw on its way out, which would read as the peer having failed.
      if (job && controller.signal.aborted) return close({ report: stopped(peer.config.id, startedAt, controller.signal.reason) });
      log.error("peer turn failed", {
        from: request.from,
        agent_id: peer.config.id,
        error: String(err),
      });
      // Sanitized, because this text ends up in a message the caller writes to a person (§17.2 item 5).
      return close({ report: buildHandoff({ agentId: peer.config.id, startedAt, error: toUserMessage(err) }) });
    } finally {
      settled = true;
      nudges?.stop();
      release();
      request.ctx.signal.removeEventListener("abort", follow);
      // Not awaited, like the ordinary turn's: the caller is waiting on this answer, and a chat platform
      // acknowledging a status line is not something to hold it for. `finish` swallows its own failures. One in the
      // background has had its bubble sealed: it says nothing more in the chat.
      if (!job) void progress?.finish(failed ? "failed" : "ok");
    }
  })();

  return {
    startedAt,
    ended,
    done: () => settled,
    detach: (to) => {
      if (settled) return false;
      job = to;
      request.ctx.signal.removeEventListener("abort", follow);
      const stop = () => controller.abort(to.signal.reason);
      if (to.signal.aborted) stop();
      else to.signal.addEventListener("abort", stop, { once: true });
      for (const line of before.splice(0)) to.log(line);
      gathering = false;
      // Its own turn from here (0.7.26), read like a chat turn: what it does now is no row of the asking turn's.
      record = beginDelegated(ctx.deps.turns, {
        via: "ask_agent",
        by: peer.config.id,
        job: to,
        ...(request.ctx.turnId ? { parent: request.ctx.turnId } : {}),
        sessionId,
        gatewayId: request.ctx.gatewayId,
        chatId: request.ctx.chatId,
        senderId: request.ctx.senderId,
        prompt: request.task,
      });
      record?.step("note", `moved to the background as ${to.id}${request.ctx.turnId ? ` (its steps before this are turn ${request.ctx.turnId}'s)` : ""}`);
      // The last thing it says in the chat, until its answer comes back through the agent that asked.
      void progress?.seal("working in the background");
      return true;
    },
    stay: () => {
      gathering = false;
      before.length = 0;
    },
  };
}

/** A turn that is over before it began. */
function over(startedAt: number, report: PeerTurnResult): PeerTurn {
  return { startedAt, ended: Promise.resolve({ report }), done: () => true, detach: () => false, stay: () => {} };
}

/**
 * Why it cannot be asked here now: it is at work in this chat. When that work is what the asking agent asked it before
 * — in the background, its answer still to come — that is said, with where the answer will come from.
 */
function busy(ctx: TurnContext, request: PeerTurnRequest, peer: string): string {
  const asked = ctx.deps.jobs?.backgroundTurns(request.from).find((job) => job.ask?.agent === peer && job.chatId === request.ctx.chatId && job.gatewayId === request.ctx.gatewayId);
  return asked
    ? `${peer} is still working in the background on what you asked earlier (${asked.id}). Its answer comes to you as a message when it is done; ask again after that, with anything more`
    : `${peer} is already working in this chat. Ask again once it is done, or put both in one ask`;
}

/** What an asked agent says of the brief itself — the words that carry the rule, asserted by a test. */
export const ASKED_TO_SAY =
  "If you do anything outside this brief, or the brief cannot be followed as written, say so explicitly in your report.";

/**
 * What the peer is actually asked.
 *
 * Framed as a message from another agent rather than from a person, and it has to be: the peer's
 * persona tells it how to talk to whoever it is with, and without this it writes a chat reply — a
 * greeting, a sign-off, a question at the end — into a string that no human will ever read verbatim.
 * What the caller needs back is a report.
 */
function briefing(request: PeerTurnRequest): string {
  return [
    `[${request.from} is asking you to do something. This is not a person and this is not a chat.]`,
    "",
    request.task,
    "",
    `---`,
    `Your reply goes back to ${request.from} as the result of a tool call. Nobody else reads it, and`,
    `nothing you write here appears in any conversation: ${request.from} is the one talking to the`,
    "person, and will relay what you say. So: do the work, then report it. What you did, what came of",
    "it, anything that failed, and anything they need to pass on. No greeting and no sign-off.",
    // 0.8.7: a relayed report described a brief nobody wrote. The brief is kept with the job (`work` job) to check
    // against; the asked agent says where it went past it, or could not follow it, so the check has words to find.
    ASKED_TO_SAY,
  ].join("\n");
}
