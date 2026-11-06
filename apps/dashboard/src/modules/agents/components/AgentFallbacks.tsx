/**
 * Who answers when this agent's model cannot (0.8.0, `[llm] fallbacks`): a list, in order, each a provider profile and a
 * model on it — a model's name alone means nothing on another provider. Another model on the same profile answers a
 * model that is busy or not served; another profile answers an endpoint that is down, out of credit or refusing its key.
 *
 * Saved whole, as the pack writes it: the daemon checks every pair when the agent reloads, and a list it refuses is
 * not written.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowDown, Check, Plus, Trash2 } from "lucide-react";
import { api, type AgentSummary, type FallbackPair } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { Combobox } from "@/commons/components/ui/Combobox";
import { useSaved } from "@/commons/hooks/use-saved";
import { chatModels } from "@/commons/lib/model-kind";

const same = (a: FallbackPair[], b: FallbackPair[]) =>
  a.length === b.length && a.every((pair, i) => pair.provider === b[i]?.provider && pair.model.trim() === b[i]?.model);

/** One pair: its profile, and a model from that profile's own list — or typed, where the list is not to be had. */
function PairRow({
  pair,
  index,
  profiles,
  editable,
  onChange,
  onRemove,
}: {
  pair: FallbackPair;
  index: number;
  profiles: string[];
  editable: boolean;
  onChange: (next: FallbackPair) => void;
  onRemove: () => void;
}) {
  const models = useQuery({
    queryKey: ["provider-models", pair.provider],
    queryFn: () => api.providerModels(pair.provider),
    enabled: !!pair.provider,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return (
    <li className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {/* On a phone the number and the remove button share the row's first line; from `sm` all four share one. */}
      <div className="flex items-center justify-between sm:contents">
        <span className="font-mono text-xs text-base-content/65 w-6 shrink-0">{index + 1}.</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square rounded-xl sm:order-last"
          aria-label={`Remove fallback ${index + 1}`}
          disabled={!editable}
          onClick={onRemove}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      <select
        className="select select-sm w-full sm:w-48 rounded-xl text-sm"
        aria-label={`Fallback ${index + 1} provider`}
        value={pair.provider}
        disabled={!editable}
        onChange={(event) => onChange({ ...pair, provider: event.target.value })}
      >
        {!profiles.includes(pair.provider) && <option value={pair.provider}>{pair.provider || "choose a provider"}</option>}
        {profiles.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <div className="flex-1 min-w-0">
        <Combobox
          options={models.data?.ok ? chatModels(models.data.models) : []}
          loading={models.isLoading}
          value={pair.model}
          onChange={(model) => onChange({ ...pair, model })}
          disabled={!editable}
        />
      </div>
    </li>
  );
}

export function AgentFallbacks({ agent, profiles, editable }: { agent: AgentSummary; profiles: string[]; editable: boolean }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  const own = agent.fallbacks ?? [];
  /** The list being edited; `undefined` follows the daemon until it is touched. */
  const [typed, setTyped] = useState<FallbackPair[] | undefined>(undefined);
  const list = typed ?? own;
  const dirty = !same(list, own);
  const complete = list.every((pair) => pair.provider && pair.model.trim());

  const save = useMutation({
    mutationFn: (next: FallbackPair[]) => api.saveAgentFallbacks(agent.id, next),
    onSuccess: async (answer, next) => {
      saved(answer, next.length > 0 ? `${agent.id} falls back to ${next.map((pair) => `${pair.model} on ${pair.provider}`).join(", then ")}` : `${agent.id} has no fallbacks of its own`, "From its next turn.");
      setTyped(undefined);
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  // A daemon from before 0.8.0 says nothing of a list: no control rather than a dead one.
  if (agent.fallbacks === undefined) return null;

  const change = (index: number, next: FallbackPair) => setTyped(list.map((pair, i) => (i === index ? next : pair)));
  return (
    <Card
      title="Fallbacks"
      description="Who answers when this agent's model cannot, in order, after its provider's own retries. Another model on the same provider answers a model that is rate limited, overloaded or not served; another provider also answers one that is down, out of credit or refusing its key. The rest of that turn stays on the one that answered."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && complete) save.mutate(list.map((pair) => ({ provider: pair.provider, model: pair.model.trim() })));
        }}
      >
        {list.length === 0 ? (
          <p className="text-sm text-base-content/65">None: a turn whose model cannot answer ends with what its provider said.</p>
        ) : (
          <ol className="space-y-3">
            {list.map((pair, index) => (
              <PairRow
                key={index}
                pair={pair}
                index={index}
                profiles={profiles}
                editable={editable}
                onChange={(next) => change(index, next)}
                onRemove={() => setTyped(list.filter((_, i) => i !== index))}
              />
            ))}
          </ol>
        )}
        {list.length > 1 && (
          <p className="flex items-center gap-1.5 text-xs text-base-content/65">
            <ArrowDown size={12} aria-hidden="true" /> Tried from the top; each once.
          </p>
        )}
        <ErrorNote error={save.error} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-ghost btn-sm rounded-xl gap-1.5 active:scale-95 transition-all"
            disabled={!editable}
            onClick={() => setTyped([...list, { provider: agent.provider, model: "" }])}
          >
            <Plus size={14} aria-hidden="true" />
            Add fallback
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl gap-1.5 shadow-xs active:scale-95 transition-all"
            disabled={!editable || !dirty || !complete || save.isPending}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : <Check size={14} aria-hidden="true" />}
            Save Fallbacks
          </button>
        </div>
      </form>
    </Card>
  );
}
