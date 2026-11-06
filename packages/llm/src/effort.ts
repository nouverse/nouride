/**
 * An effort level a model will not take, dropped for that model and remembered (`ChatParams.effort`).
 *
 * `[llm.defaults] effort` reaches every agent, and not every model takes it: an OpenAI model that does not reason, an
 * older Claude, a level its endpoint does not know. Each answers 400, and every turn of that agent would fail on a
 * setting meant to make it faster. So a 400 to a request that carried an effort is asked once more without it; when
 * that answers, the effort was the trouble, the model is sent none from then on, and the log says so once.
 *
 * Kept small on purpose. No list of models, no reading of an endpoint's error wording: the endpoint's answer is the
 * test. Nothing extra is sent unless a request with an effort was refused, and a 400 the effort did not cause fails as
 * it would have.
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

  async post(params: ChatParams, send: (params: ChatParams) => Promise<Response>): Promise<Response> {
    const asked = params.effort && this.refused.has(params.model) ? withoutEffort(params) : params;
    if (asked !== params) refusedFor(params);
    try {
      return await send(asked);
    } catch (err) {
      if (!asked.effort || !(err instanceof LLMError) || err.status !== 400) throw err;
      let answered: Response;
      try {
        answered = await send(withoutEffort(params));
      } catch {
        // Not the effort, then: the request fails as it would have without this guard.
        throw err;
      }
      this.refused.add(params.model);
      log.warn("this model refused the effort level; sent without it from now on", {
        model: params.model,
        effort: asked.effort,
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
