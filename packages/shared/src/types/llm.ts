/** LLM provider contracts — §6 SPEC, TD-004, TD-006. */

export type ProviderKind = "openai" | "anthropic";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * The model sent arguments that are not one JSON object — they did not parse, or parsed as something else.
   * `arguments` is empty then, and the call is answered with what went wrong rather than run: coerced into nothing,
   * the tool said a field was missing, and the model retried the same call to the iteration cap.
   */
  argumentsError?: { raw: string; reason: string };
}

/**
 * A message is text, or a list of parts when one of them is not text.
 *
 * ## Why this stopped being a plain string
 *
 * It was one, deliberately, and the reason is still in `packages/llm/src/vision.ts`: making it a
 * union ripples through truncation, token estimation, session persistence and both wire clients.
 * The trade was that an image became *a description of an image* before it reached the model —
 * a separate call whose output is prose, injected as prose.
 *
 * That trade failed in the field on 2026-09-11. An operator sent a screenshot of an overlapping
 * mobile layout; the agent received two thousand characters of prose about it, which carried no
 * coordinates, no bounding boxes and no z-order — none of the things the question was about. Blind
 * and holding a shell, it built a computer-vision rig out of PIL crops, a Tesseract subprocess and
 * NumPy brightness sums, and hit the tool-call ceiling without answering. The description had been
 * regenerated three times on the way, each one a round trip.
 *
 * A description is not an image. Every modern conversation model can take the pixels, so it gets
 * the pixels.
 *
 * ## The three parts, and why there are three
 *
 * `text` and `image` are what a provider understands. `image_ref` is what a *database* should hold:
 * a pointer to the file on disk rather than a megabyte of base64 in the session row, resolved into
 * an `image` part for the turn that needs it and collapsed back to a line of text for the turns
 * that do not. Storing base64 in the transcript would grow the database by the size of every
 * picture anyone ever sent and re-upload each of them on every subsequent turn.
 *
 * A wire client that meets an `image_ref` throws: reaching a serializer means the resolution step
 * was skipped, and silently sending a file path to a model is the failure that looks like the model
 * being stupid.
 */
export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  mimeType: string;
  /** Base64, no data-URL prefix. Ephemeral: built for one request and never persisted. */
  data: string;
}

export interface ImageRefPart {
  type: "image_ref";
  /** The attachment index's own id, so `attachment_read` and this name the same file. */
  ref: string;
  localPath: string;
  mimeType: string;
  /** What the sender called it, for the line shown when this is not resolved. */
  filename?: string;
  /**
   * When the picture was sent — its own message's time, or the time an earlier one was posted when a reply or the room
   * carries it in. The line in front of it says when, and whether it came with the message being answered. Absent on a
   * part written before 0.7.29, which is read as its message's time.
   */
  sentAt?: number;
}

/**
 * The `ref` of a picture the agent opened with `read`, or a tool handed back, rather than one sent in the
 * conversation: `file:<absolute path>`. When a request leaves it out, the line in its place says to `read`
 * it again where an attachment's says `attachment_read`.
 */
export const FILE_IMAGE_REF = "file:";

/**
 * The encodings an audio part can travel in.
 *
 * `mp3` and `wav` are the two OpenAI's `input_audio` defines. `ogg` is not, and is sent only to a
 * model whose gateway lists it (Nougate's `input_audio_formats`) — which is what lets a Telegram voice
 * note go out as it arrived instead of through ffmpeg first.
 */
export type AudioFormat = "mp3" | "wav" | "ogg";

/**
 * Sound, for the one request that carries it. The pair of `ImagePart`, and ephemeral for the same
 * reason: base64 in a session row is every voice note re-uploaded on every later turn.
 */
export interface AudioPart {
  type: "audio";
  format: AudioFormat;
  /** Base64, no data-URL prefix. */
  data: string;
}

/**
 * A voice note or audio file as the transcript holds it: a pointer, resolved at the wire.
 *
 * Built only when the model this was sent to is known to hear — see `Hearing` in the engine's attachments module. A ref that
 * exists is therefore a promise that the bytes will be sent, which is what lets the notice tell the
 * model it is listening rather than hedging.
 */
export interface AudioRefPart {
  type: "audio_ref";
  ref: string;
  /** The file that will be sent: the original when its format is accepted, a transcode otherwise. */
  localPath: string;
  format: AudioFormat;
  durationSec?: number;
  filename?: string;
}

export type ContentPart = TextPart | ImagePart | ImageRefPart | AudioPart | AudioRefPart;

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: MessageRole;
  /**
   * A string, or parts when the message carries something that is not text.
   *
   * Only user messages ever hold parts today — images arrive from people. Assistant and tool
   * messages stay strings, which is why the change did not ripple as far as it could have.
   */
  content: MessageContent;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages — which call this answers. */
  toolCallId?: string;
  /** Wall-clock time the message entered the conversation. */
  timestamp?: number;
}

/**
 * The text of a message, whatever shape it is in.
 *
 * Every place that logs, summarises, searches or displays a message wants this and does not care
 * about the pictures. One function so none of them has to narrow the union by hand — and so the
 * answer for a parts message is the same everywhere, which it would not be if each site joined the
 * text parts with its own separator.
 */
export function messageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

/**
 * One span of the system prompt, and whether a prompt-cache breakpoint belongs at its end.
 *
 * The caller splits the prompt where its *stability* changes, not where its subject does: what is
 * loaded from the agent's files, what depends on the toolset, and what changes every request. A
 * provider that cannot express breakpoints joins the blocks back into one string and loses nothing —
 * the concatenation is byte-identical to the single-string form, which is what makes the hint
 * optional rather than a second wire format.
 */
export interface SystemBlock {
  text: string;
  /**
   * Ask for a cache breakpoint at the end of this block.
   *
   * Never set it on the last block unless that block is genuinely stable: a breakpoint after content
   * that changes every request writes an entry nothing ever reads, which is a surcharge rather than a
   * saving.
   */
  cache?: boolean;
}

/**
 * How long a model thinks before it answers, where the model is one that thinks: `output_config.effort` on an Anthropic
 * endpoint, `reasoning_effort` on an OpenAI-compatible one.
 *
 * Unset, the provider decides — and on Claude Sonnet 5.5 its default thinks for twenty seconds before a ten-sentence
 * answer: measured through nougate (2026-10-21), 22 s to the first word and 3,557 output tokens at the default, 2 s and
 * 565 at `medium`. In a dashboard that streams the answer, those twenty seconds read as a stall.
 */
export const LLM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type LlmEffort = (typeof LLM_EFFORTS)[number];

export function isLlmEffort(value: unknown): value is LlmEffort {
  return typeof value === "string" && (LLM_EFFORTS as readonly string[]).includes(value);
}

export interface ChatParams {
  model: string;
  messages: ChatMessage[];
  /**
   * The system prompt, as one string or as ordered blocks carrying cache hints.
   *
   * Both forms mean the same prompt — `SystemBlock[]` joined with a blank line *is* the string form —
   * so a caller that does not care about caching passes a string and every provider still works.
   */
  system?: string | SystemBlock[];
  /**
   * Who is asking, sent only to a profile that says `identify`: the agent, and the conversation it is in.
   * `conversation` is an opaque id made by the caller: never a chat's id, a person's name or a number.
   */
  identity?: { agentId: string; conversation: string };
  /**
   * Said after everything else, for this request only: the conversation's work notes (0.7.26), read fresh at every step.
   *
   * Not a message, because a message is stored and cached. Stored, eight kilobytes of notes would be copied into the
   * history at every turn; cached, the conversation's breakpoint would sit on them, and the next step — where they have
   * moved past a tool result — would miss the whole turn so far. So each client puts it at the very end, after the
   * conversation's own cache breakpoint: the prefix before it is read back next time, and it costs its own tokens only.
   */
  tail?: string;
  tools?: ToolDefinition[];
  /**
   * `none`: the tools are offered and may not be called — the model answers in words. For a turn's last word: the tools
   * stay in the request, and with them the cached prefix they open, where leaving them out started the cache over at
   * its first byte (a 90k-token conversation written again, live 2026-10-22).
   */
  toolChoice?: "none";
  temperature?: number;
  maxTokens?: number;
  /** How long a thinking model thinks (`LLM_EFFORTS`). Absent, the provider's own default. */
  effort?: LlmEffort;
  stream?: boolean;
  signal?: AbortSignal;
  /** Called before each wait to ask the provider again — so a turn waiting thirty seconds on one can say why. */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Called when this request goes out without its `effort` because the model refused it: refused now, or on an earlier
   * request (`EffortGuard`, 0.8.17). A chat that asked for a level with `/effort` is told, where only the log was. A
   * model that takes the field and ignores it calls nothing: it cannot be told apart from one that heeds it.
   */
  onEffortRefused?: (refusal: { effort: LlmEffort; model: string }) => void;
}

/** A model call about to be asked again (`ChatParams.onRetry`), said before the wait. */
export interface RetryInfo {
  /** The attempt about to be made, from 2. */
  attempt: number;
  maxAttempts: number;
  /** How long until it is made. */
  delayMs: number;
  /** The last answer's HTTP status, when there was an answer. */
  status?: number;
  /** What went wrong, as a class — `rate_limit`, `overloaded`, `timeout`, `network` — never a body or a URL. */
  failure: string;
}

export interface TokenUsage {
  /**
   * The whole prompt, cached parts included.
   *
   * **Normalised by each provider, because the two wire formats disagree.** OpenAI's `prompt_tokens`
   * already counts a cache hit inside itself, so `cached_tokens` is a subset. Anthropic's
   * `input_tokens` is the *uncached remainder only* — the cache counters sit beside it, and the
   * prompt is the sum of all three. A field that meant one thing on one path and another on the
   * other would have to be disambiguated by every reader, which is a provider conditional in shared
   * code by another name (§2 of the contributing invariants). So each client converts to this
   * meaning on the way in, and nothing downstream asks which vendor it came from.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * True when the provider did not report usage and these are our own estimate.
   *
   * A proxy is free to omit the field — Nougate does on its OpenAI-compatible path — and
   * treating that silence as zero would make the daily cost cap fail open. Anything
   * charging against a budget should know which of the two it is looking at.
   */
  estimated?: boolean;
  /**
   * Of `inputTokens`, how many the provider served from its prompt cache — charged at the model's cached
   * price, a tenth of input for most of them (`cost.ts` has each one's).
   *
   * A *subset* of `inputTokens`, on every path, by the normalisation described above.
   * `estimateCost` is the one place that reprices them.
   *
   * Absent means the provider said nothing, which is not the same as zero — Gemini through a gateway
   * that never maps `cachedContentTokenCount` reports no cache hits whether or not it had any. A cost
   * cap that read silence as zero would charge every cached token at full price and refuse turns the
   * budget could afford (§4 of the contributing invariants, the other direction).
   */
  cachedInputTokens?: number;
  /**
   * Of `inputTokens`, how many were *written* to the cache this request — charged at 1.25x.
   *
   * The other half of the cache accounting, and the half that says whether a breakpoint is in the
   * right place. A healthy loop writes only what the last turn added while reading everything before
   * it; a breakpoint sitting after per-request content instead writes on every request and reads
   * nothing, which costs 25% more than not caching at all. The two counts are indistinguishable
   * without this field, so a misplaced breakpoint reads as "caching is on" for as long as nobody
   * checks the bill.
   *
   * Anthropic-only today: OpenAI's implicit caching writes nothing it charges for and reports no
   * equivalent. Absent means the provider said nothing, as above.
   */
  cacheCreationInputTokens?: number;
  /**
   * Not tokens: what the call itself took, carried with its usage because usage is the one thing every caller
   * already records. HTTP attempts — 1 unless the provider refused or timed out and was asked again.
   */
  attempts?: number;
  /** From the request leaving to this usage being read, retries and their waits included. */
  latencyMs?: number;
  /**
   * Who answered, when a gateway in between says so: Nougate sends `x-nougate-provider`, `-model` and
   * `-attempts` on every response. The model asked for and the one that answered can differ — an alias, a
   * fallback — and only the gateway knows which provider it went to, and how many it tried. Absent when nothing
   * in between said.
   */
  upstream?: { provider?: string; model?: string; attempts?: number };
  /**
   * Not tokens either: why the provider says the call ended, its own word normalised — `stop` (it finished),
   * `tool_calls` (it asked for tools), `max_tokens` (cut at the output limit, **even when the cut reply carried tool
   * calls**, which `ChatResponse.stopReason` calls `tool_calls`), `error` (the provider said generation failed).
   * Carried with the usage because usage is what every caller records (`llm_usage.stop_reason`).
   *
   * Absent when the provider said nothing — a stream that ended on `[DONE]` alone — or said something none of these
   * is (`content_filter`, `refusal`): never a guess. "Cut at the output limit" is read here, not inferred from an
   * output count that stopped at 8192 (2026-10-20).
   */
  stopReason?: StopReason;
  /**
   * Reported by a coding CLI over ACP (0.8.8): spent on the CLI's own account, which no provider profile of this daemon
   * pays. Recorded with the conversation's usage, and outside both daily caps (`llm_usage.basis = 'cli'`).
   */
  cli?: true;
}

export type StopReason = "stop" | "tool_calls" | "max_tokens" | "error";

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /**
   * The reply stopped at the output limit (`max_tokens`). Set even when it carried tool calls, whose stop reason says
   * `tool_calls`: the call being written when the limit hit arrives with half its arguments, and the model has to be
   * told why — told only "not valid JSON", it sent the same oversized call again (2026-10-21).
   */
  cutAtLimit?: true;
  usage: TokenUsage;
  model: string;
}

export type StreamChunk =
  | { type: "text"; delta: string }
  /**
   * The model's own account of what it is working out, when the provider sends one.
   *
   * Separate from `text` because it is not part of the answer: it never enters the conversation history
   * and is never shown to the person the agent is talking to. It exists so a *watching operator* can see
   * that a 30-second pause is work rather than a hang.
   *
   * Absent from most providers, and that is fine — a consumer treats it as optional and shows a plain
   * elapsed timer instead. Inventing a plausible narration would be worse than showing none.
   */
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  /**
   * Bytes of a tool call's arguments as they stream, before the call is complete.
   *
   * Only a size, never the fragment. A partly-written JSON argument object is not something a consumer can
   * act on — the clients assemble it and emit `tool_call` once — but the *fact* that it is still arriving is
   * exactly what a watching operator needs. Measured on a real turn: a 5KB file streamed as arguments took
   * eighty seconds during which no event was emitted at all.
   */
  | { type: "progress"; bytes: number }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; stopReason: StopReason; cutAtLimit?: true };

/**
 * Two implementations, both raw `fetch` (TD-006): one for anything speaking the
 * OpenAI chat-completions shape, one for Anthropic's Messages API. Pointing
 * `baseUrl` at a Nougate deployment covers every other provider without Nouride
 * knowing they exist.
 */
export interface LLMProvider {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  /**
   * How long the endpoint keeps a cached prompt prefix after its last request, where its profile says
   * (`ProviderProfile.cacheMinutes`). Absent: not known, and whoever asks takes it for still warm.
   */
  readonly cacheLifetimeMs?: number;

  chat(params: ChatParams): Promise<ChatResponse>;
  stream(params: ChatParams): AsyncIterable<StreamChunk>;
  /**
   * Vectors for texts — OpenAI's `POST /embeddings`, which OpenAI, Gemini, Mistral, Jina and Ollama
   * all answer. Absent where the API has none (Anthropic), so a caller asks rather than assumes.
   */
  embed?(params: EmbedParams): Promise<EmbedResponse>;
}

export interface EmbedParams {
  model: string;
  input: string[];
  /** Asked for where the model can shorten its output (Matryoshka); ignored by the ones that cannot. */
  dimensions?: number;
  signal?: AbortSignal;
}

export interface EmbedResponse {
  /** One per input, in input order. */
  vectors: number[][];
  inputTokens: number;
  /** True when the provider reported no usage and `inputTokens` is this daemon's estimate of the input. */
  estimated?: boolean;
}
