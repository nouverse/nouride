/**
 * Which releases this install is offered (0.8.18, PLAN §3.3): the newest, or a long-term line (1.0 the first) that it
 * moves to and stays on. Both choices say what each would install now, so "1.0.7, long-term" and "1.1.0, newest" sit
 * side by side once both exist; until then they offer the same. Picking one saves it at once: it changes what is
 * offered and installs nothing. An admin's choice, as everything that decides what replaces the binary is.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { UpdateStatus, UpdateTrack } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { UPDATE_QUERY_KEY } from "@/commons/hooks/use-update";
import { isAdmin, useMe } from "@/commons/lib/session";

type Check = NonNullable<UpdateStatus["check"]>;

const TRACKS: { id: UpdateTrack; label: string; summary: string }[] = [
  { id: "latest", label: "Newest", summary: "Every update as soon as it is out: new features and fixes." },
  { id: "lts", label: "Stable", summary: "Stays on version 1 and gets fixes only. You are told when a newer version is out." },
];

/** What a track would install now: this one's newest, the other's when the daemon named it, else the same. */
function offered(check: Check, track: UpdateTrack): string {
  if (track !== check.track && check.otherTrack?.track === track) return check.otherTrack.tag;
  return check.newer ? check.latest : `${check.current}, installed`;
}

export function TrackCard({ check }: { check: Check }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (track: UpdateTrack) => api.setUpdateTrack(track),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: UPDATE_QUERY_KEY }),
  });
  // A daemon before 0.8.18 has no tracks.
  if (!check.track) return null;

  return (
    <Card title="Which updates" description="Choose the updates this Nouride gets.">
      <div role="radiogroup" aria-label="Which updates" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TRACKS.map((track) => {
          const on = track.id === check.track;
          return (
            <button
              key={track.id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!admin || save.isPending}
              onClick={() => !on && save.mutate(track.id)}
              className={`text-left rounded-box border p-3 transition-colors active:scale-[0.99] ${on ? "border-primary bg-primary/5" : "border-base-content/10 hover:border-base-content/30"} disabled:cursor-default`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm">{track.label}</span>
                <span className="text-xs font-mono opacity-70">{offered(check, track.id)}</span>
              </span>
              <span className="block text-xs opacity-70 mt-1">{track.summary}</span>
            </button>
          );
        })}
      </div>
      {!admin && <p className="text-xs opacity-70 mt-2">Only an admin can change this.</p>}
      {save.error ? <div className="mt-2"><ErrorNote error={save.error} /></div> : null}
    </Card>
  );
}
