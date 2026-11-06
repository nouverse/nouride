/**
 * How long a background job may print nothing before its agent tells the person it is still running
 * — for every agent that does not say otherwise.
 *
 * The notice repeats at double the wait, and double again, so the number shown is also the spacing
 * the person will hear it at: 5 means 5, 10, 20, 40 minutes. Nothing is ever stopped by it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/** `5` → "5, 10, 20, 40 minutes". The schedule, said the way the person will meet it. */
export function quietSchedule(minutes: number): string {
  if (minutes <= 0) return "never";
  return `${[0, 1, 2, 3].map((n) => minutes * 2 ** n).join(", ")}… minutes`;
}

export function JobQuietControl() {
  const me = useMe();
  const policy = useQuery({ queryKey: ["job-quiet"], queryFn: api.jobQuietPolicy, retry: false });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    setDraft(null);
  }, [policy.data?.minutes]);

  const save = useMutation({
    mutationFn: (value: number) => api.setJobQuietMinutes(value),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["job-quiet"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(
        result,
        result.minutes === 0 ? "Quiet-job notices are off" : `Quiet jobs are reported after ${result.minutes} min`,
        result.minutes === 0 ? "Jobs still report when they finish." : `Then at ${quietSchedule(result.minutes)}. Live now.`,
      );
    },
  });

  const data = policy.data;
  const current = data?.minutes;
  const value = draft ?? (current === undefined ? "" : String(current));
  const parsed = Number(value);
  const writable = canWrite(me.data ?? null) && (data?.editable ?? false);
  const outOfRange = value !== "" && (!Number.isInteger(parsed) || parsed < 0 || parsed > (data?.max ?? 1440));

  return (
    <Card
      title="Quiet background jobs"
      description="How long a background job may print nothing before its agent tells the person it is still running. Nothing is stopped for being quiet."
    >
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
            <Hourglass size={12} /> Minutes
          </span>
          <input
            type="number"
            className={`input input-sm w-36 tabular-nums ${outOfRange ? "input-error" : ""}`}
            min={0}
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
        {!outOfRange && value !== ""
          ? parsed === 0
            ? "Off: a job is only reported when it finishes."
            : `A quiet job is reported at ${quietSchedule(parsed)}. New output starts the count over.`
          : `0 (off) to ${data?.max ?? 1440} minutes.`}
      </p>
      <p className="text-xs text-base-content/65 mt-2">
        Agents can override this in their own settings; ones that do not, follow this number.
      </p>
      <ErrorNote error={save.error ?? policy.error} />
    </Card>
  );
}
