/**
 * The most this daemon may spend on models in a day — for the **whole daemon**, not one agent.
 *
 * Shown with today's spend beside it, because the cap is not calibratable without it. "Is 20 dollars
 * generous, or about to refuse the next turn?" has no answer on this page otherwise, and the number
 * is already recorded — so leaving it out would mean reading the cap here and the usage on the
 * Monitor page to make one decision.
 *
 * `0` means no cap and says so in words rather than showing an empty field. The config carried
 * `max_daily_cost_usd` for a whole phase while nothing recorded spend, so the number read like a
 * budget and enforced nothing; a control that displays `0` as though it were a small budget would
 * repeat that in the UI.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CircleDollarSign } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { NoSettingsFile } from "@/commons/components/ui/NoSettingsFile";
import { useToast } from "@/commons/components/ui/toast";
import { useSaved } from "@/commons/hooks/use-saved";

const MAX_CAP = 10_000;

export function SpendCapControl() {
  const me = useMe();
  const policy = useQuery({
    queryKey: ["spend-policy"],
    queryFn: api.spendPolicy,
    retry: false,
  });
  const queryClient = useQueryClient();
  const toast = useToast();
  const announce = useSaved();

  const [draft, setDraft] = useState<string | null>(null);

  // Cleared whenever the daemon reports a different value — another operator's change, or our own
  // save landing.
  useEffect(() => {
    setDraft(null);
  }, [policy.data?.maxDailyCostUsd]);

  const save = useMutation({
    mutationFn: (usd: number) => api.setDailyCostCap(usd),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["spend-policy"] });
      announce(
        result,
        result.maxDailyCostUsd === 0
          ? "Spend cap removed"
          : `Spend cap set to ${result.maxDailyCostUsd.toFixed(2)} USD a day`,
        result.maxDailyCostUsd === 0
          ? "Nothing will refuse a turn on cost."
          : "Live from the next turn.",
      );
    },
    // The toast carries the failure too, because this control can be saved and left immediately and
    // `ErrorNote` below only helps somebody still looking at it.
    onError: (error: unknown) => toast.error("Could not save the spend cap", error),
  });

  // A daemon with no config file to write gets no control rather than a dead one.
  if (policy.error || !policy.data) return null;

  const saved = policy.data.maxDailyCostUsd;
  const value = draft ?? (saved === 0 ? "" : String(saved));
  const parsed = value.trim() === "" ? 0 : Number(value);
  const valid =
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= MAX_CAP &&
    Math.round(parsed * 100) === parsed * 100;
  const editable = policy.data.editable !== false;
  const writable = canWrite(me.data ?? null);
  const dirty = valid && parsed !== saved;

  const spent = policy.data.spentTodayUsd;
  const pct = saved > 0 && spent !== null ? (spent / saved) * 100 : null;

  return (
    <div className="rounded-2xl border border-base-content/[0.08] bg-base-100/80 backdrop-blur-xl p-5 shadow-xs space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-bold text-sm tracking-tight text-base-content flex items-center gap-2">
            <CircleDollarSign
              size={15}
              className={saved > 0 ? "text-success" : "text-base-content/65"}
            />
            Daily spend cap
            <span className="badge badge-xs badge-ghost font-semibold font-mono">all agents</span>
          </p>
          <p className="text-base-content/65 text-sm mt-1 max-w-prose">
            {saved > 0 ? (
              <>
                Once today&apos;s model spend reaches{" "}
                <span className="font-semibold">{saved.toFixed(2)} USD</span>, turns are refused
                until the day rolls over in this server&apos;s time zone. Past{" "}
                {policy.data.alertThresholdPct}% of it a turn still runs and carries a warning, so
                the ceiling announces itself before it becomes a wall.
              </>
            ) : (
              "No cap. Nothing refuses a turn on cost; a loop that retries a large context can spend a lot before anyone notices."
            )}
          </p>

          {spent === null ? (
            <p className="text-base-content/65 text-xs mt-1.5">
              This server keeps no record of what is spent, so a cap here could not be held.
            </p>
          ) : (
            <p className="text-base-content/65 text-xs mt-1.5">
              Spent today: <span className="font-semibold">{spent.toFixed(4)} USD</span>
              {pct !== null ? <> · {pct.toFixed(0)}% of the cap</> : null}
              {policy.data.unpricedRequests > 0 ? (
                <>
                  {" "}
                  · plus {policy.data.unpricedRequests} call(s) on a model with no published price,
                  so the real figure is higher
                </>
              ) : null}
            </p>
          )}

          {!editable && <NoSettingsFile keys={["[llm.limits] max_daily_cost_usd"]} />}
        </div>

        <div className="flex items-center gap-3">
          <label className="input input-sm rounded-xl flex items-center gap-2 w-36">
            <span className="text-base-content/65 text-xs">USD</span>
            <input
              type="number"
              min={0}
              max={MAX_CAP}
              step={0.5}
              className="grow text-sm"
              aria-label="Daily spend cap in USD"
              // Empty rather than `0`, so the field reads as "no cap" instead of as a cap of nothing.
              placeholder="no cap"
              value={value}
              disabled={!writable || !editable || save.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>

          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={!writable || !editable || !dirty || save.isPending}
            onClick={() => save.mutate(parsed)}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Save
          </button>
        </div>
      </div>

      {!valid && (
        <div role="alert" className="alert alert-warning alert-soft text-sm">
          <span>
            Enter dollars with at most two decimal places, up to {MAX_CAP.toLocaleString()}, or
            leave it empty for no cap.
          </span>
        </div>
      )}

      <ErrorNote error={save.error} />
    </div>
  );
}
