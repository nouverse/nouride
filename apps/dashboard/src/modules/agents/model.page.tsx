/**
 * Which endpoint and model this agent runs on.
 * Remade with Apple HIG: clean dropdowns, reactive model search combobox,
 * tool chips, and tactile save actions.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, RefreshCw, Sparkles } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { Combobox } from "@/commons/components/ui/Combobox";
import { useSaved } from "@/commons/hooks/use-saved";
import { AgentModelTiers } from "./components/AgentModelTiers";
import { AgentFallbacks } from "./components/AgentFallbacks";
import { AgentEffort } from "./components/AgentEffort";
import { ExternalNote } from "./components/ExternalNote";
import { chatModels } from "@/commons/lib/model-kind";

export default function AgentModelPage({ agentId }: { agentId: string }) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers, retry: false });
  const me = useMe();
  const queryClient = useQueryClient();

  const agent = (status.data?.agents ?? []).find((entry) => entry.id === agentId);
  const editable = canWrite(me.data ?? null);

  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);

  const currentProvider = provider ?? agent?.provider ?? "";
  const currentModel = model ?? agent?.model ?? "";

  const profiles = providers.data?.providers ?? [];
  const profile = profiles.find((entry) => entry.name === currentProvider);

  const saved = useSaved();
  const save = useMutation({
    mutationFn: () => api.saveAgentModel(agentId, { provider: currentProvider, model: currentModel }),
    onSuccess: async (answer) => {
      saved(answer, `${agentId} answers with ${currentModel}`, `On ${currentProvider}, from its next turn.`);
      setProvider(null);
      setModel(null);
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const modelList = useQuery({
    queryKey: ["provider-models", currentProvider],
    queryFn: () => api.providerModels(currentProvider),
    enabled: !!currentProvider,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const fetchModels = useMutation({
    mutationFn: () => api.providerModels(currentProvider),
    onSuccess: (data) => {
      queryClient.setQueryData(["provider-models", currentProvider], data);
    },
  });

  const models = modelList.data?.ok ? chatModels(modelList.data.models) : [];
  const dirty = currentProvider !== agent?.provider || currentModel !== agent?.model;

  const budgeted = agent?.contextWindow;

  return (
    <div className="space-y-6">
      <ExternalNote
        agentId={agentId}
        says={({ name, cli }) =>
          `${cli} answers ${name}, on its own model, chosen above on the Brain tab. The model, tiers and fallbacks here run Nouride's own work around it (a mission's review, the memory pass, helpers it hands work to) and answer a turn ${cli} cannot, signed out or at its account's limit, saying so.`
        }
      />
      <Card
        title="Model"
        description="Which AI provider and model this agent answers with. Saving applies it at once."
      >
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) save.mutate();
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Provider"
              hint={profile ? `At ${profile.baseUrl}` : "Set up on the Models page."}
            >
              <select
                className="select w-full rounded-xl text-sm"
                value={currentProvider}
                disabled={!editable}
                onChange={(e) => setProvider(e.target.value)}
              >
                {profiles.length === 0 && <option value={currentProvider}>{currentProvider}</option>}
                {profiles.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name} {entry.hasCredential ? "" : "(No API key)"}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Model Name" hint="Search or enter model name accepted by this provider.">
              <Combobox
                options={models}
                loading={modelList.isLoading}
                value={currentModel}
                onChange={setModel}
                disabled={!editable}
              />
            </Field>
          </div>

          {budgeted && (
            <div className={`space-y-1 font-mono text-xs ${budgeted.source === "default" ? "text-warning" : "text-base-content/65"}`}>
              <p>
                Reads up to {budgeted.tokens.toLocaleString("en-US")} tokens at a time ({WINDOW_SOURCE[budgeted.source]}) {/* plain-words-ok: tokens, the unit a model's reading is counted in */}
              </p>
              {budgeted.source === "default" ? (
                <Details>
                  <p>Set context_window in the agent's pack, or have the gateway state it.</p>
                </Details>
              ) : null}
            </div>
          )}

          {profile && !profile.hasCredential && (
            <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning text-xs rounded-xl p-3">
              <span>This provider has no API key yet. Add one on the Models page.</span>
            </div>
          )}

          {modelList.data && !modelList.data.ok && (
            <p className="text-base-content/65 text-xs">
              Could not list its models ({modelList.data.plain ?? modelList.data.error ?? "no answer"}). You can type the model's exact name instead.
            </p>
          )}

          <ErrorNote error={save.error} />

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="submit"
              className="btn btn-primary btn-sm rounded-xl gap-1.5 shadow-xs active:scale-95 transition-all"
              disabled={!editable || !dirty || save.isPending}
            >
              {save.isPending ? <span className="loading loading-spinner loading-xs" /> : <Sparkles size={14} />}
              Save & Reload
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm rounded-xl gap-2 font-medium active:scale-95 transition-all"
              disabled={!profile || fetchModels.isPending}
              onClick={() => fetchModels.mutate()}
            >
              {fetchModels.isPending ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                <RefreshCw size={14} />
              )}
              Fetch Models
            </button>
            {save.isSuccess && !dirty && (
              <span className="text-success flex items-center gap-1 text-xs font-semibold">
                <Check size={14} /> Saved and reloaded
              </span>
            )}
          </div>
        </form>
      </Card>

      {/* An external agent's effort is chosen on its CLI tab, which folds this tab in: once is enough. */}
      {agent && !agent.external && <AgentEffort agent={agent} editable={editable} />}

      {agent && <AgentModelTiers agent={agent} models={models} loading={modelList.isLoading} editable={editable} />}

      {agent && <AgentFallbacks agent={agent} profiles={profiles.map((entry) => entry.name)} editable={editable} />}
    </div>
  );
}

/** Where the window a turn is budgeted at comes from, as the daemon reports it. */
const WINDOW_SOURCE: Record<"pack" | "gateway" | "table" | "default", string> = {
  pack: "set for this agent",
  gateway: "as its provider says",
  table: "as Nouride knows this model",
  default: "a guess",
};
