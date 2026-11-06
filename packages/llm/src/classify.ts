/**
 * What kind of failure this is, and what to do about it.
 *
 * The gap this closes was measured, not imagined. `retryable` used to be `status === 429 || status
 * >= 500` and nothing else, so every other failure looked identical. Observed live in this repo: a
 * model id missing its provider prefix came back as `model_prefix_required`, a permanent
 * configuration error — and the chat said *"The model is not responding right now."* The model was
 * answering perfectly. We retried three times and then blamed the provider.
 *
 * Hermes carries 1,842 lines of this (`agent/error_classifier.py`) and uses it to drive provider
 * failover. This is the tenth of it that covers the failures we can actually act on differently.
 *
 * **A classification that does not change behaviour is decoration.** Each class below names an
 * action, and each action is wired: `retry` drives the backoff loop, `shrink` drives context
 * truncation, `stop` prevents pointless retries, and `alert` reaches the operator with the real
 * cause instead of a generic outage message.
 */

export type FailureClass =
  /** Bad or missing credential. Retrying cannot help; the operator has to fix a secret. */
  | "auth"
  /** Out of credit, spending cap, quota exhausted. Same: an operator problem, not a transient one. */
  | "billing"
  /** 429. The one case the old code got right. */
  | "rate_limit"
  /** Provider is up but saturated. Worth waiting for. */
  | "overloaded"
  /** The request was longer than the model's window. Truncate harder and try again. */
  | "context_overflow"
  /** The request body was too big — usually an attachment or an image, not history. */
  | "payload_too_large"
  /** The model or the gateway in front of it cannot take a part we sent — audio, so far. */
  | "media_unsupported"
  /** The model id does not exist, or is missing a required prefix. A config error, phrased as one. */
  | "model_not_found"
  /** The provider refused on content grounds. Not a fault; the user needs to know. */
  | "content_policy"
  /** Malformed request. Almost always a bug in our own wire mapping, so it must be loud. */
  | "request_invalid"
  /** 5xx with nothing more specific. */
  | "transient"
  | "unknown";

export type FailureAction =
  /** Back off and try again. */
  | "retry"
  /** Reduce the request and try again — smaller context, fewer attachments. */
  | "shrink"
  /**
   * Take out what the model cannot take and try once more, telling it what was taken out.
   *
   * Not `shrink`: nothing here is too long, and dropping history would not help. The voice note stays
   * in the conversation as a line saying it could not be heard, so the answer that comes back is an
   * honest one rather than the error that would otherwise end the turn.
   */
  | "degrade"
  /** Do not retry. The same request will fail the same way. */
  | "stop";

export interface Classification {
  class: FailureClass;
  action: FailureAction;
  /**
   * Whether the operator needs to know.
   *
   * True for the classes only they can fix. A rate limit is not their problem; an expired API key
   * is, and finding out hours later from a user saying "the bot is broken" is the failure mode this
   * exists to prevent.
   */
  alertOperator: boolean;
  /** Shown in chat. Never a stack trace, never a provider's raw body (§8 invariant). */
  userMessage: string;
  /** Shown to the operator, in the log and the alert. Says what to change. */
  operatorHint: string;
}

/** Matched against the lower-cased provider message. Order matters: first hit wins. */
const PATTERNS: { class: FailureClass; patterns: RegExp[] }[] = [
  {
    // Before `auth`: a spending cap often arrives as a 403, and telling the operator to check their
    // API key when the real problem is an empty balance sends them to the wrong place.
    class: "billing",
    patterns: [
      /insufficient[_ ]quota/,
      /billing/,
      /payment required/,
      /spending limit/,
      /credit balance/,
      /out of credits/,
      /quota exceeded/,
    ],
  },
  {
    class: "auth",
    patterns: [
      /invalid[_ ]api[_ ]key/,
      /incorrect api key/,
      /unauthorized/,
      /authentication/,
      /invalid[_ ]token/,
      /permission denied/,
    ],
  },
  {
    // Before every other 400. A refused audio part is not a bad model id or a bug in our mapping — it
    // is a model that cannot hear, and the turn can still be answered without the clip.
    // `unsupported_content_part` is Nougate's own code for it; the rest are how OpenAI-compatible
    // servers phrase a format or a modality they do not take.
    class: "media_unsupported",
    patterns: [
      /unsupported[_ ]content[_ ]part/,
      /input_audio/,
      /audio.{0,30}not (supported|enabled)/,
      /does not support audio/,
      /audio.{0,20}modality/,
    ],
  },
  {
    // Before `request_invalid`: both are 400, and this one is fixable by config while that one is a
    // bug in our own mapping. Conflating them wastes the operator's time on the wrong file.
    class: "model_not_found",
    patterns: [
      /model[_ ](not[_ ]found|prefix[_ ]required|does not exist|unavailable)/,
      /unknown model/,
      /no such model/,
      /must include provider prefix/,
      /invalid model/,
      // A gateway that serves no model by that name, with a 400 rather than a 404 (Nougate, live 2026-10-25): read as a
      // request-shape bug, it skipped the agent's fallbacks and told the person the requests were built wrong.
      /no provider serves/,
    ],
  },
  {
    class: "context_overflow",
    patterns: [
      /context[_ ](length|window|overflow)/,
      /maximum context/,
      /too many tokens/,
      /prompt is too long/,
      /reduce the length of the messages/,
      /exceeds? the (maximum )?(context|token) limit/,
    ],
  },
  {
    class: "payload_too_large",
    patterns: [/payload too large/, /request entity too large/, /image.{0,20}too large/, /file too large/],
  },
  {
    class: "content_policy",
    patterns: [
      /content[_ ](policy|filter)/,
      /safety (system|filter)/,
      /flagged/,
      /refus(ed|al) to generate/,
      /prohibited content/,
    ],
  },
  {
    class: "rate_limit",
    patterns: [/rate[_ ]limit/, /too many requests/, /slow down/],
  },
  {
    class: "overloaded",
    patterns: [/overloaded/, /capacity/, /server is busy/, /temporarily unavailable/, /try again later/],
  },
  {
    class: "request_invalid",
    patterns: [/invalid[_ ]request/, /validation (error|failed)/, /missing required/, /malformed/],
  },
];

/** Classes keyed off the status alone, when the body says nothing useful. */
function classFromStatus(status: number | undefined): FailureClass {
  if (status === undefined) return "unknown";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) return "model_not_found";
  if (status === 413) return "payload_too_large";
  if (status === 429) return "rate_limit";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 500) return "transient";
  if (status === 400 || status === 422) return "request_invalid";
  return "unknown";
}

const BEHAVIOUR: Record<
  FailureClass,
  { action: FailureAction; alertOperator: boolean; userMessage: string; operatorHint: string }
> = {
  auth: {
    action: "stop",
    alertOperator: true,
    userMessage: "I cannot reach the model: my credentials are not working. The operator has been told.",
    operatorHint:
      "the provider rejected the credential. Check the secret named in [providers.*] api_key (`nouride doctor` lists which resolve).",
  },
  billing: {
    action: "stop",
    alertOperator: true,
    userMessage: "I cannot reach the model right now: there is a billing problem. The operator has been told.",
    operatorHint: "the provider reports no credit or a spending cap. Retrying will not help.",
  },
  rate_limit: {
    action: "retry",
    alertOperator: false,
    userMessage: "I am being rate limited. Give me a moment and try again.",
    operatorHint: "rate limited by the provider; backing off.",
  },
  overloaded: {
    action: "retry",
    alertOperator: false,
    userMessage: "The model is busy. Try again shortly.",
    operatorHint: "provider is saturated; backing off.",
  },
  context_overflow: {
    action: "shrink",
    alertOperator: false,
    // Said only when the shorter request failed too (`provider-caller.ts`): it said "I trimmed the oldest part and carried
    // on" to a person whose turn had just ended without an answer.
    userMessage: "That conversation is too long for the model, even with its oldest part left out. Shorten it with /compact, or start a new one with /new.",
    operatorHint:
      "the request exceeded the model's window. Retried with harder truncation; lower [llm.context] max_context_ratio if it keeps happening.",
  },
  payload_too_large: {
    action: "stop",
    alertOperator: false,
    userMessage: "That was too large for me to send to the model. Try a smaller file or less text.",
    operatorHint: "request body rejected as too large; usually an attachment or image.",
  },
  media_unsupported: {
    action: "degrade",
    // Not the operator's to hear about from here: the engine alerts once per model when it degrades,
    // with the fix. Alerting per failed request would be one message for every voice note.
    alertOperator: false,
    userMessage: "I could not send your voice note to the model, so I could not hear it. Could you type it?",
    operatorHint:
      "the model or its gateway refused an audio part. The agent answered without it; `[media]` in config.example.toml lists the options.",
  },
  model_not_found: {
    action: "stop",
    alertOperator: true,
    userMessage: "I am misconfigured: the model I was told to use does not exist. The operator has been told.",
    operatorHint:
      "the model id is wrong or missing a provider prefix. Nougate namespaces models as `provider:model-id`, e.g. `antigravity:claude-sonnet-4-6`.",
  },
  content_policy: {
    action: "stop",
    alertOperator: false,
    userMessage: "The model declined to answer that on content grounds.",
    operatorHint: "provider content policy refused the request; not a fault.",
  },
  request_invalid: {
    action: "stop",
    alertOperator: true,
    userMessage: "Something is wrong with how I am building requests. The operator has been told.",
    operatorHint:
      "the provider rejected the request shape. This is usually a bug in Nouride's wire mapping, not your config. The full body is in the log.",
  },
  transient: {
    action: "retry",
    alertOperator: false,
    userMessage: "The model is not responding right now. Try again shortly.",
    operatorHint: "provider returned a server error; backing off.",
  },
  unknown: {
    action: "stop",
    alertOperator: false,
    userMessage: "The model is not responding right now.",
    operatorHint: "unclassified provider failure; the full response is in the log.",
  },
};

/**
 * Classify a provider failure.
 *
 * The body is consulted **before** the status, because a provider's own wording is more specific than
 * its HTTP code: `model_prefix_required` and a malformed-JSON complaint are both 400, and they need
 * opposite responses.
 */
export function classifyFailure(params: {
  status?: number | undefined;
  message?: string | undefined;
}): Classification {
  const haystack = (params.message ?? "").toLowerCase();

  let matched: FailureClass | null = null;
  for (const entry of PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(haystack))) {
      matched = entry.class;
      break;
    }
  }

  const failureClass = matched ?? classFromStatus(params.status);
  return { class: failureClass, ...BEHAVIOUR[failureClass] };
}
