/**
 * An agent's fallbacks as its pack says them (SMART_AUTOMATION §3.1): `[llm] fallbacks`, each a provider and a model —
 * and one `{ provider, model }`, which the daemon's own `[llm.defaults]` reads with the same words.
 */

import { ConfigError, type FallbackPair, type LLMDefaultsSection } from "@nouride/shared";

/**
 * `[llm] fallbacks` — each a provider and a model, in order. A pack that says none takes `[llm.defaults]`'s, less a
 * pair that is the agent's own model. Every provider is a configured profile, checked here as `provider` is.
 *
 * 0.7's `fallback_model`, one model on the agent's own provider, is refused for that agent, naming the line to write:
 * 0.8.0 rewrote it as `fallbacks` in every pack at its first start, and this version starts only on data 0.8.0 has run
 * on, so one met now came back — a pack pulled from git, a hand edit. Read as nothing, it would take the agent's
 * fallback away without a word.
 */
export function fallbacksOf(
  llm: { fallbacks?: unknown; fallback_model?: unknown },
  where: string,
  provider: string,
  model: string,
  defaults: LLMDefaultsSection,
  knownProviders: string[] | undefined,
): { fallbacks?: FallbackPair[] } {
  const own = (pair: FallbackPair) => pair.provider === provider && pair.model === model;
  if (llm.fallback_model !== undefined) {
    const named = typeof llm.fallback_model === "string" && llm.fallback_model.trim() ? llm.fallback_model.trim() : "…";
    throw new ConfigError(
      `${where} [llm] fallback_model was replaced by fallbacks in 0.8.0: write fallbacks = [{ provider = "${provider}", model = "${named}" }] in its place` +
        (llm.fallbacks === undefined ? "" : ", or take the line out: fallbacks is there already"),
    );
  }
  if (llm.fallbacks === undefined) {
    const inherited = (defaults.fallbacks ?? []).filter((pair) => !own(pair));
    return inherited.length > 0 ? { fallbacks: inherited } : {};
  }
  if (!Array.isArray(llm.fallbacks)) throw new ConfigError(`${where} [llm] fallbacks must be a list of { provider, model }`);
  const pairs = llm.fallbacks.map((entry, i) => fallbackPair(entry, `${where} [llm] fallbacks[${i}]`, knownProviders));
  for (const [i, pair] of pairs.entries()) {
    if (own(pair)) throw new ConfigError(`${where} [llm] fallbacks[${i}] is the agent's own model (${pair.model} on ${pair.provider}): a fallback has to be another one`);
    if (pairs.findIndex((other) => other.provider === pair.provider && other.model === pair.model) !== i) {
      throw new ConfigError(`${where} [llm] fallbacks[${i}] repeats ${pair.model} on ${pair.provider}`);
    }
  }
  return pairs.length > 0 ? { fallbacks: pairs } : {};
}

/** One `{ provider, model }` of a fallbacks list — shared with `[llm.defaults]`, read by the daemon's own config. */
export function fallbackPair(entry: unknown, where: string, knownProviders: readonly string[] | undefined): FallbackPair {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ConfigError(`${where} must be { provider = "…", model = "…" }`);
  const { provider, model, ...rest } = entry as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new ConfigError(`${where} has ${extra.join(", ")}, but a fallback is a provider and a model, nothing else`);
  if (typeof provider !== "string" || !provider.trim()) throw new ConfigError(`${where} needs provider: a model's name means nothing without its provider`);
  if (typeof model !== "string" || !model.trim()) throw new ConfigError(`${where} needs model`);
  if (knownProviders && !knownProviders.includes(provider.trim())) {
    throw new ConfigError(`${where} provider "${provider.trim()}" is not a configured profile (known: ${knownProviders.join(", ")})`);
  }
  return { provider: provider.trim(), model: model.trim() };
}
