/**
 * What the page says while the daemon restarts or is not answering, instead of signing anybody out (`session.ts`) or
 * failing every query on it — one strip above the page, whichever way the restart began (`commons/lib/restart.ts`).
 *
 * A restart from Overview, a save that needs one, an update installing, another tab or the CLI: each leaves the daemon
 * silent for seconds, on a slow box for a minute. The cookie is as good as it was, so the page stays — with whatever was
 * typed in it — says what is happening, and picks up again by itself when the daemon does. The follower holds the
 * page's queries meanwhile, so nothing on it turns into an error and back.
 */

import { Mascot } from "@/commons/components/brand/Mascot";
import { useEffect, useRef } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { RestartButton } from "@/commons/components/box/RestartButton";
import { useToast } from "@/commons/components/ui/toast";
import { restartNow, useRestart, useRestartPending, useRestartsFinished, type RestartState } from "@/commons/lib/restart";

const STRIP = "alert rounded-none border-0 border-b px-4 py-2 text-xs flex flex-wrap items-center gap-2 shrink-0";

/** The words for where a restart is. */
function line(state: Exclude<RestartState, { phase: "idle" }>): string {
  if (state.phase === "rolled-back") return `Back on ${state.running}, not ${state.expected}: the new version did not start.`;
  if (state.phase === "back") return "Back. Loading the new dashboard…";
  if (state.phase === "stuck") return "Nothing has answered for longer than a restart takes.";
  if (state.phase === "waiting") return "Restart asked. Nouride finishes what is running first.";
  return state.kind === "outage"
    ? "Reconnecting to Nouride; it is probably restarting. Nothing on this page is lost; it picks up again on its own."
    : "Restarting. This page comes back by itself.";
}

/** Above the page, which stays as it was. `offline` is the session's own reading, for a first load during a boot. */
export function ReconnectingBanner({ offline }: { offline: boolean }) {
  const state = useRestart();
  // Nothing followed now — none yet, or an update that rolled back, which is the update page's card to say, with what
  // to do about it. Whether the daemon answers is then the session's own reading: a rollback said once does not hide
  // an outage after it.
  if (state.phase === "idle" || state.phase === "rolled-back") {
    if (!offline) return null;
    return (
      <div role="status" aria-live="polite" className={`${STRIP} alert-warning bg-warning/10 text-warning border-warning/20`}>
        <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />
        <span className="font-medium">{line({ phase: "restarting", kind: "outage", note: null, startedAt: 0 })}</span>
      </div>
    );
  }
  const stuck = state.phase === "stuck";
  return (
    <div role="status" aria-live="polite" className={`${STRIP} ${stuck ? "alert-warning bg-warning/10 text-warning border-warning/20" : "alert-info bg-info/10 text-info border-info/20"}`}>
      {!stuck && <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />}
      <span className="font-medium flex-1 min-w-0" title={state.note ?? undefined}>
        {line(state)}
      </span>
      {state.phase === "waiting" && (
        <button type="button" className="btn btn-info btn-xs" onClick={restartNow}>
          Restart now
        </button>
      )}
      {stuck && (
        <button type="button" className="btn btn-warning btn-xs gap-1" onClick={() => window.location.reload()}>
          <RotateCw size={12} aria-hidden="true" /> Reload
        </button>
      )}
    </div>
  );
}

/**
 * "Saved (takes effect after a restart)", for every save since the last restart that waits for one, with the Restart
 * button beside it — whichever page the save was made on, and until a restart happens.
 */
export function RestartPendingBar() {
  const pending = useRestartPending();
  const state = useRestart();
  if (pending.length === 0 || state.phase !== "idle") return null;
  return (
    <div role="status" className={`${STRIP} alert-warning bg-warning/10 text-warning border-warning/20`}>
      <span className="font-medium flex-1 min-w-0">
        Saved, takes effect after a restart: <span className="font-mono">{pending.join(" · ")}</span>
      </span>
      <RestartButton className="btn-xs" />
    </div>
  );
}

/** Says once that a restart asked for here is over — the page has already refreshed itself. */
export function RestartedToast() {
  const finished = useRestartsFinished();
  const toast = useToast();
  const seen = useRef(finished);
  useEffect(() => {
    if (finished === seen.current) return;
    seen.current = finished;
    toast.success("Restarted", "Nouride is back, and this page with it.");
  }, [finished, toast]);
  return null;
}

/** A first load while the daemon boots: nobody known yet to show a page to, and the login form would be wrong. */
export function ReconnectingScreen() {
  // The one pose built into the bundle (`Mascot`'s `offline`): nothing more can be fetched from a daemon that does not
  // answer, so a picture it had to serve would be a broken image here.
  return (
    <div className="bg-app flex min-h-screen items-center justify-center p-4">
      <div role="status" aria-live="polite" className="flex w-full max-w-sm flex-col items-center gap-3 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-6 text-center shadow-soft">
        <Mascot pose="offline" decorative className="w-32" />
        <h1 className="text-xl text-base-content">Waiting for Nouride</h1>
        <p className="text-sm text-base-content/70">
          Nouride is not answering yet; it is probably starting. This page tries again every few seconds.
        </p>
        <Loader2 size={18} className="animate-spin text-secondary" aria-hidden="true" />
      </div>
    </div>
  );
}
