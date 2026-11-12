/**
 * Everything decided before the first provider call: the window, the prompt, the budget, and what
 * of the history still fits inside it.
 *
 * Its own file because it is a different *kind* of work from the loop below it. Nothing here talks
 * to a provider or a tool — it is arithmetic on token counts, plus one optional summarization pass
 * — and every number it produces is a ceiling something later spends against. Getting one of them
 * wrong shows up as an overflow on every request, which is why they are computed in one place from
 * one declared window rather than derived twice.
 */

import { estimateTokens, estimateToolsTokens } from "@nouride/llm";
import { foldDefinitions } from "@/modules/tools/fold.ts";
import { createLogger, type ChatMessage, type LLMProvider, type Skill, type SystemBlock , resolveToolIterations, resolveTurnDurationMs, tierModel } from "@nouride/shared";
import { compactionThreshold, conversationBudget, pruneToolOutputs, resolveCompactionLimit, truncateContext } from "@/modules/llm/context.ts";
import { ASSUMED_CACHE_LIFETIME_MS, CacheBreaks } from "@/modules/llm/cache-breaks.ts";
import { compactHistory } from "@/modules/llm/summarize.ts";
import { outputCap, plannedOutputTokens } from "@/modules/llm/output-cap.ts";
import { summarizerRoute, summarizerWindowFor } from "@/modules/llm/summarizer.ts";
import { metered } from "@/modules/llm/metered.ts";
import { orOwnModel } from "@/modules/llm/helper-model.ts";
import { compactionEnded, compactionStarted } from "@/modules/llm/compaction-steps.ts";
import { idFormsFor } from "@/modules/people/match.ts";
import { buildSystemPrompt, workFacts } from "@/modules/llm/prompt/index.ts";
import { contextWindowFor, warnOnceAboutContextWindow } from "./context-window.ts";
import { workspaceView } from "./workspace-view.ts";
import { agentCommandsHaveOwnUsers, sha256Text } from "@nouride/runtime";
import { agentBins } from "@/modules/toolchain/env.ts";
import { clockNote, withReminders } from "./reminders.ts";
import {
  MAX_TOOL_RESULT_TOKENS,
  MIN_TOOL_RESULT_TOKENS,
  PROMPT_SHARE,
  TOOL_RESULT_SHARE,
  TRIM_TO_SHARE,
  type CompactionPlan,
  type ExecutorDeps,
  type TurnRequest,
} from "./types.ts";

const log = createLogger("llm.executor");

export interface TurnPlan {
  /**
   * The system prompt, split at its stability boundaries so the stable parts can be cached — and who is speaking, which
   * is sent after the conversation instead (`BuiltPrompt.situation`).
   */
  prompt: { blocks: SystemBlock[]; situation: string };
  /** The model this turn actually runs on, after any `/model` override. */
  model: string;
  /**
   * What the conversation's provider counted per estimated token when the turn began — the scale the
   * window below was decided at. 1 until a provider has reported a count (`context-scale.ts`).
   */
  scale: number;
  /** The system prompt and tool schemas, estimated: what every request carries besides its messages. */
  overhead: number;
  /**
   * Every ceiling the turn spends against, at a scale.
   *
   * A function rather than numbers, because the scale moves: each call that reports a count measures it
   * again, and the loop reads the ceilings anew from what was last measured.
   */
  ceilingsAt: (scale: number) => TurnCeilings;
  /** History as it stands after any summarization pass — what gets persisted from. */
  history: ChatMessage[];
  /** Who sums up, and on which model: the history before the turn, and the turn's own oldest steps if they fill the window. */
  summarizer: { provider: LLMProvider; model: string };
  /** The slice of it that fits, and what was dropped to make it fit. */
  window: ReturnType<typeof truncateContext>;
  /**
   * The message being answered, exactly as it is sent: the clock and this turn's reminders at its end.
   * What the session keeps, so the next turn's request repeats it byte for byte — `reminders.ts`.
   */
  userMessage: ChatMessage;
}

/** What a turn spends against, in the estimator's tokens — the numbers every estimate is compared with. */
export interface TurnCeilings {
  /** Tokens the conversation may occupy, prompt and tools already subtracted. */
  budget: number;
  /** The ceiling on a single tool result before it is spilled to disk. */
  toolResultCap: number;
  /**
   * Where the loop starts dropping this turn's own tool output.
   *
   * Below `budget`, and read again on every iteration: from the second round on, `working` carries
   * output the first round produced and nothing else is measuring it.
   */
  compactAt: number;
  /**
   * How far that drop goes once it starts: a share of `compactAt`, so the rounds after it send the same
   * prefix until the set has grown back to the line (`TRIM_TO_SHARE`).
   */
  trimTo: number;
  /** What compaction is measured against, kept for the pass that runs after the reply. */
  compaction: CompactionPlan;
}

/**
 * What a turn's ceilings are derived from, fixed for the turn.
 *
 * The window, the reserved output and the compaction limit are the provider's tokens, as configured or
 * looked up; the prompt and the tool schemas are estimates. `ceilingsAt` is where the two meet.
 */
export interface WindowFacts {
  contextWindow: number;
  maxContextRatio: number;
  promptTokens: number;
  toolsTokens: number;
  maxOutputTokens: number;
  compactAtRatio: number;
  /** The whole-request compaction limit, and where it came from. */
  totalLimit: { tokens: number; source: string };
  summaryModel: string;
  summarizerWindow: number;
}

/**
 * The turn's ceilings, for what the provider counts per estimated token.
 *
 * A limit is the provider's number and the history is the estimator's, so every limit is divided by the
 * scale before an estimate is held against it — the prompt and tools, being estimates already, are
 * subtracted after. At a scale of 1 these are the numbers the raw estimate always got. What a scale
 * changes is where the history is cut, where compaction starts, where the loop starts dropping tool
 * output, and how big a tool result may be: each at its real size rather than at 2.3x it.
 *
 * Not the system prompt's ceiling. That is a share of the window as a matter of policy, and the scale is
 * measured on requests a long history dominates — applying it would drop the agent's memory and skills on
 * a density the prompt's own prose does not have.
 */
export function ceilingsAt(facts: WindowFacts, scale: number): TurnCeilings {
  const overhead = facts.promptTokens + facts.toolsTokens;
  const budget = conversationBudget({
    contextWindow: facts.contextWindow,
    maxContextRatio: facts.maxContextRatio,
    systemPromptTokens: facts.promptTokens,
    toolsTokens: facts.toolsTokens,
    maxOutputTokens: facts.maxOutputTokens,
    scale,
  });
  // The ceiling is the *whole request* — prompt, tools and history — because that is what is sent, billed
  // and shown in the usage log. It used to count history alone, so a 120k setting showed up as ~180k and
  // nobody could reconcile the two. The prompt and tools are subtracted here to get what the history may use.
  const compactAt = compactionThreshold(
    budget,
    facts.compactAtRatio,
    Math.max(MIN_HISTORY_TOKENS, Math.floor(facts.totalLimit.tokens / scale) - overhead),
  );

  /**
   * What one tool result may cost, in tokens.
   *
   * Derived from this turn's real budget rather than configured as a byte count, because the thing
   * being protected is the window and the window is what varies — the same 6MB log is survivable
   * at a million tokens and fatal at thirty-two thousand. The hard ceiling is what a result costs on
   * every request after it, so it is divided by the scale like any limit; the floor is about leaving an
   * excerpt worth reading, which is characters, so it is not.
   */
  const toolResultCap = Math.max(
    MIN_TOOL_RESULT_TOKENS,
    Math.min(Math.floor(MAX_TOOL_RESULT_TOKENS / scale), Math.floor(budget * TOOL_RESULT_SHARE)),
  );

  return {
    budget,
    toolResultCap,
    compactAt,
    trimTo: Math.floor(compactAt * TRIM_TO_SHARE),
    compaction: {
      threshold: compactAt,
      limit: compactAt,
      totalLimit: facts.totalLimit.tokens,
      source: facts.totalLimit.source,
      summaryModel: facts.summaryModel,
      // The conversation's scale, measured on the turn's model, is the best figure there is for its
      // summarizer as well: a stretch is split to fit half of this.
      summarizerWindow: Math.floor(facts.summarizerWindow / scale),
    },
  };
}

/**
 * Never allowed to fail a turn.
 *
 * The scan touches a directory the daemon does not own, and losing a skill is smaller than losing
 * the conversation.
 */
async function loadProjectSkills(deps: ExecutorDeps, req: TurnRequest): Promise<Skill[]> {
  return await (deps.projectSkills?.(req.agent) ?? Promise.resolve([])).catch(() => [] as Skill[]);
}

export async function prepareTurn(
  deps: ExecutorDeps,
  req: TurnRequest,
  now: () => Date,
): Promise<TurnPlan> {
  const { agent, toolset } = req;
  const projectSkills = await loadProjectSkills(deps, req);
  const at = now();

  /**
   * The window, resolved before the prompt because the prompt has to be bounded by it.
   *
   * Read through `contextWindowInfo`, which says whether the figure was looked up, so a model nobody has a
   * figure for is *reported* rather than silently given the conservative default — and preferring
   * the pack's own `context_window` where the operator wrote one down, because a proxy renames
   * models and no pattern list can keep up with that.
   *
   * The declared number is only trusted for the model it was declared against. A `/model`
   * override points at something else, and carrying a hand-written window across to it is how you
   * get a 1M budget on a 32k model — an overflow on every request, which is worse than the
   * conservative guess it replaced.
   */
  const requested = req.model ?? agent.config.llm.model;
  const contextWindow = contextWindowFor({
    model: requested,
    packModel: agent.config.llm.model,
    ...(agent.config.llm.contextWindow !== undefined ? { declared: agent.config.llm.contextWindow } : {}),
    // What the gateway states for the model — a `/model` override's included: it is the gateway's own answer about
    // that model, unlike the pack's figure, which is about the model it was written against.
    stated: deps.windowOf?.(requested) ?? null,
  });
  if (contextWindow.source === "default") {
    warnOnceAboutContextWindow(requested, contextWindow.tokens);
  }

  /**
   * Ceiling on the system prompt: half the usable window, no more.
   *
   * Without a number here the trim loop in `buildSystemPrompt` never ran at all — `maxTokens` was
   * simply not passed, so `TRIM_ORDER` was dead code and `prompt.trimmed` was always empty. The
   * prompt had no upper bound, and a persona that grew would quietly take the conversation's room
   * instead of its own sections being dropped.
   *
   * Half is the split that keeps the failure legible. The prompt is the agent's instructions and
   * the rest is the work; a prompt allowed past half has stopped being context for a conversation
   * and started being the conversation. Deliberately *not* derived from the real budget, which
   * would be circular — the budget is computed from the finished prompt's size.
   */
  const promptCeiling = Math.floor(
    contextWindow.tokens * deps.llm.context.maxContextRatio * PROMPT_SHARE,
  );

  const prompt = buildSystemPrompt({
    agent,
    maxTokens: promptCeiling,
    ...(projectSkills.length ? { projectSkills } : {}),
    tools: toolset.definitions,
    harness: {
      approvalRequired: toolset.definitions
        .map((t) => t.name)
        .filter((name) => toolset.requiresApproval(name)),
      approvalAvailable: deps.approvals.available,
      ...(deps.execPolicy ? { execPolicy: deps.execPolicy(agent.config.id) } : {}),
      // The resolved level, from the same function the gate consults — so what the agent is told and
      // what actually happens cannot disagree.
      ...(deps.approvalLevel ? { approvals: deps.approvalLevel() } : {}),
      workspace: workspaceView(req),
      // Kept when the only others are out of reach: who cannot be tagged here, and why, is what the agent needs then.
      ...(req.otherAgents?.names.length || req.otherAgents?.absent?.length ? { otherAgents: req.otherAgents } : {}),
      ...(deps.installDir ? { installDir: deps.installDir } : {}),
      ...agentBins(deps.binDir, req.privateDir, agentCommandsHaveOwnUsers()),
      ...(agentCommandsHaveOwnUsers() && deps.changesSharedTools?.(agent.config.id) ? { sharesTools: true } : {}),
      ...(req.helper ? { helper: true } : {}),
      ...(req.unattended ? { unattended: true } : {}),
      // A chat's turn that can start one — not a mission's own, nor a schedule's, which asks the person first.
      ...(toolset.definitions.some((t) => t.name === "mission") && !req.unattended ? { startsMissions: true } : {}),
      // What the toolset was resolved with for this turn, so the prompt and the tool's schema say the same thing.
      ...workFacts(toolset),
      // The models `tier` chooses between, from the same function the helper and the peer are started with.
      ...(toolset.definitions.some((t) => t.name === "delegate" || t.name === "ask_agent")
        ? { modelTiers: { small: tierModel(agent.config.llm, deps.llm.defaults, "small"), default: agent.config.llm.model, high: tierModel(agent.config.llm, deps.llm.defaults, "high") } }
        : {}),
      // What this agent will actually be stopped at — the prompt must not promise a different
      // number from the one the loop enforces.
      maxToolIterations: resolveToolIterations(
        req.agent.config.llm.maxToolIterations,
        deps.llm.limits.maxToolIterations,
      ),
      // Resolved per agent for the same reason the line above it is: this is the sentence that
      // tells the model what it has, and a prompt that names the daemon's clock beside this
      // agent's round-trip cap reads as though both were the agent's.
      maxTurnDurationMs: resolveTurnDurationMs(
        req.agent.config.llm.maxTurnDurationMs,
        deps.llm.limits.maxTurnDurationMs,
      ),
      commands: deps.commands,
      truncates: deps.llm.context.truncationStrategy === "sliding_window",
      // Only when the agent can actually run a command. Naming a directory to an agent with no
      // `exec` describes a capability it does not have, which is prompt budget spent on a dead end.
      ...(toolset.definitions.some((t) => t.name === "exec")
        ? {
            ...(deps.credentialsDir ? { credentialsDir: deps.credentialsDir } : {}),
            ...(agent.config.execSecrets.length ? { execSecrets: agent.config.execSecrets } : {}),
          }
        : {}),
    },
    gateway: req.gateway,
    ...(req.formatting ? { formatting: req.formatting } : {}),
    chatId: req.chatId,
    chatType: req.chatType,
    ...(req.roomName ? { roomName: req.roomName } : {}),
    sessionId: req.sessionId,
    model: req.model ?? agent.config.llm.model,
    now: at,
    timezone: deps.timezone,
    ...(req.systemEvent ? { systemEvent: true } : {}),
    ...(req.senderName ? { senderName: req.senderName } : {}),
    ...(req.senderVerified ? { senderVerified: true } : {}),
    ...(req.person ? { person: req.person } : {}),
    ...(req.recall ? { recall: req.recall } : {}),
    ...(req.peopleConfigured ? { peopleConfigured: true } : {}),
    ...(req.gatewayId && req.senderId
      ? (() => {
          // Both forms, from the same helper the matcher uses — so what the prompt tells the agent to
          // write is a string the matcher will certainly recognise.
          const [qualified, onPlatform] = idFormsFor({
            gatewayId: req.gatewayId,
            senderId: req.senderId,
          });
          return {
            ...(qualified ? { personRef: qualified } : {}),
            ...(onPlatform ? { personRefPlatform: onPlatform } : {}),
          };
        })()
      : {}),
    ...(req.gatewayId ? { gatewayId: req.gatewayId } : {}),
  });

  if (prompt.trimmed.length > 0) {
    log.warn("system prompt sections trimmed to fit the context window", {
      agent_id: agent.config.id, turn_id: req.turnId,
      trimmed: prompt.trimmed,
    });
  }

  // Compaction happens before truncation and only when configured, because it costs a provider
  // call. The compacted history is what gets persisted — `messages` below is built from it — so a
  // conversation is summarized once rather than re-summarized on every turn that overflows.
  //
  // A failure inside returns the history unchanged, and truncation then does what it always did.
  // Room is made at `compact_at_ratio` of the budget, not at the budget itself. Firing only once
  // history is already over the line left no headroom at all: the first thing that ever happened was
  // the request that would have overflowed.
  //
  // The lower of a share of the budget and a flat ceiling. The ratio alone ties the threshold to the
  // window, which is a statement about what the model *can* read and not about what it should carry
  // per call: at a million tokens it put the line at ~610k, so a 426k session compacted never and
  // resent itself twenty times in one turn. The ceiling is inert on small windows, where the ratio
  // is already the smaller number. First match wins for the ceiling: the agent, the operator, the
  // model's own figure.
  // As they are sent: several of them as one entry (`tools/fold.ts`).
  const toolsTokens = estimateToolsTokens(foldDefinitions(toolset.definitions));
  // Who summarises: the runner's route (`llm/summarizer.ts`) — `[memory]`'s pass model when set — else the
  // turn's own provider, metered here as its compaction, with `summary_model` or the turn's model.
  const own = { profile: agent.config.llm.provider, model: requested };
  const route = summarizerRoute({ summaryModel: deps.llm.context.summaryModel }, own, { agent: agent.config.llm, install: deps.llm.defaults });
  // Metered as what it is: a call the turn makes, for the history rather than the answer.
  const turnProvider = metered(req.provider, (usage, model) => deps.onUsage?.({ ...usage, model, agentId: agent.config.id, purpose: "compaction" }));
  const summarizer = deps.summarizer?.(requested) ?? {
    // A `summary_model` that cannot answer falls back to the turn's model, as the runner's route does (`helper-model.ts`).
    provider: orOwnModel({ ...route, provider: turnProvider }, { ...own, provider: () => turnProvider }, "compaction"),
    model: route.model,
  };
  const summaryModel = summarizer.model;
  const facts: WindowFacts = {
    contextWindow: contextWindow.tokens,
    maxContextRatio: deps.llm.context.maxContextRatio,
    // The work notes ride at the end of every request (`ChatParams.tail`): room for them comes off the history's.
    promptTokens: prompt.tokens + estimateTokens(req.notes?.() ?? ""),
    toolsTokens,
    // The room the history plans to leave for a reply: the request's cap, but no more than a typical reply's
    // (`plannedOutputTokens`). Planning for the whole 32k cap took a quarter of a Claude conversation's room and
    // cleared tool results the agent had only just read (live, 0.7.25's first run); the request still asks for the
    // whole cap, and the compaction limit keeps it inside the window (`output-limit.test.ts`).
    maxOutputTokens: plannedOutputTokens(outputCap(agent.config.llm.maxTokens, requested, deps.llm.limits.maxTokensPerTurn)),
    compactAtRatio: deps.llm.context.compactAtRatio,
    totalLimit: resolveCompactionLimit(agent.config.llm.compactAtTokens, deps.llm.context.compactAtTokens, requested),
    summaryModel,
    summarizerWindow: summarizerWindowFor(summaryModel, requested, contextWindow.tokens),
  };
  // Where the conversation's last measured scale left it — so a log-heavy history is cut and compacted at
  // its real size from this turn's first call, not only once that call has reported — or, for a conversation
  // that has measured nothing yet, where its agent's did (`context-scale.ts`).
  const scale = deps.tokenScales?.get(req.sessionId, requested, agent.config.id) ?? 1;
  const { budget, compactAt, compaction } = ceilingsAt(facts, scale);

  /**
   * Context upkeep is said out loud, as a `note`, at the moment it happens.
   *
   * It used to be one `thinking` line after the summary came back — a kind the chat bubble never
   * shows and the turn record never keeps — so on Telegram a turn spent twenty seconds compacting
   * with nothing to show for it, and afterwards there was no trace that it had.
   */
  let history = req.history;
  history = clearStaleOutput(deps, req, history, sha256Text(`${requested}\n${toolset.definitions.map((tool) => tool.name).join(",")}\n${prompt.text}`), at.getTime());
  if (deps.llm.context.truncationStrategy === "summary") {
    const say = deps.onActivity ? (text: string, detail: Record<string, unknown>) => void deps.onActivity?.("compact", text, detail) : undefined;
    const compacted = await compactHistory(history, {
      provider: summarizer.provider,
      ...(req.signal ? { signal: req.signal } : {}),
      model: summaryModel,
      maxTokens: compactAt,
      limit: compaction.limit,
      summarizerWindow: compaction.summarizerWindow,
      timezone: deps.timezone,
      key: req.sessionId,
      onStart: ({ turns, tokens }) => compactionStarted(say, turns, tokens),
      ...(deps.spill ? { keep: deps.spill.keeperFor({ agentId: req.agent.config.id, sessionId: req.sessionId }) } : {}),
    });
    history = compacted.messages;
    if (compacted.compacted) deps.onCompacted?.(compacted.messages);
    compactionEnded(say, compacted, "dropping the oldest turns instead");
  }

  const userMessage = withReminders(req.userMessage, [clockNote(at, deps.timezone), ...(req.reminders ?? [])]);
  const window = truncateContext([...history, userMessage], {
    maxTokens: budget,
    preserveRecentTurns: deps.llm.context.preserveRecentTurns,
  });

  if (window.truncated) {
    deps.onActivity?.("compact", `context full: left out ${window.dropped.length} earlier message(s)`, { phase: "trimmed", dropped: window.dropped.length });
    log.info("context truncated", {
      agent_id: agent.config.id, turn_id: req.turnId,
      chat_id: req.chatId,
      dropped: window.dropped.length,
      // In the estimator's tokens: times the scale, it is the provider's.
      budget,
      token_scale: scale,
    });
  }

  return {
    prompt,
    model: requested,
    scale,
    overhead: prompt.tokens + toolsTokens,
    ceilingsAt: (measured) => ceilingsAt(facts, measured),
    history,
    summarizer: { provider: summarizer.provider, model: summaryModel },
    window,
    userMessage,
  };
}

/** Turns whose tool output stays in the history whole — a starting value. */
const STALE_AFTER_TURNS = 2;
/**
 * Tool output worth clearing even while the cache is warm: about what the rewrite costs, as one cache write of the
 * prefix after it — a starting value, until a measurement moves it.
 */
const CLEAR_WORTH_TOKENS = 16_000;
const cacheBreaks = new CacheBreaks();

/**
 * Tool output older than the last few turns, out of the history at a turn's start (0.8.13): the
 * same marker and kept file as a trim inside a turn, `read` bringing one back. On the live box tool output was 75 % of
 * the stored history and stayed whole until compaction, so requests grew to 100–200k first. Cleared when the cache was
 * lost anyway (`CacheBreaks`), or once there is enough of it to pay for the rewrite; once cleared it stays cleared, so
 * the prefix only shrinks at those moments.
 */
function clearStaleOutput(deps: ExecutorDeps, req: TurnRequest, history: ChatMessage[], prefix: string, now: number): ChatMessage[] {
  const lastAt = history.findLast((message) => message.timestamp !== undefined)?.timestamp;
  // The lifetime is the endpoint's, as its client declares it: five minutes idle loses one cache and not another.
  const lost = cacheBreaks.lost(req.sessionId, prefix, lastAt, now, req.provider.cacheLifetimeMs ?? ASSUMED_CACHE_LIFETIME_MS);
  const stale = pruneToolOutputs(history, {
    protectTokens: 0,
    protectTurns: STALE_AFTER_TURNS,
    minSavingsTokens: lost ? 1 : CLEAR_WORTH_TOKENS,
    ...(deps.spill ? { keep: deps.spill.keeperFor({ agentId: req.agent.config.id, sessionId: req.sessionId }) } : {}),
  });
  if (stale.pruned === 0) return history;
  log.info("old tool output cleared from the history", { agent_id: req.agent.config.id, turn_id: req.turnId, cleared: stale.pruned, saved_tokens: stale.savedTokens, cache_lost: lost });
  deps.onCompacted?.(stale.messages);
  return stale.messages;
}

/**
 * Never let the limit's share for history shrink to nothing.
 *
 * Applied to the limit, not to the result: a small window's ratio is still allowed to be lower, because
 * that is the model's real room. A prompt and tool schemas larger than the limit would otherwise leave
 * a threshold of zero or less,
 * and every turn would compact the conversation down to its last message — an agent that has forgotten
 * what it was just told, which reads as the model being broken rather than as one number set too low.
 */
const MIN_HISTORY_TOKENS = 8_000;
