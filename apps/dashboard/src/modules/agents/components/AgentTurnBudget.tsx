/**
 * One agent's wall clock, or none — which means it follows the daemon's.
 *
 * The same two states as `AgentToolBudget`, and the switch exists for the same reason: an agent with
 * no value of its own tracks the daemon's, while typing today's default into the field looks
 * identical and pins it for ever. The difference only surfaces months later, when somebody raises
 * the global and one agent quietly does not move.
 *
 * What differs is the cost being described. Round-trips are paid in money; seconds are paid by
 * whoever messages this agent next, because the queue is per chat. So the warning here is about the
 * queue rather than about spend, and its threshold comes from the daemon — `queue_timeout_ms` is
 * configurable, and a hardcoded number here would be wrong on exactly the installs that tuned it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

export function AgentTurnBudget({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const policy = useQuery({ queryKey: ["turn-seconds"], queryFn: api.turnSecondsPolicy, retry: false });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const own = agent.maxTurnSeconds ?? null;
  const daemon = policy.data?.turnSeconds;

  const [overriding, setOverriding] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    setOverriding(null);
    setDraft(null);
  }, [own]);

  const save = useMutation({
    mutationFn: (value: number | null) => api.setAgentTurnSeconds(agent.id, value),
    onSuccess: async (result, value) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(
        result,
        value === null
          ? `${agent.displayName || agent.id} follows the default again`
          : `${agent.displayName || agent.id} capped at ${value}s per reply`,
        value === null
          ? `Currently ${daemon ?? 300}s, and it will track any change to that.`
          : "Live from this agent's next turn.",
      );
    },
  });

  const isOverriding = overriding ?? own !== null;
  const value = draft ?? String(own ?? daemon ?? 300);
  const parsed = Number(value);
  const min = policy.data?.min ?? 30;
  const max = policy.data?.max ?? 3600;
  const outOfRange = !Number.isInteger(parsed) || parsed < min || parsed > max;
  const queueSeconds = policy.data?.queueSeconds;
  const crowdsTheQueue =
    Number.isInteger(parsed) && queueSeconds !== undefined && parsed > queueSeconds / 2;

  const unchanged = isOverriding ? own === parsed : own === null;

  return (
    <Card
      title="Turn budget"
      description="How long this agent may take answering one message, tool calls included, before it is asked to wrap up."
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
          {isOverriding ? "This agent has its own clock" : "Follows the default"}
          {!isOverriding && daemon !== undefined && (
            <span className="text-base-content/65"> (currently {daemon}s, and it tracks changes to it)</span>
          )}
        </span>
      </label>

      {isOverriding && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label>
            <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
              <Timer size={12} /> Seconds
            </span>
            <input
              type="number"
              className={`input input-sm w-36 tabular-nums ${outOfRange ? "input-error" : ""}`}
              min={min}
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
        Allowed {min}–{max} seconds. Anything genuinely slower than a few minutes belongs in a
        background job, which does not hold the chat.
      </p>
      {isOverriding && crowdsTheQueue && !outOfRange && (
        <p className="text-xs text-warning mt-1">
          The queue is per chat, and drops anything waiting past {queueSeconds}s. At {parsed}s, a
          second message arriving mid-turn spends most of that window waiting.
        </p>
      )}
      <ErrorNote error={save.error} />
    </Card>
  );
}
