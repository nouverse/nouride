/**
 * A temperature a model will not take, dropped for that model and remembered (`ChatParams.temperature`).
 *
 * Every request carries one: `[llm.defaults] temperature` reaches every agent, and compaction, the memory pass and
 * reflection ask at 0. Not every model takes it: the newer Claude models refuse any but their own default, and so does
 * an OpenAI model that reasons. Each answers 400, and every turn of that agent failed on a setting nobody had chosen.
 * So a 400 to a request that carried a temperature is asked once more without it; when that answers, the temperature
 * was the trouble, the model is sent none from then on, and the log says so once.
 *
 * The effort guard's twin (`effort.ts`), and kept as small: no list of models, no reading of an endpoint's error
 * wording. Nothing extra is sent unless a request with a temperature was refused, and a 400 the temperature did not
 * cause fails as it would have.
 */

import { createLogger, LLMError, type ChatParams } from "@nouride/shared";

const log = createLogger("llm.temperature");

function withoutTemperature(params: ChatParams): ChatParams {
  const { temperature: _dropped, ...rest } = params;
  return rest;
}

/** One per client — one profile — keyed by model: the same model behind another profile may take it. */
export class TemperatureGuard {
  private readonly refused = new Set<string>();

  async post(params: ChatParams, send: (params: ChatParams) => Promise<Response>): Promise<Response> {
    // Absent, not falsy: 0 is a temperature, the one compaction and the memory pass ask at.
    if (params.temperature === undefined) return await send(params);
    if (this.refused.has(params.model)) return await send(withoutTemperature(params));
    try {
      return await send(params);
    } catch (err) {
      if (!(err instanceof LLMError) || err.status !== 400) throw err;
      let answered: Response;
      try {
        answered = await send(withoutTemperature(params));
      } catch {
        // Not the temperature, then: the request fails as it would have without this guard.
        throw err;
      }
      this.refused.add(params.model);
      log.warn("this model refused the temperature; sent without it from now on", {
        model: params.model,
        temperature: params.temperature,
        error: err.message.slice(0, 200),
      });
      return answered;
    }
  }
}
