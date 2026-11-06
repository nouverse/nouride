/**
 * How many tool round-trips one reply may take, for every agent that does not say otherwise.
 *
 * ## Why it needs a form and not just a config file
 *
 * It is the setting people most want to change *while something is going wrong*: a turn stopped
 * short, the agent reported a half-finished job, and the fix is a bigger budget for the next
 * attempt. Sending somebody to a TOML file at that moment is how they give up and raise it to
 * something absurd instead.
 *
 * ## Why the guidance is on the control and not only in the docs
 *
 * Because the number looks free and is not. A turn that hits the cap does not fail — the model is
 * asked to summarise and stop — so nothing about the interface suggests a cost, and the obvious
 * move on meeting the limit is to type a much bigger number. Every iteration re-sends the whole
 * conversation, so the spend of one runaway turn grows faster than this number does. The band is
 * named where the decision is made.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/**
 * The recommended range, said by this control and by each agent's (`AgentToolBudget`), so the two cannot differ.
 * Its top is where the returns fall off: past it a turn that has not finished is usually stuck, not busy.
 *
 * A copy of `TOOL_ITERATIONS_ADVISED` (`packages/shared/src/types/config.ts`), which the dashboard cannot import;
 * `tool-budget.test.ts` holds the two together.
 */
export const SWEET_SPOT = { from: 50, to: 250 };

export function ToolBudgetControl() {
  const me = useMe();
  const policy = useQuery({
    queryKey: ["tool-iterations"],
    queryFn: api.toolIterationsPolicy,
    retry: false,
  });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const [draft, setDraft] = useState<string | null>(null);

  // Cleared whenever the daemon reports a different value — another operator's change, or our own
  // save landing.
  useEffect(() => {
    setDraft(null);
  }, [policy.data?.maxToolIterations]);

  const save = useMutation({
    mutationFn: (value: number) => api.setToolIterations(value),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["tool-iterations"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(
        result,
        `Tool budget set to ${result.maxToolIterations} round-trips`,
        "Live from the next turn.",
      );
    },
  });

  const data = policy.data;
  const current = data?.maxToolIterations;
  const value = draft ?? (current === undefined ? "" : String(current));
  const parsed = Number(value);
  const writable = canWrite(me.data ?? null) && (data?.editable ?? false);

  const outOfRange =
    value !== "" && (!Number.isInteger(parsed) || parsed < (data?.min ?? 5) || parsed > (data?.max ?? 9999));
  const high = Number.isInteger(parsed) && parsed > SWEET_SPOT.to;

  return (
    <Card
      title="Tool budget per reply"
      description="How many times an agent may call a tool while answering one message, before it is asked to summarise what it has and stop."
    >
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
            <Repeat size={12} /> Round-trips
          </span>
          <input
            type="number"
            className={`input input-sm w-36 tabular-nums ${outOfRange ? "input-error" : ""}`}
            min={data?.min}
            max={data?.max}
            value={value}
            disabled={!writable || policy.isLoading}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!writable || save.isPending || outOfRange || value === "" || parsed === current}
          onClick={() => save.mutate(parsed)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {draft !== null && parsed !== current && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(null)}>
            Cancel
          </button>
        )}
      </div>

      <p className="text-xs text-base-content/65 mt-3">
        Allowed {data?.min ?? 5}–{data?.max ?? 9999}. <strong>{SWEET_SPOT.from}–{SWEET_SPOT.to}</strong> is
        the range that works: below it a longer piece of work is cut off part-way, and past{" "}
        {SWEET_SPOT.to} a turn runs out of its hour before it runs out of calls.
      </p>
      {high && !outOfRange && (
        <p className="text-xs text-warning mt-1">
          Every round-trip re-sends the whole conversation, so the cost of one long turn grows faster
          than this number does. Above {SWEET_SPOT.to}, prefer a background job.
        </p>
      )}
      <p className="text-xs text-base-content/65 mt-2">
        Agents can override this in their own settings; ones that do not, follow this number.
      </p>
      <ErrorNote error={save.error ?? policy.error} />
    </Card>
  );
}
