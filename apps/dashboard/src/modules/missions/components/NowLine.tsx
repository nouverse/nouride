/**
 * What the mission is doing at this moment, in one line — read from its conversation's live turn, the feed the chat
 * draws its steps from (`useConversation`, `stepNow`). Between turns it says what it is between: a job it waits on, its
 * checks, the queue, or the next turn about to start.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { LiveTurn, MissionView, Reviewing, RunningJob } from "@nouride/wire";
import { formatElapsed, stepIcon, stepNow } from "@/commons/lib/steps";

/** The line, as words: what is happening, and whether it is happening now (a spinner) or waiting on something. */
export function nowSaid(
  mission: Pick<MissionView, "status" | "reason">,
  live: LiveTurn | undefined,
  jobs: RunningJob[],
  reviewing?: Reviewing,
): { text: string; icon: string | null; moving: boolean } {
  if (live && live.status === "running") {
    const now = stepNow(live.steps);
    if (now.what === "call") return { text: now.text ?? "", icon: stepIcon({ kind: "tool", text: now.text ?? "" }), moving: true };
    if (now.what === "waiting") return { text: now.text ?? "waiting for a person", icon: "⏸", moving: false };
    return { text: now.text ?? "Thinking…", icon: null, moving: true };
  }
  // Its commands take seconds; a review, minutes a pass — said as such, or ten minutes of "Running its checks" read as stuck.
  if (mission.status === "checking" && reviewing) return { text: `The reviewer is looking: pass ${reviewing.pass} of ${reviewing.of}`, icon: "🔍", moving: true };
  if (mission.status === "checking") return { text: "Running its checks", icon: "💻", moving: true };
  if (mission.status === "queued") return { text: mission.reason ?? "Waiting for a free slot", icon: null, moving: false };
  const job = jobs[0];
  if (job) return { text: `Waiting on ${job.command}`, icon: null, moving: true };
  return { text: "Between turns. The next starts shortly", icon: null, moving: false };
}

export function NowLine({ mission, live, jobs, reviewing }: { mission: MissionView; live: LiveTurn | undefined; jobs: RunningJob[]; reviewing?: Reviewing }) {
  const [clock, setClock] = useState(() => Date.now());
  const running = live?.status === "running";
  const looking = !running && mission.status === "checking" && reviewing !== undefined;
  useEffect(() => {
    if (!running && !looking) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, looking]);
  const said = nowSaid(mission, live, jobs, reviewing);

  return (
    <div className="flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/[0.04] px-4 py-3" aria-live="polite">
      <span className="mt-1 shrink-0">
        {said.moving ? <Loader2 size={14} className="animate-spin text-primary" aria-hidden="true" /> : <span className="status status-primary block size-2 rounded-full" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-primary">
          Now{running && live ? ` · turn ${mission.turnsUsed + 1} · ${formatElapsed(clock - live.startedAt)}` : looking && reviewing ? ` · review · ${formatElapsed(clock - reviewing.since)}` : ""}
        </p>
        <p className="mt-0.5 text-sm leading-relaxed text-base-content/90 break-all sm:break-words">
          {said.icon ? <span className="mr-1.5">{said.icon}</span> : null}
          {said.text}
        </p>
      </div>
    </div>
  );
}
