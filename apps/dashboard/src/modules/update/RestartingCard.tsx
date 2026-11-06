/**
 * After Install, until the new version answers — the part of this flow nobody is in control of.
 *
 * The files are swapped first; the daemon restarts once nothing is running, a background job however long it takes,
 * and then is silent for a boot — eight to fifteen seconds on a Raspberry Pi, longer on a slow box. Meanwhile this tab
 * runs the *old* dashboard bundle, out of a directory the swap replaced.
 *
 * The restart is followed by the one follower every restart uses (`commons/lib/restart.ts`): it holds the page's
 * queries while the daemon is away, and when the version installed answers it reloads, which is what fetches the new
 * bundle. This card says which part it is in — the old version still answering is waiting for its work, not "no
 * answer" — and, if the one that comes back is not the version installed, that the new one did not start.
 *
 * In plain words (0.8.19): what the daemon said before it went (files and folders) and the commands that look into a
 * failed start are under Details, for whoever runs the server.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RotateCw } from "lucide-react";
import { Card } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { followInstall, restartNow, useRestart } from "@/commons/lib/restart";

export function RestartingCard({
  note,
  expected,
  before,
}: {
  /** What the daemon said before it went: which files moved, where the old one is, and what it waits for. */
  note: string;
  /** The version it reported installing, as published — `v0.3.2`. */
  expected: string;
  /** The uptime of the daemon that installed it, or null if it was not answering then. */
  before: number | null;
}) {
  const state = useRestart();
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);

  useEffect(() => followInstall({ before, expected, note }), [before, expected, note]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);

  if (state.phase === "back") {
    return (
      <Card title={`Back on ${expected}`} description="" className="border-success/40 bg-success/5">
        <p className="flex items-center gap-2 text-xs text-base-content/80">
          <CheckCircle2 size={14} className="text-success shrink-0" aria-hidden="true" />
          Nouride restarted and is answering. Reloading the page to show the new version…
        </p>
      </Card>
    );
  }

  if (state.phase === "rolled-back") {
    return (
      <Card title={`Back on ${state.running}, not ${expected}`} description="" className="border-warning/40 bg-warning/5">
        <p className="flex items-center gap-2 text-xs text-base-content/80">
          <AlertTriangle size={14} className="text-warning shrink-0" aria-hidden="true" />
          Nouride restarted, but the new version did not start, so the version before it is running again.
        </p>
        <Details className="mt-2">
          <p>The service log says why: <code>journalctl -u nouride -n 100</code>.</p>
        </Details>
      </Card>
    );
  }

  const phase = state.phase === "idle" ? "waiting" : state.phase;
  const waited = formatWait(now - startedAt);
  const line = {
    waiting: `Installed. Nouride restarts once nothing is running (${waited} so far).`,
    restarting: `Restarting… ${waited}`,
    stuck: `Nothing has answered for longer than a restart takes (${waited}).`,
  }[phase];

  return (
    <Card
      title={`Installing ${expected}`}
      description=""
      className={phase === "stuck" ? "border-warning/40 bg-warning/5" : "border-info/40 bg-info/5"}
    >
      <p className="flex items-center gap-2 text-xs text-base-content/80">
        <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />
        {line}
      </p>
      <Details className="mt-2">
        <p>{note}</p>
      </Details>
      {phase === "waiting" && (
        <button type="button" className="btn btn-sm btn-ghost mt-3" onClick={restartNow}>
          Restart now, cut off what is running
        </button>
      )}
      {phase === "stuck" && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn btn-sm btn-ghost gap-1.5" onClick={() => window.location.reload()}>
              <RotateCw size={13} aria-hidden="true" /> Reload the page
            </button>
            <span className="text-xs text-base-content/70">If it still does not answer, whoever runs this server can look at why.</span>
          </div>
          <Details>
            <p>The service: <code>systemctl status nouride</code>.</p>
          </Details>
        </div>
      )}
    </Card>
  );
}

function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
