/**
 * The model tiers (0.8.0, SIMPLIFY §3) as the dashboard sets them: the install's `small_model` and `high_model`, each
 * helper key's tier — the install's settings — and one agent's own pair, in its pack.
 *
 * A helper key holds a model id, a tier's name, or nothing: nothing is the agent's own model, as every helper had before
 * tiers. `pass_model` is the one with a partner: a model id is on `pass_provider`'s profile, and a tier is each agent's
 * own model of it on its own provider — so a tier clears `pass_provider`, and so does "the agent's own".
 *
 * **Live.** Every reader resolves a tier where it is used, from the config the daemon holds by reference, and a save
 * changes that in place (`config/follow.ts`); an agent's pair is in its pack, which the write reloads.
 */

import { createLogger, isModelTier, MODEL_TIERS } from "@nouride/shared";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import { editPackFile } from "@/modules/config/config-file.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

/** Each helper key a tier may be named in: where it is written, and its name in the view. */
const HELPERS = {
  summaryModel: { table: "llm.context", key: "summary_model" },
  passModel: { table: "memory", key: "pass_model" },
  steerReplyModel: { table: "queue", key: "steer_reply_model" },
  imageModel: { table: "media", key: "image_model" },
  learningModel: { table: "skills.learning", key: "model" },
} as const;
type Helper = keyof typeof HELPERS;

export interface ModelTiersView {
  /** `[llm.defaults]`: the provider the install's tiers are on, and the three models. Empty is unset: `model`. */
  defaults: { provider: string; model: string; smallModel: string; highModel: string };
  /** Each helper key as written: a model id, `small`/`default`/`high`, or empty for the agent's own. */
  helpers: Record<Helper, string>;
  /** `[memory] pass_provider`, beside `pass_model` — set only with a model id. */
  passProvider: string;
}

export type ModelTiersPatch = Partial<{ smallModel: string; highModel: string } & Record<Helper, string>>;

export function modelTiers(deps: Pick<SettingsDeps, "config">): ModelTiersView {
  const { config } = deps;
  return {
    defaults: {
      provider: config.llm.defaults.provider,
      model: config.llm.defaults.model,
      smallModel: config.llm.defaults.smallModel ?? "",
      highModel: config.llm.defaults.highModel ?? "",
    },
    helpers: {
      summaryModel: config.llm.context.summaryModel ?? "",
      passModel: config.memory.passModel,
      steerReplyModel: config.queue.steerReplyModel,
      imageModel: config.media.imageModel,
      learningModel: config.skills.learning.model,
    },
    passProvider: config.memory.passProvider,
  };
}

/** The install's tiers and each helper's, from a patch; absent fields are left alone, and nothing is written past a refusal. */
export async function setModelTiers(deps: SettingsDeps, params: { patch: ModelTiersPatch; actor?: string }): Promise<SaveResult> {
  const patch = Object.fromEntries(Object.entries(params.patch).filter(([, value]) => value !== undefined).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])) as ModelTiersPatch;
  const refused = refusal(patch, deps.config.memory.passProvider);
  if (refused) return { ok: false, error: refused };
  if (Object.keys(patch).length === 0) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => {
    let text = source;
    for (const [field, key] of [["smallModel", "small_model"], ["highModel", "high_model"]] as const) {
      const value = patch[field];
      if (value !== undefined) text = value ? upsertTomlTable(text, "llm.defaults", { [key]: value }) : removeTomlKey(text, "llm.defaults", key);
    }
    for (const helper of Object.keys(HELPERS) as Helper[]) {
      const value = patch[helper];
      if (value === undefined) continue;
      const { table, key } = HELPERS[helper];
      // A tier, or the agent's own, is on each agent's provider — so `pass_provider` goes with it.
      if (helper === "passModel" && (value === "" || isModelTier(value))) text = removeTomlKey(text, "memory", "pass_provider");
      text = value ? upsertTomlTable(text, table, { [key]: value }) : removeTomlKey(text, table, key);
    }
    return text;
  });
  if (!saved.ok) return saved;

  log.info("model tiers changed", { ...patch, actor: params.actor });
  deps.audit?.record({ action: "model_tiers_changed", actor: params.actor, details: { ...patch } });
  return { ok: true, restartRequired: false };
}

function refusal(patch: ModelTiersPatch, passProvider: string): string | null {
  for (const [field, value] of Object.entries(patch)) {
    if (field !== "smallModel" && field !== "highModel" && !(field in HELPERS)) return `unknown setting "${field}"`;
    if (typeof value !== "string") return `${field} must be text: a model, ${MODEL_TIERS.join(", ")}, or empty`;
  }
  for (const field of ["smallModel", "highModel"] as const) {
    if (patch[field] !== undefined && isModelTier(patch[field])) return `${field === "smallModel" ? "small_model" : "high_model"} names a model, not a tier`;
  }
  // A model id for the pass is a model on `pass_provider`'s profile; without one, it would be sent to every agent's.
  const pass = patch.passModel;
  if (pass && !isModelTier(pass) && !passProvider) {
    return "a model for the nightly pass needs its provider: set both on the Memory page, or choose a tier here";
  }
  return null;
}

/**
 * One agent's own `small_model` / `high_model`, or `null` to inherit the install's (`tierModel`). Absent and written are
 * kept apart for the reason the budgets keep them apart: a model copied from the install stops following it.
 */
export async function saveAgentTiers(deps: SettingsDeps, input: {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
  tiers: { small?: string | null; high?: string | null };
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  const wanted = (["small", "high"] as const).flatMap((tier) => {
    const value = input.tiers[tier];
    return value === undefined ? [] : [{ tier, key: `${tier}_model`, value: value === null ? null : value.trim() }];
  });
  for (const { key, value } of wanted) {
    if (value === "") return { ok: false, error: `${key} is a model id, or none to inherit the install's` };
    if (value !== null && isModelTier(value)) return { ok: false, error: `${key} names a model, not a tier` };
  }
  if (wanted.length === 0) return { ok: true, restartRequired: false };

  const saved = await editPackFile({
    path: input.agentConfigPath,
    reload: input.reload,
    edit: (source) =>
      wanted.reduce((text, { key, value }) => (value === null ? removeTomlKey(text, "llm", key) : upsertTomlTable(text, "llm", { [key]: value })), source),
  });
  if (!saved.ok) return saved;

  const details = Object.fromEntries(wanted.map(({ key, value }) => [key, value]));
  log.info("agent model tiers changed", { agent: input.agentId, ...details, actor: input.actor });
  deps.audit?.record({ action: "agent_model_tiers_changed", actor: input.actor, details: { agent: input.agentId, ...details } });
  return { ok: true, restartRequired: false };
}
