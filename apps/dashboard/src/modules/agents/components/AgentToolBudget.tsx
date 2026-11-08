/**
 * One agent's tool budget, or none — which means it follows the daemon's.
 *
 * ## The two states, and why "follow" is not the same as typing the default
 *
 * An agent with no value of its own tracks the daemon's, so raising the global later raises this
 * agent too. Typing today's default into the field looks identical and behaves differently: it
 * pins the agent at that number for ever, and the difference only shows up months later when
 * somebody changes the global and one agent quietly does not move.
 *
 * So there is a switch, not just a field. On means "this agent has its own"; off means "follow",
 * and saves `null` rather than a number.
 *
 * ## Why an agent would want its own
 *
 * The daemon's number is a compromise across every agent on it. One doing long refactors needs
 * room; one answering questions in a group chat is where a runaway turn is both expensive and slow
 * to notice. That is the whole case for the override — it lets the compromise be broken in one
 * direction without breaking it in the other.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { SWEET_SPOT } from "./ToolBudgetControl";

export function AgentToolBudget({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const policy = useQuery({
    queryKey: ["tool-iterations"],
    queryFn: api.toolIterationsPolicy,
    retry: false,
  });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const own = agent.maxToolIterations ?? null;
  const daemon = policy.data?.maxToolIterations;

  const [overriding, setOverriding] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  // Reset whenever the daemon reports a different answer for this agent — our save landing, or
  // somebody else's.
  useEffect(() => {
    setOverriding(null);
    setDraft(null);
  }, [own]);

  const save = useMutation({
    mutationFn: (value: number | null) => api.setAgentToolIterations(agent.id, value),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(
        result,
        result.maxToolIterations === null
          ? `${agent.displayName || agent.id} follows the default again`
          : `${agent.displayName || agent.id} capped at ${result.maxToolIterations} round-trips`,
        result.maxToolIterations === null
          ? `Currently ${result.daemonDefault}, and it will track any change to that.`
          : "Live from this agent's next turn.",
      );
    },
  });

  const isOverriding = overriding ?? own !== null;
  const value = draft ?? (own === null ? String(daemon ?? SWEET_SPOT.from) : String(own));
  const parsed = Number(value);
  const min = policy.data?.min ?? 5;
  const max = policy.data?.max ?? 9999;
  const outOfRange = !Number.isInteger(parsed) || parsed < min || parsed > max;
  const high = Number.isInteger(parsed) && parsed > SWEET_SPOT.to;

  const unchanged = isOverriding ? own === parsed : own === null;

  return (
    <Card
      title="Tool budget"
      description="How many times this agent may call a tool while answering one message, before it is asked to summarise and stop."
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
          {isOverriding ? "This agent has its own budget" : "Follows the default"}
          {!isOverriding && daemon !== undefined && (
            <span className="text-base-content/65"> (currently {daemon}, and it tracks changes to it)</span>
          )}
        </span>
      </label>

      {isOverriding && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label>
            <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
              <Repeat size={12} /> Round-trips
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
        Allowed {min}–{max}. <strong>{SWEET_SPOT.from}–{SWEET_SPOT.to}</strong> is the range that
        works. Below it a longer piece of work is cut off part-way, and past {SWEET_SPOT.to} a turn runs out
        of its hour before it runs out of calls.
      </p>
      {isOverriding && high && !outOfRange && (
        <p className="text-xs text-warning mt-1">
          Every round-trip re-sends the whole conversation, so one long turn costs more than
          proportionally. Above {SWEET_SPOT.to}, prefer a background job.
        </p>
      )}
      <ErrorNote error={save.error} />
    </Card>
  );
}
