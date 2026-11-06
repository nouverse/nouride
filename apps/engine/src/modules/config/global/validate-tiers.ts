/**
 * The install's model tiers (`[llm.defaults] small_model`, `high_model` — 0.8.0, `types/tiers.ts`), checked at load.
 *
 * Each names a model. A tier's name there — `small_model = "high"` — would name a tier by a tier, which reads as a
 * model id nobody serves and fails at the first piece of work that asks for it, hours later: refused here instead,
 * with the file and the key (invariant 7). A pack's own pair is checked where the pack is parsed.
 */

import { ConfigError, isModelTier, type GlobalConfig } from "@nouride/shared";

export function validateTiers(config: Pick<GlobalConfig, "llm">): void {
  const { smallModel, highModel } = config.llm.defaults;
  for (const [key, value] of [["small_model", smallModel], ["high_model", highModel]] as const) {
    if (isModelTier(value?.trim())) {
      throw new ConfigError(`[llm.defaults] ${key} = "${value}" names a tier, but this key names a model: the one ${key === "small_model" ? "small" : "high"} work runs on`);
    }
  }
}
