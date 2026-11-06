/**
 * Who writes a conversation's compaction summary — which provider profile, and which model on it.
 *
 * 1. `[llm.context] summary_model`, on the turn's own profile: what that setting has always meant, a model the
 *    agent's profile can serve.
 * 2. Else `[memory] pass_provider` and `pass_model`, when they are set — always together (`validate-memory.ts`).
 *    The operator has already chosen a model for condensing a stretch of conversation: the nightly pass files the
 *    same transcripts compaction condenses, and the model chosen for it is usually the small one. Compaction ran on
 *    the agent's own model regardless, the dearest model on a box that had set a cheap one (M12).
 * 3. Else the turn's own profile and model, as before either existed.
 *
 * Either key may name a tier instead of a model (0.8.0, `types/tiers.ts`) — `summary_model = "small"` — and then it is
 * the turn's agent's model of that tier, on the turn's own profile: a `pass_model` tier has no `pass_provider` beside it.
 *
 * A route that is not the turn's own falls back to it when its model cannot answer (`helper-model.ts`): a pass model
 * that went away took every compaction on the box with it, and a conversation was never compacted again.
 */

import { contextWindowInfo } from "@nouride/llm";
import { helperModel, isModelTier, type AgentTiers, type InstallTiers, type LLMProvider, type MemorySection } from "@nouride/shared";
import type { ProviderRegistry } from "./providers.ts";
import type { UsagePort } from "./usage.store.ts";
import { meter, metered } from "./metered.ts";
import { orOwnModel } from "./helper-model.ts";

export function summarizerRoute(
  settings: { summaryModel?: string | undefined; passProvider?: string; passModel?: string },
  turn: { profile: string; model: string },
  /** The turn's agent and the install, for a key that names a tier. Absent: a tier is the turn's own model. */
  tiers?: { agent: AgentTiers; install: InstallTiers },
): { profile: string; model: string } {
  const read = (setting: string | undefined) => (tiers ? helperModel(setting, tiers.agent, tiers.install) : helperModel(setting, { provider: turn.profile, model: turn.model }, { provider: "" }));
  const summary = read(settings.summaryModel);
  if (summary) return { profile: turn.profile, model: summary };
  if (settings.passProvider && settings.passModel) return { profile: settings.passProvider, model: settings.passModel };
  const pass = !settings.passProvider && isModelTier(settings.passModel) ? read(settings.passModel) : "";
  if (pass) return { profile: turn.profile, model: pass };
  return turn;
}

/**
 * The route, ready to call: for a turn on `model`, the provider to summarise with — metered as the turn's compaction,
 * under the profile that answers it, so its price and its billing are that profile's — and the model to ask for.
 *
 * What `ExecutorDeps.summarizer` takes, and what a summary after the reply uses, so the two cannot pick different
 * models for one conversation.
 */
export function summarizerFor(
  deps: {
    config: { llm: { context: { summaryModel?: string | undefined }; defaults: InstallTiers }; memory: Pick<MemorySection, "passProvider" | "passModel"> };
    providers: Pick<ProviderRegistry, "get">;
    usage?: Pick<UsagePort, "record">;
  },
  turn: { agentId: string; profile: string; sessionId?: string; turnId?: string; /** The agent's `[llm]`, for a tier. */ tiers: AgentTiers },
): (model: string) => { provider: LLMProvider; model: string } {
  return (model) => {
    const route = summarizerRoute(
      { summaryModel: deps.config.llm.context.summaryModel, passProvider: deps.config.memory.passProvider, passModel: deps.config.memory.passModel },
      { profile: turn.profile, model },
      { agent: turn.tiers, install: deps.config.llm.defaults },
    );
    // Each charged under the profile that answered: a fallback's call is the turn's own profile's to pay.
    const client = (profile: string) =>
      metered(
        deps.providers.get(profile),
        meter(deps.usage, {
          agentId: turn.agentId,
          provider: profile,
          purpose: "compaction",
          ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
          ...(turn.turnId ? { turnId: turn.turnId } : {}),
        }),
      );
    return { provider: orOwnModel({ ...route, provider: client(route.profile) }, { profile: turn.profile, model, provider: () => client(turn.profile) }, "compaction"), model: route.model };
  };
}

/**
 * The window a summary's stretches are sized for: the smaller of the helper's and the agent's own. A helper that cannot
 * answer hands the call to the agent's own model (`helper-model.ts`), and a stretch sized for a million-token helper
 * would not fit a 200k one.
 */
export function summarizerWindowFor(summaryModel: string, ownModel: string, ownWindow: number): number {
  return summaryModel === ownModel ? ownWindow : Math.min(contextWindowInfo(summaryModel).tokens, ownWindow);
}
