/**
 * Every model call recorded the one way: what the provider reported, with what the call was for (`llm_usage`).
 *
 * Metering was opt-in at each call site — seven hand-written `record` calls, each spreading the same counts — and the
 * features that wrote none never reached `llm_usage`: compaction and reflection, both on by default, an image read,
 * a clip transcribed. Both daily caps, the dashboard's spend and `nouride turns show` missed them. A call site now
 * asks for a meter — or for its provider wrapped in one — and what goes into the row is decided here.
 *
 * The executor meters its own calls, retries and all (`executor/provider-caller.ts`); a runner hands it a meter.
 */

import type { LLMProvider, TokenUsage, UsagePurpose } from "@nouride/shared";
import { reportedCounts, type UsagePort } from "./usage.store.ts";

/** Who a call is charged to, and what it was for. */
export interface MeterFor {
  agentId: string;
  /** The provider profile the call went through: what the price, and the billing, are looked up by. */
  provider: string;
  purpose: UsagePurpose;
  sessionId?: string;
  /** The turn the call was made for, or set off by — a compaction after its reply, a reflection on it. */
  turnId?: string;
  /** A call billed by time — a clip transcribed — and how long the clip was. */
  durationMs?: number;
}

/**
 * One call, as the provider reported it, and the model that answered. `purpose` stands in for the meter's own when
 * one caller makes calls of two kinds: a turn's executor compacts as well as answers.
 */
export type Meter = (usage: TokenUsage, model: string, purpose?: UsagePurpose, provider?: string) => void;

/** `provider`, given, is the profile that answered — a fallback's, not the one the meter was made for. */
export function meter(usage: Pick<UsagePort, "record"> | undefined, to: MeterFor): Meter {
  return (counts, model, purpose, provider) =>
    usage?.record({
      ...to,
      ...(provider ? { provider } : {}),
      ...(purpose ? { purpose } : {}),
      model,
      inputTokens: counts.inputTokens,
      outputTokens: counts.outputTokens,
      ...reportedCounts(counts),
      // Not one of the counts the event stream carries: its `basis` says it (`UsageStore.record`).
      ...(counts.cli ? { cli: true } : {}),
    });
}

/**
 * `provider`, each call it makes reported to `record` once it is answered: a chat's usage, a stream's closing count,
 * an embedding's input. Recorded before the caller looks at the answer — a summary that came back empty was still
 * paid for.
 */
export function metered(provider: LLMProvider, record: Meter): LLMProvider {
  const embed = provider.embed?.bind(provider);
  return {
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    async chat(params) {
      const response = await provider.chat(params);
      record(response.usage, response.model || params.model);
      return response;
    },
    async *stream(params) {
      for await (const chunk of provider.stream(params)) {
        if (chunk.type === "usage") record(chunk.usage, params.model);
        yield chunk;
      }
    },
    ...(embed
      ? {
          async embed(params) {
            const response = await embed(params);
            record({ inputTokens: response.inputTokens, outputTokens: 0, ...(response.estimated ? { estimated: true } : {}) }, params.model);
            return response;
          },
        }
      : {}),
  };
}
