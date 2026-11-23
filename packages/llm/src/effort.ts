/**
 * An effort level a model will not take, dropped for that model and remembered (`ChatParams.effort`).
 *
 * `[llm.defaults] effort` reaches every agent, and not every model takes it: an OpenAI model that does not reason, an
 * older Claude, a level its endpoint does not know. Each answers 400, and every turn of that agent would fail on a
 * setting meant to make it faster. So a 400 to a request that carried an effort is asked once more without it; when
 * that answers, the effort was the trouble, the model is sent none from then on, and the log says so once.
 *
 * And a model that takes no tools while it reasons at all. Some answer 400 to a request with tools unless it says
 * outright not to reason, the level left out included, since their own default reasons: an agent there answered a plain
 * question and failed at every tool, with any effort and with none. Where the wire has a word for "do not reason"
 * (`EffortGuard`'s `none`), a request with tools refused that way is asked once more with it; when that answers, that
 * model's requests with tools say it from then on, and the log says so once. Its requests without tools keep the
 * effort they asked for.
 *
 * Kept small on purpose. No list of models, no reading of an endpoint's error wording: the endpoint's answer is the
 * test. Nothing extra is sent unless a request was refused with a 400, and one this did not cause fails as it would
 * have, with the first answer it got.
 */

import { createLogger, LLMError, type ChatParams } from "@nouride/shared";

const log = createLogger("llm.effort");

function withoutEffort(params: ChatParams): ChatParams {
  const { effort: _dropped, ...rest } = params;
  return rest;
}

/**
 * One per client — one profile — keyed by model: the same model behind another profile may take it.
 *
 * Each request sent without the effort it asked for says so to its caller (`ChatParams.onEffortRefused`), the first
 * refusal and every request after it alike: the log line is once per model, and a chat that set `/effort` is told.
 */
export class EffortGuard {
  private readonly refused = new Set<string>();
  /** Models that took a request with tools only once it said not to reason at all. */
  private readonly unreasoned = new Set<string>();

  /** `none`: this wire has a word for "do not reason", which `send` says when it is handed `"none"`. */
  constructor(private readonly wire: { none?: boolean } = {}) {}

  async post(params: ChatParams, send: (params: ChatParams, reasoning?: "none") => Promise<Response>): Promise<Response> {
    const tools = Boolean(params.tools?.length);
    if (tools && this.unreasoned.has(params.model)) {
      refusedFor(params);
      return await send(withoutEffort(params), "none");
    }
    const asked = params.effort && this.refused.has(params.model) ? withoutEffort(params) : params;
    if (asked !== params) refusedFor(params);
    try {
      return await send(asked);
    } catch (err) {
      if (!(err instanceof LLMError) || err.status !== 400) throw err;
      if (asked.effort) {
        try {
          const answered = await send(withoutEffort(params));
          this.refused.add(params.model);
          log.warn("this model refused the effort level; sent without it from now on", {
            model: params.model,
            effort: asked.effort,
            error: err.message.slice(0, 200),
          });
          refusedFor(params);
          return answered;
        } catch (again) {
          // Not the level, then: the request fails as it would have without this guard, unless it was refused once
          // more, which a model that takes no tools while it reasons does with the level left out too.
          if (!(again instanceof LLMError) || again.status !== 400) throw err;
        }
      }
      if (!this.wire.none || !tools) throw err;
      let answered: Response;
      try {
        answered = await send(withoutEffort(params), "none");
      } catch {
        // Not its reasoning either.
        throw err;
      }
      this.unreasoned.add(params.model);
      log.warn("this model takes no tools while it reasons; its requests with tools say not to reason from now on", {
        model: params.model,
        effort: params.effort ?? null,
        error: err.message.slice(0, 200),
      });
      refusedFor(params);
      return answered;
    }
  }
}

/** Tells the caller its request went without the effort it asked for. */
function refusedFor(params: ChatParams): void {
  if (params.effort) params.onEffortRefused?.({ effort: params.effort, model: params.model });
}
