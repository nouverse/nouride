/**
 * A helper model that cannot answer, and the agent's own model asked instead.
 *
 * Two jobs are sent to a model the operator chose for them rather than the agent's own: a conversation's compaction
 * (`summarizer.ts` — `[llm.context] summary_model`, else `[memory] pass_model`) and the nightly memory pass
 * (`boot/memory-pass.ts`). On the box (2026-10-21) that model went away — nougate answered
 * `404 No account has access to "gemini-3.7-flash"`, then `429 … insufficient_quota` — and from then on every
 * compaction failed and so did every conversation the pass tried to file. Each said so as one `warn` in the journal.
 * A Telegram conversation was never compacted: ~180k tokens a call against a 160k limit, and the in-turn trim cleared
 * even the tool results the agent had just read.
 *
 * So a helper's call that fails because *that model* cannot answer now is asked once more, of the agent's own profile
 * and model, and the journal says so once an hour per helper. Only that kind of failure: a 5xx, a timeout or a short
 * rate limit has had its retries already (`postJson`), and is the provider being slow, not the model being gone.
 */

import { createLogger, LLMError, type ChatParams, type LLMProvider } from "@nouride/shared";

const log = createLogger("llm.helper");

/** What a helper model is asked for — named in the line that says it was not. */
type HelperJob = "compaction" | "memory pass";

/** A provider profile and a model on it. */
interface ModelRoute {
  profile: string;
  model: string;
}

/**
 * Failure classes that mean "not this model, not now" (`classifyFailure`): not served, out of credit, a credential
 * refused. Each is about the helper's profile or model, and the agent's own profile meets none of them by being asked.
 */
const GONE: ReadonlySet<string> = new Set(["model_not_found", "billing", "auth"]);
/** A provider saying in words that it does not serve the model, whatever status it chose to say it with. */
const NOT_SERVED = /unknown model|no such model|model[_ ](not[_ ]found|does not exist)|(no account|not) ha(s|ve) access/;

/**
 * Why a helper's call failed, shortened, when the failure means the model cannot answer now — a 404, 403 or 402, a 429
 * that says quota, a model the provider does not know — or null when asking again elsewhere is not the answer: a 5xx,
 * a timeout, a network error, a plain rate limit, a stop.
 */
export function helperUnavailable(err: unknown): string | null {
  if (!(err instanceof LLMError)) return null;
  const { status } = err;
  const text = err.message.toLowerCase();
  const gone =
    (err.failure !== undefined && GONE.has(err.failure.class)) ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    (status === 429 && text.includes("quota")) ||
    (status !== undefined && status >= 400 && status < 500 && NOT_SERVED.test(text));
  return gone ? shorten(err.message) : null;
}

/** One line of an error, short enough for a log line or a doctor hint. */
export function shorten(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * When each helper last said it fell back — one line an hour per helper, however many calls it answers in between. A
 * row per helper model the config names, so it cannot grow past what the config holds.
 */
const said = new Map<string, number>();
const SAY_EVERY_MS = 60 * 60_000;

/** The line a helper writes when it answers — read back by `helper-trouble.ts`, which takes it as the fallback over. */
export const HELPER_ANSWERED = "helper model answered";
/** Helpers that have said they answer since this process started, and those that fell back since they last said so. */
const answered = new Set<string>();
const fellBack = new Set<string>();

/**
 * Said the first time a helper answers in this process, and the first time after each fallback line — no more. Without
 * it a fallback was said for a day after the helper was fine again: live, a profile saved with the wrong kind for
 * nineteen seconds (2026-10-21) left the Overview saying the pass model could not answer until the next evening.
 */
function sayAnswered(helper: ModelRoute): void {
  const name = `${helper.profile}/${helper.model}`;
  if (answered.has(name) && !fellBack.has(name)) return;
  answered.add(name);
  fellBack.delete(name);
  log.info(HELPER_ANSWERED, { helper_profile: helper.profile, helper_model: helper.model });
}

function sayFellBack(helper: ModelRoute, own: ModelRoute, job: HelperJob, reason: string, now: number): void {
  const name = `${helper.profile}/${helper.model}`;
  const last = said.get(name);
  if (last !== undefined && now - last < SAY_EVERY_MS) return;
  said.set(name, now);
  fellBack.add(name);
  const ownName = `${own.profile}/${own.model}`;
  // Read back by `helper-trouble.ts` for `/health` and `nouride doctor`, by its component and these fields.
  log.warn(`helper model ${name} unavailable (${reason}), so used the agent's own model ${ownName} for ${job}`, {
    helper_profile: helper.profile,
    helper_model: helper.model,
    own: ownName,
    job,
    reason,
  });
}

/**
 * `helper`, asked again of `own` when it cannot answer (`helperUnavailable`) — once, and only when the two differ: the
 * agent's own model failing is a failure, not a reason to ask it twice. Its success is the call's success, so what
 * counts failures (compaction's breaker) sees none. A stream falls back only before its first chunk; after it, an
 * answer is half-given.
 *
 * `own.provider` is asked for only to fall back: a profile nobody else uses needs no credential until then, and one
 * that has none leaves the helper's own failure to be reported.
 */
export function orOwnModel(
  helper: ModelRoute & { provider: LLMProvider },
  own: ModelRoute & { provider: () => LLMProvider },
  job: HelperJob,
  now: () => number = Date.now,
): LLMProvider {
  if (helper.profile === own.profile && helper.model === own.model) return helper.provider;
  const instead = (err: unknown, params: ChatParams): { provider: LLMProvider; params: ChatParams } | null => {
    if (params.signal?.aborted) return null;
    const reason = helperUnavailable(err);
    if (!reason) return null;
    let provider: LLMProvider;
    try {
      provider = own.provider();
    } catch {
      return null;
    }
    sayFellBack(helper, own, job, reason, now());
    return { provider, params: { ...params, model: own.model } };
  };
  return {
    kind: helper.provider.kind,
    baseUrl: helper.provider.baseUrl,
    async chat(params) {
      try {
        const response = await helper.provider.chat(params);
        sayAnswered(helper);
        return response;
      } catch (err) {
        const fallback = instead(err, params);
        if (!fallback) throw err;
        return await fallback.provider.chat(fallback.params);
      }
    },
    async *stream(params) {
      let started = false;
      try {
        for await (const chunk of helper.provider.stream(params)) {
          started = true;
          yield chunk;
        }
        sayAnswered(helper);
      } catch (err) {
        const fallback = started ? null : instead(err, params);
        if (!fallback) throw err;
        yield* fallback.provider.stream(fallback.params);
      }
    },
  };
}
