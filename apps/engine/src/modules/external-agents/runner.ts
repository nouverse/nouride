/**
 * An external agent's turn (0.8.1): the conversation's message prompted to its coding CLI over ACP, and the answer
 * returned as a `TurnResult`, so the turn record, the reply, a mission's count and every place that reads them stay as
 * they are for a model's turn.
 *
 * What a CLI keeps, Nouride does not repeat: its context, its compaction, its system prompt. What Nouride keeps, the
 * CLI does not see: the transcript is written as a user message and the CLI's answer, the history as the CLI never
 * needs it. A person's message that arrives while the CLI works is its next prompt in the same turn, as a steer is to
 * a model. `/stop` and a shutdown are a `session/cancel`.
 */

import { steeringOffered, type CliRow, type McpServer, type PlanEntry, type PromptAnswer, type RequestPermissionParams, type StopReason as AcpStopReason } from "@nouride/acp";
import { contained, createLogger, NourideError, type ChatMessage, type ExternalPermissions, type LoadedAgent, type StopReason } from "@nouride/shared";
import type { ExecutorDeps, TurnRequest, TurnResult } from "@/modules/llm/executor/types.ts";
import { clockNote } from "@/modules/llm/executor/reminders.ts";
import type { PlanStep } from "@/modules/notes/store.ts";
import { writeInstruction } from "./instruction.ts";
import { askPermission } from "./permission.ts";
import { signedOut, unavailableReason, type CliConnection } from "./connection.ts";
import { offeredEfforts, offeredModels, type OfferedModels } from "./models.ts";
import { folderReady } from "./launch.ts";
import { UpdateReader } from "./updates.ts";
import { situationOf, untold, type Situation } from "./situation.ts";
import { ownKey, type OwnChat, type OwnWords } from "./own-words.ts";
import { isMissionChat, MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { ownFolderOf } from "@/modules/missions/worktree.ts";
import { missionDeleteScope } from "./inside-delete.ts";
import { promptOf, promptTakes } from "./prompt.ts";
import { cliUsage, type CliContexts, type CliSpending } from "./usage.ts";
import { merged, MidPrompt, untilSaid } from "./steering.ts";

/** A conversation's CLI session, kept and found by this: the chat it is in. */
export const cliSessionKey = (gatewayId: string, chatId: string) => `${gatewayId}|${chatId}`;

/** What the runner needs of the service that holds the agents' CLIs. */
export interface RunnerHost {
  connection(agent: LoadedAgent): Promise<CliConnection>;
  /** The CLI a turn prompts on, and the variables its shell does not have yet (`ExternalAgents.forTurn`, 0.8.15). */
  forTurn?(agent: LoadedAgent, signal?: AbortSignal): Promise<{ cli: CliConnection; notYet: string[] }>;
  /**
   * The session a conversation kept from before, for a CLI that reopens sessions; and keeping a new one, with the
   * fingerprint of the instructions it opened on (`writeInstruction`) — null where they could not be written.
   */
  keptSession(agentId: string, key: string): string | undefined;
  keepSession(agentId: string, key: string, sessionId: string, instructions: string | null): void;
  /** The fingerprint of the instructions the conversation's session opened on; none where it is not known (0.8.8). */
  instructedWith(agentId: string, key: string): string | undefined;
  /** A conversation's session let go, open or kept, so its next one is new. */
  forgetSession(agentId: string, gatewayId: string, chatId: string): void;
  /** Whether an open session still owes its chat words it said by itself, or a command it left running. */
  owes(agentId: string, cli: CliConnection, sessionId: string): boolean;
  /** The models the CLI offers, as a session that opened said them — the Brain tab suggests them — and the one it opened on. */
  models?: Pick<OfferedModels, "keep" | "of" | "runsOn">;
  /** The efforts the CLI offers for the model its last session is on, for the Brain tab to show beside the model. */
  efforts?: Pick<OfferedModels, "keep">;
  /** How long a CLI asked to stop has before it is stopped. Absent: `STOP_GRACE_MS`. */
  readonly stopGraceMs?: number;
  /** How long a message for a running prompt waits for an open tool call. Absent: `STEER_HOLD_MS`. */
  readonly steerHoldMs?: number;
  /** The agent's status from now on: why it cannot answer, or null when it can. */
  setUnavailable(agentId: string, reason: string | null): void;
  /** The CLI's plan, as the conversation's plan beside the chat — a mission's checklist. */
  keepPlan?(key: { agentId: string; gatewayId: string; chatId: string }, steps: PlanStep[]): Promise<void>;
  /** Lend the CLI Nouride's tools for this turn, over MCP; returns the turn's end. */
  lend?(agentId: string, key: string, req: TurnRequest, deps: ExecutorDeps): () => void;
  /** Nouride's MCP server as this conversation's session is given it, or none. */
  mcpServers?(agentId: string, key: string, connection: CliConnection): McpServer[];
  /** The agent's skills copied where its CLI reads them; returns those it could not read. */
  syncSkills(agent: LoadedAgent, row: CliRow): Promise<string[]>;
  /** The preset the CLI runs in: the pack's, or `folder` where it says none — and never `folder` where agents are not their own users. */
  preset(chosen?: ExternalPermissions): ExternalPermissions;
  /** What each CLI session was last told of who is here (`situation.ts`), by its id. Kept in memory: told again after a restart. */
  readonly told?: Map<string, Situation>;
  /** What each CLI session said between turns, by itself (`own-words.ts`). */
  readonly ownWords?: Pick<OwnWords, "answers" | "take" | "follow" | "forget">;
  /** How many commands the CLI's process runs now; and that a session's prompt left one running, for its chat (0.8.6). */
  commandsOf?(cli: CliConnection): number;
  leftRunning?(key: string, chat: OwnChat): void;
  /** What each conversation's CLI session last said of its context, for `/status` (0.8.8). */
  readonly contexts?: Pick<CliContexts, "keep">;
  /** What each conversation's running turn has spent so far, estimated, for a mission's limit (0.8.8). */
  readonly spending?: Pick<CliSpending, "set" | "clear">;
  /** A conversation's running turn has spent more, by its estimate: a mission's limits are read as it does (0.8.8). */
  spent?(agentId: string, gatewayId: string, chatId: string): void;
}

/** How long a CLI asked to stop may take: Claude Code and Codex end a cancelled prompt in seconds. */
const STOP_GRACE_MS = 30_000;

const log = createLogger("external-agents");

/** The whole turn's work and nothing a compaction could shorten: the CLI keeps its own context. */
const NO_COMPACTION = { threshold: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER, totalLimit: Number.MAX_SAFE_INTEGER, source: "external agent", summaryModel: "", summarizerWindow: 0 };

export class ExternalTurnRunner {
  constructor(
    private readonly agent: LoadedAgent,
    private readonly deps: ExecutorDeps,
    private readonly host: RunnerHost,
  ) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    const external = this.agent.config.external;
    if (!external) throw new NourideError("external_agent", `${this.agent.config.id} is not an external agent`);
    const agentId = this.agent.config.id;
    const key = cliSessionKey(req.gatewayId, req.chatId);
    const turnMessages: ChatMessage[] = [req.userMessage];
    const empty = (paused: boolean): TurnResult => this.result(req, "", turnMessages, [], 0, 0, "stop", paused);
    if (req.pause?.()) return empty(true);

    let connection: CliConnection | undefined;
    let sessionId: string | undefined;
    let deaf: ReturnType<typeof setTimeout> | undefined;
    // Listened for from the start: a stop while the CLI starts or opens its session was lost, and the prompt then ran
    // in full (0.8.1). A CLI that does not stop when asked is stopped: its prompt held the chat — a mission's slot — for
    // good.
    const cancel = contained(log, "could not stop an external agent's turn", () => {
      const open = connection;
      if (!open) return;
      try {
        if (sessionId) open.cancel(sessionId);
      } catch {
        // A CLI already gone has nothing to cancel; the prompt has failed or will.
      }
      deaf = setTimeout(contained(log, "could not stop a CLI that did not stop when asked", () => open.close("it did not stop when asked")), this.host.stopGraceMs ?? STOP_GRACE_MS);
    });
    req.signal?.addEventListener("abort", cancel, { once: true });
    /** Secrets kept since the CLI started that its shell does not have this turn: named in the first prompt. */
    let notYet: string[] = [];
    try {
      if (this.host.forTurn) ({ cli: connection, notYet } = await this.host.forTurn(this.agent, req.signal));
      else connection = await this.host.connection(this.agent);
    } catch (err) {
      req.signal?.removeEventListener("abort", cancel);
      throw this.unavailable(err, undefined);
    }
    const cli = connection;
    // Held from here to the turn's end, so the idle sweep does not stop a CLI still opening this turn's session.
    const release = cli.hold();

    const steps: TurnResult["toolSteps"] = [];
    let text = "";
    /** What the chat is answered with: the reply less what already went out as a step's opening line. */
    let answer = "";
    /** The reply's last message, the answer where all of it went out already — the chat then is not told it twice. */
    let last = "";
    /** Whether any of the reply went out before the answer: the record then keeps the whole of it (`TurnResult.told`). */
    let spoke = false;
    let calls = 0;
    let prompts = 0;
    /** The tokens the CLI reported for this turn's prompts; null while it has reported none. */
    let reported: number | null = null;
    /** What the turn's ended prompts spent — reported, else as estimated while they ran — for the running estimate. */
    let spentBefore = 0;
    let refused = 0;
    let stop: StopReason = "stop";
    let reader: UpdateReader | undefined;
    /** What the prompt read said, into the turn: at its end, or where the CLI was closed under it. */
    const take = (read: UpdateReader) => {
      read.end();
      calls += read.toolCalls;
      steps.push(...read.steps);
      if (read.text) text = text ? `${text}\n\n${read.text}` : read.text;
      if (read.unsaid) answer = answer ? `${answer}\n\n${read.unsaid}` : read.unsaid;
      last = read.last || last;
      spoke = spoke || read.spoke;
    };
    /**
     * The chat's lines in the order the CLI said them: an opening line is posted before the step after it reaches the
     * bubble, as a model's turn awaits it (`ExecutorDeps.onPreamble`) — otherwise the bubble lands above the words.
     */
    let order: Promise<unknown> = Promise.resolve();
    const inOrder = <T>(fn: () => T | Promise<T>): Promise<T> => {
      const next = order.then(fn);
      order = next.catch(() => undefined);
      return next;
    };
    /**
     * A mission's turn: the folder the daemon made for it, where a delete needs nobody (`inside-delete.ts`). Its worktree
     * and the folder itself are kept — deleting those is the person's call.
     */
    const deleteScope = req.gatewayId === MISSION_GATEWAY_ID && req.privateDir ? missionDeleteScope(ownFolderOf(req.privateDir, req.chatId), req.workdir) : null;
    /** What the CLI asks permission for, asked as the turn's approval, its step announced above the question. */
    const permit = (read: UpdateReader) => async (request: RequestPermissionParams) => {
      read.announce(request.toolCall.toolCallId, request.toolCall.title);
      const outcome = await askPermission({
        cli: cli.row.id,
        cliName: cli.row.name,
        request,
        approvals: this.deps.approvals,
        asked: {
          agentId,
          chatId: req.chatId,
          gateway: req.gateway,
          gatewayId: req.gatewayId,
          senderId: req.senderId,
          ...(req.turnId ? { turnId: req.turnId } : {}),
          ...(req.signal ? { signal: req.signal } : {}),
          ...(req.parkApprovalsMs !== undefined ? { waitMs: 0, answerableMs: req.parkApprovalsMs } : {}),
        },
        waiting: (approvalId, tool) => inOrder(() => this.deps.onActivity?.("waiting", `waiting for approval: ${tool}`, { callId: request.toolCall.toolCallId, name: tool, approvalId })),
        ...(deleteScope ? { deleteScope } : {}),
        allowedAlone: (tool, command, targets) => {
          log.info("a delete inside the mission's folder allowed without asking", { agent_id: agentId, mission: req.chatId, tool, command, targets });
          void inOrder(() => this.deps.onActivity?.("note", `allowed without asking (${command} inside the mission's folder): ${targets.join(", ")}`));
        },
      });
      if (outcome.outcome !== "selected" || !request.options.find((option) => option.optionId === outcome.optionId)?.kind.startsWith("allow")) refused += 1;
      return outcome;
    };
    // Before the session opens: a CLI lists its MCP tools when it does, from this turn's toolset. A turn that follows
    // the CLI going on by itself lends them too: what it calls of Nouride's then is this turn's.
    const endLending = this.host.lend?.(agentId, key, req, this.deps);
    // A turn the daemon started for what the CLI said by itself reads it in the session it was said in. One gone since —
    // the CLI stopped, the conversation ended — has nothing to read, and the turn says nothing.
    let follow = req.ownWords === true;
    // The session this turn works in, held from when it has one to its end (0.8.8): a `/new` that lands between its
    // prompts lets the conversation go, and the session is closed once the turn is done with it rather than under it.
    let letSession: (() => void) | undefined;
    const hold = (id: string) => void (letSession ??= cli.use(id));
    try {
      if (follow) {
        sessionId = cli.sessionOf(key);
        if (sessionId) hold(sessionId);
      } else sessionId = await this.open(cli, req, key, hold);
      let message: ChatMessage | null = req.signal?.aborted || !sessionId ? null : req.userMessage;
      /** What the CLI did not take mid-prompt (`steering.ts`): the next prompt's, in front of what waits. */
      let left: ChatMessage | null = null;
      const situation = situationOf(req, sessionId ? this.host.told?.get(sessionId) : undefined);
      while (message && sessionId) {
        /** This prompt's held messages (`steering.ts`), told the moment its last tool call ends. */
        let held: MidPrompt | null = null;
        const read = new UpdateReader({
          idle: () => held?.wake(),
          text: (delta) => this.deps.onText?.(delta),
          activity: (kind, said, detail) => void inOrder(() => this.deps.onActivity?.(kind, said, detail)).catch(() => undefined),
          preamble: (words) => (this.deps.onPreamble ? inOrder(async () => (await this.deps.onPreamble!(words, { own: true })) === true).catch(() => false) : Promise.resolve(false)),
          plan: (entries) => void this.host.keepPlan?.({ agentId, gatewayId: req.gatewayId, chatId: req.chatId }, entries.map(planStep)).catch(() => {}),
          context: (used, size) => {
            this.host.contexts?.keep(agentId, key, { used, size });
            this.host.spending?.set(agentId, key, spentBefore + read.spent);
            this.host.spent?.(agentId, req.gatewayId, req.chatId);
          },
        });
        reader = read;
        let reason: AcpStopReason = "end_turn";
        if (follow) {
          follow = false;
          const end = cli.follow(sessionId, permit(read));
          try {
            await this.host.ownWords?.follow(ownKey(agentId, sessionId), read, { ...(req.signal ? { signal: req.signal } : {}), gone: () => cli.closed !== null });
          } finally {
            end();
          }
        } else {
          // What the CLI said by itself that no turn read yet comes first, in the order it was said, as its own message.
          const kept = this.host.ownWords?.take(ownKey(agentId, sessionId)) ?? [];
          for (const update of kept) read.read(update);
          if (kept.length > 0) await read.apart();
          // What it says by itself from now on wakes this chat — where the chat is the agent's own.
          const chat = req.asked || isMissionChat(req) ? null : { agentId, gatewayId: req.gatewayId, chatId: req.chatId };
          this.host.ownWords?.answers(ownKey(agentId, sessionId), chat);
          const first = prompts === 0;
          const opening = first && notYet.length > 0 ? { ...req, reminders: [...(req.reminders ?? []), notYetNote(notYet)] } : req;
          const blocks = await promptOf(message, first ? opening : undefined, first ? untold(situation, this.host.told?.get(sessionId)) : "", promptTakes(cli.info), this.deps.maxImageBytes, first ? clockNote(this.deps.now?.() ?? new Date(), this.deps.timezone) : undefined);
          const before = chat ? (this.host.commandsOf?.(cli) ?? 0) : 0;
          // A message for the turn while the prompt runs goes into it (0.8.10, `steering.ts`) — where the CLI takes one.
          const open = sessionId;
          const mid =
            req.steer && req.steerListen && steeringOffered(cli.info)
              ? new MidPrompt({
                  take: () => req.steer?.() ?? null,
                  send: async (said) => await cli.steer(open, await promptOf(said, undefined, "", promptTakes(cli.info), this.deps.maxImageBytes)),
                  busy: () => read.running > 0,
                  replying: () => req.steerReplying?.() === true,
                  taken: (said, outcome) => {
                    turnMessages.push(said);
                    log.info("a message went into a CLI's running prompt", { agent_id: agentId, outcome });
                  },
                  ...(this.host.steerHoldMs !== undefined ? { holdMs: this.host.steerHoldMs } : {}),
                })
              : null;
          held = mid;
          const unlisten = mid ? req.steerListen!(() => mid.poke()) : undefined;
          // One that came while the session opened goes in now, not after the prompt.
          mid?.poke();
          let answered: PromptAnswer;
          try {
            answered = await cli.prompt(sessionId, blocks, (update) => read.read(update), permit(read));
          } finally {
            unlisten?.();
            left = (await mid?.end()) ?? null;
          }
          reason = answered.stopReason;
          // What the CLI says the prompt spent, where it says (ACP's unstable `usage`): a mission counts it (0.8.7), and
          // the conversation's usage records it as the CLI's, outside the daily caps (0.8.8) — `/status` said 0 after
          // hours of work. Recorded here and counted from the turn's result, so no prompt is either twice.
          if (answered.usage) {
            reported = (reported ?? 0) + answered.usage.totalTokens;
            this.deps.onUsage?.({ ...cliUsage(answered.usage), model: external.model ?? this.host.models?.runsOn(agentId) ?? cli.row.name, agentId, provider: cli.row.id });
          }
          // How far the estimate was from what the CLI then reported: the measure of the running count a limit reads.
          log.info("a CLI prompt ended", { agent_id: agentId, estimated: read.spent, ...(answered.usage ? { reported: answered.usage.totalTokens } : {}) });
          spentBefore += answered.usage?.totalTokens ?? read.spent;
          // A command left running past its answer: if the daemon stops before it ends, the chat is told (0.8.6).
          if (chat && (this.host.commandsOf?.(cli) ?? 0) > before) this.host.leftRunning?.(ownKey(agentId, sessionId), chat);
          if (prompts === 0) this.host.told?.set(sessionId, situation);
          prompts += 1;
        }
        reader = undefined;
        await read.settled();
        // Before the stop below: a steer whose prompt was stopped answered too, and its message went missing.
        if (message !== req.userMessage) turnMessages.push(message);
        if (reason !== "end_turn") stop = reason === "max_tokens" ? "max_tokens" : "stop";
        // A message that came while the CLI worked is its next prompt, here, as a steer is a model's next round — with
        // one the CLI did not take mid-prompt in front of it. Stopped, that one is kept in the turn's record at least.
        const stopped = reason === "cancelled" || req.signal?.aborted === true;
        // The line in the agent's own words, said before the next prompt reads what it answers — as mid-prompt.
        if (!stopped) await untilSaid(() => req.steerReplying?.() === true, this.host.steerHoldMs);
        const waiting = stopped ? null : (req.steer?.() ?? null);
        if (stopped && left) turnMessages.push(left);
        const next = stopped ? null : left && waiting ? merged(left, waiting) : (left ?? waiting);
        left = null;
        // This prompt's answer said now, where the next one's follows: the two went out as one message (0.8.5).
        if (next) await read.sayRest();
        take(read);
        message = next;
      }
      this.host.setUnavailable(agentId, null);
    } catch (err) {
      release();
      // A session the CLI has dropped is let go, so the conversation's next turn opens a fresh one.
      if (sessionId) this.host.ownWords?.forget(ownKey(agentId, sessionId));
      cli.forget(key);
      // Stopped — and the CLI closed for not stopping: the turn ends as a stopped one with what it said, and the agent is
      // not unavailable.
      if (!req.signal?.aborted) throw this.unavailable(err, cli);
      if (reader) take(reader);
    } finally {
      clearTimeout(deaf);
      release();
      this.host.spending?.clear(agentId, key);
      letSession?.();
      endLending?.();
      req.signal?.removeEventListener("abort", cancel);
    }
    return {
      ...this.result(req, text, turnMessages, steps, calls, refused, stop, req.pause?.() === true, prompts, answer || last),
      externalTokens: reported,
      answeredBy: [cli.row.name, external.model ?? this.host.models?.runsOn(agentId)].filter(Boolean).join(" · "),
      ...(spoke ? { told: text } : {}),
    };
  }

  /**
   * The conversation's session, ready for a prompt: its instruction file and skills where the CLI reads them, opened or
   * reopened, and set to the preset, model and effort the pack names now.
   */
  private async open(cli: CliConnection, req: TurnRequest, key: string, hold: (sessionId: string) => void): Promise<string> {
    const external = this.agent.config.external!;
    const agentId = this.agent.config.id;
    const preset = this.host.preset(external.permissions);
    const own = req.privateDir ?? cli.launch.cwd;
    // A mission's session works in the mission's folder, one session the mission long (its chat is the mission's).
    const folder = req.workdir ?? own;
    if (folder !== own) await folderReady(agentId, folder);
    // Before the session: a CLI reads its instruction file when one opens. In the agent's own folder or the CLI's
    // profile, never a mission's — that may be a person's repository, whose files are theirs. A file it cannot write
    // leaves the CLI as it was, and the turn goes on — said, not fatal.
    const instructions = await writeInstruction(this.agent, cli, own, { missions: lent(req, "mission"), work: lent(req, "work"), memory: lent(req, "memory_write"), links: lent(req, "work") || lent(req, "mission") || lent(req, "schedule") }).catch((err: unknown) => {
      this.deps.onActivity?.("note", `could not write ${cli.row.instructionFile}: ${String(err)}`);
      return null;
    });
    /**
     * A session opened on other instructions is let go, and this turn opens a new one, which reads them (0.8.8). A session
     * keeps what it read when it opened: a SOUL.md saved on the Files tab never reached a chat already going, and
     * `agent reload` set the model in it and nothing else. Reopening is not relied on — claude-agent-acp answers a load of
     * a session still live with that session as it was — so what the CLI held of the conversation goes; Nouride keeps the
     * transcript, and the person changed who the agent is. A conversation's turns run one at a time, so nothing is
     * prompting in it; another conversation's turn, in a session of its own, goes on until its own next turn. One that
     * still owes its chat what it said by itself, or a command it left running, is kept for this turn: closing it lost
     * the words and ended the command. Its fingerprint stays the old one, so a later turn lets it go.
     */
    const open = cli.sessionOf(key);
    if (instructions !== null && (open ?? this.host.keptSession(agentId, key)) && this.host.instructedWith(agentId, key) !== instructions && !(open && this.host.owes(agentId, cli, open))) {
      this.host.forgetSession(agentId, req.gatewayId, req.chatId);
    }
    // Its Nouride skills, where its CLI reads its own — in any folder, a mission's too.
    await this.host.syncSkills(this.agent, cli.row)
      .then((skipped) => skipped.length > 0 && this.deps.onActivity?.("note", `could not read the skills ${skipped.join(", ")} to give ${cli.row.name}`))
      .catch((err: unknown) => this.deps.onActivity?.("note", String(err)));
    const sessionId = await cli.session(key, folder, this.host.keptSession(agentId, key), this.host.mcpServers?.(agentId, key, cli) ?? [], async (id, opened) => {
      this.host.keepSession(agentId, key, id, instructions);
      const offered = offeredModels(opened);
      if (offered) this.host.models?.keep(agentId, offered);
    });
    hold(sessionId);
    // Each turn, not only a session's first: a preset or model changed on the Brain tab reaches a chat already going.
    const offered = this.host.models?.of(agentId) ?? [];
    await cli.settle(sessionId, {
      mode: cli.row.modes?.[preset],
      // A model only where the CLI offers one; the CLI's own default back where the pack no longer names one.
      ...(offered.length > 0 ? { model: external.model ?? offered.find((model) => model.current)?.value, own: external.model === undefined } : {}),
      // `/effort` in this chat, else the one effort an API agent's model thinks with too: `[llm] effort`, else
      // `[llm.defaults] effort`. None at all puts back the CLI's own, where this chat had set another.
      effort: req.effort ?? this.agent.config.llm?.effort,
      note: (line) => this.deps.onActivity?.("note", line),
    });
    this.host.efforts?.keep(agentId, offeredEfforts(cli.optionsOf(sessionId)));
    return sessionId;
  }

  /** A failure as the person reads it, and as the agent's status where it is the CLI's state rather than this turn's. */
  private unavailable(err: unknown, connection: CliConnection | undefined): NourideError {
    const row = connection?.row;
    if (!row) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.setUnavailable(this.agent.config.id, message);
      return new NourideError("external_agent", message, message);
    }
    // Its stderr says "not installed" only of a CLI that never answered: an old "server not found" line in a running
    // CLI's tail turned a later failure into "not installed here" (0.8.1).
    const reason = unavailableReason(row, err, connection.info ? [] : connection.stderrTail);
    if (signedOut(row, err) || /not installed/.test(reason) || connection.closed) this.host.setUnavailable(this.agent.config.id, reason);
    return new NourideError("external_agent", reason, reason, { cause: err });
  }

  /** `text` is the whole reply, kept in the conversation; `answer` what of it the chat still has to be told. */
  private result(req: TurnRequest, text: string, turnMessages: ChatMessage[], steps: TurnResult["toolSteps"], calls: number, refused: number, stop: StopReason, paused: boolean, iterations = 0, answer = text): TurnResult {
    const said: ChatMessage[] = text ? [...turnMessages, { role: "assistant", content: text, timestamp: Date.now() }] : turnMessages;
    return {
      text: answer,
      messages: [...req.history, ...said],
      turnMessages: said,
      // None of the daemon's models: what the CLI reported is recorded as its own, prompt by prompt (`run`), and charged
      // to no cap — the CLI's tokens are its plan's.
      usage: { inputTokens: 0, outputTokens: 0 },
      toolCalls: calls,
      iterations,
      approvalsRefused: refused,
      toolSteps: steps,
      stopReason: stop,
      contextTokens: 0,
      truncated: false,
      compaction: NO_COMPACTION,
      tokenScale: 1,
      ...(paused ? { paused: true } : {}),
    };
  }
}

/**
 * Variables kept since the CLI started that this turn's shell does not have (`ExternalAgents.forTurn`): said, so the
 * agent neither reads an empty one as missing nor asks the person for a credential already kept — a mission asked for
 * three keys the chat had kept two minutes before it (2026-11-02).
 */
function notYetNote(names: readonly string[]): string {
  const listed = names.map((name) => `$${name}`).join(", ");
  return (
    `[Kept since your CLI started, and not in your shell this turn: ${listed}. They are kept, so do not ask the person for ` +
    "them again; your shell has them from your next turn. Do now what does not need them, and say what waits for them.]"
  );
}

/** An ACP plan entry as a step of the plan beside the chat. */
function planStep(entry: PlanEntry): PlanStep {
  return { text: entry.content, state: entry.status === "completed" ? "done" : entry.status === "in_progress" ? "active" : "pending" };
}

/** Whether the turn holds this tool: what the instruction file names only where the agent has it. */
function lent(req: TurnRequest, name: string): boolean {
  return req.toolset.definitions.some((tool) => tool.name === name);
}
