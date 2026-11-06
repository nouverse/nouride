/**
 * One agent's quiet-job wait, or none — which means it follows the daemon's.
 *
 * The same two states as `AgentTurnBudget`, for the same reason: typing today's default into the
 * field pins it, and the difference only shows the day somebody moves the global.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { api, type AgentSummary } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { quietSchedule } from "./JobQuietControl";

export function AgentJobQuiet({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const policy = useQuery({ queryKey: ["job-quiet"], queryFn: api.jobQuietPolicy, retry: false });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const own = agent.jobQuietAfterMinutes ?? null;
  const daemon = policy.data?.minutes;

  const [overriding, setOverriding] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setOverriding(null);
    setDraft(null);
  }, [own]);

  const save = useMutation({
    mutationFn: (value: number | null) => api.setAgentJobQuietMinutes(agent.id, value),
    onSuccess: async (result, value) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      const name = agent.displayName || agent.id;
      saved(
        result,
        value === null ? `${name} follows the default again` : value === 0 ? `${name} never reports quiet jobs` : `${name} reports quiet jobs after ${value} min`,
        value === null ? `Currently ${daemon ?? 5} min, and it tracks changes to that.` : "Live from the next check, within a minute.",
      );
    },
  });

  const isOverriding = overriding ?? own !== null;
  const value = draft ?? String(own ?? daemon ?? 5);
  const parsed = Number(value);
  const max = policy.data?.max ?? 1440;
  const outOfRange = !Number.isInteger(parsed) || parsed < 0 || parsed > max;
  const unchanged = isOverriding ? own === parsed : own === null;

  return (
    <Card
      title="Quiet background jobs"
      description="How long one of this agent's background jobs may print nothing before it tells the person the job is still running."
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
          {isOverriding ? "This agent has its own wait" : "Follows the default"}
          {!isOverriding && daemon !== undefined && (
            <span className="text-base-content/65"> (currently {daemon === 0 ? "off" : `${daemon} min`}, and it tracks changes to it)</span>
          )}
        </span>
      </label>

      {isOverriding && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label>
            <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
              <Hourglass size={12} /> Minutes
            </span>
            <input
              type="number"
              className={`input input-sm w-36 tabular-nums ${outOfRange ? "input-error" : ""}`}
              min={0}
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
        {isOverriding && !outOfRange
          ? parsed === 0
            ? "Off for this agent: its jobs are only reported when they finish."
            : `Reported at ${quietSchedule(parsed)}. Nothing is stopped for being quiet.`
          : `0 (off) to ${max} minutes. Nothing is stopped for being quiet.`}
      </p>
      <ErrorNote error={save.error} />
    </Card>
  );
}
