/**
 * How long this install keeps conversations — for the **whole daemon**.
 *
 * A card rather than the small inline input the log windows get, because it is not the same kind of
 * setting wearing a different size. The log windows govern records with a second copy somewhere
 * else: the journal on the host holds every line the daemon printed either way. This one governs the
 * conversations themselves, and there is no second copy of those anywhere.
 *
 * So lowering it is a delete, on a timer, with no undo — and the number of days between the old
 * value and the new one is how much history goes. That is worth a sentence and a confirmation, not
 * a 14-pixel box beside a tab.
 *
 * One number covers three tables, and the copy says so: `sessions.context` is what was said,
 * `turn_records` is the same history seen from the other side, and `chat_events` annotates it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Archive } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { useSaved } from "@/commons/hooks/use-saved";

const MAX_DAYS = 3650;

export function SessionRetentionControl() {
  const me = useMe();
  // The same query key the log page's control uses, so React Query serves both from one request and
  // a save on either is reflected in the other.
  const windows = useQuery({ queryKey: ["retention"], queryFn: api.retention, retry: false });
  const queryClient = useQueryClient();
  const toast = useToast();
  const announce = useSaved();
  const { ask, dialog } = useConfirm();

  const [draft, setDraft] = useState<string | null>(null);
  const saved = windows.data?.windows.sessions;

  useEffect(() => {
    setDraft(null);
  }, [saved]);

  const save = useMutation({
    mutationFn: (days: number) => api.setRetention("sessions", days),
    onSuccess: (result) => {
      const days = result.windows.sessions;
      void queryClient.invalidateQueries({ queryKey: ["retention"] });
      announce(
        result,
        days === 0 ? "Conversations are now kept forever" : `Conversations kept for ${days} days`,
        "Applied at the next clean-up: when Nouride starts, and once a day.",
      );
    },
    onError: (error: unknown) => toast.error("Could not save the retention window", error),
  });

  // Nothing until the number is known: a box showing a default that is not this daemon's value is
  // worse than a box that has not appeared yet.
  if (windows.error || saved === undefined) return null;

  const value = draft ?? String(saved);
  const parsed = value.trim() === "" ? Number.NaN : Number(value);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_DAYS;
  const writable = canWrite(me.data ?? null) && me.data?.role === "admin";
  const dirty = valid && parsed !== saved;
  /** Lowering it deletes; raising it only keeps more. `0` never deletes — it keeps everything. */
  const deletes = dirty && parsed !== 0 && (saved === 0 || parsed < saved);

  async function handleSave() {
    if (!valid) return;
    if (deletes) {
      const confirmed = await ask({
        title: `Keep only ${parsed} days of conversation?`,
        body: (
          <>
            The next clean-up will permanently delete every conversation, record of an agent's work and room event
            older than that
            {saved === 0 ? " (nothing has ever been deleted here)" : ` (currently ${saved} days)`}
            . There is no undo and no second copy.
          </>
        ),
        confirmLabel: "Delete older history",
      });
      if (!confirmed) return;
    }
    save.mutate(parsed);
  }

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-bold text-sm tracking-tight text-base-content flex items-center gap-2">
            <Archive size={15} className={saved === 0 ? "text-base-content/40" : "text-info"} />
            Conversation history
            <span className="badge badge-xs badge-ghost font-semibold font-mono">all agents</span>
          </p>
          <p className="text-base-content/65 text-sm mt-1 max-w-prose">
            {saved === 0 ? (
              <>
                Kept forever. Nothing is ever deleted, which is the safe answer, and the one that in time
                makes the history too big to back up.
              </>
            ) : (
              <>
                Conversations older than <span className="font-semibold">{saved} days</span> are
                deleted at the daily clean-up. One window covers three records (what was said, what
                each turn did, and what happened to the room) because keeping any of them past the
                conversation they belong to leaves steps for a transcript that is gone.
              </>
            )}
          </p>
          <p className="text-base-content/65 text-xs mt-1.5">
            Unlike the log windows on the Logs page, there is no second copy of this anywhere.{" "}
            <code className="bg-base-200 px-1.5 py-0.5 rounded text-xs font-mono">0</code> keeps
            everything.
          </p>
          {!writable && (
            <p className="text-base-content/65 text-xs mt-1.5">
              Admins only: this deletes history for every agent.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <label className="input input-sm rounded-xl flex items-center gap-2 w-32">
            <input
              type="number"
              min={0}
              max={MAX_DAYS}
              step={1}
              className="grow text-sm"
              aria-label="Days of conversation history to keep"
              value={value}
              disabled={!writable || save.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <span className="text-base-content/65 text-xs whitespace-nowrap">days</span>
          </label>

          <button
            type="button"
            className={`btn btn-sm rounded-xl shadow-xs active:scale-95 transition-all ${
              deletes ? "btn-error" : "btn-primary"
            }`}
            disabled={!writable || !dirty || save.isPending}
            onClick={() => void handleSave()}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            {deletes ? "Save & delete" : "Save"}
          </button>
        </div>
      </div>

      {!valid && (
        <div role="alert" className="alert alert-warning alert-soft text-sm">
          <span>Enter a whole number of days between 0 and {MAX_DAYS.toLocaleString()}.</span>
        </div>
      )}

      <ErrorNote error={save.error} />
      {dialog}
    </div>
  );
}
