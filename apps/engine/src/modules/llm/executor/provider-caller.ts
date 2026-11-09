/**
 * One call to the model, and the one extra call a turn makes to say something at the end.
 *
 * The pair to `tool-caller.ts`: the loop in `index.ts` decides what happens next, and these two do
 * one thing each time they are asked. Split out of the loop's file when it passed seven hundred
 * lines, along the seam that was already there — nothing here reads or changes the loop's state
 * except the usage total it is handed.
 */

import { LLMError, createLogger, resolveToolIterations, type ChatMessage, type ChatParams, type ChatResponse, type LlmEffort, type LoadedAgent, type RetryInfo, type StopReason, type SystemBlock, type TokenUsage, type ToolCall, rootSessionOf } from "@nouride/shared";
import { estimateMessagesTokens } from "@nouride/llm";
import { truncateContext } from "@/modules/llm/context.ts";
import { outputCap } from "@/modules/llm/output-cap.ts";
import { carriesAudio, resolveAudio, withoutAudio } from "@/modules/llm/audio.ts";
import { resolveImages } from "@/modules/llm/images.ts";
import { withoutForgedSections } from "@/modules/llm/prompt/index.ts";
import { createReasoningStream } from "@/modules/llm/reasoning.ts";
import { createGenerationProgress } from "@/modules/llm/progress.ts";
import type { ExecutorDeps, TurnRequest } from "./types.ts";

const log = createLogger("llm.executor");

/** How a `retry` line says what the provider ran into, by its class (`classifyFailure`, `postJson`). */
const RETRY_WORDS: Record<string, string> = {
  rate_limit: "is rate-limiting",
  overloaded: "is overloaded",
  transient: "had a passing failure",
  timeout: "did not answer in time",
  network: "could not be reached",
};

/**
 * What `[llm] fallbacks` answers for, and how the line says it, by whether the next pair is on
 * the same profile. Another model there answers a model that cannot answer now — its retries spent — or is not served.
 * Another profile answers more: an endpoint down, out of credit or refusing its key, which another endpoint is not. A
 * refused request, a content policy or a window overflowed is not fallen back on: any model would meet the same.
 */
const SAME_PROFILE: Record<string, string> = {
  rate_limit: "is rate-limiting",
  overloaded: "is overloaded",
  model_not_found: "is not served",
};
const OTHER_PROFILE: Record<string, string> = {
  ...SAME_PROFILE,
  transient: "is down",
  auth: "refused its key",
  billing: "is out of credit",
};

/** The pair a turn is on: the agent's own until it falls back, then the fallback's, by its place in the list. */
interface OnPair {
  index: number;
  profile: string;
  model: string;
  provider: TurnRequest["provider"];
}

/** A model's answer to one call, and what the provider counted for it. */
interface ProviderAnswer {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /**
   * The reply stopped at the output limit, and this was the limit (`ChatResponse.cutAtLimit`) — so a call it cut off can
   * be answered with why (`ToolCaller`), rather than only "not valid JSON".
   */
  cutAt?: number;
  /**
   * The input the provider reported for this request, beside our estimate of the messages it carried —
   * the pair the executor learns its token scale from (`context-scale.ts`). The messages are the ones
   * actually sent, after any retry took some out. Absent when the usage is our own estimate: a provider
   * that said nothing teaches nothing.
   */
  counted?: { input: number; messages: number };
}

export class ProviderCaller {
  /**
   * The fallback a turn moved to, for the rest of it. Keyed by the turn's request, which is one object for as long as
   * the turn runs and nothing holds after it — so the entry goes with the turn, and concurrent turns cannot meet.
   */
  private readonly fellBack = new WeakMap<TurnRequest, OnPair>();

  /**
   * Failures that came after the reply had begun to stream. Never fallen back on: its text is already in front of whoever
   * watches the turn, and another model's answer would be a second one under it (`streamEvents`).
   */
  private readonly midReply = new WeakSet<LLMError>();

  /** The level a turn's `/effort` asked for that its model refused (`TurnResult.effortRefused`), keyed as `fellBack` is. */
  private readonly refusedEffort = new WeakMap<TurnRequest, { effort: LlmEffort; model: string }>();

  constructor(private readonly deps: ExecutorDeps) {}

  /** What this turn's requests went without: the chat's `/effort` level, refused by its model, or nothing. */
  effortRefused(req: TurnRequest): { effort: LlmEffort; model: string } | undefined {
    return this.refusedEffort.get(req);
  }

  /**
   * What a request of this turn is sent as its effort, and who hears that it was refused: `/effort` in this chat over
   * `[llm] effort` (0.8.17), as a coding CLI's runner reads it. Only the chat's own level is reported: a person set it
   * there and is told. `[llm] effort` refused stays the guard's log line.
   */
  private effortOf(req: TurnRequest): Pick<ChatParams, "effort" | "onEffortRefused"> {
    const effort = req.effort ?? req.agent.config.llm.effort;
    if (!effort) return {};
    return req.effort ? { effort, onEffortRefused: (refusal) => this.refusedEffort.set(req, refusal) } : { effort };
  }

  /** The model this turn's next call goes to: its fallback once it has fallen back, else `/model`'s, else the agent's. */
  private modelFor(req: TurnRequest): string {
    return this.fellBack.get(req)?.model ?? req.model ?? req.agent.config.llm.model;
  }

  /** The endpoint it goes to, and the profile it is charged to: the fallback's once fallen back. */
  private providerFor(req: TurnRequest): TurnRequest["provider"] {
    return this.fellBack.get(req)?.provider ?? req.provider;
  }

  private profileFor(req: TurnRequest): string {
    return this.fellBack.get(req)?.profile ?? req.agent.config.llm.provider;
  }

  /** The next pair after the one the turn is on that answers this failure — or null, and the failure stands. */
  private nextPair(req: TurnRequest, failureClass: string): (OnPair & { why: string }) | null {
    const pairs = req.fallbacks ?? [];
    const from = this.profileFor(req);
    for (let index = (this.fellBack.get(req)?.index ?? -1) + 1; index < pairs.length; index += 1) {
      const pair = pairs[index]!;
      const why = (pair.profile === from ? SAME_PROFILE : OTHER_PROFILE)[failureClass];
      if (why && !(pair.profile === from && pair.model === this.modelFor(req))) return { ...pair, index, why };
    }
    return null;
  }

  /**
   * Moves the turn to the next pair that answers this failure, and says so — or false, when none does or the reply had
   * begun (`midReply`), and the failure stands. Asked by the model call and the wrap-up alike: the wrap-up called the
   * agent's own model with no fallback, so a rate limit there ended a turn a pair would have answered.
   */
  private fallBack(req: TurnRequest, err: unknown): boolean {
    const failure = err instanceof LLMError ? err.failure : undefined;
    const next = failure && !this.midReply.has(err as LLMError) ? this.nextPair(req, failure.class) : null;
    if (!failure || !next) return false;
    const from = { profile: this.profileFor(req), model: this.modelFor(req) };
    this.fellBack.set(req, { index: next.index, profile: next.profile, model: next.model, provider: next.provider });
    this.deps.onFallback?.({ from: from.model, fromProfile: from.profile, to: next.model, toProfile: next.profile, failure });
    const on = next.profile === from.profile ? "" : ` on ${next.profile}`;
    this.deps.onActivity?.("retry", `${from.model} ${next.why}: answering with ${next.model}${on}`, {
      reason: "fallback",
      failure: failure.class,
      from: from.model,
      to: next.model,
    });
    log.warn("the model could not answer; answering with the next fallback", {
      agent_id: req.agent.config.id, turn_id: req.turnId,
      from: from.model, from_profile: from.profile, to: next.model, to_profile: next.profile, failure_class: failure.class,
    });
    return true;
  }

  /**
   * One provider call, with the classified-failure responses applied.
   *
   * `shrink` is the one that earns its keep: a context-overflow used to end the turn, and the user
   * saw a generic outage message for a problem that fixes itself by dropping old history. Retried
   * **once** — if half of what was sent is still too much, the request is not the problem.
   */
  async call(
    req: TurnRequest,
    prompt: { blocks: SystemBlock[]; situation?: string },
    messages: ChatMessage[],
    usage: TokenUsage,
    budget?: number,
    /** This model's stream was cut once already in this call, and asked again — see below. */
    cutOnce = false,
  ): Promise<ProviderAnswer> {
    try {
      return await this.attemptProvider(req, prompt, messages, usage);
    } catch (err) {
      const failure = err instanceof LLMError ? err.failure : undefined;

      /**
       * The stream broke off before any of the reply had streamed: the same model, once more, before anything else.
       *
       * Nothing was shown and nothing ran — tool calls are acted on only once the stream finishes, so arguments that
       * were streaming are safe to ask for again. Without this, an agent with no fallback ended the turn on one dropped
       * socket and was taken up again minutes later. Once: a second cut is answered as any failure is, by a fallback or
       * by the turn ending. Not after the reply began (`midReply`), and not when the turn itself was stopped.
       */
      if (!cutOnce && err instanceof LLMError && err.streamCut && !this.midReply.has(err) && req.signal?.aborted !== true) {
        this.deps.onActivity?.("retry", `${this.modelFor(req)}'s stream was cut before its reply began: asking it again`, {
          // A provider asked again, as the request's own retries are: the event stream's `reason` is a fixed list.
          reason: "provider",
          ...(failure ? { failure: failure.class } : {}),
        });
        log.warn("the model's stream was cut before its reply began; asking it again", {
          agent_id: req.agent.config.id, turn_id: req.turnId, model: this.modelFor(req), error: err.message,
        });
        return await this.call(req, prompt, messages, usage, budget, true);
      }

      /**
       * The model or its gateway refused a voice note. Once more without it, saying so.
       *
       * Hearing was declared for this route — by the gateway's listing or by the operator — and the
       * declaration was wrong, or the route changed underneath it. The turn is still answerable: the
       * person asked something, and "I could not listen to that" is a true answer, where the error
       * would be "the model is not responding" about a model that responded perfectly well.
       *
       * Once, and only when there was audio to take out. A `media_unsupported` on a request carrying
       * none is not something this can fix, and retrying it would be the same request twice.
       */
      if (failure?.action === "degrade" && carriesAudio(messages)) {
        this.deps.onAudioRefused?.();
        this.deps.onActivity?.("retry", "the model refused the voice note: answering without it", { reason: "audio_refused" });
        log.warn("model refused audio; retrying without it", { agent_id: req.agent.config.id, turn_id: req.turnId });
        return await this.attemptProvider(req, prompt, withoutAudio(messages), usage);
      }

      /**
       * The model the turn is on cannot answer, and a pair further down the agent's list can.
       *
       * After the provider's own retries, never instead of them: a rate limit that clears in two seconds is still
       * waited out on the model the agent was given. Through `call` again, so the fallback's request gets the same
       * help this one would have — a voice note it refuses, a window it overflows — and, failing too, the pair after
       * it: each is tried once, in order, and the turn stays on the one that answered.
       */
      if (this.fallBack(req, err)) return await this.call(req, prompt, messages, usage, budget);

      if (failure?.action !== "shrink" || budget === undefined) throw err;

      // Half of what was sent, where that is less than the budget: a window put too high — the table's guess for a model
      // whose route allows less — overflows on a request well under half the budget, and halving the budget then dropped
      // nothing, so the turn failed on an overflow a shorter request clears (nouride-releases#14).
      const half = Math.floor(Math.min(budget, estimateMessagesTokens(messages)) / 2);
      const halved = truncateContext(messages, {
        maxTokens: half,
        preserveRecentTurns: 1,
      });
      // No point retrying the same thing: if truncation dropped nothing, the overflow is not coming
      // from history — an oversized single message, or a window smaller than one turn.
      if (!halved.truncated) throw err;

      this.deps.onActivity?.("retry", `the model's context overflowed: retrying without ${halved.dropped.length} earlier message(s)`, { reason: "context_overflow", dropped: halved.dropped.length });
      log.warn("context overflowed; retrying with harder truncation", {
        agent_id: req.agent.config.id, turn_id: req.turnId,
        dropped: halved.dropped.length,
        budget_halved: half,
      });
      return await this.attemptProvider(req, prompt, halved.messages, usage);
    }
  }

  /**
   * A provider asked again, said while the wait happens: a turn quiet for thirty seconds on a rate limit used to
   * look hung. The line names the class of what went wrong, never what the provider said.
   */
  private readonly retrying = (info: RetryInfo): void => {
    const what = RETRY_WORDS[info.failure] ?? "failed";
    void this.deps.onActivity?.("retry", `the provider ${what}: asking again in ${Math.max(1, Math.round(info.delayMs / 1000))}s (attempt ${info.attempt} of ${info.maxAttempts})`, {
      reason: "provider",
      failure: info.failure,
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      delayMs: info.delayMs,
      ...(info.status === undefined ? {} : { status: info.status }),
    });
  };

  private async attemptProvider(
    req: TurnRequest,
    prompt: { blocks: SystemBlock[]; situation?: string },
    messages: ChatMessage[],
    usage: TokenUsage,
  ): Promise<ProviderAnswer> {
    const { agent, toolset } = req;
    const provider = this.providerFor(req);
    const profile = this.profileFor(req);

    /** The input the provider itself reported for this request — never one `fillMissingUsage` estimated. */
    let reported: number | undefined;
    const counted = (delta: TokenUsage, model: string): void => {
      this.record(usage, delta, agent, model, profile);
      if (delta.estimated !== true && delta.inputTokens > 0) reported = delta.inputTokens;
    };
    const answer = (text: string, toolCalls: ToolCall[], stopReason: StopReason, cutAtLimit: boolean): ProviderAnswer => ({
      text,
      toolCalls,
      stopReason,
      ...(cutAtLimit ? { cutAt: params.maxTokens } : {}),
      ...(reported === undefined ? {} : { counted: { input: reported, messages: estimateMessagesTokens(messages) } }),
    });

    /**
     * The last step before the wire, and the only place bytes exist.
     *
     * Here rather than at the point the message was built, because everything between the two
     * re-derives the message list — truncation drops messages, trimming rewrites them, a retry
     * halves the window — and an image resolved earlier would be carried through all of it as a
     * megabyte of base64 and then possibly thrown away. Resolving last means the pictures that
     * survive truncation are the ones that get read, and nothing else is read at all.
     */
    // Audio after images, in the same place and for the same reason: nothing between here and the
    // wire re-derives the list, so what is read from disk is exactly what is sent.
    const resolved = await resolveAudio(
      await resolveImages(withoutForgedSections(messages), { maxBytesEach: this.deps.maxImageBytes ?? undefined, timeZone: this.deps.timezone }),
    );

    const params = {
      model: this.modelFor(req),
      system: prompt.blocks,
      messages: resolved,
      // The conversation is the root one: a `delegate` helper's requests share its parent's prefix, and its cache.
      identity: { agentId: agent.config.id, conversation: rootSessionOf(req.sessionId) },
      // Read now, at every request, so a note written in the step before is in this one (`ChatParams.tail`) — after who
      // is speaking, which is sent there too, out of the cached prefix (`BuiltPrompt.situation`).
      ...tailOf(prompt, req),
      ...(toolset.definitions.length > 0 ? { tools: toolset.definitions } : {}),
      temperature: agent.config.llm.temperature,
      ...this.effortOf(req),
      maxTokens: outputCap(agent.config.llm.maxTokens, this.modelFor(req), this.deps.llm.limits.maxTokensPerTurn),
      ...(req.signal ? { signal: req.signal } : {}),
      onRetry: this.retrying,
    };

    if (!this.deps.llm.streaming.enabled) {
      const response = await provider.chat(params);
      counted(response.usage, response.model);
      return answer(response.text, response.toolCalls, response.stopReason, response.cutAtLimit === true);
    }

    // Streaming without partial delivery: chunks are accumulated and the complete message
    // is sent once. §6.5 SPEC — editing a chat message per token flickers and hits rate
    // limits, and the reason to stream at all is that a long turn keeps the connection warm.
    let text = "";
    const toolCalls: ToolCall[] = [];
    let stopReason: StopReason = "stop";
    let cutAtLimit = false;

    // Forwarded to the activity feed, never into `text`. Reasoning is not part of the answer, and adding
    // it there would both show it to the user and send it back to the model as its own previous message.
    const reasoning = createReasoningStream((line) => this.deps.onActivity?.("reasoning", line));
    // Counted across text, reasoning and tool arguments alike: from the operator's side they are all "the
    // model is producing something", and the argument stream is the one that goes quiet for eighty seconds
    // while a file is written.
    const progress = createGenerationProgress((text) => this.deps.onActivity?.("thinking", text));

    try {
      for await (const chunk of provider.stream(params)) {
        switch (chunk.type) {
          case "text":
            text += chunk.delta;
            progress.add(chunk.delta);
            // The reply as it is written, for whoever is watching. Never the gateways — see `onText`.
            this.deps.onText?.(chunk.delta);
            break;
          case "reasoning":
            reasoning.push(chunk.delta);
            progress.add(chunk.delta);
            break;
          case "tool_call":
            toolCalls.push(chunk.call);
            break;
          case "progress":
            // An absolute total from the client, not an increment, so a reconnect or a re-sent chunk cannot
            // double-count.
            progress.setBytes(chunk.bytes);
            break;
          case "usage":
            counted(chunk.usage, params.model);
            break;
          case "done":
            stopReason = chunk.stopReason;
            cutAtLimit = chunk.cutAtLimit === true;
            break;
        }
      }
    } catch (err) {
      if (text && err instanceof LLMError) this.midReply.add(err);
      throw err;
    }

    reasoning.flush();
    return answer(text, toolCalls, stopReason, cutAtLimit);
  }

  private record(
    total: TokenUsage,
    delta: TokenUsage,
    agent: LoadedAgent,
    model: string,
    /** The profile that answered — a fallback's is not the agent's, and its price and billing are its own. */
    provider: string,
  ): void {
    total.inputTokens += delta.inputTokens;
    total.outputTokens += delta.outputTokens;
    this.deps.onUsage?.({ ...delta, model, agentId: agent.config.id, provider });
  }

  /**
   * One final call after the iteration cap, with tools withheld.
   *
   * Without this the user gets silence from a turn that did plenty of work. Withholding
   * the tools is what makes it terminate: offered them again, a model in a loop asks for
   * them again.
   */
  async wrapUp(
    req: TurnRequest,
    prompt: { blocks: SystemBlock[]; situation?: string },
    messages: ChatMessage[],
    usage: TokenUsage,
    wrapUpInstruction: string,
    /** Why the rescue ran, so the log distinguishes a capped loop from a model that went quiet. */
    reason: string,
    how: {
      /** Tool calls the approval gate blocked this turn — the fallback below only mentions it if true. */
      notApproved?: number;
      /** A tool ended the turn on purpose — a job it started — rather than the turn running out of road. */
      asked?: boolean;
    } = {},
  ): Promise<string> {
    const notApproved = how.notApproved ?? 0;
    const fields = {
      agent_id: req.agent.config.id, turn_id: req.turnId,
      reason,
      cap: resolveToolIterations(req.agent.config.llm.maxToolIterations, this.deps.llm.limits.maxToolIterations),
    };
    // A finish a tool asked for is the turn going as designed — starting a background job always ends one — and at
    // `warn` it was the commonest warning in a live journal. A rescue (the cap, a deadline, an empty reply) is one.
    if (how.asked) log.info("finishing a turn a tool ended", fields);
    else log.warn("wrapping up a turn that would otherwise say nothing", fields);

    /**
     * What the turn owes, placed after the wrap-up instruction and marked as taking precedence.
     *
     * Last, deliberately. The whole reason this parameter exists is that position beats wording here:
     * a reporting instruction in the turn's opening prompt lost, every time, to the `background_started`
     * instruction written at the tail — 17 failures out of 18 went out as "…sedang berjalan di
     * background, nanti gw kabarin", and the single exception was the one turn that called no tools and
     * so never reached this function.
     *
     * Both instructions are kept. They are not in conflict: one asks what finished, the other asks what
     * is now running, and the person needs both in the order stated.
     */
    const instruction = req.owedReport
      ? `${wrapUpInstruction}\n\n[system] This takes precedence over the paragraph above, and comes` +
        ` first in your reply: ${req.owedReport}`
      : wrapUpInstruction;

    /**
     * Resolved here too, and it was not.
     *
     * The ordinary path resolves just before `provider.chat` — see the note at the `resolveImages`
     * call in `run` — and this rescue path went straight to the provider with the transcript as it
     * stands, `image_ref` parts and all. The serializer refuses one of those on principle, so any
     * turn that carried a picture **and** reached the wrap-up died with
     * `an unresolved image_ref reached the wire serializer`, which the classifier could only report
     * as "The model is not responding right now." A person reading that goes and checks their
     * provider.
     *
     * It became common rather than rare when `background_started` started reaching here: a turn that
     * kicks off a job now always wraps up, so every screenshot sent to an agent that starts one hit
     * it.
     */
    const request = async (offered: boolean) =>
      await this.providerFor(req).chat({
        model: this.modelFor(req),
        system: prompt.blocks,
        // Audio too — the lesson above, not relearned: a voice-note turn that reached the wrap-up would
        // otherwise die in the serializer on its `audio_ref`.
        messages: await resolveAudio(
          await resolveImages(
            withoutForgedSections([
              ...messages,
              {
                role: "user",
                content: instruction,
              },
            ]),
            { maxBytesEach: this.deps.maxImageBytes ?? undefined, timeZone: this.deps.timezone },
          ),
        ),
        /**
         * Offered and not to be called. Left out, they ended the loop the same way — and started the conversation's cache
         * over at its first byte, the tools being the first thing in a request: a 90k-token conversation written again for
         * one closing sentence (live, 2026-10-22). With `none` the prefix is the turn's own, and only the instruction is new.
         */
        ...(offered && req.toolset.definitions.length > 0 ? { tools: req.toolset.definitions, toolChoice: "none" as const } : {}),
        ...tailOf(prompt, req),
        temperature: req.agent.config.llm.temperature,
        ...this.effortOf(req),
        maxTokens: outputCap(req.agent.config.llm.maxTokens, this.modelFor(req), this.deps.llm.limits.maxTokensPerTurn),
        ...(req.signal ? { signal: req.signal } : {}),
        onRetry: this.retrying,
      });
    // Through the agent's fallbacks, as the turn's other calls are — the next ask goes to the pair that answered.
    const ask = async (offered: boolean): Promise<ChatResponse> => {
      try {
        return await request(offered);
      } catch (err) {
        if (this.fallBack(req, err)) return await ask(offered);
        throw err;
      }
    };

    let response = await ask(true);
    this.record(usage, response.usage, req.agent, response.model, this.profileFor(req));
    // An endpoint that does not honour `none` can still answer with a call and no words: asked once more with the tools
    // withheld, as this did before, so silence is never what comes back.
    if (!response.text && response.toolCalls.length > 0) {
      response = await ask(false);
      this.record(usage, response.usage, req.agent, response.model, this.profileFor(req));
    }
    if (response.text) return response.text;

    // Twice-empty is possible, and silence is the one answer this must never return. What it says is
    // the difference between a useful message and the guess this replaced: the approval hint appears
    // only when an approval was actually refused this turn.
    if (notApproved > 0) {
      return (
        "I stopped without finishing that. A tool call did not get past the approval gate: it was " +
        "denied, it expired, or there was nobody to ask. `nouride approvals` shows anything still waiting."
      );
    }
    return "I did the work but could not put an answer together. Ask me again and I will summarize it.";
  }
}

/**
 * What goes after everything else in a request: who is speaking (`BuiltPrompt.situation`), then the work notes — both
 * read at this request, neither in the cached prefix.
 */
function tailOf(prompt: { situation?: string }, req: TurnRequest): { tail?: string } {
  const tail = [prompt.situation, req.notes?.()].filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
  return tail ? { tail } : {};
}
