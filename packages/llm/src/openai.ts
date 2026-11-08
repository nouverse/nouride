const ARGUMENT_ENCODER = new TextEncoder();

/** Bytes, not characters: a file with an emoji in it is bigger than its `length` says. */
function byteLength(text: string): number {
  return text === "" ? 0 : ARGUMENT_ENCODER.encode(text).length;
}

/**
 * OpenAI-compatible provider — TD-004.
 *
 * Covers GPT, OpenRouter, a Nougate deployment, llama.cpp, anything speaking
 * `/chat/completions`. Raw fetch, no SDK (TD-006): the request shape is fifty lines
 * of types and we get to own retry, timeouts and error handling instead of inheriting
 * an SDK's opinions.
 */

import {
  LLMError,
  messageText,
  type AudioFormat,
  type ChatMessage,
  type ChatParams,
  type ChatResponse,
  type EmbedParams,
  type EmbedResponse,
  type MessageContent,
  type LLMProvider,
  type StopReason,
  type StreamChunk,
  type TokenUsage,
  type ToolCall,
  type ToolDefinition,
  eventJson,
  SSE_DONE,
} from "@nouride/shared";
import { collectStream, isEventStream } from "./collect.ts";
import { EffortGuard } from "./effort.ts";
import { toolArguments } from "./tool-arguments.ts";
import { cutOff, parsedBody, postJson, reportedFailure, requireBody, streamEvents, streamIdleTimeoutMs, unreadable, withCallStats, type HttpDeps } from "./http.ts";
import { flattenSystem } from "./system.ts";
import { estimateTokens, fillMissingUsage } from "./tokens.ts";

export interface OpenAIProviderOptions {
  baseUrl: string;
  apiKey: string;
  /** Extra headers — e.g. OpenRouter's HTTP-Referer, a Nougate gateway key. */
  headers?: Record<string, string>;
  /** Send who is asking (`ChatParams.identity`); off for a server that rejects fields it does not know. */
  identify?: boolean;
  http?: HttpDeps;
}

/**
 * OpenAI's own multimodal shape: `image_url` with a `data:` URL, beside the text parts.
 *
 * Nougate forwards these to Gemini and to Anthropic unchanged, so one spelling covers every
 * provider this client talks to.
 */
type WireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  | { type: "input_audio"; input_audio: { data: string; format: AudioFormat } };

interface WireMessage {
  role: string;
  content: string | WireContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface WireResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: WireMessage["tool_calls"] };
    finish_reason?: string;
  }[];
  usage?: WireUsage;
  model?: string;
  /** A failure the server names in a 200 body — `reportedFailure`. */
  error?: unknown;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Everything the call counted. Where a gateway leaves thinking out of `completion_tokens`, it is still in here. */
  total_tokens?: number;
  /** OpenAI's automatic prompt caching reports its hits here. */
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * One `usage` object's counts, over what an earlier chunk said. Output is what the call produced, thinking included:
 * OpenAI counts reasoning inside `completion_tokens`, but Nougate copies Gemini's `candidatesTokenCount` there — the
 * answer without the thinking — while its `total_tokens` is Gemini's `totalTokenCount`, thinking and all. So the
 * larger of the two readings is the output, which on OpenAI's own wire is the same number twice.
 */
function countsOf(usage: WireUsage, before: { inputTokens: number; outputTokens: number }): TokenUsage {
  const inputTokens = usage.prompt_tokens ?? before.inputTokens;
  const completion = usage.completion_tokens ?? before.outputTokens;
  const beyondPrompt = typeof usage.total_tokens === "number" && typeof usage.prompt_tokens === "number" ? usage.total_tokens - usage.prompt_tokens : 0;
  return {
    inputTokens,
    outputTokens: Math.max(completion, beyondPrompt),
    ...(typeof usage.prompt_tokens_details?.cached_tokens === "number" ? { cachedInputTokens: usage.prompt_tokens_details.cached_tokens } : {}),
  };
}

interface WireStreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      /**
       * Nougate's field for the model's reasoning. Not in the OpenAI specification, which is why it is
       * optional and why nothing downstream requires it — a provider that omits it is normal.
       */
      reasoning_content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: WireUsage;
  /** A failure named part-way through the stream (`reportedFailure`): OpenAI's, OpenRouter's and LiteLLM's shape. */
  error?: unknown;
}

export class OpenAIProvider implements LLMProvider {
  readonly kind = "openai" as const;
  readonly baseUrl: string;
  private readonly effort = new EffortGuard();

  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async embed(params: EmbedParams): Promise<EmbedResponse> {
    if (params.input.length === 0) return { vectors: [], inputTokens: 0 };
    const res = await postJson(
      `${this.baseUrl}/embeddings`,
      { authorization: `Bearer ${this.options.apiKey}`, ...this.options.headers },
      {
        model: params.model,
        input: params.input,
        encoding_format: "float",
        ...(params.dimensions ? { dimensions: params.dimensions } : {}),
      },
      params.signal,
      this.options.http,
    );
    const body = (await res.json()) as { data?: { index?: number; embedding?: number[] }[]; usage?: { prompt_tokens?: number } };
    const rows = body.data ?? [];
    // By `index`, not by position: the API returns them in order, and a compatible server that does
    // not would pair every fact with somebody else's vector — silently, and forever.
    // Filled, not `new Array(n)`: a missing vector must be a visible hole, and `.some` skips the
    // holes of a sparse array — which is how a short answer first passed this check.
    const vectors: (number[] | undefined)[] = Array.from({ length: params.input.length }, () => undefined);
    rows.forEach((row, position) => {
      const at = row.index ?? position;
      if (at >= 0 && at < vectors.length) vectors[at] = row.embedding;
    });
    if (vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)) {
      throw new LLMError(`provider returned ${rows.length} embeddings for ${params.input.length} inputs`);
    }
    // A server that says nothing about usage is estimated, and says so — its silence is not a free call (#4).
    const reported = body.usage?.prompt_tokens;
    return typeof reported === "number"
      ? { vectors: vectors as number[][], inputTokens: reported }
      : { vectors: vectors as number[][], inputTokens: params.input.reduce((sum, text) => sum + estimateTokens(text), 0), estimated: true };
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const startedAt = Date.now();
    const res = await this.post(params, false);
    const raw = await res.text();
    // Streamed although `stream: false` was sent — read as the stream it is (`collect.ts`).
    if (isEventStream(res, raw)) return await collectStream(this.read(new Response(raw), params, { from: res, startedAt }), params.model);
    const body = parsedBody<WireResponse>(raw, res.status);
    const choice = body.choices?.[0];
    if (!choice) throw body.error ? reportedFailure(body.error, "provider returned no choices") : unreadable("provider returned no choices", res.status);

    const toolCalls = (choice.message?.tool_calls ?? []).map(fromWireToolCall);
    const text = choice.message?.content ?? "";

    return {
      text,
      toolCalls,
      stopReason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
      ...(choice.finish_reason === LENGTH ? { cutAtLimit: true as const } : {}),
      usage: withCallStats(
        fillMissingUsage(
          countsOf(body.usage ?? {}, { inputTokens: 0, outputTokens: 0 }),
          params,
          text,
          (choice.message?.tool_calls ?? []).map((call) => ({ name: call.function?.name ?? "", arguments: call.function?.arguments ?? "" })),
        ),
        res,
        startedAt,
        reportedStop(choice.finish_reason),
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

    // Tool call arguments arrive as fragments and are assembled here, emitted only once the stream
    // says the turn is over — a half-parsed JSON argument object is not something a caller can do
    // anything with.
    //
    // A list rather than a map keyed by index: providers do not agree on what `index` means. Standard
    // OpenAI gives each parallel call its own index; Nougate gives them all `index: 0` and distinguishes
    // them by `id`. `slotByIndex` points at the call currently accumulating for each index, and a new
    // `id` rotates it.
    const assembled: { index: number; id: string; name: string; args: string }[] = [];
    const slotByIndex = new Map<number, number>();
    let stopReason: StopReason = "stop";
    /** The finish reason as the record keeps it — absent until one arrives (`TokenUsage.stopReason`). */
    let reported: StopReason | undefined;
    /** The finish reason said the output limit — see `ChatResponse.cutAtLimit`. */
    let cutAtLimit = false;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let accumulatedText = "";
    /**
     * Bytes of tool-call arguments seen so far, so a long argument stream can report progress.
     *
     * The fragments themselves are never yielded: half a JSON object is not something a caller can act on.
     * Only the size leaves this loop.
     */
    let argumentBytes = 0;

    /** Whether the stream said it was done — a finish reason, or `[DONE]`. Either will do: some servers send only one. */
    let finished = false;

    for await (const event of streamEvents(requireBody(res), streamIdleTimeoutMs(this.options.http))) {
      if (event.data === SSE_DONE) finished = true;
      const chunk = eventJson<WireStreamChunk>(event);
      if (!chunk) continue;

      // Before anything else in the chunk: OpenRouter sends its error beside an empty delta and `finish_reason: "error"`.
      if (chunk.error) throw reportedFailure(chunk.error, "the provider's stream reported a failure");
      if (chunk.usage) usage = countsOf(chunk.usage, usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta?.content;
      if (delta) {
        accumulatedText += delta;
        yield { type: "text", delta };
      }

      // Nougate sends the model's reasoning on a second field alongside `content`, confirmed against the
      // real endpoint. Never appended to `accumulatedText`: it is not part of the answer, and putting it
      // there would send the model's private working back to it as its own previous message.
      const reasoning = choice.delta?.reasoning_content;
      if (reasoning) yield { type: "reasoning", delta: reasoning };

      const argumentBytesBefore = argumentBytes;

      for (const call of choice.delta?.tool_calls ?? []) {
        // Keyed by index, but a **different `id` at the same index starts a new call**.
        //
        // Standard OpenAI streams one call per index and sends `id` only on the first fragment, so
        // keying on index alone works there. Nougate (Vertex behind it) sends parallel calls **all at
        // `index: 0`** with a distinct `id` each — so index-only keying concatenated their argument
        // strings into one slot and produced `{"pattern":"FIXME"}{"pattern":"**/app.js"}`, which parses
        // as nothing.
        //
        // Observed against the real endpoint, and it broke every turn where the model wanted two tools
        // at once — which is most non-trivial ones. The agent then retried the same malformed call to
        // the iteration cap and reported that its tools were broken.
        const index = typeof call.index === "number" ? call.index : 0;
        const slot = slotByIndex.get(index);
        const current = slot !== undefined ? assembled[slot] : undefined;

        // Only when both ids are known and differ. A fragment with no id is a continuation, which is
        // exactly what standard OpenAI sends after the first frame.
        const startsNewCall =
          current === undefined || (Boolean(call.id) && Boolean(current.id) && call.id !== current.id);

        if (startsNewCall) {
          assembled.push({
            index,
            id: call.id ?? "",
            name: call.function?.name ?? "",
            args: call.function?.arguments ?? "",
          });
          slotByIndex.set(index, assembled.length - 1);
        } else {
          current.id = current.id || (call.id ?? "");
          current.name = current.name || (call.function?.name ?? "");
          current.args += call.function?.arguments ?? "";
          argumentBytes += byteLength(call.function?.arguments ?? "");
        }
      }

      // One event per chunk rather than per fragment — a chunk can carry several — and only when something
      // actually arrived, so a stream of empty deltas stays silent.
      if (argumentBytes > argumentBytesBefore) {
        yield { type: "progress", bytes: argumentBytes };
      }

      if (choice.finish_reason) {
        finished = true;
        stopReason = mapStopReason(choice.finish_reason, assembled.length > 0);
        reported = reportedStop(choice.finish_reason);
        cutAtLimit = choice.finish_reason === LENGTH;
      }
    }
    // A body that just stops — no finish reason, no `[DONE]` — is an answer cut off, not a finished one: read as
    // finished, half a reply went out as the whole and a half-streamed call ran with half its arguments.
    if (!finished) throw cutOff();

    // Sorted by index, **stably**, so both provider shapes come out right: standard OpenAI can send
    // index 1 before index 0 and the caller still gets them in order, while Nougate's calls — all at
    // index 0 — keep the order they arrived in. A caught regression: sorting was there for the first
    // case and dropping it broke a test that existed for exactly that reason.
    const ordered = [...assembled].sort((a, b) => a.index - b.index);

    for (const [index, call] of ordered.entries()) {
      yield {
        type: "tool_call",
        call: {
          id: call.id || `call_${index}`,
          name: call.name,
          ...toolArguments(call.args),
        },
      };
    }

    const produced = ordered.map((call) => ({ name: call.name, arguments: call.args }));
    yield { type: "usage", usage: withCallStats(fillMissingUsage(usage, params, accumulatedText, produced), call.from, call.startedAt, reported) };
    yield { type: "done", stopReason, ...(cutAtLimit ? { cutAtLimit: true as const } : {}) };
  }

  /** Through the effort guard: a model that refuses `effort` is asked again without it (`effort.ts`). */
  private async post(params: ChatParams, stream: boolean): Promise<Response> {
    return await this.effort.post(params, (asked) => this.send(asked, stream));
  }

  private async send(params: ChatParams, stream: boolean): Promise<Response> {
    const messages: WireMessage[] = [];
    // OpenAI caches matching prefixes automatically — there is no field for a breakpoint, so the
    // caller's cache hints are dropped and only their *order* matters. Joining the blocks keeps the
    // stable ones in front, which is what makes the leading bytes identical across turns and is the
    // only thing an implicit cache can act on.
    const system = flattenSystem(params.system);
    if (system) messages.push({ role: "system", content: system });
    messages.push(...params.messages.map(toWireMessage));
    // Last, so the prefix an implicit cache matches ends where it began (`ChatParams.tail`).
    if (params.tail) messages.push({ role: "user", content: params.tail });

    /**
     * Who is asking, for a profile that says `identify`. Without it every agent was one client to a gateway,
     * and two agents in one chat one session: `user` tells them apart, `x-client-id` names the agent in its
     * metrics, and `prompt_cache_key` sends a conversation's requests to the cache its prefix is already in.
     */
    const identity = this.options.identify ? params.identity : undefined;
    return await postJson(
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.options.apiKey}`, ...this.options.headers, ...(identity ? { "x-client-id": `nouride/${identity.agentId}` } : {}) },
      {
        model: params.model,
        messages,
        ...(identity ? { user: `${identity.agentId}:${identity.conversation}`, prompt_cache_key: identity.conversation } : {}),
        ...(params.tools?.length ? { tools: params.tools.map(toWireTool) } : {}),
        ...(params.tools?.length && params.toolChoice === "none" ? { tool_choice: "none" } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
        // The level as the operator wrote it: an endpoint that does not know `xhigh` says so on the first call.
        ...(params.effort ? { reasoning_effort: params.effort } : {}),
        // `false` said outright: a proxy that defaults to streaming when the field is absent — 9Router does —
        // otherwise streams to a caller that turned streaming off.
        ...(stream ? { stream: true, stream_options: { include_usage: true } } : { stream: false }),
      },
      params.signal,
      params.onRetry ? { ...this.options.http, onRetry: params.onRetry } : this.options.http,
    );
  }
}

/**
 * Our content into OpenAI's, which is a string until a picture makes it a list.
 *
 * Left as a plain string whenever it can be. A one-element `[{type:"text"}]` array is accepted by
 * OpenAI and rejected or mangled by several compatible servers, and it changes the bytes of every
 * request for no gain — which on the implicit-prefix caches these endpoints use is not free.
 *
 * `image_ref` throws rather than degrading. Reaching here means the resolution step was skipped,
 * and quietly sending a filesystem path to a model produces an answer about a path: wrong, fluent,
 * and indistinguishable from the model being bad at its job.
 */
function toWireContent(content: MessageContent): string | WireContentPart[] {
  if (typeof content === "string") return content;
  if (content.every((part) => part.type === "text")) return messageText(content);

  return content.map((part): WireContentPart => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") {
      return {
        type: "image_url",
        // `auto` rather than `high`: the model picks its own tiling, which is the cheaper default
        // and the one that does not double the token bill for a screenshot of a phone.
        image_url: { url: `data:${part.mimeType};base64,${part.data}`, detail: "auto" },
      };
    }
    // The format is passed through, `ogg` included: the engine only builds an `ogg` part for a model
    // whose gateway listed it, so choosing here would be second-guessing a decision already made.
    if (part.type === "audio") return { type: "input_audio", input_audio: { data: part.data, format: part.format } };
    throw new LLMError(
      `an unresolved ${part.type} reached the wire serializer: the turn was sent without resolving ` +
        "attachments to bytes first",
    );
  });
}

function toWireMessage(message: ChatMessage): WireMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      // Tool results are text by construction; a tool has no way to return a picture.
      content: messageText(message.content),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    };
  }

  const content = toWireContent(message.content);
  return {
    role: message.role,
    // Explicitly null, not "": an assistant turn that only requested tools has no
    // text, and some compatible servers reject an empty string alongside tool_calls.
    content: typeof content === "string" ? content || (message.toolCalls?.length ? null : "") : content,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        }
      : {}),
  };
}

function toWireTool(tool: ToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function fromWireToolCall(call: NonNullable<WireMessage["tool_calls"]>[number]): ToolCall {
  return { id: call.id, name: call.function.name, ...toolArguments(call.function.arguments) };
}

/** The finish reason of a reply that stopped at `max_tokens`. */
const LENGTH = "length";

function mapStopReason(reason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === "tool_calls" || reason === "function_call") return "tool_calls";
  if (reason === LENGTH) return "max_tokens";
  return "stop";
}

/**
 * The finish reason as the record keeps it (`TokenUsage.stopReason`): the provider's own word, normalised — `length`
 * is `max_tokens` whatever the reply carried, and `error`, a gateway saying generation failed, is kept. Anything else
 * — `content_filter`, or nothing at all — is no reason rather than a guessed one.
 */
function reportedStop(reason: string | null | undefined): StopReason | undefined {
  switch (reason) {
    case "stop":
      return "stop";
    case LENGTH:
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "error":
      return "error";
    default:
      return undefined;
  }
}
