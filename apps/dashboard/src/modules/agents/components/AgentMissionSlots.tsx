/**
 * How many missions one agent may have working at once (0.8.11) — `[missions] per_agent` in its pack — or none of its
 * own, which means it follows the daemon's, set on the Missions page. Set per agent, so one can have three or four.
 *
 * The same two states as `AgentBackgroundHelpers`, for the same reason: typing today's default into the field pins it.
 * Live: the dispatcher reads it at its next decision. The box's own `max_running` still bounds them all.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/** `3` → what it means for the agent's missions, as the queue notice says it. */
export function missionsSaid(slots: number): string {
  if (slots <= 1) return "One at a time: the next waits in the queue and starts by itself.";
  return `Up to ${slots} at once, each in a folder of its own. Two in one repository still take turns.`;
}

export function AgentMissionSlots({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const policy = useQuery({ queryKey: ["mission-settings"], queryFn: api.missionSettings, retry: false });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const own = agent.missionsPerAgent ?? null;
  const daemon = policy.data?.perAgent;
  const max = policy.data?.bounds.perAgent.max ?? 4;

  const [overriding, setOverriding] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setOverriding(null);
    setDraft(null);
  }, [own]);

  const save = useMutation({
    mutationFn: (value: number | null) => api.setAgentMissionsPerAgent(agent.id, value),
    onSuccess: async (result, value) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      await queryClient.invalidateQueries({ queryKey: ["mission-settings"] });
      const name = agent.displayName || agent.id;
      saved(
        result,
        value === null ? `${name} follows the default again` : `${name} may run ${value} ${value === 1 ? "mission" : "missions"} at once`,
        value === null ? `Currently ${daemon ?? 1}, and it tracks changes to that.` : "Live from its next mission.",
      );
    },
  });

  const isOverriding = overriding ?? own !== null;
  const value = draft ?? String(own ?? daemon ?? 1);
  const parsed = Number(value);
  const outOfRange = !Number.isInteger(parsed) || parsed < 1 || parsed > max;
  const unchanged = isOverriding ? own === parsed : own === null;

  return (
    <Card
      title="Missions at once"
      description="How many of this agent's missions may work at the same time. The next one waits in the queue and starts by itself. The limit for the whole server, on the Missions page, still holds them all."
    >
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="toggle toggle-sm toggle-primary"
          checked={isOverriding}
          disabled={!editable || save.isPending}
          onChange={(event) => {
            setOverriding(event.target.checked);
            setDraft(null);
          }}
        />
        <span className="text-sm">
          {isOverriding ? "This agent has its own number" : "Follows the default"}
          {!isOverriding && daemon !== undefined && <span className="text-base-content/65"> (currently {daemon}, and it tracks changes to it)</span>}
        </span>
      </label>

      {isOverriding && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label>
            <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
              <Target size={12} /> At once
            </span>
            <input
              type="number"
              className={`input input-sm w-36 tabular-nums ${outOfRange ? "input-error" : ""}`}
              min={1}
              max={max}
              value={value}
              disabled={!editable || save.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!editable || save.isPending || unchanged || (isOverriding && outOfRange)}
          onClick={() => save.mutate(isOverriding ? parsed : null)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {!unchanged && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setOverriding(null);
              setDraft(null);
            }}
          >
            Cancel
          </button>
        )}
      </div>

      <p className="text-xs text-base-content/65 mt-3">
        {isOverriding && !outOfRange ? missionsSaid(parsed) : `1 to ${max}. ${missionsSaid(own ?? daemon ?? 1)}`}
      </p>
      <ErrorNote error={save.error} />
    </Card>
  );
}
