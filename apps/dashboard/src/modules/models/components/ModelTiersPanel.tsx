/**
 * The install's model tiers and each helper's tier (0.8.0, SIMPLIFY §3): `[llm.defaults] small_model` and
 * `high_model` beside `model`, and the tier — or model — that compaction, the nightly pass, the steering reply, image
 * reading and skill learning each run on.
 *
 * On this page and collapsed, as the Skills page keeps its settings: it is the page's setting, not its content. A
 * helper names a tier with one word, and nothing changes until someone does — every helper is each agent's own model
 * until then. An agent's own pair is on its Model tab.
 *
 * **Live.** The daemon resolves a tier where it is used, so a save applies to the next piece of work.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Layers } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { ModelTiersPatch, TierHelper } from "@nouride/wire";
import { isAdmin, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { Combobox } from "@/commons/components/ui/Combobox";
import { useSaved } from "@/commons/hooks/use-saved";
import { chatModels } from "@/commons/lib/model-kind";

/** Each helper, as a person knows it, and what its empty setting means — they do not all mean the same thing. */
const HELPERS: { key: TierHelper; label: string; setting: string; unset: string }[] = [
  { key: "summaryModel", label: "Compacting a long conversation", setting: "[llm.context] summary_model", unset: "Each agent's own model (or the pass's, when it names one)" },
  { key: "passModel", label: "The nightly memory pass", setting: "[memory] pass_model", unset: "Each agent's own model" },
  { key: "steerReplyModel", label: "The reply under a steered message", setting: "[queue] steer_reply_model", unset: "Each agent's own model" },
  { key: "imageModel", label: "Reading an image", setting: "[media] image_model", unset: "Each agent's own model, shown the picture" },
  { key: "learningModel", label: "Skill learning", setting: "[skills.learning] model", unset: "Each agent's own model" },
];

const TIER_OPTIONS = [
  { value: "small", label: "Small tier (the cheapest)" },
  { value: "default", label: "Default tier (each agent's model)" },
  { value: "high", label: "High tier (the strongest)" },
];

export function ModelTiersPanel() {
  const queryClient = useQueryClient();
  const me = useMe();
  const view = useQuery({ queryKey: ["model-tiers"], queryFn: api.modelTiers, retry: false });
  const provider = view.data?.defaults.provider ?? "";
  const modelList = useQuery({
    queryKey: ["provider-models", provider],
    queryFn: () => api.providerModels(provider),
    enabled: !!provider,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  /** What is being changed, by field; absent follows the daemon. */
  const [draft, setDraft] = useState<ModelTiersPatch>({});
  const saved = useSaved();
  const save = useMutation({
    mutationFn: (patch: ModelTiersPatch) => api.saveModelTiers(patch),
    onSuccess: async (answer, patch) => {
      saved(answer, `Model tiers: ${Object.keys(patch).length} setting(s) changed`, "From the next piece of work.");
      setDraft({});
      await queryClient.invalidateQueries({ queryKey: ["model-tiers"] });
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  // A daemon with no config file to write, or from before 0.8.0: no control rather than a dead one.
  if (view.error || !view.data) return null;
  const live = view.data;
  const editable = live.editable && isAdmin(me.data ?? null);
  const models = modelList.data?.ok ? chatModels(modelList.data.models) : [];
  const value = <K extends keyof ModelTiersPatch>(key: K, current: string) => draft[key] ?? current;
  const helper = (key: TierHelper) => value(key, live.helpers[key]);
  const changed = (Object.keys(draft) as (keyof ModelTiersPatch)[]).filter((key) => {
    const current = key === "smallModel" ? live.defaults.smallModel : key === "highModel" ? live.defaults.highModel : live.helpers[key as TierHelper];
    return (draft[key] ?? "").trim() !== current;
  });
  const small = live.defaults.smallModel || live.defaults.model;
  const high = live.defaults.highModel || live.defaults.model;

  return (
    <details className="collapse-arrow bg-base-100 border-base-content/10 collapse rounded-2xl border">
      <summary className="collapse-title flex flex-wrap items-center gap-2 text-sm font-medium">
        <Layers size={15} className="opacity-60" />
        Model tiers
        <span className="text-xs font-normal text-base-content/65">
          {live.defaults.smallModel || live.defaults.highModel ? `small ${small || "—"} · default ${live.defaults.model || "—"} · high ${high || "—"}` : "all three are the default model"}
        </span>
      </summary>

      <div className="collapse-content space-y-5">
        <p className="text-xs text-base-content/65">
          An agent picks one of three models for the work it hands off (a helper, another agent's answer): small for
          quick, simple work, high for hard work that has to be right, default when it says nothing. Unset, a tier is the
          default model. An agent on <b>{provider || "the default provider"}</b> uses these; its Model tab can name its own.
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="block space-y-1.5 text-sm">
            <span className="text-base-content/85 block text-xs font-semibold uppercase tracking-wider font-mono">Default</span>
            <span className="block py-2 font-mono text-sm">{live.defaults.model || "—"}</span>
            <span className="block text-xs text-base-content/65">Set with the first agent.</span>
          </label>
          {(["smallModel", "highModel"] as const).map((key) => (
            <label key={key} className="block space-y-1.5 text-sm">
              <span className="text-base-content/85 block text-xs font-semibold uppercase tracking-wider font-mono">{key === "smallModel" ? "Small" : "High"}</span>
              <Combobox
                options={models}
                loading={modelList.isLoading}
                value={value(key, live.defaults[key])}
                onChange={(next) => setDraft((was) => ({ ...was, [key]: next }))}
                disabled={!editable}
              />
              <span className="block text-xs text-base-content/65">
                {key === "smallModel" ? "The cheapest. Empty: the default model." : "The strongest and the dearest. Empty: the default model."}
              </span>
            </label>
          ))}
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm">What each helper runs on</legend>
          {HELPERS.map(({ key, label, unset }) => {
            const current = helper(key);
            const named = current !== "" && !TIER_OPTIONS.some((option) => option.value === current);
            return (
              <label key={key} className="grid grid-cols-1 gap-1 sm:grid-cols-[1fr_minmax(0,18rem)] sm:items-center">
                <span className="text-sm">{label}</span>
                <select
                  className="select select-sm w-full rounded-xl"
                  value={current}
                  disabled={!editable}
                  onChange={(event) => setDraft((was) => ({ ...was, [key]: event.target.value }))}
                >
                  <option value="">{unset}</option>
                  {TIER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  {named ? <option value={current}>{key === "passModel" && live.passProvider ? `${live.passProvider}/${current}` : current} (a model)</option> : null}
                </select>
              </label>
            );
          })}
          <p className="text-xs text-base-content/65">
            A tier is each agent's own model of it, on its own provider. Choosing one for the nightly pass clears its
            provider; a model of its own for the pass is set on the Knowledge & Memory page.
          </p>
          {/* Where each is written, for whoever runs the server (0.8.19). */}
          <Details>
            <ul className="space-y-0.5">
              <li className="font-mono">[llm.defaults] model: the default model</li>
              {HELPERS.map(({ key, label, setting }) => (
                <li key={key}>
                  {label}: <span className="font-mono">{setting}</span>
                </li>
              ))}
            </ul>
          </Details>
        </fieldset>

        <ErrorNote error={save.error} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={!editable || changed.length === 0 || save.isPending}
            onClick={() => save.mutate(Object.fromEntries(changed.map((key) => [key, (draft[key] ?? "").trim()])))}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Save
          </button>
          <span className="text-xs text-base-content/65">
            {editable ? "Live: applies to the next piece of work, no restart." : live.editable ? "Read only: you need the admin role." : "This cannot be changed from the dashboard on this server."}
          </span>
        </div>
      </div>
    </details>
  );
}
