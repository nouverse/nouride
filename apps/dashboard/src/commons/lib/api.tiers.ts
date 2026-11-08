/**
 * The model tiers (0.8.0): the install's `small_model` and `high_model`, the tier or model each helper key names, and
 * one agent's own pair. Spread into `api` like the other modules. The payload types are `@nouride/wire`'s.
 */

import { control, post, request } from "./api.client";
import type { ModelTiersPatch, ModelTiersView } from "@nouride/wire";

export const tiersApi = {
  modelTiers: () => request<ModelTiersView>(`${control}/llm/tiers`),

  saveModelTiers: (patch: ModelTiersPatch) => post<{ ok: true } & Omit<ModelTiersView, "editable">>(`${control}/llm/tiers`, patch),

  /** One agent's own small and high model — `null` to inherit the install's, absent to leave alone. */
  saveAgentTiers: (agent: string, tiers: { small?: string | null; high?: string | null }) =>
    post<{ ok: true }>(`${control}/agents/${agent}/tiers`, tiers),
};
