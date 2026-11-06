/**
 * The model tiers (0.8.0): the install's `small_model` and `high_model`, the tier or model each helper key names, and
 * one agent's own pair. Spread into `api` like the other modules; the types are re-exported from `api.ts`.
 */

import { control, post, request } from "./api.client";

/** What `tier` and a helper key accept — `MODEL_TIERS` in the daemon, held to it by `scripts/check-wire.ts`. */
export type ModelTier = "small" | "default" | "high";

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

export const tiersApi = {
  modelTiers: () => request<ModelTiersView>(`${control}/llm/tiers`),

  saveModelTiers: (patch: ModelTiersPatch) => post<{ ok: true } & Omit<ModelTiersView, "editable">>(`${control}/llm/tiers`, patch),

  /** One agent's own small and high model — `null` to inherit the install's, absent to leave alone. */
  saveAgentTiers: (agent: string, tiers: { small?: string | null; high?: string | null }) =>
    post<{ ok: true }>(`${control}/agents/${agent}/tiers`, tiers),
};
