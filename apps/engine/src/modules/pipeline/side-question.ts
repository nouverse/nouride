/**
 * `/btw`, a side question (0.8.17): asked while the agent works, or when it does not, and answered
 * beside the turn by a one-shot turn of its own, shaped like a peer's (`peer-turn.ts`) and with no session of its own.
 *
 * What it is, as decided on 2026-11-05: the agent itself, in its persona and the person's language,
 * with the conversation and the work in flight, that can do nothing. A question is answered; something to do is said,
 * in its own words, to be better asked in the chat. Live that day it was none of that: on Nix, at its `[llm] effort`, it
 * thought for 24 s, called a tool, and its minute ran out on the daemon's English "ask it as a message".
 *
 * - It sees what the agent sees (`aside-context.ts`): the conversation so far and the work in flight, cut to a size
 *   budget. It writes nothing back: not journaled, not saved, so neither the
 *   running turn nor the next one sees it. Its answer is the command's reply, which the chat gets marked and the turn
 *   log keeps as a `note` record, done without a model, that memory skips (`inbound.ts`,
 *   `TurnStore.exchangesBetween`).
 * - No tools: nothing it does can change what the running turn works on, and one round answers it.
 * - The agent's own model at `low` effort, within a minute: an aside, not a task.
 * - One at a time per chat: a second is refused while one is answered.
 * - Metered as `side_question` in a session of its own, never in the running turn's record; its start, end and failure
 *   are logged with its numbers (invariant 16).
 */

import { dirname, join } from "@nouride/runtime";
import { childSessionId, createLogger, sessionIdFor, toUserMessage, TOOL_ITERATIONS_MIN, type GateDecision, type LlmEffort, type LoadedAgent, type MessageEnvelope } from "@nouride/shared";
import { TurnExecutor } from "@/modules/llm/executor/index.ts";
import { meter } from "@/modules/llm/metered.ts";
import { fallbacksFor } from "@/modules/llm/fallbacks.ts";
import { changesSharedTools } from "@/modules/toolchain/shared-tools.ts";
import { resolveToolset, type AgentToolset } from "@/modules/tools/registry.ts";
import { conversationSoFar, workInFlight } from "./aside-context.ts";
import { alertOnFallback } from "./fallback-alert.ts";
import type { TurnContext } from "./turn-context.ts";

const log = createLogger("pipeline.side-question");

/**
 * Model rounds a side question may take: the fewest a turn may have. It is offered no tool, so it answers in one; the
 * rest are for a model that calls one anyway and is refused.
 */
export const SIDE_ROUNDS = TOOL_ITERATIONS_MIN;
/** Its clock: a minute. A design value. */
const SIDE_MS = 60_000;
/** Characters of the conversation it reads, the newest kept first: the last several exchanges. A design value. */
const CONVERSATION_BUDGET = 24_000;
/** How hard it thinks: an aside answered in seconds. At the agent's own `max` it thought for 24 s before a word (live, 2026-11-05). */
const SIDE_EFFORT: LlmEffort = "low";

/** What marks a side answer in the chat, ahead of its words. */
const SIDE_MARK = "btw: ";

/** A message that asks a side question: `/btw …`, also addressed (`@bot /btw`, `nova: /btw`) as a room has it. */
export function isSideQuestion(text: string): boolean {
  return /^\s*(?:@\S+[\s,:]*|[\p{L}\p{N}_-]+:\s*)?\/btw(?:@\S+)?(?:\s|$)/iu.test(text);
}

/** A side answer one of our bots posted, as a platform echoes it back. */
export function isSideAnswer(text: string): boolean {
  return text.startsWith(SIDE_MARK);
}

/**
 * What the side turn is asked: who it is answering as and what it may do, the conversation, the work in flight, and
 * the question. Its rule is the owner's (2026-11-05): itself and in their language, a question answered, a request to
 * do something sent to the chat in its own words.
 */
export function sideQuestionMessage(question: string, conversation: string, steps: string): string {
  return [
    "[A side question, asked with /btw beside the conversation. Answer it as yourself, in your own voice and in the language it was asked in, " +
      "from the conversation and the work shown here and what you know. From here you can do nothing: no tools, nothing run, nothing changed. " +
      "If it asks you to do something, or the answer needs something looked up or run, say so in a sentence, in your voice and their language: " +
      "that it is better said in the chat itself, where you can do it. Neither this question nor your answer is kept in the conversation, and your work goes on as it was.]",
    ...(conversation ? ["", "[The conversation so far:]", conversation] : []),
    ...(steps ? ["", "[Your turn still running, its last steps:]", steps] : []),
    "",
    question,
  ].join("\n");
}

/** No tool at all: one a model calls anyway is refused, and runs nothing. */
function noTools(toolset: AgentToolset): AgentToolset {
  return {
    ...toolset,
    definitions: [],
    get: () => undefined,
    gate: (): GateDecision => ({ action: "refuse", reason: "a side question does nothing: answer from what you have, or say it is better asked in the chat" }),
  };
}

/**
 * The work, or the minute: a tool that does not heed the stop holds neither the person nor the chat past it. Found in
 * the VM sandbox (0.8.17): a read stuck on a pipe kept a side question past its minute, and every `/btw` after it was
 * refused as one at a time, until something wrote to the pipe. What it was doing goes on, and its answer is dropped.
 */
export function withinTheMinute<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

/**
 * The words a person reads besides the answer: the daemon's, when the agent has none. None of them sends the person to
 * the chat with a question: whether a question is the chat's is the agent's to say, in its own words.
 */
export const SIDE_SAYS = {
  usage: "Ask it after the command: `/btw what port was that?`",
  busy: "One side question at a time here: the one before is still being answered.",
  late: "No answer within a minute. Try /btw again in a moment.",
  empty: "No answer came back. Try /btw again in a moment.",
  failed: (why: string) => `I could not answer that one: ${why}`,
};

export class SideQuestions {
  /** The chats a side question is being answered in now, `gatewayId:chatId`. */
  private readonly answering = new Set<string>();

  constructor(private readonly ctx: TurnContext) {}

  /** The reply to `/btw <question>` from this envelope's sender, for this agent: the marked answer, or why there is none. */
  async ask(agent: LoadedAgent, envelope: MessageEnvelope, question: string): Promise<string> {
    if (!question.trim()) return SIDE_SAYS.usage;
    const chat = `${envelope.gatewayId}:${envelope.chatId}`;
    if (this.answering.has(chat)) return SIDE_SAYS.busy;
    this.answering.add(chat);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("a side question's minute is up"), SIDE_MS);
    const key = { agentId: agent.config.id, gatewayId: envelope.gatewayId, chatId: envelope.chatId };
    try {
      const conversation = conversationSoFar(this.ctx.deps.sessions.load(key).messages, CONVERSATION_BUDGET);
      const steps = workInFlight(this.ctx.deps, agent.config.id, envelope.gatewayId, envelope.chatId);
      const lines = (text: string) => (text ? text.split("\n").length : 0);
      log.info("side question asked", { agent_id: agent.config.id, chat_id: envelope.chatId, conversation: lines(conversation), steps: lines(steps) });
      const sessionId = childSessionId(sessionIdFor(key), "btw");
      const workspace = this.ctx.workspaceFor(agent.config.id);
      const result = await withinTheMinute(this.executor(agent, sessionId).run({
        signal: controller.signal,
        // A few rounds, not the agent's own budget, at `low` effort: an aside. Its minute is the timer above and
        // no `deadlineAt`: the reserve kept for a last word is the daemon's turn's (a minute of an hour), and with a
        // minute's deadline it left no room for a round, so every answer was a wrap-up after the first.
        agent: { ...agent, config: { ...agent.config, llm: { ...agent.config.llm, maxToolIterations: SIDE_ROUNDS, effort: SIDE_EFFORT } } },
        provider: this.ctx.deps.providers.get(agent.config.llm.provider),
        ...fallbacksFor(agent, this.ctx.deps.providers),
        toolset: noTools(resolveToolset(agent, this.ctx.tools, this.ctx.deps.config.security, this.ctx.toolsetDeps())),
        // The conversation is in the question, as words (`aside-context.ts`): an agent on a coding CLI has its session
        // in the CLI, and an agent's own history holds every tool result, most of a long session, for an aside.
        history: [],
        userMessage: { role: "user", content: sideQuestionMessage(question.trim(), conversation, steps), timestamp: Date.now() },
        workspaceDir: workspace.shared,
        privateDir: workspace.own,
        readOnlyRoots: this.ctx.readOnlyRoots(agent, sessionId),
        gateway: envelope.gateway,
        ...this.ctx.formattingFor(envelope.gatewayId),
        gatewayId: envelope.gatewayId,
        chatId: envelope.chatId,
        chatType: envelope.chatType,
        senderId: envelope.senderId,
        sessionId,
      }), controller.signal);
      const answer = result.text.trim();
      log.info("side question answered", {
        agent_id: agent.config.id,
        chat_id: envelope.chatId,
        model: result.answeredBy ?? agent.config.llm.model,
        tool_calls: result.toolCalls,
        iterations: result.iterations,
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
        ms: Date.now() - startedAt,
      });
      return answer ? `${SIDE_MARK}${answer}` : SIDE_SAYS.empty;
    } catch (err) {
      log.warn("side question failed", { agent_id: agent.config.id, chat_id: envelope.chatId, error: String(err), ms: Date.now() - startedAt });
      return controller.signal.aborted ? SIDE_SAYS.late : SIDE_SAYS.failed(toUserMessage(err));
    } finally {
      clearTimeout(timer);
      this.answering.delete(chat);
    }
  }

  /** The agent's own model, as its helpers run on it, metered as a side question in its own session. */
  private executor(agent: LoadedAgent, sessionId: string): TurnExecutor {
    const ctx = this.ctx;
    return new TurnExecutor({
      ...(ctx.deps.spill ? { spill: ctx.deps.spill } : {}),
      onFallback: alertOnFallback(ctx.outages, ctx.deps.notifier, agent),
      windowOf: (model) => ctx.deps.providers?.catalog?.windowNow(agent.config.llm.provider, model) ?? null,
      llm: ctx.deps.config.llm,
      approvals: ctx.deps.approvals,
      approvalLevel: () => ctx.approvalLevel(agent),
      timezone: ctx.deps.config.daemon.timezone,
      ...(ctx.deps.credentialsDir ? { credentialsDir: ctx.deps.credentialsDir } : {}),
      installDir: dirname(dirname(ctx.deps.config.daemon.dataDir)),
      binDir: join(dirname(ctx.deps.config.daemon.dataDir), "bin"),
      changesSharedTools: (agentId: string) => changesSharedTools(ctx.deps.config, ctx.deps.registry.get(agentId)),
      // Nobody can type a slash command at this turn: it answers one.
      commands: [],
      onUsage: (usage) =>
        meter(ctx.deps.usage, { agentId: usage.agentId, provider: agent.config.llm.provider, purpose: "side_question", sessionId })(usage, usage.model, usage.purpose, usage.provider),
    });
  }
}
