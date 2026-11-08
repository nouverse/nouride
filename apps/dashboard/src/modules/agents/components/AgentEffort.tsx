/**
 * How long an agent's own model thinks (0.8.17): `[llm] effort`, sent with each of its requests in every chat, where a
 * chat's `/effort` sets its own over it. Chosen here as an agent on a coding CLI chooses it on its CLI tab, which is
 * where an external agent's stays: this card is not shown for one.
 *
 * "Default" takes the agent's own away, so it follows `[llm.defaults] effort`, else the provider's. A model that refuses
 * the level is sent none; one that takes it and ignores it cannot be told apart, so the card says what is sent.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { EFFORT_LEVELS } from "@/commons/lib/api.agents";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/** Its own `[llm] effort`, or "default" where it follows the install's: the same value either way. */
function ownEffort(agent: Pick<AgentSummary, "effort" | "effortDefault">): string {
  return !agent.effort || agent.effort === agent.effortDefault ? "default" : agent.effort;
}

export function AgentEffort({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  /** The level being chosen; `undefined` follows the daemon until one is picked. */
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const value = picked ?? ownEffort(agent);
  const dirty = value !== ownEffort(agent);

  const save = useMutation({
    mutationFn: (effort: string) => api.saveAgentEffort(agent.id, effort),
    onSuccess: async (answer, effort) => {
      saved(answer, effort === "default" ? `${agent.id} follows the default effort` : `${agent.id} thinks at ${effort}`, "From its next turn, in each chat without an /effort of its own.");
      setPicked(undefined);
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  // A daemon from before 0.8.17 says nothing of an effort: no control rather than a dead one.
  if (agent.effort === undefined) return null;

  const follows = agent.effortDefault ? `the effort set for every agent, ${agent.effortDefault}` : "the provider's own, as no effort is set for every agent";
  const hint = value === "default" ? `Default follows ${follows}.` : `Each request asks for ${value}. A model that refuses it is sent none.`;
  return (
    <Card
      title="Effort"
      description="How long the model thinks before it answers, asked for in each of its requests, in every chat. A chat's /effort sets its own over it, and is told when the model refuses the level."
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) save.mutate(value);
        }}
      >
        <Field label="Effort" hint={hint}>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Effort">
            {["default", ...EFFORT_LEVELS].map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={value === choice}
                disabled={!editable}
                onClick={() => setPicked(choice)}
                className={`btn btn-xs rounded-lg font-mono ${value === choice ? "btn-primary" : "btn-ghost border border-base-content/10"}`}
              >
                {choice === "default" ? `Default${agent.effortDefault ? ` (${agent.effortDefault})` : ""}` : choice}
              </button>
            ))}
          </div>
        </Field>

        <ErrorNote error={save.error} />

        <button type="submit" className="btn btn-primary btn-sm rounded-xl active:scale-95 transition-all" disabled={!editable || !dirty || save.isPending}>
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
          Save
        </button>
      </form>
    </Card>
  );
}
