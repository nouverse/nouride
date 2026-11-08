/**
 * The model tiers (`routes/tiers.ts`): the install's small and high models, the tier or model each helper key names, and
 * one agent's own pair.
 */

import type { ModelTier } from "@nouride/shared";

export type { ModelTier };

/** Each helper key a tier may be named in, as the daemon's view names it. */
export type TierHelper = "summaryModel" | "passModel" | "steerReplyModel" | "imageModel" | "learningModel";

export interface ModelTiersView {
  /** `[llm.defaults]`: the provider the install's tiers are on, and its three models. Empty is unset: `model`. */
  defaults: { provider: string; model: string; smallModel: string; highModel: string };
  /** Each helper key as written: a model id, a tier's name, or empty for each agent's own model. */
  helpers: Record<TierHelper, string>;
  /** `[memory] pass_provider`, beside a `pass_model` that names a model. */
  passProvider: string;
  editable: boolean;
}

export type ModelTiersPatch = Partial<{ smallModel: string; highModel: string } & Record<TierHelper, string>>;
