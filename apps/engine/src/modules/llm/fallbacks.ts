/**
 * An agent's `[llm] fallbacks` as a turn's request carries them: each pair with its endpoint (SMART_AUTOMATION §3.1).
 *
 * Every profile was checked when the pack loaded; one removed from `config.toml` since is left out here rather than
 * failing the turn the agent's own model may well answer.
 */

import { createLogger, type LoadedAgent } from "@nouride/shared";
import type { TurnRequest } from "./executor/types.ts";
import type { ProviderRegistry } from "./providers.ts";

const log = createLogger("llm.fallbacks");

export function fallbacksFor(agent: LoadedAgent, providers: Pick<ProviderRegistry, "get">): Pick<TurnRequest, "fallbacks"> {
  const pairs = (agent.config.llm.fallbacks ?? []).flatMap((pair) => {
    try {
      return [{ profile: pair.provider, model: pair.model, provider: providers.get(pair.provider) }];
    } catch (err) {
      log.warn("a fallback's provider is not configured, so it is left out", { agent_id: agent.config.id, provider: pair.provider, error: String(err) });
      return [];
    }
  });
  return pairs.length > 0 ? { fallbacks: pairs } : {};
}
