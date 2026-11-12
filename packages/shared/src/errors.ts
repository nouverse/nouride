/**
 * Error taxonomy.
 *
 * Two audiences read our errors and they need different things: logs want the
 * cause, chat users must never see internal paths or stack traces (§17.2). Every
 * error therefore carries a `userMessage` that is safe to send to a chat, while
 * `message` stays for the log.
 */

export class NourideError extends Error {
  /**
   * A literal, in every subclass too: release builds mangle identifiers, so `new.target.name` — what this read
   * until 0.7.10 — logged a refusal as `jm: [files] …`. A subclass's own `name` field is set after this
   * constructor returns, so it wins. `error-names.test.ts` fails on an error class that names none.
   */
  override name = "NourideError";
  /** Safe to show a chat user. Never contains paths, tokens, or stack frames. */
  readonly userMessage: string;
  readonly code: string;

  constructor(code: string, message: string, userMessage?: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.userMessage = userMessage ?? "Something went wrong on my side.";
  }
}

export class ConfigError extends NourideError {
  override name = "ConfigError";
  constructor(message: string, options?: ErrorOptions) {
    super("config_error", message, "My configuration is invalid. Check the logs.", options);
  }
}

export class GatewayError extends NourideError {
  override name = "GatewayError";
  readonly gateway: string;

  constructor(gateway: string, message: string, options?: ErrorOptions) {
    super("gateway_error", `[${gateway}] ${message}`, "A chat connection failed.", options);
    this.gateway = gateway;
  }
}

/**
 * The platform refused the gateway's credentials — a wrong or revoked token, not a dropped connection.
 *
 * Its own class because the two want opposite answers: a dropped connection is worth reconnecting to, ten times
 * over ten minutes; a refused token answers the same way every time, so that is ten minutes of noise before the
 * operator hears of it. An adapter throws this from `connect()` where the platform says which it was.
 */
export class GatewayAuthError extends GatewayError {
  override name = "GatewayAuthError";
}

/**
 * How a provider failure should be handled.
 *
 * Set by `classifyFailure` in `@nouride/llm` and carried here so every consumer — the retry loop, the
 * executor, the pipeline's alerting — reads one decision instead of re-deriving it from a status code.
 * `shared` cannot import the classifier (it imports nothing), so the shape lives here and the logic
 * lives there.
 */
export interface LLMFailure {
  class: string;
  action: "retry" | "shrink" | "degrade" | "stop";
  alertOperator: boolean;
  operatorHint: string;
  /**
   * The provider's own sentence about it, where its answer held one. For the operator's alert and never the chat: a
   * gateway that has no account for a model says which one to add, and the hint alone names this install's own key.
   */
  said?: string;
}

export class LLMError extends NourideError {
  override name = "LLMError";
  readonly status?: number;
  /** Whether another attempt could succeed. Comes from the classification, not from the status. */
  readonly retryable: boolean;
  /**
   * What kind of failure this is, when it was classified.
   *
   * Absent on errors raised before a provider answered. Present ones carry an action: `retry` drives
   * backoff, `shrink` drives context truncation, `stop` prevents pointless retries.
   */
  readonly failure?: LLMFailure;
  /**
   * What a gateway in between said about the failed call — which providers it tried, in order, how many, and whose
   * failure it handed back. Nougate's `x-nougate-tried` says it on an error response since 0.7.11; absent when nothing
   * in between said. For the operator: the message carries it too, so the turn's `error` does, and never the chat.
   */
  readonly upstream?: { provider?: string; model?: string; attempts?: number; tried?: string[] };
  /**
   * The provider had begun to answer and its stream broke off — dropped, gone quiet, or ended without a finish — rather
   * than the request failing, which the client has already retried. Said by the client that read the stream; a turn
   * asks the same model once more when nothing of the reply had streamed yet (`provider-caller.ts`).
   */
  readonly streamCut?: true;

  constructor(
    message: string,
    status?: number,
    options?: ErrorOptions & { failure?: LLMFailure; userMessage?: string; upstream?: LLMError["upstream"]; streamCut?: true },
  ) {
    // Status-derived retryability is kept as the fallback for errors raised before any classification
    // — a network timeout, an aborted stream. A classified error overrides it, which is the whole
    // point: `model_prefix_required` is a 400 that used to read as "not retryable, unknown cause" and
    // now reads as a configuration error with a name.
    const retryable = options?.failure
      ? options.failure.action === "retry"
      : status === 429 || (status !== undefined && status >= 500);
    super(
      "llm_error",
      message,
      options?.userMessage ?? "The model is not responding right now.",
      options,
    );
    this.status = status;
    this.retryable = retryable;
    if (options?.failure) this.failure = options.failure;
    if (options?.upstream) this.upstream = options.upstream;
    if (options?.streamCut) this.streamCut = true;
  }
}

export class ToolError extends NourideError {
  override name = "ToolError";
  readonly tool: string;

  constructor(tool: string, message: string, userMessage?: string, options?: ErrorOptions) {
    super("tool_error", `[${tool}] ${message}`, userMessage ?? `Tool \`${tool}\` failed.`, options);
    this.tool = tool;
  }
}

function isNourideError(err: unknown): err is NourideError {
  return err instanceof NourideError;
}

/** Message safe to send to a chat user. Unknown throwables collapse to a generic line. */
export function toUserMessage(err: unknown): string {
  return isNourideError(err) ? err.userMessage : "Something went wrong on my side.";
}
