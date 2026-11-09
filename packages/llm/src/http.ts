/**
 * The single HTTP call both providers make, with retry.
 *
 * Retry lives here rather than in the executor because it can only be done safely
 * before the response body is touched: once a stream has yielded a chunk to the
 * caller, replaying the request would duplicate output. So this retries the
 * *request* and hands back an untouched `Response`.
 */

import { contained, createLogger, LLMError, parseSse, SseStalledError, type LLMFailure, type RetryInfo, type SseEvent, type StopReason, type TokenUsage } from "@nouride/shared";
import { classifyFailure } from "./classify.ts";

const log = createLogger("llm.http");

export interface HttpDeps {
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable so tests do not actually wait out the backoff. Given the turn's signal, to stop waiting on it. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  /**
   * Deadline for getting *response headers* back. Not the whole generation — a long answer is
   * legitimate, a provider that accepts the connection and says nothing is not.
   */
  timeoutMs?: number;
  /**
   * Deadline between streamed chunks. A stalled stream looks identical to a slow one until this
   * fires.
   */
  streamIdleTimeoutMs?: number;
  /** Told before each wait to ask again (`ChatParams.onRetry`). Its failure is the caller's, never the request's. */
  onRetry?: (info: RetryInfo) => void;
}

/**
 * Six attempts, waiting 1, 2, 4, 8 and 16 seconds between them: half a minute for a provider to come back.
 *
 * Was three in a second and a half, which suited a chat reply and not a turn that makes two hundred calls
 * over an hour: one rate limit or one gateway restart anywhere in it ended the whole turn. A wait the
 * provider names (`Retry-After`) is honoured when it is longer, up to `MAX_RETRY_AFTER_MS`.
 */
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 1_000;

/**
 * The longest wait a provider may ask for before this gives up instead.
 *
 * A minute is a rate limit easing; an hour is a quota that ran out, and a turn holding its chat for it
 * helps nobody — it fails now, keeps its work, and is taken up again later (`pipeline/provider-resume.ts`).
 */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * All the waiting one request may do, together. A provider answering every attempt with a minute's
 * `Retry-After` would otherwise hold a turn for five; past this the turn fails, keeps its work, and is
 * tried again a few minutes on (`pipeline/provider-resume.ts`) without holding its chat meanwhile.
 */
const MAX_TOTAL_WAIT_MS = 90_000;

/**
 * At most two attempts end by timing out. Each can take `DEFAULT_TIMEOUT_MS`, so six of them would hold a
 * turn for twelve minutes on a provider that is not answering at all.
 */
const MAX_TIMEOUTS = 2;

/**
 * Timeouts exist because their absence is unrecoverable, not because the numbers are precious.
 *
 * A turn with no deadline hangs the whole chat: the queue is sequential per conversation, so one
 * stalled request blocks every later message behind it and `idle()` never resolves. Observed live
 * — a daemon sat for thirteen minutes on one request and only stopped on SIGTERM.
 */
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_MS = 90_000;

/**
 * A provider that did not answer — not reached, silent past the deadline, its stream cut off — classified as the
 * passing failure it is. Unclassified, it was the one failure `[llm] fallbacks` never stood in for: a stopped endpoint
 * ended the turn with another provider listed to answer it.
 */
function noAnswer(operatorHint: string): LLMFailure {
  return { class: "transient", action: "retry", alertOperator: false, operatorHint };
}

function requestTimeoutMs(deps: HttpDeps = {}): number {
  return deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

export function streamIdleTimeoutMs(deps: HttpDeps = {}): number {
  return deps.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_MS;
}

/** A wait that ends early when `signal` aborts — so a turn stopped during a backoff stops at once. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // The timer and the abort listener are one contained function, so the listener taken off is the one put on.
    const finish = contained(log, "a backoff's wait could not end", done);
    const timer = setTimeout(finish, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * How long a provider asked to be left alone: `retry-after-ms`, or `retry-after` in seconds or as a date.
 * Zero when it said nothing usable — the backoff decides then.
 */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const value = headers.get("retry-after")?.trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

/** How many attempts each successful response took — read back by `withCallStats`; weak, so nothing outlives its response. */
const ATTEMPTS = new WeakMap<Response, number>();

/**
 * The call's own numbers on the usage it reports: the attempts `postJson` made for `res`, and the time since
 * `startedAt` — the whole call as the turn waited on it, retries and their waits included — and why the provider said
 * it ended (`TokenUsage.stopReason`), when it said.
 */
export function withCallStats(usage: TokenUsage, res: Response, startedAt: number, stopReason?: StopReason): TokenUsage {
  const upstream = servedBy(res.headers);
  return {
    ...usage,
    attempts: ATTEMPTS.get(res) ?? 1,
    latencyMs: Math.max(0, Date.now() - startedAt),
    ...(upstream ? { upstream } : {}),
    ...(stopReason ? { stopReason } : {}),
  };
}

/** What a gateway in between says answered the call — `x-nougate-provider`, `-model`, `-attempts` — or nothing. */
export function servedBy(headers: Headers): TokenUsage["upstream"] | undefined {
  const provider = headers.get("x-nougate-provider")?.trim();
  const model = headers.get("x-nougate-model")?.trim();
  const attempts = Number.parseInt(headers.get("x-nougate-attempts") ?? "", 10);
  if (!provider && !model && !(attempts > 0)) return undefined;
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(attempts > 0 ? { attempts } : {}) };
}

/**
 * What a gateway in between says about a call that failed: `servedBy`'s three, and which providers it tried, in
 * order, as `x-nougate-tried`. Nougate sends them on an error response too since 0.7.11 — when every provider threw,
 * the response used to carry none, and "every provider failed" was the failure with no attribution. Or nothing.
 */
export function failedVia(headers: Headers): LLMError["upstream"] {
  const tried = (headers.get("x-nougate-tried") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const served = servedBy(headers);
  if (!served && tried.length === 0) return undefined;
  return { ...served, ...(tried.length > 0 ? { tried } : {}) };
}

/** `(through nougate, tried alpha, beta)` — said on the error, for the turn's record and the log; never the chat. */
function throughGateway(upstream: NonNullable<LLMError["upstream"]>): string {
  if (upstream.tried?.length) return ` (through nougate, tried ${upstream.tried.join(", ")})`;
  const who = [upstream.provider, upstream.model].filter(Boolean).join(" ") || "a provider";
  const count = upstream.attempts !== undefined && upstream.attempts > 1 ? `, ${upstream.attempts} tried` : "";
  return ` (through nougate: ${who}${count})`;
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  deps: HttpDeps = {},
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? abortableSleep;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastError: unknown;
  /** What the last attempt ran into, for `onRetry`: its class, and the status when the provider answered. */
  let failure = "network";
  let status: number | undefined;
  /** What the provider asked to wait, from the last refusal — longer than the backoff, or nothing. */
  let askedMs = 0;
  let timeouts = 0;
  let waited = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const wait = Math.max(baseDelay * 2 ** (attempt - 1), askedMs);
      if (waited + wait > MAX_TOTAL_WAIT_MS) break;
      waited += wait;
      try {
        deps.onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs: wait, ...(status === undefined ? {} : { status }), failure });
      } catch {
        // Somebody watching the retry is not a reason for it not to happen.
      }
      await sleep(wait, signal);
      // Stopped while waiting: `/stop`, a shutdown, the turn's deadline. Not a failure to retry around.
      if (signal?.aborted) throw new LLMError("request aborted", undefined, { cause: lastError });
    }

    // A fresh deadline per attempt, combined with any caller signal so a cancelled turn still
    // aborts immediately. A timer cleared once the headers are in, not `AbortSignal.timeout`: fetch
    // keeps its signal on the body, so a fixed deadline cut a healthy reply still streaming when it
    // fired. Past the headers the stream answers to the idle watchdog (`streamEvents`) and the caller.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), requestTimeoutMs(deps));
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;

    let res: Response;
    let detail = "";
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: combined,
      });
      // A refusal's body is read under the same deadline: a status followed by silence must not hold the turn.
      if (!res.ok) detail = await safeText(res);
    } catch (err) {
      // A caller-initiated abort is a decision, not a failure to retry around.
      if (signal?.aborted) throw new LLMError("request aborted", undefined, { cause: err });

      if (deadline.signal.aborted) {
        // Retryable: a provider that did not answer in time may answer the next one, and this is
        // the case that used to hang forever.
        lastError = new LLMError(
          `no response within ${requestTimeoutMs(deps)}ms`,
          504,
          { cause: err, failure: noAnswer("the provider did not answer in time.") },
        );
        failure = "timeout";
        status = undefined;
        if (++timeouts >= MAX_TIMEOUTS) break;
        continue;
      }

      // A URL `fetch` cannot even parse is configuration, not a network blip: no retry fixes a base URL.
      if ((err as { code?: string } | undefined)?.code === "ERR_INVALID_URL") {
        throw new LLMError(`the provider URL is not valid: ${url}`, 400, { cause: err });
      }
      lastError = new LLMError(`network error: ${String(err)}`, 503, { cause: err, failure: noAnswer("the provider could not be reached.") });
      failure = "network";
      status = undefined;
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      ATTEMPTS.set(res, attempt + 1);
      return res;
    }

    // Classified from the body first, the status second: `model_prefix_required` and a malformed-JSON
    // complaint are both 400 and need opposite responses. The old code saw only the status, retried a
    // permanent config error three times, and reported it as the model not responding.
    const classification = classifyFailure({ status: res.status, message: detail });
    // Which providers a gateway in between tried — on the error itself, so the turn's failure says it.
    const upstream = failedVia(res.headers);
    const error = new LLMError(`${res.status} ${res.statusText}: ${detail}${upstream ? throughGateway(upstream) : ""}`, res.status, {
      failure: {
        class: classification.class,
        action: classification.action,
        alertOperator: classification.alertOperator,
        operatorHint: classification.operatorHint,
      },
      userMessage: classification.userMessage,
      ...(upstream ? { upstream } : {}),
    });
    if (!error.retryable) throw error;
    lastError = error;
    failure = classification.class;
    status = res.status;
    askedMs = retryAfterMs(res.headers);
    // A wait longer than a rate limit is a quota: fail now rather than hold the turn for it.
    if (askedMs > MAX_RETRY_AFTER_MS) break;
  }

  throw lastError instanceof LLMError
    ? lastError
    : new LLMError(`request failed after ${maxAttempts} attempts`);
}

/**
 * Error bodies are truncated: providers sometimes echo the whole request back, and a
 * log line holding a full conversation is both useless and a way to leak content
 * that was never meant to be logged.
 */
async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

export function requireBody(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new LLMError("provider returned no response body", res.status);
  return res.body;
}

/**
 * The provider's event stream, with a failure part-way through given a name.
 *
 * `postJson` above covers the *request*: a connection refused, a 503, a socket closed before the
 * headers arrive. It cannot cover what happens afterwards, because by then it has returned and the
 * body is being read somewhere else — and that is a real failure with its own shape. A socket reset
 * mid-generation surfaces from `reader.read()` as bun's bare
 * `TypeError: The socket connection was closed unexpectedly`, which is not an `LLMError`, so
 * `toUserMessage` fell through to "Something went wrong on my side." — a sentence that names nothing
 * and suggests nothing. Seen live on 2026-09-17: six steps, seventy-nine seconds, and that line.
 *
 * So the translation happens here, at the one seam both providers share. What it does *not* do is
 * retry: the stream is half-consumed, its text has already been shown in the chat by the progress
 * line, and re-issuing the request would produce a second answer to a question that has visibly had
 * one started. Saying plainly what happened and letting the person send it again is the honest
 * version, and it is what they asked for. It is classified all the same, so a stream that failed before
 * its reply began is answered by a fallback; one that failed after is not (`provider-caller.ts`).
 */
export async function* streamEvents(
  stream: ReadableStream<Uint8Array>,
  idleTimeoutMs?: number,
): AsyncIterableIterator<SseEvent> {
  try {
    yield* parseSse(stream, idleTimeoutMs);
  } catch (err) {
    // Already ours — a body that was never there, an abort. Re-labelling it would lose the reason.
    if (err instanceof LLMError) throw err;

    const text = String(err);
    // By type, not by its words: rewording the shared message turned a stall into "connection dropped".
    const stalled = err instanceof SseStalledError;
    throw new LLMError(
      stalled ? `stream stalled mid-reply: ${text}` : `stream ended mid-reply: ${text}`,
      // 503 for the same reason the request path uses it: the provider did not finish, and nothing
      // about the request was wrong.
      503,
      {
        cause: err,
        failure: noAnswer(stalled ? "the provider's stream went quiet part-way through." : "the provider's stream dropped part-way through."),
        userMessage: stalled
          ? "The model stopped sending part-way through my reply and never resumed. Send that again."
          : "My connection to the model dropped part-way through my reply. Send that again.",
      },
    );
  }
}

/** A provider's answer read as JSON — or, when it is not JSON, a failure that says so rather than a SyntaxError. */
export function parsedBody<T>(raw: string, status: number): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw unreadable(`provider answered with a body that is not JSON: ${raw.slice(0, 200)}`, status);
  }
}

/** An answer this client cannot read — classified, so a person is told something better than "something went wrong". */
export function unreadable(message: string, status: number): LLMError {
  return new LLMError(message, 502, {
    userMessage: "The model's provider sent back an answer I could not read. Send that again; if it keeps happening, the endpoint is not speaking the API it claims to.",
    ...(status ? { cause: new Error(`status ${status}`) } : {}),
  });
}

/**
 * A failure the provider named inside an answer that began as a success: an `error` in an OpenAI-shaped stream or body
 * (OpenAI, OpenRouter, LiteLLM and the OpenAI SDKs read it so), Anthropic's `error` event. Read past, it was an empty
 * answer: a person got "I did not manage to produce an answer" on every message for a failure the provider had named
 * (nouride-releases#14). Classified by its words as an error response is; a status it carries is used, else it is the
 * server's failure it reads as.
 */
export function reportedFailure(error: unknown, fallback: string): LLMError {
  const said = typeof error === "object" && error !== null ? (error as { message?: unknown; code?: unknown; type?: unknown }) : {};
  const message = typeof said.message === "string" && said.message.trim() ? said.message : typeof error === "string" && error.trim() ? error : fallback;
  const code = typeof said.code === "string" ? said.code : typeof said.type === "string" ? said.type : undefined;
  const status = typeof said.code === "number" && said.code >= 400 && said.code < 600 ? said.code : 502;
  const detail = (code && !message.includes(code) ? `${code}: ${message}` : message).slice(0, 300);
  const classification = classifyFailure({ status, message: detail });
  return new LLMError(`the provider reported a failure in its answer: ${detail}`, status, {
    failure: { class: classification.class, action: classification.action, alertOperator: classification.alertOperator, operatorHint: classification.operatorHint },
    userMessage: classification.userMessage,
  });
}

/** A stream that ended without saying it was done. */
export function cutOff(): LLMError {
  return new LLMError("stream ended without a finish: the reply was cut off", 503, {
    failure: noAnswer("the provider's stream ended before its reply did."),
    userMessage: "My connection to the model ended before its reply did. Send that again.",
  });
}
