/**
 * How many days of a record to keep, set where the record is read: each System Logs panel, and Helpers & jobs (0.8.12),
 * which shows the same rows the jobs panel does and is where the owner looks for them.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { api, type RetentionScope } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { useSaved } from "@/commons/hooks/use-saved";

/**
 * What each retention window governs, and where it is written.
 *
 * Four different windows, deliberately — the audit log is one row per decision and worth keeping,
 * the daemon log is every line the process printed. Which is exactly why the control sits *inside*
 * each panel: above the tabs it looked like one page-level setting for everything, and it never was.
 */
const RETENTION_META = {
  log: {
    governs: "these log lines",
    key: "[retention] log_days",
    max: 90,
    note: "The server's own system log keeps the full history either way.",
  },
  audit: {
    governs: "audit rows",
    key: "[retention] audit_days",
    max: 3650,
    note: "The record of authority. Kept far longer than the log, on purpose.",
  },
  cronRuns: {
    governs: "run history",
    key: "[cron] run_retention_days",
    max: 365,
    note: "Per job, across every job.",
  },
  jobLogs: {
    governs: "these jobs and what they printed",
    key: "[retention] job_log_days",
    max: 365,
    note: "Counted from when it last printed anything. A job still running is never deleted.",
  },
  /**
   * Deliberately not every scope.
   *
   * `sessions` is a retention window too and it does not belong on this page: these four govern
   * records the host's journal or the job's own output file holds a second copy of, and that one
   * governs the conversations themselves. It lives on Agent Settings, as a card with a confirmation,
   * because lowering it is a delete with no undo rather than a housekeeping preference.
   *
   * `satisfies` rather than an annotation, so a typo in a key is still a compile error while a scope
   * this page does not show is not required to appear here.
   */
} satisfies Partial<Record<RetentionScope, { governs: string; key: string; max: number; note: string }>>;

/** The windows a page shows, derived so the two cannot disagree. */
export type RetentionShown = keyof typeof RETENTION_META;

/**
 * How many days of this panel's record to keep.
 *
 * On this page rather than in a settings screen, because this is where somebody discovers the window
 * was wrong — either it did not reach far enough back, or they have just read how many entries it is
 * holding.
 *
 * Fetches its own number and its own permission rather than being handed them: the query key is
 * shared, so React Query serves every instance from one request, and the alternative was drilling
 * two props through four panels for a control that is the same control each time.
 */
export function RetentionControl({ scope }: { scope: RetentionShown }) {
  const queryClient = useQueryClient();
  const me = useMe();
  const windows = useQuery({ queryKey: ["retention"], queryFn: api.retention, retry: false });
  const [draft, setDraft] = useState<string | null>(null);

  const meta = RETENTION_META[scope];
  const days = windows.data?.windows[scope];
  const editable = canWrite(me.data ?? null) && me.data?.role === "admin";

  const saved = useSaved();
  const save = useMutation({
    mutationFn: () => api.setRetention(scope, Number(draft)),
    onSuccess: (answer) => {
      saved(answer, `Kept for ${draft} day(s)`, "Applied at the next clean-up: when Nouride starts, and once a day.");
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["retention"] });
    },
  });

  // Nothing at all until the number is known: a box showing a default that is not this daemon's
  // value is worse than a box that has not appeared yet.
  if (days === undefined) return null;

  const value = draft ?? String(days);
  const dirty = value.trim() !== "" && Number(value) !== days;

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-0.5 text-xs text-base-content/65">
      <span>Keep {meta.governs} for</span>
      <input
        className="input input-xs w-14 rounded-lg font-mono text-center"
        type="number"
        min={0}
        max={meta.max}
        value={value}
        disabled={!editable}
        onChange={(e) => setDraft(e.target.value)}
      />
      <span>days</span>
      {dirty && editable && (
        <button
          type="button"
          className="btn btn-primary btn-xs rounded-lg"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : "Save"}
        </button>
      )}
      {dirty && editable && (
        <button
          type="button"
          className="btn btn-ghost btn-xs rounded-lg px-1.5"
          onClick={() => setDraft(null)}
          aria-label="Cancel"
        >
          <X size={12} />
        </button>
      )}
      {save.isSuccess && !dirty && (
        <span className="text-success inline-flex items-center gap-1 font-semibold">
          <Check size={12} /> saved
        </span>
      )}
      <span>0 keeps everything.</span>
      <Details>
        <p>
          <span className="font-mono">{meta.key}</span> in config.toml. {meta.note}
        </p>
      </Details>
      <ErrorNote error={save.error} />
    </div>
  );
}
