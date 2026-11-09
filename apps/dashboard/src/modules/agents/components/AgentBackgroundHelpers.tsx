/**
 * How many helpers one agent may have working in the background at once (0.7.15) — `[delegate] max_background` in
 * its pack — or none of its own, which means it follows the daemon's.
 *
 * The same two states as `AgentJobQuiet`, for the same reason: typing today's default into the field pins it, and the
 * difference only shows the day somebody moves the daemon's. Live: the next helper the agent starts is held to it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/** `2` → what the agent is told it may do — said the way the agent itself is told (`harness-delegate.ts`). */
export function helpersSaid(limit: number): string {
  if (limit <= 0) return "Off: it hands work to helpers only in the foreground, and waits for them.";
  if (limit === 1) return "One at a time: a task that takes a while goes to a helper, and the agent stays free for the person.";
  return `Up to ${limit} at once: one for a task that takes a while, more only for independent pieces.`;
}

export function AgentBackgroundHelpers({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const policy = useQuery({ queryKey: ["delegate-policy"], queryFn: api.delegatePolicy, retry: false });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const own = agent.maxBackgroundHelpers ?? null;
  const daemon = policy.data?.maxBackground;
  const max = policy.data?.max ?? 4;

  const [overriding, setOverriding] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setOverriding(null);
    setDraft(null);
  }, [own]);

  const save = useMutation({
    mutationFn: (value: number | null) => api.setAgentMaxBackground(agent.id, value),
    onSuccess: async (result, value) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      const name = agent.displayName || agent.id;
      saved(
        result,
        value === null ? `${name} follows the default again` : value === 0 ? `${name} runs no helpers in the background` : `${name} may run ${value} in the background`,
        value === null ? `Currently ${daemon ?? 2}, and it tracks changes to that.` : "Live from the next helper it starts.",
      );
    },
  });

  const isOverriding = overriding ?? own !== null;
  const value = draft ?? String(own ?? daemon ?? 2);
  const parsed = Number(value);
  const outOfRange = !Number.isInteger(parsed) || parsed < 0 || parsed > max;
  const unchanged = isOverriding ? own === parsed : own === null;

  return (
    <Card
      title="Helpers in the background"
      description="How many helpers this agent may have working at once while it stays free to talk, each a job of its own, whose result it reports as that helper finishes. A helper it was waiting for, or an agent it asked, that is still working after a minute counts here too: its result comes back the same way."
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
          {isOverriding ? "This agent has its own limit" : "Follows the default"}
          {!isOverriding && daemon !== undefined && (
            <span className="text-base-content/65"> (currently {daemon === 0 ? "off" : daemon}, and it tracks changes to it)</span>
          )}
        </span>
      </label>

      {isOverriding && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label>
            <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
              <Bot size={12} /> At once
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
        {isOverriding && !outOfRange ? helpersSaid(parsed) : `0 (off) to ${max}. ${helpersSaid(own ?? daemon ?? 2)}`}
      </p>
      <ErrorNote error={save.error} />
    </Card>
  );
}
