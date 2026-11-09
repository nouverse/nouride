/**
 * Three model tiers — `small`, `default`, `high` (0.8.0).
 *
 * `model` is the default for everything; `small_model` and `high_model` are optional, in `[llm.defaults]` and in a
 * pack's `[llm]`. The agent picks one per piece of work it starts — a helper, another agent's answer — with a `tier`
 * argument, and every helper key (`summary_model`, `pass_model`, `steer_reply_model`, `image_model`,
 * `[skills.learning] model`) may name one instead of a model: `summary_model = "small"`. Unsaid, a piece of work is
 * `default`, and a helper is the agent's own model, as before tiers: nothing changes until somebody writes one.
 *
 * Added beside the helper keys, never folded into them: merging would be a translation, and could quietly change what
 * a box spends.
 */

/** The tiers, cheapest first. Also what a `tier` argument and a helper key accept. */
export const MODEL_TIERS = ["small", "default", "high"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === "string" && (MODEL_TIERS as readonly string[]).includes(value);
}

/** What an agent says about its own tiers: its pack's `[llm]`, resolved for `provider` and `model`. */
export interface AgentTiers {
  provider: string;
  model: string;
  /** The pack's own `small_model`; absent inherits. */
  smallModel?: string;
  /** The pack's own `high_model`; absent inherits. */
  highModel?: string;
}

/** What the install says: `[llm.defaults]`. Empty is unset. */
export interface InstallTiers {
  provider: string;
  smallModel?: string;
  highModel?: string;
}

/**
 * The model a tier names for an agent: the pack's own, else the install's — only while the agent runs on the install's
 * provider, since a model id is a name on one endpoint and the install's means nothing on another — else the agent's
 * `model`. `default` is always `model`.
 */
export function tierModel(agent: AgentTiers, install: InstallTiers, tier: ModelTier): string {
  if (tier === "default") return agent.model;
  const own = tier === "small" ? agent.smallModel : agent.highModel;
  if (own) return own;
  const installs = tier === "small" ? install.smallModel : install.highModel;
  if (installs && agent.provider === install.provider) return installs;
  return agent.model;
}

/**
 * A helper key's model for an agent: a tier name is that tier's model (`tierModel`), a model id is itself, and empty
 * is empty — the caller's own default, which every helper had before tiers and keeps.
 */
export function helperModel(setting: string | undefined, agent: AgentTiers, install: InstallTiers): string {
  const said = setting?.trim() ?? "";
  return isModelTier(said) ? tierModel(agent, install, said) : said;
}
