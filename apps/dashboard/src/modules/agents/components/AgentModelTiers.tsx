/**
 * One agent's three model tiers (0.8.0): `default` is its model, above; `small` and `high` are its pack's own
 * `small_model` / `high_model`, or what it inherits until one is written — the install's, while it runs on the install's
 * provider, else its own model. The agent picks a tier for the work it hands off (`tier` on `delegate` and
 * `ask_agent`); helper keys that name a tier use these too.
 *
 * Inheriting and naming the same model are kept apart, as the budgets keep them: "Inherit" removes the key, so a change
 * to the install's reaches this agent.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, Layers } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { Combobox } from "@/commons/components/ui/Combobox";
import { useSaved } from "@/commons/hooks/use-saved";

type Tier = "small" | "high";

/** What each tier is for, as the agent's own prompt says it — in words, never in money. */
const FOR: Record<Tier, string> = {
  small: "The cheapest: quick, simple work: a lookup, a check, a summary.",
  high: "The strongest and the dearest: hard work that has to be right: a subtle bug, a design, a review.",
};

export function AgentModelTiers({ agent, models, loading, editable }: { agent: AgentSummary; models: string[]; loading: boolean; editable: boolean }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  /** What is being typed, per tier; `undefined` follows the daemon until it is touched. */
  const [typed, setTyped] = useState<Partial<Record<Tier, string>>>({});
  const tiers = agent.tiers;

  const save = useMutation({
    mutationFn: (next: Partial<Record<Tier, string | null>>) => api.saveAgentTiers(agent.id, next),
    onSuccess: async (answer, next) => {
      const said = (Object.entries(next) as [Tier, string | null][]).map(([tier, model]) => `${tier}: ${model ?? "inherited"}`).join(", ");
      saved(answer, `${agent.id}'s tiers: ${said}`, "From the next piece of work it hands off.");
      setTyped({});
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  // A daemon from before 0.8.0 says nothing of tiers: no control rather than a dead one.
  if (!tiers) return null;

  const current = (tier: Tier) => typed[tier] ?? tiers[tier].own ?? "";
  const dirty = (["small", "high"] as const).filter((tier) => current(tier).trim() !== (tiers[tier].own ?? ""));

  return (
    <Card
      title="Model Tiers"
      description="The work this agent hands off (a helper, another agent's answer) runs on one of three models, chosen per piece of work. Unset, a tier follows the one set for every agent (on the same provider) or this agent's model."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty.length > 0) save.mutate(Object.fromEntries(dirty.map((tier) => [tier, current(tier).trim() || null])));
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <span className="text-base-content/85 block text-xs font-semibold uppercase tracking-wider font-mono">Default</span>
            <p className="font-mono text-sm text-base-content py-2">{agent.model || "—"}</p>
            <span className="text-base-content/65 block text-xs leading-normal">Most work, and what runs when no tier is asked for. The model above.</span>
          </div>
          {(["small", "high"] as const).map((tier) => (
            <Field
              key={tier}
              label={tier === "small" ? "Small" : "High"}
              hint={`${FOR[tier]} ${tiers[tier].own ? `Set for this agent; inherits ${tiers[tier].inherits} when cleared.` : `Inherits ${tiers[tier].inherits}.`}`}
            >
              <Combobox options={models} loading={loading} value={current(tier)} onChange={(value) => setTyped((was) => ({ ...was, [tier]: value }))} disabled={!editable} />
            </Field>
          ))}
        </div>
        <ErrorNote error={save.error} />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="btn btn-primary btn-sm rounded-xl gap-1.5 shadow-xs active:scale-95 transition-all"
            disabled={!editable || dirty.length === 0 || save.isPending}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : <Check size={14} />}
            Save Tiers
          </button>
          {(tiers.small.own || tiers.high.own) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm rounded-xl gap-1.5 active:scale-95 transition-all"
              disabled={!editable || save.isPending}
              onClick={() => save.mutate({ ...(tiers.small.own ? { small: null } : {}), ...(tiers.high.own ? { high: null } : {}) })}
            >
              <Layers size={14} /> Inherit both
            </button>
          )}
        </div>
      </form>
    </Card>
  );
}
