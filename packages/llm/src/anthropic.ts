/**
 * Anthropic Messages API provider — TD-004.
 *
 * A separate implementation rather than a translation layer, because the two formats
 * differ structurally, not cosmetically: the system prompt is a top-level field, tool
 * results are content blocks inside a *user* message, and consecutive tool results
 * must be merged into one message. Nougate has full bidirectional mappers; Nouride only
 * needs to speak each format natively.
 */

import {
  LLMError,
  messageText,
  type ChatMessage,
  type ChatParams,
  type ChatResponse,
  type LLMProvider,
  type MessageContent,
  type StopReason,
  type StreamChunk,
  type SystemBlock,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
  eventJson,
} from "@nouride/shared";
import { collectStream, isEventStream } from "./collect.ts";
import { EffortGuard } from "./effort.ts";
import { cutOff, parsedBody, postJson, reportedFailure, requireBody, streamEvents, streamIdleTimeoutMs, unreadable, withCallStats, type HttpDeps } from "./http.ts";
import { toolArguments } from "./tool-arguments.ts";
import { systemBlocks } from "./system.ts";
import { fillMissingUsage } from "./tokens.ts";

/** The Messages API version this client speaks — sent with every request, and with a model listing (`models.ts`). */
export const ANTHROPIC_VERSION = "2023-06-01";

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * The API's own ceiling on `cache_control` markers per request. A fifth is a 400, not a warning.
 *
 * Counted rather than assumed, because the markers come from two places now — the caller's system
 * blocks and the conversation breakpoint below — and neither can see the other's total.
 */
const MAX_CACHE_BREAKPOINTS = 4;

export interface AnthropicProviderOptions {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  /** Send who is asking, as `metadata.user_id` (`ChatParams.identity`). */
  identify?: boolean;
  http?: HttpDeps;
}

/**
 * A cache breakpoint. Anthropic allows four per request, and Nouride's prompt uses all of them: one per cached
 * system block — the pack, the harness, what is recalled about the chat — and one on the conversation; see `post`.
 */
type CacheControl = { type: "ephemeral" };

type ContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      cache_control?: CacheControl;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      cache_control?: CacheControl;
    }
  /**
   * Anthropic's image block: base64 in a `source`, rather than OpenAI's data-URL in an `image_url`.
   *
   * The two wire formats differ for the same capability, which is exactly the kind of thing
   * `ProviderKind` exists to keep out of the engine — nothing above this file knows either spelling.
   */
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
      cache_control?: CacheControl;
    };

export interface WireMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/**
 * The three token counters, which are disjoint.
 *
 * `input_tokens` is the uncached remainder *only* — the whole prompt is the sum of all three. This
 * is the opposite of OpenAI's convention and the reason `toUsage` exists; see `TokenUsage`.
 */
interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** Served from the cache this request, priced at 0.1x. */
  cache_read_input_tokens?: number;
  /** Written to the cache this request, priced at 1.25x. */
  cache_creation_input_tokens?: number;
}

interface WireResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: WireUsage;
  model?: string;
}

interface WireStreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: { usage?: WireUsage };
  usage?: WireUsage;
}

/**
 * Anthropic's three disjoint counters, as the one inclusive input total everything downstream reads.
 *
 * Getting this wrong is not a rounding error. `estimateCost` subtracts the cached count from the
 * input total before repricing it, so on a request that hit the cache hard — 40k read, 500 fresh —
 * the un-normalised numbers made the whole prompt look like 500 tokens, and the daily cap saw a
 * turn that cost almost nothing. A spend limit that under-counts fails open (§4).
 */
function toUsage(usage: WireUsage | undefined): TokenUsage {
  const read = usage?.cache_read_input_tokens;
  const written = usage?.cache_creation_input_tokens;
  return {
    inputTokens: (usage?.input_tokens ?? 0) + (read ?? 0) + (written ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
    ...(typeof read === "number" ? { cachedInputTokens: read } : {}),
    ...(typeof written === "number" ? { cacheCreationInputTokens: written } : {}),
  };
}

type InputCounts = Pick<WireUsage, "input_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens">;

/** One event's input side, the three counts together, or undefined when it carries none. */
function inputSide(usage: WireUsage | undefined): InputCounts | undefined {
  const side: InputCounts = {};
  for (const field of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
    const value = usage?.[field];
    if (typeof value === "number") side[field] = value;
  }
  return Object.keys(side).length > 0 ? side : undefined;
}

const promptOf = (side: InputCounts) => (side.input_tokens ?? 0) + (side.cache_read_input_tokens ?? 0) + (side.cache_creation_input_tokens ?? 0);

/**
 * A stream's input counts, from `message_start` and each `message_delta`. The delta's are cumulative (Anthropic
 * documents them so), and a proxy that learns the prompt's size only at the end (Nougate from an OpenAI upstream)
 * sends zeros at the start and the counts there: read from the start alone, such a turn was estimated and its cache
 * hits lost. So the later event's counts are taken, as one set: two events can split one prompt differently, and
 * Nougate's Gemini route says the whole prompt is uncached at the start, its first chunk not counting the cache yet,
 * and gives the split at the end. Taking the higher of each field across the two counted the cache twice (166,469
 * for a prompt of 84,280, the box sandbox on 2026-11-04). A cumulative count never goes down, so a later set adding
 * up to less (a delta whose input fields are zeros) does not replace the earlier one.
 */
function laterCounts(earlier: InputCounts | undefined, later: InputCounts | undefined): InputCounts | undefined {
  if (!later || !earlier) return later ?? earlier;
  return promptOf(later) >= promptOf(earlier) ? later : earlier;
}

export class AnthropicProvider implements LLMProvider {
  readonly kind = "anthropic" as const;
  readonly baseUrl: string;
  private readonly effort = new EffortGuard();

  constructor(private readonly options: AnthropicProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const startedAt = Date.now();
    const res = await this.post(params, false);
    const raw = await res.text();
    // Streamed although `stream: false` was sent — a proxy that always streams — read as the stream it is, as the
    // OpenAI client does (`collect.ts`).
    if (isEventStream(res, raw)) return await collectStream(this.read(new Response(raw), params, { from: res, startedAt }), params.model);
    const body = parsedBody<WireResponse>(raw, res.status);
    // An answer with no content is not an empty answer: said, it became a silent empty summary or reply.
    if (!Array.isArray(body.content)) throw unreadable("provider answered with no content", res.status);

    const text = (body.content ?? [])
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("");

    const toolCalls: ToolCall[] = (body.content ?? [])
      .filter(
        (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
      )
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }));

    return {
      text,
      toolCalls,
      stopReason: mapStopReason(body.stop_reason, toolCalls.length > 0),
      ...(body.stop_reason === "max_tokens" ? { cutAtLimit: true as const } : {}),
      usage: withCallStats(
        fillMissingUsage(toUsage(body.usage), params, text, toolCalls.map((call) => ({ name: call.name, arguments: JSON.stringify(call.arguments) }))),
        res,
        startedAt,
        reportedStop(body.stop_reason),
      ),
      model: body.model ?? params.model,
    };
  }

  async *stream(params: ChatParams): AsyncIterable<StreamChunk> {
    const startedAt = Date.now();
    const res = await this.post(params, true);
    yield* this.read(res, params, { from: res, startedAt });
  }

  /** `call` is the response `postJson` returned and when it was asked — what the usage at the end is stamped with. */
  private async *read(res: Response, params: ChatParams, call: { from: Response; startedAt: number }): AsyncIterable<StreamChunk> {
    const partial = new Map<number, { id: string; name: string; json: string }>();
    /** Whether the stream said it was done — a stop reason, or `message_stop`. */
    let finished = false;
    let argumentBytes = 0;
    let stopReason: StopReason = "stop";
    /** The stop reason as the record keeps it — absent until one arrives (`TokenUsage.stopReason`). */
    let reported: StopReason | undefined;
    let cutAtLimit = false;
    let input: InputCounts | undefined;
    let output: number | undefined;
    let accumulatedText = "";

    for await (const event of streamEvents(requireBody(res), streamIdleTimeoutMs(this.options.http))) {
      const payload = eventJson<WireStreamEvent>(event);
      if (!payload) continue;

      switch (payload.type) {
        case "message_start":
          // Output is still zero here and arrives on `message_delta`, so only the input side is taken.
          input = laterCounts(input, inputSide(payload.message?.usage));
          break;

        case "content_block_start":
          if (payload.content_block?.type === "tool_use" && payload.index !== undefined) {
            partial.set(payload.index, {
              id: payload.content_block.id ?? `call_${payload.index}`,
              name: payload.content_block.name ?? "",
              json: "",
            });
          }
          break;

        case "content_block_delta": {
          if (payload.delta?.type === "text_delta" && payload.delta.text) {
            accumulatedText += payload.delta.text;
            yield { type: "text", delta: payload.delta.text };
          }
          if (payload.delta?.type === "input_json_delta" && payload.index !== undefined) {
            const existing = partial.get(payload.index);
            if (existing) existing.json += payload.delta.partial_json ?? "";
            // Same reason as the OpenAI client: an argument stream that runs for a minute must not look
            // like a stalled one. Size only — a partial JSON fragment is not actionable.
            argumentBytes += new TextEncoder().encode(payload.delta.partial_json ?? "").length;
            yield { type: "progress", bytes: argumentBytes };
          }
          break;
        }

        case "message_delta":
          if (payload.delta?.stop_reason) {
            finished = true;
            stopReason = mapStopReason(payload.delta.stop_reason, partial.size > 0);
            reported = reportedStop(payload.delta.stop_reason);
            // See `ChatResponse.cutAtLimit`: the stop reason says `tool_calls` when a call was being written.
            cutAtLimit = payload.delta.stop_reason === "max_tokens";
          }
          input = laterCounts(input, inputSide(payload.usage));
          if (typeof payload.usage?.output_tokens === "number") output = Math.max(output ?? 0, payload.usage.output_tokens);
          break;

        case "message_stop":
          finished = true;
          break;

        case "error":
          // Classified, as an error response is: an `overloaded_error` here was "something went wrong", and no fallback.
          throw reportedFailure((payload as { error?: unknown }).error, `stream error: ${event.data.slice(0, 300)}`);
      }
    }
    // A body that just stops is an answer cut off, not a finished one — see the OpenAI client.
    if (!finished) throw cutOff();

    for (const [, call] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: "tool_call",
        call: {
          id: call.id,
          name: call.name,
          ...toolArguments(call.json),
        },
      };
    }

    const produced = [...partial.values()].map((call) => ({ name: call.name, arguments: call.json }));
    yield { type: "usage", usage: withCallStats(fillMissingUsage(toUsage({ ...input, ...(output === undefined ? {} : { output_tokens: output }) }), params, accumulatedText, produced), call.from, call.startedAt, reported) };
    yield { type: "done", stopReason, ...(cutAtLimit ? { cutAtLimit: true as const } : {}) };
  }

  /** Through the effort guard: a model that refuses `effort` is asked again without it (`effort.ts`). */
  private async post(params: ChatParams, stream: boolean): Promise<Response> {
    return await this.effort.post(params, (asked) => this.send(asked, stream));
  }

  private async send(params: ChatParams, stream: boolean): Promise<Response> {
    // Built together because the breakpoint budget is shared: the system blocks claim their markers
    // first (they cover the largest and most stable bytes), and the conversation gets one only if a
    // slot is left. Silently dropping the last marker beats a 400 that fails the whole turn.
    const system = toSystemBlocks(withSystemMessages(params.system, params.messages));
    const spent = Array.isArray(system) ? system.filter((block) => block.cache_control).length : 0;
    const messages = toWireMessages(params.messages);
    if (spent < MAX_CACHE_BREAKPOINTS) markConversationBreakpoint(messages);
    appendTail(messages, params.tail);

    return await postJson(
      `${this.baseUrl}/messages`,
      {
        "x-api-key": this.options.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        ...this.options.headers,
      },
      {
        model: params.model,
        // Required by the API, unlike OpenAI where it is optional.
        max_tokens: params.maxTokens ?? 4096,
        messages,
        // `undefined` only when there is no system prompt at all. The gate used to be
        // `params.system ? …`, which dropped the whole field whenever the dynamic half was empty —
        // taking the cached prefix, and with it the agent's identity, off the request. Asking
        // `toSystemBlocks` instead means the emptiness test lives with the code that assembles them.
        ...(system !== undefined ? { system } : {}),
        ...(params.tools?.length ? { tools: params.tools.map(toWireTool) } : {}),
        ...(params.tools?.length && params.toolChoice === "none" ? { tool_choice: { type: "none" } } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        // How long the model thinks before it answers: `output_config`, not a top-level field.
        ...(params.effort ? { output_config: { effort: params.effort } } : {}),
        // The Messages API's own field for who a request is on behalf of, for a profile that says `identify`.
        ...(this.options.identify && params.identity ? { metadata: { user_id: `${params.identity.agentId}:${params.identity.conversation}` } } : {}),
        // `false` said outright, for a proxy that would otherwise pick for us — see the OpenAI client.
        ...(stream ? { stream: true } : { stream: false }),
      },
      params.signal,
      params.onRetry ? { ...this.options.http, onRetry: params.onRetry } : this.options.http,
    );
  }
}

/**
 * Build the `system` field for the Anthropic Messages API.
 *
 * Each block the caller marked `cache` gets a `cache_control` breakpoint at its end, so the API can
 * serve everything up to that point from its cache on the next request. The prompt builder marks the
 * boundaries where the prompt's *stability* changes — what comes from the agent's files, then what
 * depends on its toolset, then what is remembered about the chat — and leaves the last block unmarked
 * because it carries the date.
 *
 * A breakpoint per tier rather than one is the whole point of the split. With a single breakpoint at
 * the end of the files-derived prefix, the ~3.0k-token harness block sat outside the cache and was
 * re-read on every request and every tool iteration, even though it changes only when the toolset or
 * the exec posture does. With one each, a harness that did change costs a miss on its own 3.0k instead
 * of taking the 5.0k in front of it down as well — and a recall that moved, because a fact was written
 * mid-conversation or somebody new spoke in a group, costs a miss on itself and nothing in front of it.
 *
 * A single uncached block is sent as a plain string — the format Anthropic has always accepted, and
 * the only one older proxies are guaranteed to pass through.
 *
 * Note: prompt caching requires the upstream to support `cache_control` on system content blocks, and
 * "the upstream" is not always who you are pointed at. Through a gateway there are three cases, and
 * only the first is this code's business:
 *
 *   - **Anthropic protocol, Anthropic-style upstream** — the body passes through untouched, so this
 *     works. Checked against Nougate's source: `passthroughAnthropicBody` spreads the body and swaps
 *     the model, nothing more. An older version of this note claimed Nougate stripped the field with a
 *     `deep_remove_cache_control`; that string does not exist anywhere in it, and the claim was wrong.
 *   - **Anthropic protocol, OpenAI-style upstream** — the gateway converts, and `cache_control` has
 *     nowhere to go. Not an error, just a no-op.
 *   - **OpenAI protocol** — this file is not involved. `openai.ts` sends the prefix first and relies on
 *     the upstream's automatic prefix matching; there is no field to send. Gemini through Google's
 *     Cloud Code endpoint, which is what this install actually talks to, caches implicitly or not at
 *     all, and reports hits as `usageMetadata.cachedContentTokenCount`.
 *
 * Either way the honest signal is the *response*: `cache_read_input_tokens` here, `cached_tokens` on
 * the OpenAI path. Both are parsed into `TokenUsage.cachedInputTokens`, which is what `estimateCost`
 * reprices and what the `llm_usage` table stores — so whether caching is working is a query rather
 * than an assumption.
 */
export function toSystemBlocks(
  system: string | SystemBlock[] | undefined,
  breakpointBudget = MAX_CACHE_BREAKPOINTS,
): string | { type: "text"; text: string; cache_control?: CacheControl }[] | undefined {
  // Empty blocks are already dropped here — the API rejects an empty text block outright, so one
  // absent section would be a 400 rather than a slightly shorter prompt.
  const blocks = systemBlocks(system);
  if (blocks.length === 0) return undefined;
  if (blocks.length === 1 && !blocks[0]!.cache) return blocks[0]!.text;

  let spent = 0;
  return blocks.map((block) => ({
    type: "text" as const,
    text: block.text,
    ...(block.cache && spent++ < breakpointBudget ? { cache_control: EPHEMERAL } : {}),
  }));
}

/**
 * Put a cache breakpoint at the very end of the conversation.
 *
 * The system prompt is the part that is easy to think about, and it is not the part that costs the
 * most. It is a few thousand tokens and it stops growing; the conversation grows all turn, and every
 * tool iteration re-sends the whole of it. A turn that runs twenty iterations pays for the same
 * history twenty times, and that is the quadratic term in the bill.
 *
 * So the marker goes on the last content block of the last message and moves forward each request.
 * Request N writes an entry covering everything through its own tail; request N+1 reads that entry
 * and writes only what the turn added since — one tool call and its result. That is the whole
 * mechanism: reads accrue as the conversation grows, and a marker that moved is not an invalidator,
 * because the blocks it used to sit on are still cache hits.
 *
 * Three things this deliberately does not do:
 *
 *   - **No size threshold.** A prompt below the model's minimum cacheable length (512-4096 tokens,
 *     model-dependent) simply does not cache: no error, no write, no charge. A threshold here would
 *     be a second, wronger copy of a number only the API knows.
 *   - **No skipping short conversations.** The write is billed on the delta past the highest cache
 *     hit, so on the first request of a fresh chat it covers a handful of tokens.
 *   - **No second, older breakpoint.** Reads land wherever a previous request wrote one, and the
 *     previous request's marker is two positions back — well inside the API's 20-position lookback,
 *     since a run of consecutive tool_use blocks and a run of tool_result blocks each count as one.
 *
 * Mutates, because it is called on an array `toWireMessages` just built and nobody else has seen.
 */
function markConversationBreakpoint(messages: WireMessage[]): void {
  const lastBlock = messages.at(-1)?.content.at(-1);
  if (lastBlock) lastBlock.cache_control = EPHEMERAL;
}

/**
 * `ChatParams.tail`, after the conversation's breakpoint: on the last message when that is the user's turn — a tool's
 * results are — and as a turn of its own after an assistant's. Never marked: what follows the breakpoint is what the
 * next request does not send again.
 */
function appendTail(messages: WireMessage[], tail: string | undefined): void {
  if (!tail) return;
  const last = messages.at(-1);
  if (last?.role === "user") last.content.push({ type: "text", text: tail });
  else messages.push({ role: "user", content: [{ type: "text", text: tail }] });
}

/**
 * Our content into Anthropic's blocks.
 *
 * An empty string produces nothing rather than an empty text block: a message with no content at
 * all is rejected by the API, and the caller drops it — which is only correct if "nothing" is what
 * comes back for "".
 *
 * `image_ref` throws for the reason the OpenAI client throws: reaching a serializer means the
 * resolution step was skipped, and sending a filesystem path to a model produces a confident answer
 * about a path.
 */
function toContentBlocks(content: MessageContent): ContentBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text) blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: part.mimeType, data: part.data },
      });
      continue;
    }
    /**
     * The Messages API has no audio block, so there is nothing to translate an audio part *into*.
     *
     * Reaching here means the engine's hearing check was skipped: an `anthropic` profile is answered
     * "cannot hear" before a ref is ever built. Dropping the part instead would be the failure this
     * whole path exists to prevent — a fluent reply about a voice note the model never received.
     */
    if (part.type === "audio" || part.type === "audio_ref") {
      throw new LLMError(
        "an audio part reached the Anthropic serializer: this wire format cannot carry audio, and the " +
          "hearing check that should have kept it out was skipped",
      );
    }
    throw new LLMError(
      "an unresolved image_ref reached the wire serializer: the turn was sent without resolving " +
        "attachments to bytes first",
    );
  }
  return blocks;
}

/**
 * Whether a turn is nothing but tool results.
 *
 * A function rather than an inline `.every`, which narrows the array to `tool_result[]` and then
 * refuses the text and image blocks that are the whole point of appending to it.
 */
function onlyToolResults(blocks: readonly ContentBlock[]): boolean {
  return blocks.length > 0 && blocks.every((block) => block.type === "tool_result");
}

/**
 * The system prompt with the conversation's `system` messages after it — the Messages API has no system role, and
 * `toWireMessages` leaves them out on the promise that they are here.
 *
 * They were not: an instruction sent as a `system` message — the reflection pass's triage, a compaction's — reached the
 * model as nothing at all, and it answered the transcript beneath it in prose. Live, from the morning the agents moved
 * to an Anthropic profile (2026-10-22): six triages in a day "did not answer with JSON", none in the five days before.
 */
function withSystemMessages(system: string | SystemBlock[] | undefined, messages: readonly ChatMessage[]): string | SystemBlock[] | undefined {
  const said = messages.filter((message) => message.role === "system").map((message) => messageText(message.content)).filter((text) => text.length > 0);
  if (said.length === 0) return system;
  return [...systemBlocks(system), ...said.map((text) => ({ text }))];
}

/**
 * Convert our flat message list into Anthropic's block form.
 *
 * The subtle part: a tool result is a block in a **user** message, and several results
 * from one assistant turn have to be merged into a single user message. Emitting one
 * user message per result is rejected with "unexpected role" — which is why this is a
 * loop with a merge and not a `.map()`.
 */
export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue; // hoisted to the top-level `system` field

    if (message.role === "tool") {
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        // Tool results are text by construction; a tool has no way to return a picture.
        content: messageText(message.content),
      };
      const last = out.at(-1);
      if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    const content: ContentBlock[] = [];
    content.push(...toContentBlocks(message.content));
    for (const call of message.toolCalls ?? []) {
      content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
    }
    // A message with no content at all is rejected; drop it rather than send a stub.
    if (content.length === 0) continue;

    const role = message.role === "assistant" ? "assistant" : "user";

    /**
     * A user message that lands straight after a run of tool results joins that run.
     *
     * This is how a tool hands back a picture. A tool result is text on the wire, so the executor
     * puts the image in a `user` message immediately after the `tool` messages of the same batch —
     * which maps here onto a second user turn directly behind the one holding the results, and
     * consecutive same-role turns are not a shape this API accepts.
     *
     * Merging is not a workaround for that; it is the documented form. A single user turn may carry
     * its `tool_result` blocks and then ordinary text and image blocks, and it means the picture
     * arrives attached to the call that opened it rather than as a turn of its own.
     *
     * Narrow on purpose: only a user message that actually *carries a picture*, and only into a run
     * made entirely of tool results. A person's text turn between two results is a different thing —
     * it stays a turn of its own, which is what `toWireMessages` already promised and what a test has
     * pinned since before any of this. Role alone cannot tell the two apart; carrying an image can.
     */
    const previous = out.at(-1);
    if (
      role === "user" &&
      content.some((block) => block.type === "image") &&
      previous?.role === "user" &&
      onlyToolResults(previous.content)
    ) {
      previous.content.push(...content);
      continue;
    }

    out.push({ role, content });
  }

  return out;
}

function toWireTool(tool: ToolDefinition) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function mapStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "max_tokens";
  return "stop";
}

/**
 * The stop reason as the record keeps it (`TokenUsage.stopReason`): the API's own word, normalised — `max_tokens`
 * whatever the reply carried. `refusal`, `pause_turn`, or nothing at all, is no reason rather than a guessed one.
 */
function reportedStop(reason: string | undefined): StopReason | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_calls";
    default:
      return undefined;
  }
}
